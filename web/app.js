/* =========================================================
   DSH 内网插件商店 — 前端逻辑（无框架、无构建）
   ========================================================= */

(() => {
  'use strict';

  const state = {
    data: null,
    origin: '',
    platform: '',
    cat: 'all',
    q: '',
    sort: 'featured',
  };

  const ICONS = {
    docs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3.5h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z"/><path d="M13 3.5v5h5"/><path d="M8.5 13h7M8.5 16.5h4.5"/></svg>`,
    ssh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2.5" y="4.5" width="19" height="15" rx="2.2"/><path d="m7 10 2.6 2.4L7 14.8"/><path d="M12.5 15.2h4"/></svg>`,
    ppt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/><path d="M7.5 12.5v-2M12 12.5v-4M16.5 12.5v-2.8"/></svg>`,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtStars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const catName = (id) => state.data?.categories?.find((c) => c.id === id)?.name || id;

  /* ---------------- 数据 ---------------- */

  async function load() {
    let json = null;
    try {
      const res = await fetch('/api/plugins', { cache: 'no-store' });
      if (res.ok) json = await res.json();
    } catch {}
    if (!json) {
      try {
        const res = await fetch('./data/plugins.json', { cache: 'no-store' });
        if (res.ok) json = await res.json();
      } catch {}
    }
    if (!json) {
      $('#grid').innerHTML =
        '<div class="empty"><p>没有读到插件目录</p><span>请确认服务已启动，或先运行 <code>node scripts/build-catalog.mjs</code></span></div>';
      return;
    }
    state.data = json;
    state.origin = json.origin || (location.protocol.startsWith('http') ? location.origin : 'http://你的内网IP:8787');
    state.platform = json.platform || '';

    renderStats();
    renderChips();
    render();
    fillHero();
    openFromHash();
  }

  function installCommand(p) {
    if (p.package?.status !== 'ready') return null;
    return `dsh plugin --profile web add ${state.origin}/packages/${p.package.file}`;
  }

  /** 下载到本地后再装（纯内网、或商店地址不通时用这条） */
  function localInstallCommand(p) {
    if (p.package?.status !== 'ready') return null;
    return `dsh plugin --profile web add ./${p.package.file}`;
  }

  /** 一条命令搞定：拉包 + 装本地文件 */
  function downloadAndInstallCommand(p) {
    if (p.package?.status !== 'ready') return null;
    const url = `${state.origin}/packages/${p.package.file}`;
    return `curl -O ${url} && dsh plugin --profile web add ./${p.package.file}`;
  }

  function fillHero() {
    const first = state.data.plugins.find((p) => p.package.status === 'ready');
    if (first) {
      $('#hero-cmd').innerHTML = `<code>${esc(installCommand(first))}</code>`;
      $('#hero-copy').onclick = () => copy(installCommand(first), '安装命令已复制');
    }
    $('#meta-origin').textContent = state.origin;
    const bytes = state.data.stats.totalSizeBytes || 0;
    $('#meta-size').textContent = bytes ? `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB` : '—';

    const ready = state.data.stats.ready;
    const total = state.data.stats.total;
    const inc = state.data.stats.incompatible || 0;
    $('#hero-pill').textContent = inc
      ? `${ready} 个插件已镜像 · ${ready - inc} 个可直接安装，${inc} 个需版本豁免`
      : ready === total
        ? `全部 ${total} 个插件已离线镜像 · 内网无需访问 GitHub / npm`
        : `${ready}/${total} 个插件已离线镜像`;

    $('#foot-meta').textContent = `目录生成于 ${fmtDate(state.data.generatedAt)} · v${state.data.site?.version ?? 1}${state.platform ? ` · 目标平台 ${state.platform}` : ''}`;
  }

  function renderStats() {
    $('#stat-total').textContent = state.data.stats.total;
    $('#stat-ready').textContent = state.data.stats.ready;
  }

  function renderChips() {
    const box = $('#cats');
    box.innerHTML = '';
    const counts = { all: state.data.plugins.length };
    for (const p of state.data.plugins) {
      for (const c of [p.category, ...(p.alsoIn || [])]) counts[c] = (counts[c] || 0) + 1;
    }

    const mk = (id, label, count) => {
      const b = el('button', `chip${state.cat === id ? ' active' : ''}`);
      b.innerHTML = `${esc(label)} <span class="count">${count}</span>`;
      b.onclick = () => {
        state.cat = id;
        renderChips();
        render();
      };
      return b;
    };

    box.append(mk('all', '全部', counts.all));
    for (const c of state.data.categories) box.append(mk(c.id, c.name, counts[c.id] || 0));
  }

  function matchQuery(p, q) {
    if (!q) return true;
    const hay = [p.title, p.summary, p.packageName, p.repo, ...(p.tags || []), ...(p.highlights || [])]
      .join(' ')
      .toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((t) => hay.includes(t));
  }

  function visible() {
    const list = state.data.plugins.filter((p) => {
      const catOk = state.cat === 'all' || p.category === state.cat || (p.alsoIn || []).includes(state.cat);
      return catOk && matchQuery(p, state.q);
    });

    const by = {
      featured: (a, b) => Number(b.featured) - Number(a.featured) || (b.downloads || 0) - (a.downloads || 0) || b.stars - a.stars,
      downloads: (a, b) => (b.downloads || 0) - (a.downloads || 0),
      stars: (a, b) => b.stars - a.stars,
      name: (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'),
      updated: (a, b) => String(b.pushedAt || '').localeCompare(String(a.pushedAt || '')),
    }[state.sort] || ((a, b) => b.stars - a.stars);

    return list.sort(by);
  }

  function badge(p) {
    let html = '';
    if (p.package.status === 'ready') html += '<span class="badge ready">已镜像</span>';
    else if (p.package.status === 'failed') html += '<span class="badge failed">打包失败</span>';
    else html += '<span class="badge pending">待镜像</span>';
    if (p.compat && p.compat.ok === false) html += '<span class="badge gate">需豁免</span>';
    if (p.offline && p.offline.ready === false) html += '<span class="badge net">需预热</span>';
    return html;
  }

  /** 版本门槛的豁免命令 */
  function exemptCommand(p) {
    const v = state.data.site?.dshVersion || '<dsh版本>';
    return `dsh plugin --profile web allow-version ${p.packageName}@${p.version} --dsh-version ${v} --accept-risk`;
  }

  function render() {
    const grid = $('#grid');
    const list = visible();
    grid.innerHTML = '';
    $('#empty').hidden = list.length > 0;

    for (const p of list) {
      const card = el('article', 'card');
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.innerHTML = `
        <div class="card-top">
          <div class="card-icon" data-cat="${esc(p.category)}">${ICONS[p.category] || ICONS.docs}</div>
          <div class="card-head">
            <h3>${esc(p.title)}${p.featured ? ' <span class="badge featured">推荐</span>' : ''}</h3>
            <span class="pkg">${esc(p.packageName)}${p.version ? ` · v${esc(p.version)}` : ''}</span>
          </div>
          <div class="badges">${badge(p)}</div>
        </div>
        <p class="summary">${esc(p.summary)}</p>
        <div class="tags">${(p.tags || []).slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        <div class="card-foot">
          <span class="star">★ ${fmtStars(p.stars)}</span>
          ${p.downloads ? `<span class="dl">↓ ${fmtStars(p.downloads)}</span>` : ''}
          <span>${esc(catName(p.category))}</span>
          <span>${p.package.size ? esc(p.package.size) : '—'}</span>
          <span class="grow"></span>
          <span>${esc(p.license || '未知协议')}</span>
        </div>
        <div class="card-actions">
          <button class="btn primary js-copy" ${p.package.status === 'ready' ? '' : 'disabled'}>
            ${p.package.status === 'ready' ? '安装命令' : '暂不可安装'}
          </button>
          <button class="btn ghost js-detail">详情</button>
        </div>`;

      const copyBtn = $('.js-copy', card);
      copyBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const cmd = installCommand(p);
        if (cmd) copy(cmd, '安装命令已复制');
      });

      card.addEventListener('click', () => openModal(p));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openModal(p);
        }
      });

      grid.append(card);
    }
  }

  /* ---------------- 弹窗 ---------------- */

  function openModal(p, push = true) {
    const cmd = installCommand(p);
    const modal = $('#modal');
    const body = $('#modal-body');
    if (push) {
      try { history.replaceState(null, '', `#/${p.id}`); } catch {}
    }

    const meta = [
      ['版本', p.version ? `v${p.version}` : '—'],
      ['包大小', p.package.size || '—'],
      ['许可证', p.license || '未知'],
      ['星标', fmtStars(p.stars)],
      ['镜像方式', p.package.strategy === 'npm' ? 'npm 成品包' : p.package.strategy === 'git' ? '源码构建' : p.package.strategy === 'local' ? '本地打包' : '—'],
      ['更新于', fmtDate(p.pushedAt)],
    ];

    body.innerHTML = `
      <div class="modal-head">
        <div class="card-icon" data-cat="${esc(p.category)}">${ICONS[p.category] || ICONS.docs}</div>
        <div>
          <h2 id="modal-title">${esc(p.title)}</h2>
          <span class="pkg">${esc(p.packageName)}${p.version ? ` · v${esc(p.version)}` : ''} · ${esc(p.repo)}</span>
        </div>
        <div class="badges">${badge(p)}</div>
      </div>

      <p class="modal-summary">${esc(p.summary)}</p>

      ${p.highlights?.length ? `<div class="modal-section"><h4>能力</h4><ul class="hl">${p.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>` : ''}

      ${p.tags?.length ? `<div class="modal-section"><h4>标签</h4><div class="tags">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>` : ''}

      <div class="modal-section">
        <h4>安装方式</h4>
        ${
          cmd
            ? `
            <div class="install-label">下载后安装 <span>推荐，任何环境都能用</span></div>
            <div class="install-box"><code>${esc(downloadAndInstallCommand(p))}</code><button class="btn primary" data-copy="${esc(downloadAndInstallCommand(p))}">复制</button></div>
            <p class="install-tip">两条命令一起复制执行即可；也可以点下面的「下载 .tgz」，再在本机执行第二条。</p>

            <div class="install-label">直接安装 <span>需要这台机器能访问商店地址</span></div>
            <div class="install-box"><code>${esc(cmd)}</code><button class="btn" data-copy="${esc(cmd)}">复制</button></div>
            <p class="install-tip">如果报 <code>404</code> / <code>ETIMEDOUT</code> / <code>ERR_PNPM_FETCH_404</code>，说明这台机器连不上商店地址，改用上面的下载方式。</p>
          `
            : `<div class="note bad">该插件尚未完成镜像，暂时只能查看信息。运行 <code>node scripts/mirror.mjs --only ${esc(p.id)}</code> 重新打包，或在后台重新上传。</div>`
        }
      </div>

      ${p.notes ? `<div class="modal-section"><div class="note">${esc(p.notes)}</div></div>` : ''}

      ${
        p.offline && p.offline.ready === false
          ? `<div class="modal-section"><h4>断网注意</h4><div class="note warn">${esc(p.offline.reason || '该插件运行期需要外网。')}</div></div>`
          : ''
      }

      ${
        p.compat && p.compat.ok === false
          ? `<div class="modal-section">
               <h4>版本门槛</h4>
               <div class="note bad">
                 该插件声明依赖 ${esc(
                   p.compat.unmet?.length
                     ? p.compat.unmet.slice(0, 4).map((u) => `${u.name} ${u.range}`).join('、') +
                       (p.compat.unmet.length > 4 ? ` 等 ${p.compat.unmet.length} 项` : '')
                     : '较新的 @deepseek-ai/dsh-* 版本'
                 )}，当前 DSH ${esc(state.data.site?.dshVersion || '')} 会直接拒绝加载。确认风险后可显式豁免：
               </div>
               <div class="install-box" style="margin-top:8px">
                 <code>${esc(exemptCommand(p))}</code>
                 <button class="btn primary" id="modal-exempt">复制</button>
               </div>
             </div>`
          : ''
      }

      <div class="modal-section">
        <h4>包信息</h4>
        <div class="meta-grid">${meta
          .map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
          .join('')}</div>
      </div>

      ${p.package.sha256 ? `<div class="modal-section"><h4>SHA-256</h4><div class="sha">${esc(p.package.sha256)}</div></div>` : ''}

      <div class="modal-links">
        ${p.repoUrl ? `<a class="btn ghost" href="${esc(p.repoUrl)}" target="_blank" rel="noreferrer noopener">在 GitHub 查看</a>` : ''}
        ${p.package.status === 'ready' ? `<a class="btn ghost" href="/packages/${esc(p.package.file)}" download>下载 .tgz</a>` : ''}
        ${p.package.status === 'ready' ? `<a class="btn ghost" href="/install/${esc(p.id)}.ps1">安装脚本</a>` : ''}
      </div>`;

    $('#modal-copy')?.addEventListener('click', () => copy(cmd, '安装命令已复制'));
    $('#modal-exempt')?.addEventListener('click', () => copy(exemptCommand(p), '豁免命令已复制'));
    body.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => copy(btn.dataset.copy, '命令已复制'));
    });

    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    $('.modal-card', modal).scrollTop = 0;
  }

  function closeModal() {
    $('#modal').hidden = true;
    document.body.style.overflow = '';
    if (location.hash) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch {}
    }
  }

  /** 深链：#/<id> 直接打开详情页，方便在内网里互相发链接 */
  function openFromHash() {
    const id = decodeURIComponent(location.hash.replace(/^#\/?/, '')).trim();
    if (!id) return;
    const plugin = state.data.plugins.find((p) => p.id === id);
    if (plugin) openModal(plugin, false);
  }

  /* ---------------- 复制 / Toast ---------------- */

  async function copy(text, msg = '已复制') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(msg);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    let timer;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(timer);
      const v = e.target.value;
      timer = setTimeout(() => {
        state.q = v.trim();
        render();
      }, 120);
    });

    $('#sort').addEventListener('change', (e) => {
      state.sort = e.target.value;
      render();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== $('#search')) {
        e.preventDefault();
        $('#search').focus();
      }
      if (e.key === 'Escape') closeModal();
    });

    $('#modal').addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-close')) closeModal();
    });
  }

  bind();
  load();
})();
