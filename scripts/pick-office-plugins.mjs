import fs from 'node:fs';

const rows = fs.readFileSync(process.argv[2] || 'C:\\Windows\\Temp\\dshstore\\plugins.csv', 'utf8');
const lines = rows.split(/\r?\n/);
const header = lines[0].split(',');
const idx = (n) => header.indexOf(n);

const have = new Set(
  JSON.parse(fs.readFileSync('catalog/sources.json', 'utf8')).plugins.map((p) => p.repo.toLowerCase())
);

// 办公向关键词
const KW = /(office|文档|word|docx|excel|xlsx|表格|pdf|ppt|幻灯|邮件|mail|lark|feishu|飞书|钉钉|dingtalk|企业微信|wecom|notes?|便签|todo|待办|日程|calendar|会议|meeting|翻译|translate|ocr|扫描|markdown|知识库|obsidian|zotero|文献|导出|export|公文|合同|发票)/i;

function parseLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const cands = [];
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const c = parseLine(line);
  const repo = c[idx('repo')];
  if (!repo || have.has(repo.toLowerCase())) continue;
  const zh = c[idx('intentZh')] || '';
  const en = c[idx('intentEn')] || '';
  const stars = Number(c[idx('stars')]) || 0;
  const isDsh = c[idx('isDsh')];
  if (isDsh === 'no') continue;
  if (!KW.test(zh) && !KW.test(en)) continue;
  cands.push({ repo, stars, zh: zh.slice(0, 60), cat: c[idx('category')] });
}

cands.sort((a, b) => b.stars - a.stars);
console.log(`候选 ${cands.length} 个（已排除在架插件），Top 45：\n`);
for (const c of cands.slice(0, 45)) {
  console.log(`${String(c.stars).padStart(6)}★  ${c.repo.padEnd(44)} [${c.cat}]`);
  console.log(`         ${c.zh}`);
}
