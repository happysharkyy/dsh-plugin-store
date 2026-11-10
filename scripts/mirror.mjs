#!/usr/bin/env node
/**
 * DSH 内网插件商店 —— 离线镜像打包器
 *
 * 在「有外网」的机器上运行，把插件做成内网可以直接安装的 .tgz：
 *   - 优先取 npm registry 上已发布的成品包（作者构建好的，最稳）
 *   - 没有发布 / 发布版本落后时才从 GitHub 源码构建
 *   - 两种方式都会把运行时依赖物化进包内，并从 package.json 移除 dependencies，
 *     这样内网 pnpm 安装时完全不需要访问 registry。
 *
 * 用法：
 *   node scripts/mirror.mjs                 # 镜像全部插件
 *   node scripts/mirror.mjs --only ssh-exec,pptwize
 *   node scripts/mirror.mjs --fresh         # 忽略缓存，重新拉取
 *   node scripts/mirror.mjs --strategy=npm  # 强制只用 npm 成品包
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { packDir, extractTarGzTo, readTarGz } from './lib/tar.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.mirror-work');
const OUT = path.join(ROOT, 'mirror', 'packages');
const MANIFEST = path.join(ROOT, 'mirror', 'manifest.json');

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0
  ? new Set((argv[onlyIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const FRESH = argv.includes('--fresh');
const FORCE_STRATEGY = (argv.find((a) => a.startsWith('--strategy=')) || '').split('=')[1] || null;

const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'sources.json'), 'utf8'));

const log = (...a) => console.log(...a);
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/* ------------------------------------------------------------------ */
/* 进程执行                                                            */
/* ------------------------------------------------------------------ */

function run(cmd, args, cwd, opts = {}) {
  const shell = process.platform === 'win32';
  return execFileSync(cmd, args, {
    cwd,
    stdio: opts.stdio || 'pipe',
    encoding: 'utf8',
    shell,
    windowsHide: true,
    timeout: opts.timeout ?? 20 * 60 * 1000,
    maxBuffer: 1024 * 1024 * 128,
    env: childEnv(),
  });
}

function tryRun(cmd, args, cwd) {
  try {
    run(cmd, args, cwd);
    return { ok: true };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` || e.message };
  }
}

function tryRunPnpm(args, cwd) {
  try {
    runPnpm(args, cwd);
    return { ok: true };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` || e.message };
  }
}

/* ------------------------------------------------------------------ */
/* 工具链                                                              */
/* ------------------------------------------------------------------ */

function ensurePnpmShim(nodeExe, pnpmCjs) {
  const binDir = path.join(WORK, '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'pnpm.cmd'), `@echo off\r\n"${nodeExe}" "${pnpmCjs}" %*\r\n`);
  fs.writeFileSync(path.join(binDir, 'pnpm'), `#!/bin/sh\nexec "${nodeExe}" "${pnpmCjs}" "$@"\n`, { mode: 0o755 });
  return binDir;
}

function resolveToolchain() {
  // 0) 显式指定优先（CI 里最可靠）
  const explicit = process.env.DSH_PNPM_BIN;
  if (explicit && fs.existsSync(explicit)) {
    return { kind: 'pnpm', cmd: explicit, pre: [], binDir: path.dirname(explicit) };
  }

  try {
    run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], ROOT);
    return { kind: 'pnpm', cmd: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', pre: [], binDir: null };
  } catch {}

  // 常见安装位置：npm 全局前缀不一定在 PATH 里
  if (process.platform !== 'win32') {
    const home = process.env.HOME || '';
    const guesses = [
      path.join(home, '.npm-global', 'bin', 'pnpm'),
      '/usr/local/bin/pnpm',
      '/usr/bin/pnpm',
      path.join(home, '.local', 'share', 'pnpm', 'pnpm'),
      path.join(home, '.local', 'bin', 'pnpm'),
    ];
    for (const g of guesses) {
      if (g && fs.existsSync(g)) return { kind: 'pnpm', cmd: g, pre: [], binDir: path.dirname(g) };
    }
  }

  const bundledRoots = [
    'D:\\happy\\dsh\\resources\\runtime\\primary-runtime\\dependencies',
    path.join(process.env.LOCALAPPDATA || '', 'dsh', 'runtime', 'dependencies'),
  ];
  for (const base of bundledRoots) {
    const pnpmCjs = path.join(base, 'pnpm', 'bin', 'pnpm.cjs');
    const nodeExe = path.join(base, 'node', 'bin', 'node.exe');
    if (fs.existsSync(pnpmCjs) && fs.existsSync(nodeExe)) {
      return { kind: 'pnpm', cmd: nodeExe, pre: [pnpmCjs], binDir: ensurePnpmShim(nodeExe, pnpmCjs) };
    }
  }
  return { kind: 'npm', cmd: NPM, pre: [], binDir: null };
}

const TOOL = resolveToolchain();
const TOOL_PATH_ENTRIES = [TOOL.binDir, TOOL.pre.length ? path.dirname(TOOL.cmd) : null].filter(Boolean);
const SEP = process.platform === 'win32' ? ';' : ':';

// Windows 上环境变量的键名常常是 Path 而不是 PATH，直接读 process.env.PATH 会拿到空值
const PATH_KEY = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';

function childEnv() {
  const env = { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', CI: '1' };
  const prefix = TOOL_PATH_ENTRIES.length ? TOOL_PATH_ENTRIES.join(SEP) + SEP : '';
  env[PATH_KEY] = prefix + (process.env[PATH_KEY] || '');
  return env;
}

/* ------------------------------------------------------------------ */
/* 文件工具                                                            */
/* ------------------------------------------------------------------ */

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

function copyRec(src, dest, filter) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (filter && !filter(src, true)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) copyRec(path.join(src, e), path.join(dest, e), filter);
  } else {
    if (filter && !filter(src, false)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/** 目录拷贝加速：Windows 用 robocopy（多线程），其他平台用 fs.cpSync */
function copyTree(src, dest, excludeNames = []) {
  if (!fs.existsSync(src)) return;
  if (process.platform === 'win32') {
    const args = [src, dest, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'];
    if (excludeNames.length) args.push('/XD', ...excludeNames.map((n) => path.join(src, n)));
    try {
      run('robocopy', args, ROOT);
    } catch (e) {
      // robocopy 用 0-7 表示成功
      if (e.status === undefined || e.status > 7) throw e;
    }
    return;
  }
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => !excludeNames.includes(path.basename(p)),
  });
}

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/* ------------------------------------------------------------------ */
/* 版本比较                                                            */
/* ------------------------------------------------------------------ */

function parseVer(v) {
  return String(v || '0').replace(/^v/, '').split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
}

function cmpVer(a, b) {
  const A = parseVer(a), B = parseVer(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    // 数字优先于预发布标签：1.0.0 > 1.0.0-beta
    if (typeof x === 'number') return 1;
    if (typeof y === 'number') return -1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* npm registry                                                        */
/* ------------------------------------------------------------------ */

async function registryInfo(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
      headers: { 'user-agent': 'dsh-store-mirror' },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const latest = j['dist-tags']?.latest;
    if (!latest) return null;
    return { version: latest, tarball: j.versions?.[latest]?.dist?.tarball, manifest: j.versions?.[latest] };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 打包：改写 package.json + 打 tar                                     */
/* ------------------------------------------------------------------ */

function finalizePackage(stage, pkg, plugin, meta) {
  const outPkg = JSON.parse(JSON.stringify(pkg));
  delete outPkg.dependencies;
  delete outPkg.optionalDependencies;
  delete outPkg.devDependencies;
  delete outPkg.scripts;
  delete outPkg.packageManager;
  delete outPkg.publishConfig;
  delete outPkg.private;
  delete outPkg.files;
  if (!outPkg.version) outPkg.version = '0.0.0';
  outPkg.dshMarket = {
    vendored: true,
    mirroredFrom: plugin.repo,
    mirroredAt: new Date().toISOString(),
    ...meta,
  };
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(outPkg, null, 2));

  fs.mkdirSync(OUT, { recursive: true });
  const version = String(outPkg.version).replace(/[^\w.\-]/g, '_');
  const fileName = `${plugin.id}-${version}.tgz`;
  const outFile = path.join(OUT, fileName);
  rmrf(outFile);

  // 打包前就地校验：包内 package.json 必须是合法 JSON，且补丁文件存在
  const stagedPkgPath = path.join(stage, 'package.json');
  let stagedPkg;
  try {
    stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, 'utf8'));
  } catch {
    throw new Error('校验失败：暂存包内 package.json 不是合法 JSON（可能被安全软件改写）');
  }
  // dsh.bundle.patch 可能是字符串，也可能是数组（一个包带多个 patch 层）
  const stagedPatches = patchPaths(stagedPkg);
  for (const sp of stagedPatches) {
    if (!fs.existsSync(path.join(stage, sp))) {
      throw new Error(`校验失败：包内缺少补丁文件 ${sp}`);
    }
  }

  // 在 Node 进程内打包：外部 tar 在装了透明加密的环境里会读到密文
  const buf = packDir(stage, 'package');
  fs.writeFileSync(outFile, buf);

  // 只校验 gzip 魔数，避免把几百 MB 的包完整解压回读
  const head = fs.readFileSync(outFile).subarray(0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) throw new Error('校验失败：产物不是合法的 gzip 包');

  const stat = fs.statSync(outFile);
  return {
    id: plugin.id,
    status: 'ready',
    file: fileName,
    packageName: outPkg.name,
    version: outPkg.version,
    sizeBytes: stat.size,
    sha256: sha256(outFile),
    builtAt: new Date().toISOString(),
    repo: plugin.repo,
    ...meta,
  };
}

/** 确保补丁文件在包里（npm 包偶尔漏发） */
async function ensurePatchFile(stage, plugin, patchRel) {
  const target = path.join(stage, patchRel);
  if (fs.existsSync(target)) return true;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${plugin.repo}/HEAD/${patchRel}`, {
      headers: { 'user-agent': 'dsh-store-mirror' },
    });
    if (!res.ok) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await res.text());
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 策略 A：npm 成品包 + 物化依赖                                        */
/* ------------------------------------------------------------------ */

async function buildFromNpm(plugin, info) {
  const dir = path.join(WORK, `${plugin.id}__npm`);
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });

  log(`  - npm pack ${info.version}`);
  run(NPM, ['pack', `${plugin.packageName}@${info.version}`, '--pack-destination', dir, '--silent'], dir);
  const tgz = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack 没有产出 tarball');

  const extracted = path.join(dir, 'package');
  extractTarGzTo(path.join(dir, tgz), dir);
  if (!fs.existsSync(extracted)) throw new Error('tarball 解包失败');

  log('  - 物化生产依赖');
  const depDir = path.join(dir, 'deps');
  fs.mkdirSync(depDir, { recursive: true });
  fs.writeFileSync(path.join(depDir, 'package.json'), JSON.stringify({ name: 'mirror-deps', private: true, version: '0.0.0' }));
  run(NPM, ['install', `${plugin.packageName}@${info.version}`, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', '--legacy-peer-deps'], depDir);

  const stageParent = path.join(dir, 'stage');
  const stage = path.join(stageParent, 'package');
  fs.mkdirSync(stage, { recursive: true });
  copyRec(extracted, stage);

  const depNM = path.join(depDir, 'node_modules');
  if (fs.existsSync(depNM)) {
    copyTree(depNM, path.join(stage, 'node_modules'), ['.bin', '.cache']);
    // 去掉包自身，避免 node_modules/dsh-xxx 和包内容重复
    rmrf(path.join(stage, 'node_modules', ...plugin.packageName.split('/')));
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  const patches = patchPaths(pkg);
  for (const rel of patches) await ensurePatchFile(stage, plugin, rel);

  const entry = finalizePackage(stage, pkg, plugin, { strategy: 'npm', npmVersion: info.version });
  rmrf(dir);
  return entry;
}

/* ------------------------------------------------------------------ */
/* 策略 C：本地插件目录（自己写的插件，不来自 GitHub）                     */
/* ------------------------------------------------------------------ */

async function buildFromLocal(plugin) {
  const srcDir = path.join(ROOT, plugin.local);
  if (!fs.existsSync(path.join(srcDir, 'package.json'))) {
    throw new Error(`本地插件目录缺少 package.json：${plugin.local}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'));
  const patches = patchPaths(pkg);
  log(`  - ${pkg.name}@${pkg.version}  patch=${patches.join(',')}`);

  const stageParent = path.join(WORK, `${plugin.id}__local`);
  rmrf(stageParent);
  const stage = path.join(stageParent, 'package');
  fs.mkdirSync(stage, { recursive: true });

  for (const rel of collectPayload(srcDir, pkg, patches)) {
    const src = path.join(srcDir, rel);
    if (!fs.existsSync(src)) continue;
    copyRec(src, path.join(stage, rel));
  }
  // 本地插件目录里的 skills/ 资源要全带上
  if (fs.existsSync(path.join(srcDir, 'skills'))) copyRec(path.join(srcDir, 'skills'), path.join(stage, 'skills'));

  const entry = finalizePackage(stage, pkg, plugin, { strategy: 'local' });
  rmrf(stageParent);
  return entry;
}

/* ------------------------------------------------------------------ */
/* 源码获取：优先 git clone，被墙时退到 codeload 源码包                    */
/* ------------------------------------------------------------------ */

/** 用 codeload 下整包源码（github.com 被墙但 codeload 可通的网络里很有用） */
async function downloadSource(plugin, repoDir) {
  const branches = [...new Set([plugin.branch, 'main', 'master'].filter(Boolean))];
  const urlsFor = (branch) => [
    `https://codeload.github.com/${plugin.repo}/tar.gz/refs/heads/${branch}`,
    `https://github.com/${plugin.repo}/archive/refs/heads/${branch}.tar.gz`,
  ];
  let lastErr = '';
  for (const branch of branches) {
    for (const url of urlsFor(branch)) {
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': 'dsh-store-mirror' },
          // 大仓库的源码包可能几十 MB，慢网下 3 分钟不够
          signal: AbortSignal.timeout(15 * 60 * 1000),
        });
        if (!res.ok) {
          lastErr = `${branch}: HTTP ${res.status}`;
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const entries = readTarGz(buf);
        if (!entries.length) {
          lastErr = `${branch}: 空包`;
          continue;
        }
        rmrf(repoDir);
        // 条目都在 `<repo>-<sha>/` 下，去掉这一层
        const top = entries[0].path.split('/')[0];
        for (const e of entries) {
          const rel = e.path === top ? '' : e.path.slice(top.length + 1);
          if (!rel) continue;
          const target = path.join(repoDir, rel);
          if (e.type === 'dir') fs.mkdirSync(target, { recursive: true });
          else if (e.type === 'file') {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, e.data, { mode: e.mode || 0o644 });
          }
        }
        log(`  - codeload 下载完成（${branch}, ${entries.length} 个条目）`);
        return;
      } catch (e) {
        lastErr = `${branch}: ${e.message}`;
      }
    }
  }
  throw new Error(`源码获取失败：${lastErr}`);
}

async function ensureSource(plugin, repoDir) {
  if (fs.existsSync(path.join(repoDir, 'package.json')) && fs.existsSync(path.join(repoDir, '.git'))) {
    log('  - 复用已有 clone');
    return;
  }
  if (fs.existsSync(path.join(repoDir, 'package.json'))) {
    log('  - 复用已有源码目录');
    return;
  }
  rmrf(repoDir);
  fs.mkdirSync(WORK, { recursive: true });
  log(`  - clone ${plugin.repo}`);
  try {
    // github.com 被墙时 git 会长时间挂住，给个短超时让它尽快回落到 codeload
    run('git', ['clone', '--depth', '1', '--single-branch', `https://github.com/${plugin.repo}.git`, repoDir], WORK, {
      timeout: 90 * 1000,
    });
  } catch (e) {
    log('  - git clone 失败（GitHub 直连不可用或超时），改用 codeload');
    rmrf(repoDir);
    await downloadSource(plugin, repoDir);
  }
}

function detectPM(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml')) || fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return 'pnpm';
  return 'npm';
}

function runPnpm(args, dir) {
  return run(TOOL.cmd, [...TOOL.pre, ...args], dir);
}

function pmInstall(dir, pm, prodOnly) {
  if (pm === 'pnpm') {
    runPnpm([
      'install',
      '--config.confirmModulesPurge=false',
      '--config.ignore-workspace-root-check=true',
      // 仓库的 lockfile 常与 package.json 不同步，CI=1 下 pnpm 会直接拒绝安装
      '--no-frozen-lockfile',
      // pnpm 10+ 默认拦掉依赖的 postinstall，esbuild/node-pty 这类会缺产物；
      // 镜像机是受控环境，这里放开，保证包内二进制完整。
      '--config.dangerouslyAllowAllBuilds=true',
      ...(prodOnly ? ['--config.prod=true'] : []),
    ], dir);
  } else {
    run(NPM, [
      'install',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      // 不少 DSH 插件的 peer 依赖里混着未发布的内部包（@deepseek-ai/dsh-type-meta 等），
      // 不加这个 npm 会直接 ERESOLVE 装不下去
      '--legacy-peer-deps',
      ...(prodOnly ? ['--omit=dev'] : []),
    ], dir);
  }
}

/** dsh.bundle.patch 可能是字符串，也可能是数组 */
function patchPaths(pkg) {
  const raw = pkg?.dsh?.bundle?.patch;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const norm = list.map((s) => String(s).replace(/^\.\//, '')).filter(Boolean);
  return norm.length ? norm : ['cordis.patch.yml'];
}

/** 从 package.json 的 files / 目录约定推断要打进包里的内容 */
function collectPayload(pkgDir, pkg, patches) {
  const wanted = new Set();
  const norm = (f) => f.replace(/^\.\//, '').replace(/\/$/, '');
  const firstSegment = (f) => {
    const clean = f.split('*')[0].replace(/\/$/, '');
    return clean.split('/')[0] || clean;
  };

  if (Array.isArray(pkg.files) && pkg.files.length) {
    for (const f of pkg.files) wanted.add(firstSegment(norm(f)));
  }
  // files 里常漏掉实际入口，这里补上常见目录
  for (const cand of ['lib', 'dist', 'build', 'out', 'src', 'skills', 'assets', 'templates', 'presets']) {
    if (fs.existsSync(path.join(pkgDir, cand))) wanted.add(cand);
  }
  for (const f of ['package.json', 'README.md', 'README.zh.md', 'README.en.md', 'LICENSE', 'LICENSE.md']) {
    if (fs.existsSync(path.join(pkgDir, f))) wanted.add(f);
  }
  // 所有声明的补丁文件都要带上（数组形式时逐个）
  for (const p of patches || []) {
    if (fs.existsSync(path.join(pkgDir, p))) wanted.add(p);
  }
  return [...wanted].filter((p) => fs.existsSync(path.join(pkgDir, p)));
}

/** 构建失败时的兜底：直接 tsc 产出（忽略类型错误），或调用打包器 */
function buildFallback(repoDir, pkg) {
  const binDir = path.join(repoDir, 'node_modules', '.bin');
  const win = process.platform === 'win32';
  const bin = (name) => path.join(binDir, win ? `${name}.cmd` : name);
  const candidates = [];
  if (fs.existsSync(path.join(repoDir, 'tsconfig.json')) && fs.existsSync(bin('tsc'))) {
    candidates.push([bin('tsc'), ['-p', 'tsconfig.json', '--noEmitOnError', 'false']]);
  }
  for (const b of ['tsdown', 'tsup', 'rollup']) {
    if (fs.existsSync(bin(b))) candidates.push([bin(b), []]);
  }
  for (const [cmd, args] of candidates) {
    log(`  - build 兜底: ${path.basename(cmd)} ${args.join(' ')}`);
    const r = tryRun(cmd, args, repoDir);
    const mainOk = !pkg.main || fs.existsSync(path.join(repoDir, pkg.main));
    if (mainOk) return true;
    if (!r.ok) log(`    (未成功) ${String(r.out).trim().split('\n').slice(-2).join(' ')}`);
  }
  return !pkg.main || fs.existsSync(path.join(repoDir, pkg.main));
}

async function buildFromSource(plugin) {
  const repoDir = path.join(WORK, plugin.id);
  if (FRESH) rmrf(repoDir);

  await ensureSource(plugin, repoDir);

  // monorepo：真正的插件包在子目录里
  const pkgDir = plugin.subdir ? path.join(repoDir, plugin.subdir) : repoDir;
  if (plugin.subdir) log(`  - 子包目录 ${plugin.subdir}`);
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) throw new Error('目标目录没有 package.json');

  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const pm = detectPM(repoDir);
  const patches = patchPaths(pkg);
  log(`  - ${pkg.name}@${pkg.version}  pm=${pm}  patch=${patches.join(',')}`);

  if (!fs.existsSync(path.join(repoDir, 'node_modules'))) {
    log('  - install (with dev)');
    pmInstall(repoDir, pm, false);
  }

  const mainPath = typeof pkg.main === 'string' ? path.join(pkgDir, pkg.main) : null;
  if (pkg.scripts?.build && (!mainPath || !fs.existsSync(mainPath))) {
    log(`  - build: ${pkg.scripts.build}`);
    const r = pm === 'pnpm' ? tryRunPnpm(['run', 'build'], repoDir) : tryRun(NPM, ['run', 'build'], repoDir);
    if (!r.ok) {
      log('  - build 失败，走兜底');
      if (!buildFallback(pkgDir, pkg)) throw new Error(`构建失败：${String(r.out).split('\n').slice(-4).join(' | ')}`);
    }
  }

  log('  - prune dev deps');
  try { pmInstall(repoDir, pm, true); } catch (e) { log('    (prune 失败，继续)'); }

  const stageParent = path.join(WORK, `${plugin.id}__stage`);
  rmrf(stageParent);
  const stage = path.join(stageParent, 'package');
  fs.mkdirSync(stage, { recursive: true });

  for (const rel of collectPayload(pkgDir, pkg, patches)) {
    const src = path.join(pkgDir, rel);
    if (!fs.existsSync(src)) continue;
    copyRec(src, path.join(stage, rel), (p, isDir) => {
      if (isDir && ['node_modules', '.git', '.github', 'test', 'tests', '__tests__', 'coverage'].includes(path.basename(p))) return false;
      return true;
    });
  }

  const nm = fs.existsSync(path.join(pkgDir, 'node_modules'))
    ? path.join(pkgDir, 'node_modules')
    : path.join(repoDir, 'node_modules');
  if (fs.existsSync(nm)) {
    log('  - 内置 node_modules（离线关键）');
    copyTree(nm, path.join(stage, 'node_modules'), ['.bin', '.cache']);
  }

  for (const rel of patches) await ensurePatchFile(stage, plugin, rel);
  const entry = finalizePackage(stage, pkg, plugin, { strategy: 'git', gitRef: 'HEAD' });
  rmrf(stageParent);
  return entry;
}

/* ------------------------------------------------------------------ */
/* 单个插件编排                                                        */
/* ------------------------------------------------------------------ */

async function mirrorOne(plugin) {
  const label = plugin.local || plugin.repo || plugin.packageName;
  log(`\n=== [${plugin.id}] ${label} (${plugin.packageName}) ===`);

  // 本地插件直接打包，不走网络
  if (plugin.local) {
    return buildFromLocal(plugin);
  }

  const npmInfo = plugin.subdir ? null : await registryInfo(plugin.packageName);
  let repoVersion = null;
  try {
    const manifestPath = plugin.subdir ? `${plugin.subdir}/package.json` : 'package.json';
    const raw = await fetch(`https://raw.githubusercontent.com/${plugin.repo}/HEAD/${manifestPath}`, {
      headers: { 'user-agent': 'dsh-store-mirror' },
    }).then((r) => (r.ok ? r.json() : null));
    repoVersion = raw?.version || null;
  } catch {}

  let useNpm = false;
  if (npmInfo) {
    if (FORCE_STRATEGY === 'npm') useNpm = true;
    else if (!repoVersion) useNpm = true;
    else useNpm = cmpVer(npmInfo.version, repoVersion) >= 0;
  }
  log(`  · npm=${npmInfo?.version || '无'} / repo=${repoVersion || '?'} -> ${useNpm ? 'npm 成品包' : '源码构建'}`);

  if (useNpm) {
    try {
      return await buildFromNpm(plugin, npmInfo);
    } catch (e) {
      log(`  ! npm 策略失败: ${(e.stderr || e.message).toString().split('\n').slice(-2).join(' ')}`);
      if (FORCE_STRATEGY === 'npm') throw e;
    }
  }

  try {
    return await buildFromSource(plugin);
  } catch (e) {
    const msg = (e?.stderr || e?.message || String(e)).toString().trim().split('\n').slice(-4).join(' | ');
    log(`  ! 源码构建失败: ${msg}`);
    if (npmInfo) {
      log('  ! 回退 npm 成品包');
      return await buildFromNpm(plugin, npmInfo);
    }
    throw e;
  }
}

async function main() {
  log(`工具链：${TOOL.kind} -> ${TOOL.cmd} ${TOOL.pre.join(' ')}`);

  // 同一时间只允许一个镜像进程，否则 manifest.json 会互相覆盖
  const lockFile = path.join(ROOT, '.mirror.lock');
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) {
      console.error(`已有一个镜像进程在跑（pid ${pid}）。确认无进展后删除 ${lockFile} 再试。`);
      process.exit(1);
    }
    log('清理上次残留的锁文件');
  }
  fs.writeFileSync(lockFile, String(process.pid));
  const unlock = () => { try { fs.unlinkSync(lockFile); } catch {} };
  process.on('exit', unlock);
  process.on('SIGINT', () => { unlock(); process.exit(130); });

  const manifest = fs.existsSync(MANIFEST)
    ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    : { generatedAt: null, packages: {} };
  manifest.packages ||= {};

  const list = sources.plugins.filter((p) => !ONLY || ONLY.has(p.id));
  log(`待镜像 ${list.length} 个插件 -> ${OUT}`);

  for (const plugin of list) {
    try {
      manifest.packages[plugin.id] = await mirrorOne(plugin);
      const e = manifest.packages[plugin.id];
      log(`  OK ${e.file}  ${(e.sizeBytes / 1024 / 1024).toFixed(1)} MB  [${e.strategy}]  sha256=${e.sha256.slice(0, 12)}...`);
    } catch (err) {
      const msg = (err?.stderr || err?.stdout || err?.message || String(err)).toString().trim().split('\n').slice(-6).join('\n');
      log(`  FAILED: ${msg}`);
      manifest.packages[plugin.id] = {
        id: plugin.id,
        status: 'failed',
        error: msg.slice(0, 1000),
        repo: plugin.repo,
        attemptedAt: new Date().toISOString(),
      };
    }
    manifest.generatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  }

  const all = Object.values(manifest.packages);
  log(`\n完成：${all.filter((p) => p.status === 'ready').length} 成功 / ${all.filter((p) => p.status === 'failed').length} 失败`);
  log(`产物：${OUT}`);
  process.exit(0); // fetch 的 keep-alive 句柄会拖住事件循环
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
