import fs from 'node:fs';

const res = await fetch('https://dshmarket.2020713.xyz/index.json');
const j = await res.json();
const plugins = j.plugins || [];
fs.writeFileSync('C:\\Windows\\Temp\\market-index.json', JSON.stringify(j));

const popularity = (p) => {
  const s = p.metadata?.sortKeys || {};
  return Number(s.stars || 0) * 1000 + Number(s.downloads || 0);
};

// 分类汇总
const byCat = new Map();
for (const p of plugins) {
  const c = p.metadata?.category || 'unknown';
  if (!byCat.has(c)) byCat.set(c, []);
  byCat.get(c).push(p);
}
console.log('分类（按条目数）:');
for (const [c, list] of [...byCat].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${c.padEnd(16)} ${String(list.length).padStart(3)} 个`);
}

console.log('\n每个分类的热门前二（按 stars*1000+downloads）:');
for (const [c, list] of [...byCat].sort((a, b) => b[1].length - a[1].length)) {
  const top = [...list].sort((a, b) => popularity(b) - popularity(a)).slice(0, 2);
  console.log(`\n[${c}]`);
  for (const p of top) {
    const s = p.metadata?.sortKeys || {};
    const ver = p.versions?.[0];
    console.log(
      `  ${p.name.padEnd(38)} ★${String(s.stars || 0).padStart(5)} ↓${String(s.downloads || 0).padStart(6)}  ` +
        `${ver?.version || '?'}  src=${ver?.source?.type || '?'}  labels=${(p.metadata?.labels || []).join(',')}`
    );
    console.log(`      ${(p.title?.zh || p.title?.en || '').slice(0, 60)}`);
    console.log(`      ${(p.description?.zh || '').slice(0, 90)}`);
  }
}

// 用户点名的插件
console.log('\n=== 用户点名的插件 ===');
for (const kw of ['dsh-ops', 'skill-explorer', 'wallpaper-engine', 'code-review', 'image-gen']) {
  const hits = plugins.filter((p) => p.name.toLowerCase().includes(kw));
  console.log(`\n[${kw}] ${hits.length} 个匹配`);
  for (const p of hits.slice(0, 6)) {
    const s = p.metadata?.sortKeys || {};
    console.log(`  ${p.name.padEnd(44)} ★${s.stars || 0} ↓${s.downloads || 0}  ${p.versions?.[0]?.version || ''}`);
  }
}
