#!/usr/bin/env node
/**
 * 把整个商店打成一个可拷贝的 tgz，用于跨过网络隔离。
 *
 *   node scripts/pack-for-intranet.mjs
 *
 * 产物：dist/dsh-plugin-store-<日期>.tgz
 * 内网侧解开即可 `./start.sh`，不需要任何联网步骤。
 *
 * 注意：这里用流式打包（packDirToFile），因为交付包动辄 1 GB 以上，
 * 一次性读进内存会直接打爆。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { packDirToFile } from './lib/tar.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const PREFIX = 'dsh-plugin-store';
const outFile = path.join(DIST, `${PREFIX}-${stamp}.tgz`);

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'plugins.json'), 'utf8'));

fs.mkdirSync(DIST, { recursive: true });
try { fs.rmSync(outFile, { force: true }); } catch {}

console.log('打包中（流式）…');
const paths = new Set();
const { entries, bytes } = await packDirToFile(ROOT, PREFIX, outFile, {
  excludeDirs: ['.mirror-work', 'node_modules', '.git', 'dist'],
  // 令牌与临时上传不进交付包：内网首次启动会自动生成新令牌
  excludeRel: ['.mirror.lock', 'data/admin-token.txt', 'data/uploads'],
  collectPaths: paths,
});

// 校验关键文件都在（只查路径集合，不回头解包几个 GB）
const required = [
  `${PREFIX}/start.sh`,
  `${PREFIX}/server.mjs`,
  `${PREFIX}/web/index.html`,
  `${PREFIX}/web/admin.html`,
  `${PREFIX}/web/data/plugins.json`,
  `${PREFIX}/runtime/node/bin/node`,
];
const missing = required.filter((r) => !paths.has(r));
if (!paths.has(`${PREFIX}/mirror/manifest-linux.json`) && !paths.has(`${PREFIX}/mirror/manifest.json`)) {
  missing.push('mirror/manifest*.json');
}

const packages = [...paths].filter((p) => /^dsh-plugin-store\/mirror\/packages[^/]*\/.+\.tgz$/.test(p));

// 流式算 sha256
const sha = await new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(outFile)
    .on('data', (c) => h.update(c))
    .on('end', () => resolve(h.digest('hex')))
    .on('error', reject);
});

console.log('');
console.log(`产物      ${path.relative(ROOT, outFile)}`);
console.log(`大小      ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`条目      ${entries}（其中插件包 ${packages.length} 个）`);
console.log(`平台      ${catalog.site?.platform || '未知'}`);
console.log(`插件      ${catalog.stats.total} 个，可直接装 ${catalog.stats.total - catalog.stats.incompatible}，需豁免 ${catalog.stats.incompatible}`);
console.log(`内置 Node ${fs.existsSync(path.join(ROOT, 'runtime/node/bin/node')) ? '有' : '无'}`);
console.log(`SHA-256   ${sha}`);
if (missing.length) {
  console.error(`\n缺少关键文件：${missing.join(', ')}`);
  process.exit(1);
}
console.log('');
console.log('内网侧：解包 → ./start.sh，全程无需联网。');
process.exit(0);
