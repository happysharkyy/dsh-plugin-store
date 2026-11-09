#!/usr/bin/env node
/**
 * 安装矩阵验收：把商店里的每个包，通过 HTTP 地址装进一个全新的 DSH profile，
 * 记录 DSH 是否接受（能装 + 能登记到 profile.bundles）。
 *
 *   node scripts/install-matrix.mjs [--port=8792] [--only=id1,id2]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const PORT = arg('port', '8792');
const ONLY = arg('only', '') ? new Set(arg('only', '').split(',')) : null;
const DSH = process.env.DSH_BIN || 'dsh';

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'plugins.json'), 'utf8'));
const origin = `http://127.0.0.1:${PORT}`;

const results = [];
for (const p of catalog.plugins) {
  if (p.package.status !== 'ready') {
    results.push({ id: p.id, ok: false, reason: '未镜像' });
    continue;
  }
  if (ONLY && !ONLY.has(p.id)) continue;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dshstore-${p.id}-`));
  const url = `${origin}/packages/${p.package.file}`;
  const started = Date.now();
  let ok = false;
  let detail = '';

  try {
    execFileSync(DSH, ['plugin', '--profile', 'web', 'add', url], {
      stdio: 'pipe',
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, DSH_HOME: home },
      timeout: 10 * 60 * 1000,
    });
    const prof = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'web', 'package.json'), 'utf8'));
    const bundles = prof.dsh?.profile?.bundles || [];
    const registered = bundles.includes(p.packageName) || bundles.some((b) => b === p.packageName);
    ok = registered;
    detail = registered ? `bundles +${p.packageName}` : '已安装但未登记为 profile 层';
  } catch (e) {
    const err = `${e.stderr || ''}${e.stdout || ''}` || e.message;
    detail = err
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-2)
      .join(' ')
      .slice(0, 200);
  } finally {
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 临时目录删不干净不影响结论（pnpm 有时会短暂占用句柄）
    }
  }

  results.push({ id: p.id, ok, ms: Date.now() - started, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${p.id.padEnd(20)} ${String(((Date.now() - started) / 1000).toFixed(0)).padStart(4)}s  ${detail}`);
}

const okCount = results.filter((r) => r.ok).length;
console.log(`\n安装矩阵：${okCount}/${results.length} 通过`);

// 与已有结果合并，支持分批跑（--only）
const outFile = path.join(ROOT, 'mirror', 'install-matrix.json');
let merged = { checkedAt: null, dshVersion: null, results: [] };
if (fs.existsSync(outFile)) {
  try { merged = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
}
const byId = new Map((merged.results || []).map((r) => [r.id, r]));
for (const r of results) byId.set(r.id, r);
fs.writeFileSync(outFile, JSON.stringify({
  checkedAt: new Date().toISOString(),
  port: PORT,
  results: [...byId.values()],
}, null, 2));
