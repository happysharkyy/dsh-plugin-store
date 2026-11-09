#!/usr/bin/env node
/**
 * 校验商店里已镜像的安装包是否真的可用。
 *
 *   node scripts/verify.mjs            结构校验（快，不装）
 *   node scripts/verify.mjs --install  额外做一次真实的离线安装（慢，需要 dsh）
 *
 * 结构校验会检查：
 *   - tarball 能被解开、包含 package/package.json
 *   - package.json 是合法 JSON，且 name / version 与目录一致
 *   - 声明了 dsh.bundle.patch 时，补丁文件确实在包内
 *   - 运行时依赖已被物化（node_modules 存在或本来就没有依赖）
 *   - sha256 与 manifest 记录一致
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTarGz } from './lib/tar.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DO_INSTALL = process.argv.includes('--install');
const ONLY_ARG = process.argv.find((a) => a.startsWith('--only='));
const ONLY = ONLY_ARG ? new Set(ONLY_ARG.split('=')[1].split(',')) : null;

// 与 build-catalog 一致：优先 Linux 原生产物（服务器部署用）
const PLATFORM_ARG = process.argv.find((a) => a.startsWith('--platform='));
const PLATFORM = PLATFORM_ARG
  ? PLATFORM_ARG.split('=')[1]
  : fs.existsSync(path.join(ROOT, 'mirror', 'manifest-linux.json')) ? 'linux' : 'win32';

const MANIFEST = [path.join(ROOT, 'mirror', `manifest-${PLATFORM}.json`), path.join(ROOT, 'mirror', 'manifest.json')]
  .find((p) => fs.existsSync(p));
const PKG = [path.join(ROOT, 'mirror', `packages-${PLATFORM}`), path.join(ROOT, 'mirror', 'packages')]
  .find((p) => fs.existsSync(p)) || path.join(ROOT, 'mirror', 'packages');

console.log(`校验平台 ${PLATFORM}  清单 ${path.relative(ROOT, MANIFEST || '')}  包目录 ${path.relative(ROOT, PKG)}\n`);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'sources.json'), 'utf8'));

let pass = 0;
let fail = 0;
const problems = [];

for (const plugin of sources.plugins) {
  if (ONLY && !ONLY.has(plugin.id)) continue;
  const m = manifest.packages?.[plugin.id];
  if (!m || m.status !== 'ready') {
    console.log(`SKIP  ${plugin.id}  (未镜像)`);
    continue;
  }

  const file = path.join(PKG, m.file);
  const issues = [];

  if (!fs.existsSync(file)) {
    issues.push('文件不存在');
  } else {
    const raw = fs.readFileSync(file);
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    if (sha !== m.sha256) issues.push('sha256 与 manifest 不一致');

    let entries = [];
    try {
      entries = readTarGz(raw);
    } catch (e) {
      issues.push(`解包失败：${e.message}`);
    }

    const pkgEntry = entries.find((e) => e.path === 'package/package.json');
    if (!pkgEntry) {
      issues.push('包内缺少 package/package.json');
    } else {
      let pkg = null;
      try {
        pkg = JSON.parse(pkgEntry.data.toString('utf8'));
      } catch {
        issues.push('package.json 不是合法 JSON（可能被安全软件改写）');
      }
      if (pkg) {
        if (pkg.name !== plugin.packageName) issues.push(`包名不符：${pkg.name} != ${plugin.packageName}`);
        // dsh.bundle.patch 可能是字符串或数组
        const rawPatch = pkg.dsh?.bundle?.patch;
        const patchList = (Array.isArray(rawPatch) ? rawPatch : rawPatch ? [rawPatch] : []).map((s) =>
          String(s).replace(/^\.\//, '')
        );
        if (patchList.length) {
          for (const patch of patchList) {
            const hasPatch = entries.some((e) => e.path === `package/${patch}`);
            if (!hasPatch) issues.push(`缺少补丁文件 ${patch}，DSH 无法加载该 profile 层`);
          }
        } else {
          issues.push('package.json 没有声明 dsh.bundle.patch');
        }
        if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
          issues.push(`依赖未物化：仍有 ${Object.keys(pkg.dependencies).length} 个 dependencies，离线安装会失败`);
        }
      }
    }

    const hasNM = entries.some((e) => e.path.startsWith('package/node_modules/'));
    const entryCount = entries.length;
    if (!hasNM && entryCount > 0) {
      // 没有 node_modules 也可以，前提是本来就没有运行时依赖
      const pkg = entries.find((e) => e.path === 'package/package.json');
      const deps = pkg ? JSON.parse(pkg.data.toString('utf8')).dependencies : {};
      if (deps && Object.keys(deps).length) issues.push('缺少 node_modules，且包声明了 dependencies');
    }
  }

  if (issues.length) {
    fail++;
    console.log(`FAIL  ${plugin.id}  ${m.file}`);
    for (const i of issues) console.log(`        - ${i}`);
    problems.push({ id: plugin.id, issues });
  } else {
    pass++;
    console.log(`OK    ${plugin.id}  ${m.file}  ${(m.sizeBytes / 1024 / 1024).toFixed(1)} MB  [${m.strategy}]`);
  }
}

console.log(`\n结构校验：${pass} 通过 / ${fail} 失败`);

/* ---------------- 真实离线安装 ---------------- */
if (DO_INSTALL && problems.length === 0) {
  const dsh = process.env.DSH_BIN || 'dsh';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-store-verify-'));
  process.env.DSH_HOME = home;
  const ready = sources.plugins.filter((p) => manifest.packages?.[p.id]?.status === 'ready');
  let ok = 0;
  for (const p of ready) {
    if (ONLY && !ONLY.has(p.id)) continue;
    const tgz = path.join(PKG, manifest.packages[p.id].file);
    try {
      execFileSync(dsh, ['plugin', '--profile', 'verify', 'add', `file:${tgz}`], {
        stdio: 'pipe',
        env: { ...process.env, DSH_HOME: home },
        shell: process.platform === 'win32',
      });
      console.log(`INSTALL OK    ${p.id}`);
      ok++;
    } catch (e) {
      console.log(`INSTALL FAIL  ${p.id}\n        ${String(e.stderr || e.message).trim().split('\n').slice(-3).join('\n        ')}`);
    }
  }
  console.log(`\n离线安装：${ok}/${ready.length} 通过（临时 DSH_HOME=${home}）`);
}
