#!/usr/bin/env node
/**
 * DSH 内网插件商店 —— 零依赖 Node 服务（Linux / Windows 通用）
 *
 *   GET  /                      商店首页
 *   GET  /admin                 管理后台（上传 / 编辑 / 下架插件）
 *   GET  /api/plugins           合并后的插件目录（基础目录 + 后台添加）
 *   GET  /api/stats             统计
 *   GET  /api/health            健康检查
 *   GET  /dsh/index.json        DSH 原生插件索引
 *   GET  /npm/…                 只读 npm 元数据及安装包
 *   GET  /packages/<file>.tgz   安装包
 *   GET  /install/<id>.sh|.ps1  一句话安装脚本
 *
 *   POST   /api/admin/upload            上传 tgz（原始 body）→ 校验结果
 *   GET    /api/admin/plugins           后台列表
 *   POST   /api/admin/plugins           发布（引用 uploadId + 元数据）
 *   PATCH  /api/admin/plugins/<id>      编辑元数据
 *   DELETE /api/admin/plugins/<id>      下架
 *   GET    /api/admin/session           校验令牌
 *
 * 环境变量：
 *   PORT               监听端口（默认 8787）
 *   HOST               监听地址（默认 0.0.0.0）
 *   DSH_STORE_ADMIN_TOKEN  后台令牌（不设则自动生成到 data/admin-token.txt）
 *   DSH_STORE_PLATFORM 覆盖展示的平台标识（默认 当前平台）
 *   DSH_STORE_PUBLIC_URL 反向代理的外部源站地址
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  mergedCatalog,
  readAdminToken,
  checkAdmin,
  inspectPackage,
  saveUpload,
  readUpload,
  publishUpload,
  updateAdminPlugin,
  removeAdminPlugin,
  loadAdmin,
  resolveCatalogPackage,
  resolvePackageFile,
} from './lib/store.mjs';
import { marketCatalog, marketIndex, packument } from './lib/market.mjs';

const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PLATFORM = process.env.DSH_STORE_PLATFORM || `${process.platform}-${process.arch}`;
const MAX_UPLOAD = 512 * 1024 * 1024;
const PUBLIC_URL = process.env.DSH_STORE_PUBLIC_URL && new URL(process.env.DSH_STORE_PUBLIC_URL);
if (PUBLIC_URL && (!['http:', 'https:'].includes(PUBLIC_URL.protocol) || PUBLIC_URL.username
  || PUBLIC_URL.password || PUBLIC_URL.pathname !== '/' || PUBLIC_URL.search || PUBLIC_URL.hash)) {
  throw new Error('DSH_STORE_PUBLIC_URL 必须是内网 HTTP(S) 源站地址，不含路径、凭据、查询或片段');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.tgz': 'application/gzip',
  '.gz': 'application/gzip',
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

const sendJson = (res, obj, status = 200) =>
  send(res, status, JSON.stringify(obj, null, 2), { 'content-type': 'application/json; charset=utf-8' });

function serveFile(res, req, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ext === '.tgz' ? 'public, max-age=300' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body 过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJsonBody(req, limit) {
  return readBody(req, limit).then((buf) => {
    if (!buf.length) return {};
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 });
    }
  });
}

const authOf = (req, url) => req.headers['x-admin-token'] || url.searchParams.get('token') || '';

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname;
  try {
    const url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);

    res.on('finish', () => {
      console.log(`${String(res.statusCode).padEnd(4)} ${req.method.padEnd(6)} ${pathname} ${Date.now() - started}ms`);
    });

    /* ---------------- 管理 API ---------------- */

    if (pathname.startsWith('/api/admin/')) {
      if (!checkAdmin(authOf(req, url))) {
        return sendJson(res, { error: '令牌无效' }, 401);
      }

      if (pathname === '/api/admin/session' && req.method === 'GET') {
        // 平台以目录里记录的为准（包是按那个平台打的）
        const cat = mergedCatalog();
        return sendJson(res, { ok: true, platform: cat.site?.platform || PLATFORM, processPlatform: PLATFORM });
      }

      if (pathname === '/api/admin/plugins' && req.method === 'GET') {
        return sendJson(res, loadAdmin());
      }

      if (pathname === '/api/admin/upload' && req.method === 'POST') {
        const buf = await readBody(req, MAX_UPLOAD);
        const fileName = req.headers['x-filename'] || 'package.tgz';
        const insp = inspectPackage(buf, PLATFORM);
        if (!insp.ok) return sendJson(res, { ok: false, ...insp }, 400);
        const { uploadId } = saveUpload(buf, String(fileName));
        return sendJson(res, { ok: true, uploadId, ...insp });
      }

      if (pathname === '/api/admin/plugins' && req.method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024);
        if (!body.uploadId) return sendJson(res, { error: '缺少 uploadId' }, 400);
        const entry = publishUpload(body.uploadId, body);
        return sendJson(res, { ok: true, plugin: entry }, 201);
      }

      const m = /^\/api\/admin\/plugins\/([^/]+)$/.exec(pathname);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const body = await readJsonBody(req, 256 * 1024);
          const updated = updateAdminPlugin(id, body);
          if (!updated) return sendJson(res, { error: '没有这个插件' }, 404);
          return sendJson(res, { ok: true, plugin: updated });
        }
        if (req.method === 'DELETE') {
          const ok = removeAdminPlugin(id);
          return sendJson(res, ok ? { ok: true } : { error: '没有这个插件' }, ok ? 200 : 404);
        }
      }

      return sendJson(res, { error: '未知的管理接口' }, 404);
    }

    /* ---------------- 公共 API ---------------- */

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { 'content-type': 'text/plain; charset=utf-8' });
    }

    const origin = PUBLIC_URL?.origin || new URL(`http://${req.headers.host || 'localhost'}`).origin;
    const registry = `${origin}/npm/`;
    if (pathname === '/dsh/index.json') {
      return sendJson(res, marketIndex(marketCatalog(), registry));
    }
    if (pathname.startsWith('/npm/')) {
      const { packages } = marketCatalog();
      const target = pathname.slice('/npm/'.length);
      const tarball = /^-\/(.+)\/([^/]+)\.tgz$/.exec(target);
      if (tarball) {
        const entry = packages.get(tarball[1])?.get(tarball[2]);
        if (entry) return serveFile(res, req, entry.file);
      } else if (packages.has(target)) {
        return sendJson(res, await packument(target, packages.get(target), registry));
      }
      return sendJson(res, { error: 'Not found' }, 404);
    }

    if (pathname === '/api/plugins') {
      const catalog = mergedCatalog(origin);
      if (!catalog.plugins.length) {
        return sendJson(res, { error: '目录为空。请先运行 node scripts/build-catalog.mjs，或在 /admin 上传插件' }, 503);
      }
      // 平台以目录里记录的为准（包是按那个平台打的），而不是服务进程自身平台
      return sendJson(res, { ...catalog, origin, platform: catalog.site?.platform || PLATFORM });
    }

    if (pathname === '/api/stats') {
      const catalog = mergedCatalog();
      return sendJson(res, {
        ...catalog.stats,
        platform: catalog.site?.platform || PLATFORM,
        adminCount: (loadAdmin().plugins || []).length,
      });
    }

    if (pathname === '/api/health') {
      return sendJson(res, { ok: true, uptime: Math.round(process.uptime()), platform: PLATFORM });
    }

    /* ---------------- 安装包 ---------------- */

    if (pathname.startsWith('/packages/')) {
      const name = pathname.slice('/packages/'.length);
      const catalog = mergedCatalog();
      const plugin = catalog.plugins.find((entry) => entry.package.file === name && entry.package.status === 'ready');
      const file = plugin ? resolveCatalogPackage(plugin, catalog.site.platform) : resolvePackageFile(name);
      if (!file) return send(res, 404, 'package not found', { 'content-type': 'text/plain; charset=utf-8' });
      res.setHeader('content-disposition', `attachment; filename="${path.basename(file)}"`);
      return serveFile(res, req, file);
    }

    /* ---------------- 一句话安装脚本 ---------------- */

    const inst = /^\/install\/([^/]+)\.(sh|ps1)$/.exec(pathname);
    if (inst) {
      const id = decodeURIComponent(inst[1]);
      const catalog = mergedCatalog();
      const plugin = catalog.plugins.find((p) => p.id === id);
      const type = inst[2];
      if (!plugin) return send(res, 404, '# 未知插件 id', { 'content-type': 'text/plain; charset=utf-8' });
      if (plugin.package.status !== 'ready') return send(res, 409, '# 该插件尚未镜像完成', { 'content-type': 'text/plain; charset=utf-8' });

      const pkgUrl = `${origin}/packages/${plugin.package.file}`;
      const lines = type === 'sh'
        ? [
            '#!/usr/bin/env bash',
            `# 安装 ${plugin.title} (${plugin.packageName}@${plugin.version})`,
            '# 由 DSH 内网插件商店生成',
            'set -euo pipefail',
            `SPEC="${pkgUrl}"`,
            'dsh plugin --profile web add "$SPEC"',
          ]
        : [
            `# 安装 ${plugin.title} (${plugin.packageName}@${plugin.version})`,
            '# 由 DSH 内网插件商店生成',
            `$ErrorActionPreference = 'Stop'`,
            `$spec = '${pkgUrl}'`,
            'dsh plugin --profile web add $spec',
          ];
      return send(res, 200, lines.join('\n'), { 'content-type': 'text/plain; charset=utf-8' });
    }

    /* ---------------- 页面 / 静态资源 ---------------- */

    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, req, path.join(WEB, 'index.html'));
    }
    if (pathname === '/admin' || pathname === '/admin/') {
      return serveFile(res, req, path.join(WEB, 'admin.html'));
    }

    const safe = pathname.replace(/^\/+/, '');
    if (safe.includes('..')) return send(res, 400, 'bad request');

    const candidates = [path.join(WEB, safe)];
    if (!pathname.startsWith('/data/')) candidates.push(path.join(WEB, 'data', safe));
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return serveFile(res, req, c);
    }

    send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
  } catch (err) {
    const code = err?.statusCode || (err instanceof URIError ? 400 : 500);
    console.error(`ERROR ${pathname}:`, err?.message || err);
    if (!res.headersSent) sendJson(res, { error: err?.message || '内部错误' }, code);
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const catalog = mergedCatalog();
  const token = readAdminToken();
  console.log('');
  console.log('  DSH 内网插件商店');
  console.log(`  监听    http://${HOST}:${PORT}`);
  console.log(`  平台    ${PLATFORM}`);
  console.log(`  目录    ${catalog.stats.total} 个插件（后台 ${loadAdmin().plugins.length} 个），${catalog.stats.ready} 个已就绪`);
  console.log(`  索引    ${PUBLIC_URL?.origin || `http://<商店地址>:${PORT}`}/dsh/index.json`);
  console.log(`  后台    http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/admin`);
  console.log(`  令牌    ${token.slice(0, 8)}…（完整值见 data/admin-token.txt）`);
  console.log('');
});
