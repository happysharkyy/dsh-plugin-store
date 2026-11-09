/**
 * 极简 semver 范围判断，覆盖 DSH 插件里实际出现的写法：
 *   ^1.2.3   ^0.1.0-rc.6   ~1.2.3   >=1.2.3   =1.2.3   1.2.3   *   latest
 * 只用于「插件声明的 @deepseek-ai/* 依赖是否被当前运行时满足」这一个判断。
 */

export function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/** -1 / 0 / 1；预发布版本低于同号正式版 */
export function cmp(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function satisfies(version, range) {
  const v = parse(version);
  if (!v) return true; // 解析不了就不拦
  const r = String(range || '').trim();
  if (!r || r === '*' || r === 'latest') return true;

  // 简单的多段范围（a || b）
  if (r.includes('||')) return r.split('||').some((part) => satisfies(version, part));
  if (r.includes(' ')) return r.split(/\s+/).every((part) => satisfies(version, part));

  const m = /^([\^~><=]*)\s*(.+)$/.exec(r);
  if (!m) return true;
  const op = m[1] || '=';
  const target = parse(m[2]);
  if (!target) return true;

  const c = cmp(v, target);
  if (op === '>=') return c >= 0;
  if (op === '>') return c > 0;
  if (op === '<=') return c <= 0;
  if (op === '<') return c < 0;
  if (op === '=' || op === '') return c === 0;

  if (op === '~') {
    return c >= 0 && v.major === target.major && v.minor === target.minor;
  }

  // ^：0.x 只放宽 patch，1.x 放宽 minor
  if (op === '^') {
    if (c < 0) return false;
    if (target.major > 0) return v.major === target.major;
    if (target.minor > 0) return v.major === 0 && v.minor === target.minor;
    return v.major === 0 && v.minor === 0 && v.patch === target.patch;
  }
  return true;
}

/**
 * 从 peerDependencies 里挑出运行时相关的约束。
 * 只看 @deepseek-ai/dsh-* —— cordis / schemastery 是独立版本线的库，
 * 拿 DSH 桌面端版本去比会误判（DSH 自己的校验也只拦 dsh-*）。
 */
export function dshPeerRanges(pkg) {
  const out = {};
  for (const [name, range] of Object.entries(pkg?.peerDependencies || {})) {
    if (name.startsWith('@deepseek-ai/dsh-')) out[name] = range;
  }
  return out;
}

/** 返回 { ok, unmet: [{name, range}] } */
export function checkCompat(pkg, dshVersion) {
  if (!dshVersion) return { ok: true, unmet: [] };
  const unmet = [];
  for (const [name, range] of Object.entries(dshPeerRanges(pkg))) {
    if (!satisfies(dshVersion, range)) unmet.push({ name, range });
  }
  return { ok: unmet.length === 0, unmet };
}
