/**
 * 对齐 manifest / 包文件 / sources：
 *   - 删掉 sources 里已不存在的 manifest 条目
 *   - 删掉 manifest 里非 ready 的条目
 *   - 删掉 packages 目录里没人引用的包
 */
import fs from 'node:fs';
import path from 'node:path';

const MF = process.argv[2] || 'mirror/manifest-linux.json';
const DIR = process.argv[3] || 'mirror/packages-linux';

const sources = JSON.parse(fs.readFileSync('catalog/sources.json', 'utf8')).plugins;
const wanted = new Set(sources.map((p) => p.id));
const m = JSON.parse(fs.readFileSync(MF, 'utf8'));

let droppedEntries = 0;
for (const id of Object.keys(m.packages)) {
  const e = m.packages[id];
  if (!wanted.has(id)) {
    console.log(`移除条目（已下架）: ${id}`);
    delete m.packages[id];
    droppedEntries++;
  } else if (e.status !== 'ready') {
    console.log(`移除条目（未成功）: ${id}`);
    delete m.packages[id];
    droppedEntries++;
  }
}

const keep = new Set(Object.values(m.packages).map((p) => p.file));
let removedFiles = 0;
if (fs.existsSync(DIR)) {
  for (const f of fs.readdirSync(DIR)) {
    if (!keep.has(f)) {
      fs.rmSync(path.join(DIR, f));
      removedFiles++;
      console.log(`删除包文件: ${f}`);
    }
  }
}

fs.writeFileSync(MF, JSON.stringify(m, null, 2));

const missingPkg = sources.filter((p) => !m.packages[p.id]);
console.log(
  `\n清单 ${Object.keys(m.packages).length} 个 ready，sources ${sources.length} 个` +
    `，移除条目 ${droppedEntries}，删除文件 ${removedFiles}`
);
if (missingPkg.length) console.log(`尚未构建: ${missingPkg.map((p) => p.id).join(', ')}`);
