/**
 * 从插件包里剔除指定路径的原生模块，并更新 manifest 里的体积与 sha256
 *
 *   node scripts/trim-native.mjs --manifest=mirror/manifest-linux.json \
 *        --dir=mirror/packages-linux \
 *        --only=easyssh,ssh-exec,cloud-workspaces \
 *        --match=sshcrypto.node
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readTarGz, createTarGz } from './lib/tar.mjs';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const MANIFEST = arg('manifest', 'mirror/manifest-linux.json');
const DIR = arg('dir', 'mirror/packages-linux');
const ONLY = new Set(arg('only', '').split(',').filter(Boolean));
// 支持多个匹配片段，逗号分隔
const MATCHES = arg('match', '').split(',').map((s) => s.trim()).filter(Boolean);
if (!MATCHES.length) {
  console.error('需要 --match=<文件名片段>[,片段2]');
  process.exit(1);
}
const matched = (p) => MATCHES.some((m) => p.includes(m));

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

for (const [id, entry] of Object.entries(manifest.packages)) {
  if (entry.status !== 'ready') continue;
  if (ONLY.size && !ONLY.has(id)) continue;

  const file = path.join(DIR, entry.file);
  if (!fs.existsSync(file)) {
    console.log(`skip ${id}: 文件不存在`);
    continue;
  }

  const entries = readTarGz(fs.readFileSync(file));
  const before = entries.length;
  const drop = entries.filter((e) => e.type === 'file' && matched(e.path));
  if (!drop.length) {
    console.log(`${id}: 没有匹配的文件，跳过`);
    continue;
  }

  const kept = entries.filter((e) => !(e.type === 'file' && matched(e.path)));
  const rebuilt = createTarGz(kept);
  fs.writeFileSync(file, rebuilt);

  entry.sizeBytes = rebuilt.length;
  entry.sha256 = crypto.createHash('sha256').update(rebuilt).digest('hex');
  entry.trimmed = [...new Set(drop.map((d) => path.basename(d.path)))];
  entry.trimReason = '这些原生模块要求 glibc > 2.17，在 CentOS 7 上无法加载；已由纯 JS 实现兜底';

  console.log(
    `${id.padEnd(18)} 移除 ${drop.length} 个文件（${before} -> ${kept.length}）  ` +
      `${(rebuilt.length / 1024 / 1024).toFixed(1)} MB  sha256=${entry.sha256.slice(0, 12)}…`
  );
}

fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
console.log('\nmanifest 已更新');
