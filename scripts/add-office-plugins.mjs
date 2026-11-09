import fs from 'node:fs';

const FILE = 'catalog/sources.json';
const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const have = new Set(j.plugins.map((p) => p.id));

const add = [
  {
    id: 'dsh-im',
    category: 'office',
    repo: 'xmanrui/dsh-im',
    packageName: '@xmanrui/dsh-im',
    title: '多 IM 机器人接入',
    summary: '扫码或凭据把飞书、微信、钉钉、企业微信、QQ、Slack、Telegram 等九个渠道接进 DSH，每个渠道可挂多个机器人。',
    highlights: [
      '九个 IM 渠道统一管理，无需改代码',
      '扫码 / App Manifest / 机器人凭据三种接入方式',
      '每个渠道可同时接多个机器人',
      '内置 AI Office 连接器',
    ],
    tags: ['飞书', '钉钉', '企业微信', 'Slack'],
    featured: true,
  },
  {
    id: 'vision-toolkit',
    category: 'office',
    repo: 'Anionex/dsh-vision-toolkit',
    packageName: '@anionex/dsh-vision-toolkit',
    title: '视觉工具箱（截图 OCR / 看图）',
    summary: '给纯文本模型装上眼睛：多图问答、长截图 OCR、UI 还原与 GUI 自动化。',
    highlights: [
      '长截图与图片逐字 OCR，报错信息、表格可直接转文字',
      '多图理解与 UI 还原',
      '可驱动 GUI 自动化',
    ],
    tags: ['OCR', '截图', '看图', 'UI 还原'],
    featured: true,
  },
  {
    id: 'auto-memory',
    category: 'office',
    repo: 'Aik358/dsh-auto-memory',
    packageName: '@a9i5k4/dsh-auto-memory',
    title: '自动记忆',
    summary: '三层记忆（用户级 / 项目笔记 / 每日日志）自动注入与检索，每日反思，带可视化面板。',
    highlights: [
      '用户偏好、项目约定、每日日志分三层存放',
      '自动注入相关记忆，不用每次重复交代背景',
      '支持从其他记忆插件继承',
    ],
    tags: ['记忆', '上下文', '知识沉淀'],
  },
  {
    id: 'openmaic',
    category: 'ppt',
    repo: 'THU-MAIC/dsh-openmaic',
    packageName: '@openmaic/dsh-openmaic',
    title: '课堂与幻灯片组件',
    summary: 'OpenMAIC：生成课堂、幻灯片与交互式教学组件。',
    highlights: ['课件与幻灯片生成', '交互式组件', '适合教学与汇报场景'],
    tags: ['课堂', '幻灯片', '交互'],
  },
  {
    id: 'notification',
    category: 'office',
    repo: 'omdsh-dev/dsh-notification',
    packageName: 'dsh-notification',
    title: '回合完成通知',
    summary: 'DSH 每一回合结束时弹桌面通知，可按结果分别控制，支持关键词包含 / 排除。',
    highlights: ['回合结束即提醒，长任务不用盯着屏幕', '按成功 / 失败 / 中断分别开关', '支持关键词白名单与黑名单'],
    tags: ['通知', '提醒', '桌面'],
  },
  {
    id: 'dsh-suite',
    category: 'office',
    subdir: 'packages/all',
    repo: 'whyihaveyou/dsh-suite',
    packageName: 'dsh-suite',
    title: '会话导出',
    summary: '把 append-only 会话日志导出成人读的 Markdown / HTML，按来源分组（系统提示、思维链、工具调用）。',
    highlights: ['导出的 Markdown 可直接归档或发人', '按来源分组渲染，便于复盘', '支持长会话'],
    tags: ['导出', '归档', 'Markdown'],
  },
  {
    id: 'lark-link',
    category: 'office',
    repo: 'amlyczz/dsh-lark-link',
    packageName: 'dsh-lark-link',
    title: '飞书桥接',
    summary: '高可靠的飞书 / Lark 桥接：二维码一键授权、多模式智能体、卡片式命令、零丢失发件箱。',
    highlights: ['扫码授权，不用手工配 token', '卡片式交互命令', '发件箱保证消息不丢'],
    tags: ['飞书', 'Lark', '机器人'],
  },
  {
    id: 'sticky-note',
    category: 'office',
    repo: 'Meredith2328/dsh-sticky-note',
    packageName: 'dsh-sticky-note',
    title: '便签',
    summary: '随手记点子、感想与 TODO，Markdown 预览、快捷键、历史归档，存储路径可配置。',
    highlights: ['随手记，不打断当前任务', 'Markdown 预览与历史归档', '数据落在本地文件，可自行备份'],
    tags: ['便签', '待办', '笔记'],
  },
  {
    id: 'email',
    category: 'office',
    repo: 'STARDUSTLC666/dsh-email',
    packageName: 'dsh-email',
    title: '邮件收发',
    summary: '在 DSH 里处理邮件：浏览、搜索、下载附件，核对收件人与正文后再发出回复。',
    highlights: [
      '支持 IMAP / POP3 / SMTP、Outlook OAuth 与 AgentMail',
      '在工作台浏览邮件、搜索并下载附件',
      '发送前逐项核对发件账号、To/Cc、正文与附件',
    ],
    tags: ['邮件', 'IMAP', 'Outlook'],
    featured: true,
  },
  {
    id: 'whale-report',
    category: 'office',
    repo: 'SenmuuuuW/dsh-whale-report',
    packageName: 'dsh-whale-report',
    title: '日报周报生成',
    summary: '从会话事件日志生成日报 / 周报 / 月报 / 年报，任意时间区间，只读不改写原日志。',
    highlights: ['按任意区间汇总工作内容', '只读会话日志，不会改动原始记录', '适合直接贴进周会材料'],
    tags: ['日报', '周报', '汇报'],
  },
  {
    id: 'bookmarks',
    category: 'office',
    repo: 'penguin-oo/dsh-bookmarks',
    packageName: 'dsh-bookmarks',
    title: '回复书签',
    summary: '给任意一条回复加带备注和标签的书签，跨会话集中查看，一键导出 Markdown。',
    highlights: ['消息级书签，带备注与标签', '跨会话书签中心', '一键导出 Markdown'],
    tags: ['书签', '检索', '导出'],
  },
  {
    id: 'docs-panel',
    category: 'office',
    repo: 'mlosun/dsh-docs-panel',
    packageName: 'dsh-docs-panel',
    title: '随身手册',
    summary: '全局 Markdown 笔记面板，任何工作区随时可读：右侧滑出、亮暗主题、拖拽调宽、悬浮大纲。',
    highlights: ['全局笔记，不绑定工作区', '侧边滑出阅读，可拖拽调宽', '一键转到 Chrome / VS Code 继续编辑'],
    tags: ['笔记', 'Markdown', '阅读'],
  },
  {
    id: 'file-explorer',
    category: 'office',
    repo: 'joejojoking-cloud/dsh-file-explorer',
    packageName: 'dsh-file-explorer',
    title: '文件浏览器',
    summary: '右侧可调宽文件树，Markdown 渲染、语法高亮、面板内编辑，一键用 VS Code 或系统文件管理器打开。',
    highlights: [
      '多标签预览，切换不重新加载',
      'Markdown 渲染 + 多语言语法高亮',
      '可直接在面板内编辑并保存回磁盘',
      '一键在 VS Code / 系统资源管理器中定位',
    ],
    tags: ['文件树', '预览', 'VS Code'],
  },
  {
    id: 'hongtou',
    category: 'docs',
    repo: 'ExElectron/dsh-tool-hongtou',
    packageName: 'dsh-tool-hongtou',
    title: '红头公文生成',
    summary: '两阶段解耦流水线（LLM 结构化提纲 + 确定性 Word 2003 XML 版式渲染）生成标准红头公文。',
    highlights: ['LLM 只负责内容，版式由确定性渲染保证', '输出符合公文格式的 Word 文档', '格式稳定，不会每次都变形'],
    tags: ['公文', 'Word', '红头'],
  },
  {
    id: 'pdf-edit',
    category: 'docs',
    repo: 'Whatsmore-nf/dsh-pdf-edit',
    packageName: 'dsh-pdf-edit',
    title: 'PDF 编辑',
    summary: 'AI 只改文字不改样式：支持单页与批量替换，HTML 中转保留原有排版，大文件也能处理。',
    highlights: ['改内容不动版式', '单页修改或批量替换', 'HTML 中转保留样式'],
    tags: ['PDF', '编辑', '批量'],
  },
  {
    id: 'dlp-recovery',
    category: 'tools',
    local: 'local-plugins/dlp-recovery',
    packageName: 'dsh-dlp-recovery',
    title: 'DLP 加密文件恢复',
    summary: '把被透明加密软件（Ocular / TSGuard 等）覆盖成密文的源文件还原为磁盘明文，自带扫描、恢复与校验。',
    highlights: [
      '按 %TSD-Header 特征识别被加密文件',
      '受信进程读出明文，再按字节覆写回原路径',
      '恢复后自动校验语法与哈希，串写能被发现',
      '专门解决「文件看起来正常、外部程序读到乱码」这类问题',
    ],
    tags: ['DLP', '加密', '恢复', 'Windows'],
  },
];

let added = 0;
for (const p of add) {
  if (have.has(p.id)) {
    console.log('skip (exists):', p.id);
    continue;
  }
  j.plugins.push(p);
  added++;
}
fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n');
console.log(`新增 ${added} 个，共 ${j.plugins.length} 个插件`);
