// The page shell is public; every data read/write requires the server-side admin key.
// No key is baked into this file, HTML, browser storage, URLs, or cookies.
export const adminHTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>评论审核 · Chenmin Sun</title>
<link rel="stylesheet" href="/admin.css"><script src="/admin.js" defer></script></head>
<body><main><h1>评论审核</h1>
<form id="login"><label for="key">管理密钥</label><input id="key" type="password" autocomplete="off" required>
<button>登录</button><p>密钥仅保留在当前页面内存中，刷新或退出后需重新输入。</p></form>
<p id="message" role="status" aria-live="polite"></p>
<section id="dashboard" hidden><div class="toolbar"><label for="filter">评论状态</label>
<select id="filter"><option value="pending">待审核</option><option value="approved">已发布</option><option value="rejected">已拒绝 / 已隐藏</option></select>
<button id="refresh" type="button">刷新</button><button id="logout" type="button">退出</button></div>
<p id="counts"></p><div id="list"></div><button id="more" type="button" hidden>加载更多</button></section>
</main></body></html>`;

function adminClient() {
  const $ = id => document.getElementById(id);
  let token = ''; let next = null; let loading = false;
  const message = s => { $('message').textContent = s; };
  function logout() {
    token = ''; $('key').value = ''; $('dashboard').hidden = true;
    $('login').hidden = false; $('list').replaceChildren(); next = null;
  }
  async function api(path, body) {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const data = await r.json();
    if (!r.ok) { if (r.status === 401) logout(); throw new Error(data.error || '操作失败。'); }
    return data;
  }
  function element(tag, value, cls) {
    const node = document.createElement(tag); if (value) node.textContent = value;
    if (cls) node.className = cls; return node;
  }
  function button(label, action) {
    const b = element('button', label); b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await action(); } catch (e) { message(e.message); }
      finally { b.disabled = false; }
    }); return b;
  }
  function draw(row, posts) {
    const card = element('article');
    card.append(element('h2', posts[row.post] || row.post), element('p', row.name + ' · ' + new Date(row.created_at).toLocaleString()),
      element('p', row.body, 'body'));
    const actions = element('div', '', 'toolbar');
    const change = async action => { await api('/api/admin/comments/' + row.id + '/' + action, {}); await load(); message('已保存。'); };
    if (row.status !== 'approved') actions.append(button('批准发布', () => change('approve')));
    if (row.status !== 'rejected') actions.append(button(row.status === 'approved' ? '隐藏评论' : '拒绝发布', () => change('reject')));
    actions.append(button('永久删除', async () => { if (confirm('永久删除此评论及其所有作者回复？')) await change('delete'); }));
    card.append(actions);
    for (const r of row.replies) card.append(element('p', '作者回复 · ' + new Date(r.created_at).toLocaleString() + '\n' + r.body, 'reply body'));
    if (row.status === 'approved') {
      const form = element('form'); const label = element('label', '以 Chenmin Sun 身份回复');
      const input = element('textarea'); input.id = 'reply-' + row.id; label.htmlFor = input.id;
      input.required = true; input.maxLength = 5000; input.rows = 4;
      const send = element('button', '发布作者回复'); form.append(label, input, send);
      form.addEventListener('submit', async event => {
        event.preventDefault(); send.disabled = true;
        try { await api('/api/admin/comments/' + row.id + '/reply', { body: input.value }); await load(); message('作者回复已发布。'); }
        catch (e) { message(e.message); } finally { send.disabled = false; }
      }); card.append(form);
    }
    return card;
  }
  async function load(append = false) {
    if (loading) return; loading = true;
    $('more').disabled = true; $('filter').disabled = true; $('refresh').disabled = true;
    try {
      const query = new URLSearchParams({ status: $('filter').value });
      if (append && next) query.set('cursor', next);
      const data = await api('/api/admin/comments?' + query);
      if (!append) $('list').replaceChildren();
      data.comments.forEach(row => $('list').append(draw(row, data.posts)));
      if (!append && !data.comments.length) $('list').append(element('p', '此状态下没有评论。'));
      next = data.next; $('more').hidden = !next;
      const count = Object.fromEntries(data.counts.map(row => [row.status, row.count]));
      $('counts').textContent = '待审核 ' + (count.pending || 0) + ' · 已发布 ' + (count.approved || 0) + ' · 已拒绝 / 已隐藏 ' + (count.rejected || 0);
    } finally { loading = false; $('more').disabled = false; $('filter').disabled = false; $('refresh').disabled = false; }
  }
  $('login').addEventListener('submit', async event => {
    event.preventDefault(); token = $('key').value.trim(); $('key').value = '';
    const submit = $('login').querySelector('button'); submit.disabled = true;
    try { await load(); $('dashboard').hidden = false; $('login').hidden = true; message('已登录。'); }
    catch (e) { token = ''; message(e.message); } finally { submit.disabled = false; }
  });
  $('logout').addEventListener('click', () => { logout(); message('已退出。'); });
  $('filter').addEventListener('change', () => load().catch(e => message(e.message)));
  $('refresh').addEventListener('click', () => load().catch(e => message(e.message)));
  $('more').addEventListener('click', () => load(true).catch(e => message(e.message)));
  window.addEventListener('pagehide', logout);
}
export const adminJS = '(' + adminClient.toString() + ')();';
export const adminCSS = `
:root{font-family:system-ui,sans-serif;color:#202c3c;background:#f6f8fb;line-height:1.7}
*{box-sizing:border-box}[hidden]{display:none!important}main{max-width:880px;margin:2rem auto;padding:1rem}
h1{font-size:1.8rem}h2{font-size:1.1rem}article{background:white;border:1px solid #dce2eb;border-radius:12px;padding:1.3rem;margin:1rem 0}
label{display:block}input,textarea,select,button{font:inherit}input,textarea{width:100%;padding:.6rem;border:1px solid #8a97aa;border-radius:6px}
button,select{padding:.45rem .8rem;margin:.3rem .3rem .3rem 0}button{cursor:pointer}button:disabled{cursor:wait;opacity:.6}
.toolbar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}.body{white-space:pre-wrap;overflow-wrap:anywhere}.reply{border-left:3px solid #2b5cab;padding-left:1rem}
#message{min-height:1.7em}form{margin-top:1rem} :focus-visible{outline:3px solid #2b5cab;outline-offset:3px}
`;
