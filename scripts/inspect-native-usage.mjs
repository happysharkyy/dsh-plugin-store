import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTarGz } from '../scripts/lib/tar.mjs';

const tgz = process.argv[2];
const buf = fs.readFileSync(tgz);
const entries = readTarGz(buf);

const natives = entries.filter((e) => e.path.endsWith('.node'));
console.log('原生模块:');
for (const n of natives) console.log('  ', n.path, (n.data.length / 1024 / 1024).toFixed(1) + 'MB');

// 找出引用这些 addon 的 JS 文件
const names = [...new Set(natives.map((n) => path.basename(n.path)))];
console.log('\n查找引用:', names.join(', '));

const jsEntries = entries.filter((e) => /\.(js|cjs|mjs)$/.test(e.path) && e.data.length < 2 * 1024 * 1024);
for (const name of names) {
  const stem = name.replace(/\.node$/, '');
  const hits = jsEntries.filter((e) => e.data.includes(stem));
  console.log(`\n--- ${name} 被 ${hits.length} 个文件引用`);
  for (const h of hits.slice(0, 2)) {
    const text = h.data.toString('utf8');
    const idx = text.indexOf(stem);
    const start = Math.max(0, idx - 400);
    console.log(`  ${h.path}`);
    console.log(text.slice(start, idx + 200).split('\n').map((l) => '    ' + l).join('\n'));
  }
}
