/* =========================================================
   管理后台逻辑
   ========================================================= */

(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const TOKEN_KEY = 'dsh-store-admin-token';

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    platform: '',
    categories: [],
    uploadId: null,
    editingId: null,
    plugins: [],
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtSize = (n) => (n ? `${(n / 1024 / 1024).toFixed(1)} MB` : '—');

  /* ---------------- 提示 ---------------- */

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.style.borderColor = bad ? 'rgba(248,113,113,.45)' : '';
    t.style.color = bad ? '#fca5a5' : '';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  /* ---------------- API ---------------- */

  async function api(pathname, opts = {}) {
    const res = await fetch(pathname, {
      ...opts,
      headers: {
        'x-admin-token': state.token,
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const err = new Error((json && (json.error || (json.errors || []).join('；'))) || `HTTP ${res.status}`);
      err.payload = json;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /* ---------------- 登录 ---------------- */

  async function tryAuth(token, silent = false) {
    state.token = token;
    try {
      const s = await api('/api/admin/session');
      state.platform = s.platform;
      localStorage.setItem(TOKEN_KEY, token);
      $('#auth-gate').hidden = true;
      $('#admin-app').hidden = false;
      $('#logout').hidden = false;
      $('#platform-text').textContent = `目标平台 ${s.platform}`;
      await loadCatalogMeta();
      await refreshList();
      return true;
    } catch (e) {
      if (!silent) {
        $('#auth-err').hidden = false;
      }
      state.token = '';
      localStorage.removeItem(TOKEN_KEY);
      return false;
    }
  }

  async function loadCatalogMeta() {
    try {
      const c = await (await fetch('/api/plugins')).json();
      state.categories = c.categories || [];
      const sel = $('#f-category');
      sel.innerHTML = state.categories.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    } catch {}
  }

  /* ---------------- 上传 ---------------- */

  async function handleFile(file) {
    if (!file) return;
    if (!/\.tgz$|\.tar\.gz$/i.test(file.name)) {
      toast('请选择 .tgz 文件', true);
      return;
    }
    const box = $('#inspect');
    box.hidden = false;
    box.innerHTML = '<div class="inspect-card">正在校验…</div>';

    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { 'x-admin-token': state.token, 'x-filename': encodeURIComponent(file.name) },
        body: file,
      });
      const json = await res.json();
      if (!res.ok) {
        renderInspect(json, file);
        return;
      }
      state.uploadId = json.uploadId;
      renderInspect(json, file);
      fillFormFromInspect(json, file);
    } catch (e) {
      box.innerHTML = `<div class="inspect-card err"><h4>上传失败</h4><div>${esc(e.message)}</div></div>`;
    }
  }

  function renderInspect(j, file) {
    const box = $('#inspect');
    box.hidden = false;
    const errs = j.errors || [];
    const warns = j.warnings || [];
    const cls = errs.length ? 'err' : 'ok';

    box.innerHTML = `
      <div class="inspect-card ${cls}">
        <h4>${errs.length ? '无法上架' : '校验通过'}</h4>
        <div class="kv">
          <span>文件 <b>${esc(file.name)}</b></span>
          <span>大小 <b>${fmtSize(file.size)}</b></span>
          ${j.pkg ? `<span>包名 <b>${esc(j.pkg.name)}</b></span><span>版本 <b>${esc(j.pkg.version)}</b></span>` : ''}
          ${j.entries ? `<span>条目 <b>${j.entries}</b></span>` : ''}
        </div>
        ${errs.length ? `<ul>${errs.map((e) => `<li class="bad">${esc(e)}</li>`).join('')}</ul>` : ''}
        ${warns.length ? `<ul>${warns.map((w) => `<li class="warn">${esc(w)}</li>`).join('')}</ul>` : ''}
      </div>`;

    $('#meta-panel').hidden = errs.length > 0;
  }

  function fillFormFromInspect(j, file) {
    const pkg = j.pkg || {};
    $('#meta-pkg').textContent = `${pkg.name}@${pkg.version}`;
    if (!state.editingId) {
      $('#f-title').value = $('#f-title').value || pkg.name;
      $('#f-summary').value = $('#f-summary').value || pkg.description || '';
      const base = String(pkg.name).replace(/^@?[^/]*\//, '').replace(/^dsh-/, '');
      $('#f-tags').value = $('#f-tags').value || base;
    }
    toast('校验通过，补充展示信息后即可发布');
  }

  /* ---------------- 发布 / 编辑 ---------------- */

  function readForm() {
    return {
      uploadId: state.uploadId,
      id: state.editingId || undefined,
      title: $('#f-title').value.trim(),
      summary: $('#f-summary').value.trim(),
      category: $('#f-category').value,
      highlights: $('#f-highlights').value.split('\n').map((s) => s.trim()).filter(Boolean),
      tags: $('#f-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
      repoUrl: $('#f-repo').value.trim(),
      notes: $('#f-notes').value.trim() || null,
      featured: $('#f-featured').checked,
      offline: $('#f-offline').checked
        ? { ready: false, reason: $('#f-offline-reason').value.trim() || '运行期需要外网' }
        : { ready: true, reason: null },
    };
  }

  async function publish() {
    const body = readForm();
    if (!state.uploadId && !state.editingId) return toast('先上传一个 .tgz', true);
    if (!body.title) return toast('标题不能为空', true);

    try {
      if (state.editingId) {
        await api(`/api/admin/plugins/${encodeURIComponent(state.editingId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        toast('已更新');
      } else {
        await api('/api/admin/plugins', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        toast('已上架');
      }
      resetForm();
      await refreshList();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function resetForm() {
    state.uploadId = null;
    state.editingId = null;
    $('#inspect').hidden = true;
    $('#inspect').innerHTML = '';
    $('#meta-panel').hidden = true;
    $('#meta-pkg').textContent = '';
    $('#file').value = '';
    for (const id of ['#f-title', '#f-summary', '#f-highlights', '#f-tags', '#f-repo', '#f-notes', '#f-offline-reason']) {
      $(id).value = '';
    }
    $('#f-featured').checked = false;
    $('#f-offline').checked = false;
    $('#offline-reason-wrap').hidden = true;
    $('#edit-note').hidden = true;
    $('#publish').textContent = '发布上架';
  }

  /* ---------------- 列表 ---------------- */

  async function refreshList() {
    try {
      const j = await api('/api/admin/plugins');
      state.plugins = j.plugins || [];
      $('#count').textContent = String(state.plugins.length);
      renderList();
    } catch (e) {
      if (e.status === 401) return tryAuth(state.token, true);
      toast(e.message, true);
    }
  }

  function renderList() {
    const box = $('#alist');
    if (!state.plugins.length) {
      box.innerHTML = '<div class="empty-hint">还没有后台上传的插件</div>';
      return;
    }
    box.innerHTML = state.plugins
      .map(
        (p) => `
      <div class="arow" data-id="${esc(p.id)}">
        <div class="arow-main">
          <h4>${esc(p.title)}</h4>
          <p>${esc(p.summary || '（无说明）')}</p>
          <div class="arow-meta">${esc(p.packageName)}@${esc(p.version)} · ${fmtSize(p.sizeBytes)} · ${esc(p.category)}</div>
        </div>
        <div class="arow-actions">
          <button class="btn ghost js-edit">编辑</button>
          <button class="btn danger js-del">下架</button>
        </div>
      </div>`
      )
      .join('');

    box.querySelectorAll('.arow').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.js-del').onclick = async () => {
        if (!confirm(`确认下架 ${id}？这会删除服务器上的包文件。`)) return;
        try {
          await api(`/api/admin/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast('已下架');
          await refreshList();
        } catch (e) {
          toast(e.message, true);
        }
      };
      row.querySelector('.js-edit').onclick = () => loadForEdit(id);
    });
  }

  function loadForEdit(id) {
    const p = state.plugins.find((x) => x.id === id);
    if (!p) return;
    state.editingId = id;
    state.uploadId = null;
    $('#inspect').hidden = true;
    $('#meta-panel').hidden = false;
    $('#meta-pkg').textContent = `${p.packageName}@${p.version}`;
    $('#f-title').value = p.title || '';
    $('#f-summary').value = p.summary || '';
    $('#f-category').value = p.category || 'docs';
    $('#f-highlights').value = (p.highlights || []).join('\n');
    $('#f-tags').value = (p.tags || []).join(', ');
    $('#f-repo').value = p.repoUrl || '';
    $('#f-notes').value = p.notes || '';
    $('#f-featured').checked = !!p.featured;
    const off = p.offline && p.offline.ready === false;
    $('#f-offline').checked = off;
    $('#offline-reason-wrap').hidden = !off;
    $('#f-offline-reason').value = off ? p.offline.reason || '' : '';
    $('#edit-note').hidden = false;
    $('#publish').textContent = '保存修改';
    $('#meta-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    $('#auth-btn').onclick = async () => {
      $('#auth-err').hidden = true;
      const ok = await tryAuth($('#token').value.trim());
      if (!ok) $('#auth-err').hidden = false;
    };
    $('#token').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#auth-btn').click();
    });

    $('#logout').onclick = () => {
      localStorage.removeItem(TOKEN_KEY);
      state.token = '';
      $('#admin-app').hidden = true;
      $('#auth-gate').hidden = false;
      $('#logout').hidden = true;
    };

    const drop = $('#drop');
    drop.onclick = () => $('#file').click();
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('drag');
      handleFile(e.dataTransfer.files[0]);
    });
    $('#file').onchange = (e) => handleFile(e.target.files[0]);

    $('#publish').onclick = publish;
    $('#reset').onclick = resetForm;
    $('#refresh').onclick = refreshList;

    $('#f-offline').onchange = (e) => {
      $('#offline-reason-wrap').hidden = !e.target.checked;
    };
  }

  bind();
  // 支持 /admin?token=xxx 直接进入（方便内网书签，登录后自动从地址栏清掉）
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    tryAuth(urlToken).then((ok) => {
      if (ok) {
        const u = new URL(location.href);
        u.searchParams.delete('token');
        history.replaceState(null, '', u);
      }
    });
  } else if (state.token) {
    tryAuth(state.token, true);
  }
})();
