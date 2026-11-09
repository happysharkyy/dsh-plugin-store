import fs from 'node:fs';

const names = process.argv.slice(2);
let total = 0;
const rows = [];
for (const n of names) {
  try {
    const r = await fetch(`https://registry.npmjs.org/${n.replace('/', '%2f')}`);
    if (!r.ok) {
      rows.push([n, -1, 'not found']);
      continue;
    }
    const j = await r.json();
    const v = j['dist-tags']?.latest;
    const m = j.versions?.[v];
    const unpacked = m?.dist?.unpackedSize || 0;
    const tar = m?.dist?.tarball ? null : null;
    total += unpacked;
    rows.push([n, unpacked, v]);
  } catch (e) {
    rows.push([n, -1, e.message]);
  }
}
rows.sort((a, b) => b[1] - a[1]);
for (const [n, s, v] of rows) {
  console.log(`${(s / 1024 / 1024).toFixed(1).padStart(7)} MB  ${n.padEnd(46)} ${v}`);
}
console.log(`\n合计（npm 解包体积）: ${(total / 1024 / 1024).toFixed(0)} MB`);
console.log('提示：打包后含 node_modules，通常还要再乘 1.5~3 倍');
