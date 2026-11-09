/**
 * 从 dshmarket 索引导入插件
 *
 * 规则：
 *   - 下架：IM 类三个（dsh-im / lark-bot / lark-link）
 *   - 点名加入：dsh-ops、skill-explorer、wallpaper-engine、code-review、image-gen
 *   - 每个分类取热度前二（stars*1000 + downloads）
 *
 * 用法：node scripts/import-market.mjs [--dry]
 */
import fs from 'node:fs';

const DRY = process.argv.includes('--dry');
const SRC = 'catalog/sources.json';

/* ---------- 分类映射：市场 22 个分类 -> 商店 10 个分类 ---------- */
const CAT_MAP = {
  docs: 'docs',
  ui: 'ui',
  theme: 'ui',
  fun: 'ui',
  tools: 'dev',
  dev: 'dev',
  git: 'dev',
  market: 'dev',
  security: 'dev',
  memory: 'agent',
  session: 'agent',
  skill: 'agent',
  workflow: 'agent',
  agi: 'agent',
  model: 'model',
  vision: 'model',
  voice: 'model',
  browser: 'model',
  notify: 'ops',
  remote: 'ssh',
  usage: 'ops',
  identity: 'ops',
};

const CATEGORIES = [
  { id: 'docs', name: '文档处理', desc: 'Word / Excel / PDF / 图解与文档智能' },
  { id: 'office', name: '办公协作', desc: '邮件、通知、笔记与汇报' },
  { id: 'ppt', name: 'PPT 制作', desc: '可编辑 PPTX 与 HTML 幻灯片' },
  { id: 'ssh', name: 'SSH 远程', desc: '远程主机、跳板与远程操控' },
  { id: 'ui', name: '界面与主题', desc: '看板、皮肤、桌宠与外观' },
  { id: 'agent', name: '智能体能力', desc: '记忆、技能、会话与多智能体' },
  { id: 'dev', name: '开发工具', desc: '绘图、代码审查、市场与安全' },
  { id: 'model', name: '模型与视觉', desc: '模型接入、识图、语音与浏览' },
  { id: 'ops', name: '协作与运维', desc: '通知、用量、身份与移动端' },
  { id: 'tools', name: '效率工具', desc: '本地辅助小工具' },
];

/* ---------- 下架 / 点名 ---------- */
const DROP = new Set(['dsh-im', 'lark-bot', 'lark-link']);
const NAMED = [
  'dsh-ops',
  '@linxin666/dsh-client-ui-skill-explorer',
  'dsh-plugin-wallpaper-engine',
  '@feng0531/dsh-code-review',
  'dsh-image-gen',
];

const pop = (p) => Number(p.metadata?.sortKeys?.stars || 0) * 1000 + Number(p.metadata?.sortKeys?.downloads || 0);
const zh = (o, f = '') => (typeof o === 'string' ? o : o?.zh || o?.en || f);

async function npmInfo(name) {
  try {
    const r = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
    if (!r.ok) return null;
    const j = await r.json();
    const v = j['dist-tags']?.latest;
    return v ? { version: v, manifest: j.versions?.[v] } : null;
  } catch {
    return null;
  }
}

function slugOf(name) {
  const bare = name.includes('/') ? name.split('/')[1] : name;
  return bare
    .replace(/^dsh-plugin-/, '')
    .replace(/^dsh-client-ui-/, '')
    .replace(/^dsh-/, '')
    .replace(/^@/, '')
    .replace(/[^\w.-]+/g, '-')
    .toLowerCase();
}

const index = await (await fetch('https://dshmarket.2020713.xyz/index.json')).json();
const market = index.plugins || [];
const byName = new Map(market.map((p) => [p.name, p]));

const sources = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const existingPkg = new Set(sources.plugins.map((p) => p.packageName));
const existingIds = new Set(sources.plugins.map((p) => p.id));

// 1) 下架
const before = sources.plugins.length;
sources.plugins = sources.plugins.filter((p) => !DROP.has(p.id));
console.log(`下架 ${before - sources.plugins.length} 个：${[...DROP].join(', ')}`);

// 2) 挑候选：点名 + 每分类前二
const picked = new Map(); // packageName -> {entry, why}

for (const name of NAMED) {
  const p = byName.get(name);
  if (!p) {
    console.log(`! 点名插件不在索引里：${name}`);
    continue;
  }
  picked.set(name, { p, why: '点名' });
}

for (const [cat, list] of Object.entries(
  market.reduce((acc, p) => {
    const c = p.metadata?.category || 'unknown';
    (acc[c] ||= []).push(p);
    return acc;
  }, {})
)) {
  const top = [...list].sort((a, b) => pop(b) - pop(a)).slice(0, 2);
  for (const p of top) {
    if (!picked.has(p.name)) picked.set(p.name, { p, why: `${cat} 前二` });
  }
}

// 3) 逐个确认 npm 可用，生成条目
const added = [];
for (const [name, { p, why }] of picked) {
  if (existingPkg.has(name)) {
    console.log(`= 已在架：${name}`);
    continue;
  }
  const info = await npmInfo(name);
  if (!info) {
    console.log(`! npm 上没有：${name}`);
    continue;
  }
  let id = slugOf(name);
  while (existingIds.has(id)) id += '-2';
  existingIds.add(id);

  const cat = CAT_MAP[p.metadata?.category] || 'tools';
  const keywords = (p.metadata?.keywords || []).slice(0, 5);
  const labels = p.metadata?.labels || [];

  added.push({
    id,
    category: cat,
    packageName: name,
    npmVersion: info.version,
    title: zh(p.title, name),
    summary: zh(p.description, ''),
    tags: keywords.length ? keywords : [p.metadata?.category || 'plugin'],
    stars: Number(p.metadata?.sortKeys?.stars || 0),
    downloads: Number(p.metadata?.sortKeys?.downloads || 0),
    marketCategory: p.metadata?.category || 'unknown',
    importWhy: why,
    needsSandbox: labels.includes('needs-sandbox'),
  });
  console.log(`+ ${id.padEnd(28)} ${name.padEnd(44)} ${info.version}  ${why}`);
}

if (DRY) {
  console.log(`\n[dry] 将新增 ${added.length} 个，未写入`);
  process.exit(0);
}

sources.categories = CATEGORIES;
sources.plugins.push(...added);
fs.writeFileSync(SRC, JSON.stringify(sources, null, 2) + '\n');
console.log(`\n写入完成：新增 ${added.length} 个，总计 ${sources.plugins.length} 个`);
