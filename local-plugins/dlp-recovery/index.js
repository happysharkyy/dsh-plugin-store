/**
 * dsh-dlp-recovery —— 把 skill 包成 DSH 插件
 *
 * DSH 的 skill 型插件约定：插件模块 `inject: ['skills']`，
 * 在 apply 里把 skills/<name>/SKILL.md 注册进 ctx.skills，
 * 并把 skills/<name>/ 作为资源目录交给模型按需读取。
 *
 * 这里只是把 dlp-file-recovery 这个 skill 挂上去，
 * 真正的逻辑都在 skills/dlp-file-recovery/ 下的脚本里。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'dlp-file-recovery';
const SKILL_ROOT_URL = new URL(`./skills/${SKILL_NAME}/`, import.meta.url);
const SKILL_FILE_URL = new URL('SKILL.md', SKILL_ROOT_URL);

const SKILL_DESCRIPTION =
  '把被企业透明加密软件（DLP / Ocular / TSGuard 等）覆盖成密文的源文件还原为磁盘明文。' +
  '当文件以 %TSD-Header 开头、用编辑器打开是乱码，或用户要求恢复被加密的源文件时使用。';

const SKILL_WHEN_TO_USE =
  '文件前 16 字节是 %TSD-Header-###%、打开显示为乱码二进制、源文件被安全软件加密、' +
  '需要把工作区里的密文文件恢复成明文时使用。不用于 git 回滚。';

function stripFrontmatter(markdown) {
  if (!markdown.startsWith('---\n')) return markdown;
  const end = markdown.indexOf('\n---\n', 4);
  return end === -1 ? markdown : markdown.slice(end + 5);
}

// cordis 用模块导出的 name 作为插件标识，需与 cordis.patch.yml 里的 id 一致
export const name = 'dlp-recovery';
export const inject = ['skills'];

export function apply(ctx) {
  const skillPath = fileURLToPath(SKILL_FILE_URL);
  const resourcePath = fileURLToPath(SKILL_ROOT_URL);
  const content = stripFrontmatter(readFileSync(SKILL_FILE_URL, 'utf8'));

  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'dsh-dlp-recovery',
    source: 'bundled',
    resourceBase: { kind: 'directory', path: resourcePath },
    content,
    path: skillPath,
  });
}
