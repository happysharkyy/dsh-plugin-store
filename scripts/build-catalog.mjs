#!/usr/bin/env node
/**
 * 生成商店前端数据：catalog/sources.json + mirror/manifest.json + GitHub 元数据 -> web/data/plugins.json
 *
 * GitHub 元数据会缓存到 catalog/.cache/github.json，断网也能重复构建。
 * 用法：node scripts/build-catalog.mjs [--refresh]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageJsonFast } from './lib/tar.mjs';
import { checkCompat, dshPeerRanges } from './lib/semver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'catalog', '.cache', 'github.json');
const REFRESH = process.argv.includes('--refresh');
// 内网无网络：--offline 完全不发请求，只用已缓存/已生成的数据
const OFFLINE = process.argv.includes('--offline') || process.env.DSH_STORE_OFFLINE === '1';

/** 目标平台：决定用哪一份 manifest / packages 目录 */
const PLATFORM = (() => {
  const arg = process.argv.find((a) => a.startsWith('--platform='));
  if (arg) return arg.split('=')[1];
  // 没指定就看有没有 Linux 原生产物（服务器部署通常用它）
  return fs.existsSync(path.join(ROOT, 'mirror', 'manifest-linux.json')) ? 'linux' : 'win32';
})();
const PLATFORM_LABEL = PLATFORM === 'linux' ? `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : 'win32-x64';

const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'sources.json'), 'utf8'));

const manifestPath = [path.join(ROOT, 'mirror', `manifest-${PLATFORM}.json`), path.join(ROOT, 'mirror', 'manifest.json')]
  .find((p) => fs.existsSync(p));
const manifest = manifestPath ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { packages: {} };

const PKG_DIR = [path.join(ROOT, 'mirror', `packages-${PLATFORM}`), path.join(ROOT, 'mirror', 'packages')]
  .find((p) => fs.existsSync(p)) || path.join(ROOT, 'mirror', 'packages');

/** 当前 DSH 运行时版本：优先读本机 runtime.json，其次用 sources.json 里的声明 */
function detectDshVersion() {
  if (sources.site?.dshVersion) return sources.site.dshVersion;
  const candidates = [
    path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'),
    path.join(process.env.LOCALAPPDATA || '', 'dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'),
  ];
  for (const c of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (j.desktopVersion) return j.desktopVersion;
    } catch {}
  }
  return null;
}

const DSH_VERSION = detectDshVersion();

// 真实安装验收结果（scripts/install-matrix.mjs 产出），比按 peer 范围猜更准
const matrixPath = path.join(ROOT, 'mirror', 'install-matrix.json');
let matrix = { results: [] };
if (fs.existsSync(matrixPath)) {
  try { matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8')); } catch {}
}
const matrixById = new Map((matrix.results || []).map((r) => [r.id, r]));

/**
 * 市场索引用补充「下载量 / 星标」：按 npm 包名匹配，
 * 这样从 dshmarket 导入的插件和早期上架的插件都能参与下载量排名。
 */
const MARKET_CACHE = path.join(ROOT, 'catalog', '.cache', 'market.json');
async function loadMarket() {
  if (fs.existsSync(MARKET_CACHE)) {
    try {
      const j = JSON.parse(fs.readFileSync(MARKET_CACHE, 'utf8'));
      if (j.plugins?.length) return j;
    } catch {}
  }
  if (OFFLINE) return { plugins: [] };
  try {
    const res = await fetch('https://dshmarket.2020713.xyz/index.json', { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { plugins: [] };
    const j = await res.json();
    fs.mkdirSync(path.dirname(MARKET_CACHE), { recursive: true });
    fs.writeFileSync(MARKET_CACHE, JSON.stringify(j));
    return j;
  } catch {
    return { plugins: [] };
  }
}

const market = await loadMarket();
const marketByPkg = new Map((market.plugins || []).map((p) => [p.name, p]));

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

async function ghMeta(repo) {
  const hit = cache[repo];
  // 断网模式一律用缓存；没有缓存就用中性默认值，绝不发请求
  if (OFFLINE) return hit || { repo, stars: 0, license: '', description: '', homepage: `https://github.com/${repo}`, topics: [], pushedAt: null };
  const fresh = hit && Date.now() - new Date(hit.fetchedAt).getTime() < 6 * 3600 * 1000;
  if (!REFRESH && fresh) return hit;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { 'user-agent': 'dsh-store', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000), // 内网 DNS 黑洞时别把整个构建卡死
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const meta = {
      repo,
      stars: j.stargazers_count,
      forks: j.forks_count,
      license: j.license?.spdx_id || '',
      description: j.description || '',
      homepage: j.html_url,
      topics: j.topics || [],
      pushedAt: j.pushed_at,
      archived: !!j.archived,
      fetchedAt: new Date().toISOString(),
    };
    cache[repo] = meta;
    return meta;
  } catch (e) {
    if (hit) return hit;
    return { repo, stars: 0, license: '', description: '', homepage: `https://github.com/${repo}`, topics: [], pushedAt: null };
  }
}

function fmtBytes(n) {
  if (!n) return null;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 市场索引里的 title 有时是仓库路径（如 dsh-web#packages/dsh-skill-explorer），
 * 直接当标题显示很难看，这里取末段并去掉 dsh- 前缀。
 */
function cleanTitle(title, pkgName, fallbackId) {
  const t = String(title || '').trim();
  if (!t) return pkgName || fallbackId;
  if (!t.includes('#')) return t;
  const seg = t.split('#').pop().split('/').filter(Boolean).pop() || '';
  if (!seg || seg === 'dsh-plugin' || seg === 'plugin') return pkgName || fallbackId;
  return seg.replace(/^dsh-/, '');
}

const plugins = [];
for (const p of sources.plugins) {
  const meta = await ghMeta(p.repo);
  const m = manifest.packages?.[p.id] || {};

  // 读包内 peerDependencies，判断与当前 DSH 运行时是否兼容（DSH 会据此硬性拒绝加载）
  let peerRanges = {};
  let peerCompat = { ok: true, unmet: [] };
  if (m.status === 'ready' && m.file) {
    const tgz = path.join(PKG_DIR, m.file);
    try {
      const pkg = readPackageJsonFast(tgz);
      peerRanges = dshPeerRanges(pkg);
      peerCompat = checkCompat(pkg, DSH_VERSION);
    } catch {}
  }

  // 以实测为准：跑过安装矩阵就有明确结论，否则退回 peer 范围推断
  const tested = matrixById.get(p.id);
  const compat = tested
    ? { ok: tested.ok, source: 'install-matrix', detail: tested.detail, unmet: tested.ok ? [] : peerCompat.unmet }
    : { ok: peerCompat.ok, source: 'peer-ranges', detail: null, unmet: peerCompat.unmet };

  // 市场索引里按包名补充星标 / 下载量（早期上架的插件也能参与排名）
  const mk = marketByPkg.get(p.packageName);
  const mkStars = Number(mk?.metadata?.sortKeys?.stars || 0);
  const mkDownloads = Number(mk?.metadata?.sortKeys?.downloads || p.downloads || 0);

  plugins.push({
    id: p.id,
    title: cleanTitle(p.title, p.packageName, p.id),
    summary: p.summary,
    highlights: p.highlights || [],
    tags: p.tags || [],
    category: p.category,
    alsoIn: p.alsoIn || [],
    notes: p.notes || null,
    // 断网环境能不能直接跑起来（与「能不能装上」是两件事）
    offline: p.offline || { ready: true, reason: null },
    featured: !!p.featured,
    verified: !!p.verified,
    repo: p.repo,
    repoUrl: p.repoUrl || (p.repo ? meta.homepage || `https://github.com/${p.repo}` : ''),
    packageName: m.packageName || p.packageName,
    // 版本优先取实际镜像出的包
    version: m.version || null,
    sourceVersion: null,
    license: meta.license || '',
    stars: Math.max(meta.stars || 0, mkStars, Number(p.stars) || 0),
    downloads: mkDownloads,
    forks: meta.forks || 0,
    ghDescription: meta.description || '',
    pushedAt: meta.pushedAt || null,
    archived: !!meta.archived,
    compat: {
      ok: compat.ok,
      source: compat.source,
      detail: compat.detail,
      unmet: compat.unmet,
      peerRanges,
    },
    package: {
      status: m.status || 'missing',
      file: m.file || null,
      sizeBytes: m.sizeBytes || 0,
      size: fmtBytes(m.sizeBytes),
      sha256: m.sha256 || null,
      strategy: m.strategy || null,
      builtAt: m.builtAt || null,
      error: m.error || null,
    },
  });
}

// 默认排序：推荐优先，其次 star 数（页面里还能切换成按下载量）
plugins.sort((a, b) => {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  return b.stars - a.stars;
});

const out = {
  site: { ...sources.site, dshVersion: DSH_VERSION, platform: PLATFORM_LABEL },
  generatedAt: new Date().toISOString(),
  categories: sources.categories,
  stats: {
    total: plugins.length,
    ready: plugins.filter((p) => p.package.status === 'ready').length,
    failed: plugins.filter((p) => p.package.status === 'failed').length,
    incompatible: plugins.filter((p) => !p.compat.ok).length,
    needsWarmup: plugins.filter((p) => p.offline && p.offline.ready === false).length,
    totalSizeBytes: plugins.reduce((n, p) => n + (p.package.sizeBytes || 0), 0),
    totalDownloads: plugins.reduce((n, p) => n + (p.downloads || 0), 0),
  },
  plugins,
};

fs.mkdirSync(path.join(ROOT, 'web', 'data'), { recursive: true });
const catalogFile = path.join(ROOT, 'web', 'data', 'plugins.json');
fs.writeFileSync(`${catalogFile}.tmp`, JSON.stringify(out, null, 2));
fs.renameSync(`${catalogFile}.tmp`, catalogFile);
if (!OFFLINE) fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));

console.log(`catalog 已生成：${plugins.length} 个插件（已镜像 ${out.stats.ready}，需豁免 ${out.stats.incompatible}）${OFFLINE ? ' [离线模式]' : ''}`);
console.log(`-> web/data/plugins.json`);
process.exit(0);
