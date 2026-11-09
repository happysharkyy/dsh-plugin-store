#!/usr/bin/env node
/**
 * 管理后台端到端自测：令牌鉴权 → 上传校验 → 发布 → 商店可见 → 可下载 → 编辑 → 下架
 *
 *   node scripts/test-admin.mjs --port=8801 --pkg=mirror/packages/deck-builder-0.1.0.tgz
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const PORT = arg('port', '8801');
const PKG = arg('pkg', 'mirror/packages/deck-builder-0.1.0.tgz');
// 被测服务所在的工程根（默认就是本脚本所在工程）
const SERVER_ROOT = path.resolve(arg('root', ROOT));
const BASE = `http://127.0.0.1:${PORT}`;

const tokenFile = path.join(SERVER_ROOT, 'data', 'admin-token.txt');
const token = fs.readFileSync(tokenFile, 'utf8').trim();
console.log(`目标 ${BASE}  服务根 ${SERVER_ROOT}`);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? ' OK ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const file = path.join(ROOT, PKG);
const buf = fs.readFileSync(file);

// 1. 无令牌被拒
let r = await fetch(`${BASE}/api/admin/session`);
check('无令牌访问被拒绝', r.status === 401, `HTTP ${r.status}`);

// 2. 有令牌通过
r = await fetch(`${BASE}/api/admin/session`, { headers: { 'x-admin-token': token } });
const sess = await r.json();
check('令牌校验通过', r.ok, `platform=${sess.platform}`);

// 3. 上传校验
r = await fetch(`${BASE}/api/admin/upload`, {
  method: 'POST',
  headers: { 'x-admin-token': token, 'x-filename': path.basename(file) },
  body: buf,
});
const insp = await r.json();
check('上传并解析 tgz', r.ok, `${insp.pkg?.name}@${insp.pkg?.version} entries=${insp.entries}`);
check('校验给出警告/错误字段', Array.isArray(insp.warnings) && Array.isArray(insp.errors));

// 4. 发布
r = await fetch(`${BASE}/api/admin/plugins`, {
  method: 'POST',
  headers: { 'x-admin-token': token, 'content-type': 'application/json' },
  body: JSON.stringify({
    uploadId: insp.uploadId,
    id: 'self-test-plugin',
    title: '自测插件',
    summary: '管理后台自测条目',
    category: 'ppt',
    tags: ['自测'],
    highlights: ['由 test-admin.mjs 创建'],
    featured: false,
  }),
});
const pub = await r.json();
check('发布上架', r.status === 201, pub.plugin?.file || JSON.stringify(pub).slice(0, 80));

// 5. 商店里可见
r = await fetch(`${BASE}/api/plugins`);
const catalog = await r.json();
const found = catalog.plugins.find((p) => p.id === 'self-test-plugin');
check('出现在商店目录', !!found, found ? `${found.packageName}@${found.version}` : '');
check('计入统计总数', catalog.stats.total === (catalog.plugins?.length || 0));

// 6. 包可下载
if (found) {
  r = await fetch(`${BASE}/packages/${found.package.file}`);
  const dl = Buffer.from(await r.arrayBuffer());
  check('包可下载且字节一致', r.ok && dl.length === buf.length && Buffer.compare(dl, buf) === 0, `${dl.length} bytes`);
  check('下载头为附件', (r.headers.get('content-disposition') || '').includes('attachment'));
}

// 7. 编辑
r = await fetch(`${BASE}/api/admin/plugins/self-test-plugin`, {
  method: 'PATCH',
  headers: { 'x-admin-token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ title: '自测插件（已改名）' }),
});
const patched = await r.json();
check('编辑元数据', r.ok && patched.plugin?.title === '自测插件（已改名）');

r = await fetch(`${BASE}/api/plugins`);
const c2 = await r.json();
check('编辑后商店同步', c2.plugins.find((p) => p.id === 'self-test-plugin')?.title === '自测插件（已改名）');

// 8. 下架
r = await fetch(`${BASE}/api/admin/plugins/self-test-plugin`, {
  method: 'DELETE',
  headers: { 'x-admin-token': token },
});
check('下架', r.ok);

r = await fetch(`${BASE}/api/plugins`);
const c3 = await r.json();
check('下架后从商店消失', !c3.plugins.find((p) => p.id === 'self-test-plugin'));

// 9. 拒绝坏包
r = await fetch(`${BASE}/api/admin/upload`, {
  method: 'POST',
  headers: { 'x-admin-token': token, 'x-filename': 'bad.tgz' },
  body: Buffer.from('这不是一个 tar.gz 文件'),
});
check('坏文件被拒绝', r.status === 400);

console.log(`\n管理后台自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
