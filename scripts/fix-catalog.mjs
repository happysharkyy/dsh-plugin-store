import fs from 'node:fs';

const FILE = 'catalog/sources.json';
const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// 放弃这两个：dsh-suite 源码包过大下载超时；openmaic 依赖未发布的 @deepseek-ai/dsh-type-meta
const drop = new Set(['dsh-suite', 'openmaic']);
const before = j.plugins.length;
j.plugins = j.plugins.filter((p) => !drop.has(p.id));
for (const id of drop) if (!j.plugins.some((p) => p.id === id)) console.log('已移除:', id);

// 补一个已验证的飞书插件，凑够 15 个新增
if (!j.plugins.some((p) => p.id === 'lark-bot')) {
  j.plugins.push({
    id: 'lark-bot',
    category: 'office',
    repo: 'omdsh-dev/dsh-lark',
    packageName: 'dsh-lark-channel',
    title: '飞书机器人频道',
    summary: '把飞书 / Lark 群聊接成 DSH 的对话入口：群里发消息就能驱动智能体，回复和审批都回到群里。',
    highlights: [
      '群聊直接驱动智能体',
      '回复与审批走飞书卡片',
      '适合团队共用一个 Agent',
    ],
    tags: ['飞书', 'Lark', '群聊'],
  });
  console.log('已补充: lark-bot');
}

fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n');
console.log(`插件数 ${before} -> ${j.plugins.length}`);
