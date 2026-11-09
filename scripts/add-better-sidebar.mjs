import fs from 'node:fs';

const FILE = 'catalog/sources.json';
const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));

if (j.plugins.some((p) => p.id === 'better-sidebar')) {
  console.log('已存在，跳过');
  process.exit(0);
}

j.plugins.push({
  id: 'better-sidebar',
  category: 'ui',
  packageName: 'dsh-better-sidebar',
  title: '侧边栏工作台',
  summary:
    '把右侧栏升级成完整工作台：文件渲染与编辑、终端、Git、子代理都在侧栏里，并允许第三方插件注册自己的 Tab。',
  highlights: [
    '侧栏内置文件预览/编辑、终端、Git 与子代理面板',
    '支持第三方插件注册新 Tab（壁纸引擎等插件依赖它）',
    'DSH Web 与桌面端通用',
  ],
  tags: ['侧栏', '终端', 'Git', '文件预览'],
  notes: '壁纸引擎（dsh-plugin-wallpaper-engine）要求它 ≥ 0.19.0，建议先装这个。与合集包 @linxin666/dsh-web-all 同时装可能抢占同一个侧栏位置，二选一。',
  stars: 4959,
  downloads: 289396,
  featured: true,
});

fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n');
console.log('已加入 better-sidebar，共', j.plugins.length, '个插件');

// 顺手把壁纸引擎的依赖提示补上
const wp = j.plugins.find((p) => p.id === 'wallpaper-engine');
if (wp && !wp.notes) {
  wp.notes = '前置要求：dsh-better-sidebar ≥ 0.19.0，先装侧边栏工作台再装它。';
  fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n');
  console.log('已为 wallpaper-engine 补充前置说明');
}
