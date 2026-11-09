/**
 * 下架一个插件：从 sources.json 移除，删掉包文件，清理 manifest 条目
 *   node scripts/drop-plugin.mjs docling
 */
import fs from 'node:fs';
import path from 'node:path';

const id = process.argv[2];
if (!id) {
  console.error('用法: node scripts/drop-plugin.mjs <id>');
  process.exit(1);
}

// 1) sources.json
const srcPath = 'catalog/sources.json';
const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
const before = src.plugins.length;
src.plugins = src.plugins.filter((p) => p.id !== id);
fs.writeFileSync(srcPath, JSON.stringify(src, null, 2) + '\n');
console.log(`sources.json: ${before} -> ${src.plugins.length}`);

// 2) manifest + 包文件（可能存在于多个平台目录）
for (const mf of ['mirror/manifest-linux.json', 'mirror/manifest.json']) {
  if (!fs.existsSync(mf)) continue;
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const entry = m.packages?.[id];
  if (!entry) continue;
  const dirs = ['mirror/packages-linux', 'mirror/packages'];
  for (const d of dirs) {
    const f = path.join(d, entry.file || '');
    if (entry.file && fs.existsSync(f)) {
      fs.rmSync(f);
      console.log('删除包文件:', f);
    }
  }
  delete m.packages[id];
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  console.log('已从', mf, '移除条目');
}

console.log('完成');
