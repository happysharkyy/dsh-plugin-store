import fs from 'node:fs';

const repos = process.argv.slice(2);
const out = [];

for (const repo of repos) {
  const row = { repo };
  try {
    const meta = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { 'user-agent': 'dsh-store', accept: 'application/vnd.github+json' },
    }).then((r) => (r.ok ? r.json() : null));
    if (!meta) {
      row.status = 'repo 不存在';
      out.push(row);
      continue;
    }
    row.stars = meta.stargazers_count;
    row.defaultBranch = meta.default_branch;
    row.archived = meta.archived;
    row.license = meta.license?.spdx_id || '';

    const pkg = await fetch(`https://raw.githubusercontent.com/${repo}/${meta.default_branch}/package.json`, {
      headers: { 'user-agent': 'dsh-store' },
    }).then((r) => (r.ok ? r.json() : null));
    if (!pkg) {
      row.status = '无根 package.json';
      out.push(row);
      continue;
    }
    row.pkg = pkg.name;
    row.version = pkg.version;
    row.patch = pkg.dsh?.bundle?.patch || null;
    row.private = !!pkg.private;
    row.subdirHint = null;

    // 没有根 patch 的，看看是不是 monorepo
    if (!row.patch) {
      const pkgs = await fetch(`https://api.github.com/repos/${repo}/contents/packages`, {
        headers: { 'user-agent': 'dsh-store' },
      }).then((r) => (r.ok ? r.json() : null));
      if (Array.isArray(pkgs)) {
        for (const d of pkgs.filter((x) => x.type === 'dir').slice(0, 8)) {
          const p = await fetch(`https://raw.githubusercontent.com/${repo}/${meta.default_branch}/packages/${d.name}/package.json`, {
            headers: { 'user-agent': 'dsh-store' },
          }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
          if (p?.dsh?.bundle?.patch) {
            row.subdirHint = `packages/${d.name}`;
            row.subPkg = p.name;
            break;
          }
        }
      }
    }
    row.status = row.patch || row.subdirHint ? 'ok' : '不是插件（无 dsh.bundle.patch）';

    // npm 发布情况
    if (row.pkg) {
      const reg = await fetch(`https://registry.npmjs.org/${row.pkg.replace('/', '%2f')}`, {
        headers: { 'user-agent': 'dsh-store' },
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      row.npm = reg?.['dist-tags']?.latest || null;
    }
  } catch (e) {
    row.status = `错误 ${e.message}`;
  }
  out.push(row);
  const mark = row.status === 'ok' ? 'OK  ' : 'FAIL';
  console.log(
    `${mark} ${repo.padEnd(46)} ${String(row.stars ?? '').padStart(5)}★  ${row.pkg || '-'}@${row.version || '-'}` +
      `  patch=${row.patch ? 'root' : row.subdirHint || '无'}  npm=${row.npm || '无'}` +
      (row.status === 'ok' ? '' : `  [${row.status}]`)
  );
}

fs.writeFileSync('C:\\Windows\\Temp\\office-candidates.json', JSON.stringify(out, null, 2));
console.log('\n可用的：', out.filter((r) => r.status === 'ok').length, '/', out.length);
