/**
 * 商店目录存储层
 *
 *   - 基础目录：web/data/plugins.json（scripts/build-catalog.mjs 生成，随工程分发）
 *   - 后台目录：data/admin/plugins.json（管理员在 /admin 上传的插件，运行期合并）
 *
 * 两者在 /api/plugins 里合并输出，所以后台加插件不需要重跑构建。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readTarGz } from '../scripts/lib/tar.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASE_CATALOG = path.join(ROOT, 'web', 'data', 'plugins.json');
export const IMPORT_DIR = path.join(ROOT, 'data', 'mirror');
export const IMPORT_CATALOG = path.join(IMPORT_DIR, 'plugins.json');
export const MIRROR_PKG = path.join(ROOT, 'mirror', 'packages');
export const ADMIN_DIR = path.join(ROOT, 'data', 'admin');
export const ADMIN_PKG = path.join(ADMIN_DIR, 'packages');
export const ADMIN_INDEX = path.join(ADMIN_DIR, 'plugins.json');
export const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
export const TOKEN_FILE = path.join(ROOT, 'data', 'admin-token.txt');

const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GB

/* ------------------------------------------------------------------ */
/* 管理员令牌                                                           */
/* ------------------------------------------------------------------ */

export function readAdminToken() {
  if (process.env.DSH_STORE_ADMIN_TOKEN) return process.env.DSH_STORE_ADMIN_TOKEN;
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  if (fs.existsSync(TOKEN_FILE)) {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

export function checkAdmin(token) {
  if (!token) return false;
  const expected = readAdminToken();
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* 目录读取与合并                                                       */
/* ------------------------------------------------------------------ */

export function loadBaseCatalog() {
  try {
    const file = fs.existsSync(IMPORT_CATALOG) ? IMPORT_CATALOG : BASE_CATALOG;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function loadAdmin() {
  try {
    const j = JSON.parse(fs.readFileSync(ADMIN_INDEX, 'utf8'));
    if (!Array.isArray(j.plugins)) j.plugins = [];
    return j;
  } catch {
    return { generatedAt: null, plugins: [] };
  }
}

export function saveAdmin(admin) {
  fs.mkdirSync(ADMIN_DIR, { recursive: true });
  admin.generatedAt = new Date().toISOString();
  const temporary = `${ADMIN_INDEX}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(admin, null, 2));
  fs.renameSync(temporary, ADMIN_INDEX);
}

function fmtBytes(n) {
  if (!n) return null;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 把后台条目转成和基础目录同构的形状 */
function normalizeAdminPlugin(p) {
  return {
    id: p.id,
    title: p.title,
    summary: p.summary || '',
    highlights: p.highlights || [],
    tags: p.tags || [],
    category: p.category || 'docs',
    alsoIn: p.alsoIn || [],
    notes: p.notes || null,
    offline: p.offline || { ready: true, reason: null },
    featured: !!p.featured,
    verified: true,
    source: 'admin',
    repo: p.repo || '',
    repoUrl: p.repoUrl || '',
    packageName: p.packageName,
    version: p.version,
    license: p.license || '',
    stars: Number(p.stars) || 0,
    forks: 0,
    ghDescription: p.description || '',
    pushedAt: p.updatedAt || null,
    archived: false,
    compat: p.compat || { ok: true, source: 'admin', detail: null, unmet: [], peerRanges: {} },
    package: {
      status: 'ready',
      file: p.file,
      sizeBytes: p.sizeBytes || 0,
      size: fmtBytes(p.sizeBytes),
      sha256: p.sha256 || null,
      strategy: 'upload',
      builtAt: p.uploadedAt || null,
      error: null,
    },
  };
}

/** 计算统计（基于最终合并列表） */
function computeStats(plugins) {
  return {
    total: plugins.length,
    ready: plugins.filter((p) => p.package.status === 'ready').length,
    failed: plugins.filter((p) => p.package.status === 'failed').length,
    incompatible: plugins.filter((p) => p.compat && p.compat.ok === false).length,
    needsWarmup: plugins.filter((p) => p.offline && p.offline.ready === false).length,
    totalSizeBytes: plugins.reduce((n, p) => n + (p.package.sizeBytes || 0), 0),
  };
}

export function mergedCatalog(baseUrl = '') {
  const base = loadBaseCatalog() || {
    site: { name: 'DSH 内网插件商店', shortName: 'DSH Store', version: 1 },
    categories: [
      { id: 'docs', name: '文档处理', desc: 'Word / Excel / PDF 解析与生成' },
      { id: 'ssh', name: 'SSH 远程', desc: '远程主机、跳板、SFTP' },
      { id: 'ppt', name: 'PPT 制作', desc: '可编辑 PPTX 与 HTML 幻灯片' },
    ],
    plugins: [],
  };
  const admin = loadAdmin();
  const adminPlugins = admin.plugins.map(normalizeAdminPlugin);

  // 后台条目优先覆盖同 id
  const byId = new Map();
  for (const p of base.plugins) byId.set(p.id, p);
  for (const p of adminPlugins) byId.set(p.id, p);

  const plugins = [...byId.values()].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return (b.stars || 0) - (a.stars || 0);
  });

  return {
    site: { ...base.site, platform: base.site?.platform || process.platform + '-' + process.arch },
    categories: base.categories,
    generatedAt: base.generatedAt || null,
    stats: computeStats(plugins),
    plugins,
    baseUrl,
  };
}

/* ------------------------------------------------------------------ */
/* 包校验                                                              */
/* ------------------------------------------------------------------ */

const NATIVE_RE = /\.node$/;

/**
 * 检查一个上传的 tgz 是否适合放进离线商店。
 * 返回 { ok, errors[], warnings[], pkg, entries, sha256, sizeBytes, platformTaint }
 */
export function inspectPackage(buf, targetPlatform = `${process.platform}-${process.arch}`) {
  const errors = [];
  const warnings = [];

  if (!buf || buf.length < 512) {
    return { ok: false, errors: ['文件太小，不是有效的 tgz'], warnings, pkg: null };
  }
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
    return { ok: false, errors: ['不是 gzip 包（.tgz），请上传打包器产出的文件'], warnings, pkg: null };
  }
  if (buf.length > MAX_UPLOAD) {
    return { ok: false, errors: [`文件超过 ${MAX_UPLOAD / 1024 / 1024} MB 上限`], warnings, pkg: null };
  }

  let entries;
  try {
    entries = readTarGz(buf);
  } catch (e) {
    return { ok: false, errors: [`解包失败：${e.message}`], warnings, pkg: null };
  }

  const pkgEntry = entries.find((e) => e.path === 'package/package.json');
  if (!pkgEntry) {
    return { ok: false, errors: ['包内缺少 package/package.json（是否没带 package/ 前缀？）'], warnings, pkg: null };
  }

  let pkg;
  try {
    pkg = JSON.parse(pkgEntry.data.toString('utf8'));
  } catch {
    return { ok: false, errors: ['package.json 不是合法 JSON（可能被安全软件改写）'], warnings, pkg: null };
  }

  // DSH 插件身份：必须声明 dsh.bundle.patch（字符串或数组），且补丁文件真的在包里
  const rawPatch = pkg.dsh?.bundle?.patch;
  const patchList = (Array.isArray(rawPatch) ? rawPatch : rawPatch ? [rawPatch] : []).map((s) =>
    String(s).replace(/^\.\//, '')
  );
  if (!patchList.length) {
    errors.push('package.json 没有声明 dsh.bundle.patch，DSH 不会把它当作插件加载');
  } else {
    for (const rel of patchList) {
      if (!entries.some((e) => e.path === `package/${rel}`)) errors.push(`补丁文件 ${rel} 不在包内`);
    }
  }

  // 离线可装性：依赖必须已物化
  const depCount = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.optionalDependencies || {}).length;
  if (depCount) {
    errors.push(`包内仍声明了 ${depCount} 个需要解析的依赖；请用 scripts/mirror.mjs 打包`);
  }

  // 平台相关产物检查
  const natives = entries.filter((e) => NATIVE_RE.test(e.path));
  const winMarked = entries.filter((e) => /win32|msvc|\.dll$/i.test(e.path));
  const linuxMarked = entries.filter((e) => /linux-x64|linux-arm64|\.so$/i.test(e.path));
  let platformTaint = null;
  if (targetPlatform.startsWith('linux')) {
    if (winMarked.length > natives.length) {
      platformTaint = `包含 ${winMarked.length} 个 Windows 平台相关文件，在 Linux 上大概率跑不起来`;
      warnings.push(platformTaint);
    }
  } else if (targetPlatform.startsWith('win32')) {
    if (linuxMarked.length > natives.length) {
      platformTaint = `包含 ${linuxMarked.length} 个 Linux 平台相关文件，在 Windows 上大概率跑不起来`;
      warnings.push(platformTaint);
    }
  }

  // peer 依赖提示（是否会被 DSH 版本门槛拦下，需要管理员自己判断）
  const dshPeers = Object.entries(pkg.peerDependencies || {}).filter(([n]) => n.startsWith('@deepseek-ai/dsh-'));
  if (dshPeers.length) {
    warnings.push(`声明了 ${dshPeers.length} 个 @deepseek-ai/dsh-* 依赖，若与目标 DSH 版本不匹配会被拒绝加载`);
  }

  if (!pkg.name || !pkg.version) errors.push('package.json 缺少 name 或 version');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    pkg: {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description || '',
      license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || '',
      peerDependencies: pkg.peerDependencies || {},
      entryCount: entries.length,
    },
    entries: entries.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    sizeBytes: buf.length,
    platformTaint,
  };
}

/* ------------------------------------------------------------------ */
/* 上传暂存                                                            */
/* ------------------------------------------------------------------ */

export function saveUpload(buf, fileName) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const uploadId = crypto.randomBytes(8).toString('hex');
  const safe = String(fileName || 'package.tgz').replace(/[^\w.\-]+/g, '_').slice(-80);
  const file = path.join(UPLOAD_DIR, `${uploadId}__${safe}`);
  fs.writeFileSync(file, buf);
  return { uploadId, file };
}

export function findUpload(uploadId) {
  if (!/^[0-9a-f]{16}$/.test(String(uploadId || ''))) return null;
  try {
    const f = fs.readdirSync(UPLOAD_DIR).find((n) => n.startsWith(`${uploadId}__`));
    return f ? path.join(UPLOAD_DIR, f) : null;
  } catch {
    return null;
  }
}

export function readUpload(uploadId) {
  const f = findUpload(uploadId);
  return f && fs.existsSync(f) ? fs.readFileSync(f) : null;
}

export function publishUpload(uploadId, meta) {
  const src = findUpload(uploadId);
  if (!src) throw new Error('上传记录已失效，请重新上传');
  const buf = fs.readFileSync(src);
  const insp = inspectPackage(buf);
  if (!insp.ok) throw new Error(insp.errors.join('；'));

  fs.mkdirSync(ADMIN_PKG, { recursive: true });
  const version = String(insp.pkg.version).replace(/[^\w.\-]/g, '_');
  const slug = String(meta.id || insp.pkg.name).replace(/^@/, '').replace(/[\/\\]/g, '-').replace(/[^\w.\-]/g, '-');
  const fileName = `${slug}-${version}.tgz`;
  const dest = path.join(ADMIN_PKG, fileName);
  fs.writeFileSync(dest, buf);
  try { fs.unlinkSync(src); } catch {}

  const admin = loadAdmin();
  const entry = {
    id: slug,
    title: meta.title || insp.pkg.name,
    summary: meta.summary || insp.pkg.description || '',
    highlights: meta.highlights || [],
    tags: meta.tags || [],
    category: meta.category || 'docs',
    alsoIn: meta.alsoIn || [],
    notes: meta.notes || null,
    offline: meta.offline || { ready: true, reason: null },
    featured: !!meta.featured,
    repo: meta.repo || '',
    repoUrl: meta.repoUrl || '',
    packageName: insp.pkg.name,
    version: insp.pkg.version,
    license: insp.pkg.license,
    sizeBytes: insp.sizeBytes,
    sha256: insp.sha256,
    file: fileName,
    uploadedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    compat: meta.compat || { ok: true, source: 'admin', detail: null, unmet: [], peerRanges: {} },
  };

  const idx = admin.plugins.findIndex((p) => p.id === slug);
  if (idx >= 0) {
    const old = admin.plugins[idx];
    if (old.file && old.file !== fileName) {
      try { fs.unlinkSync(path.join(ADMIN_PKG, old.file)); } catch {}
    }
    admin.plugins[idx] = entry;
  } else {
    admin.plugins.push(entry);
  }
  saveAdmin(admin);
  return entry;
}

export function updateAdminPlugin(id, patch) {
  const admin = loadAdmin();
  const idx = admin.plugins.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const allowed = ['title', 'summary', 'highlights', 'tags', 'category', 'alsoIn', 'notes', 'offline', 'featured'];
  for (const k of allowed) {
    if (patch[k] !== undefined) admin.plugins[idx][k] = patch[k];
  }
  admin.plugins[idx].updatedAt = new Date().toISOString();
  saveAdmin(admin);
  return admin.plugins[idx];
}

export function removeAdminPlugin(id) {
  const admin = loadAdmin();
  const idx = admin.plugins.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  const [removed] = admin.plugins.splice(idx, 1);
  if (removed.file) {
    try { fs.unlinkSync(path.join(ADMIN_PKG, removed.file)); } catch {}
  }
  saveAdmin(admin);
  return true;
}

/** /packages/<file> 的物理路径：先后台，再按平台目录，最后回落到默认镜像目录 */
export function resolvePackageFile(name) {
  const clean = String(name || '');
  if (!clean || clean.includes('/') || clean.includes('\\') || clean.includes('..')) return null;

  const dirs = [ADMIN_PKG];
  try {
    for (const d of fs.readdirSync(path.join(ROOT, 'mirror'))) {
      if (d.startsWith('packages')) dirs.push(path.join(ROOT, 'mirror', d));
    }
  } catch {}
  dirs.push(MIRROR_PKG);

  for (const dir of dirs) {
    const f = path.join(dir, clean);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function importedPackage(sha256) {
  return typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256)
    ? path.join(IMPORT_DIR, 'packages', `${sha256}.tgz`)
    : null;
}

export function resolveCatalogPackage(plugin, platform, { imported = true } = {}) {
  const name = plugin.package.file;
  if (typeof name !== 'string' || !/^[\w.-]+\.tgz$/.test(name) || name.includes('..')) return null;
  const os = String(platform || '').split('-')[0];
  const candidates = plugin.source === 'admin'
    ? [path.join(ADMIN_PKG, name)]
    : [
        imported ? importedPackage(plugin.package.sha256) : null,
        /^[a-z0-9]+$/.test(os) ? path.join(ROOT, 'mirror', `packages-${os}`, name) : null,
        path.join(MIRROR_PKG, name),
      ];
  return candidates.find((file) => file && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) || null;
}
