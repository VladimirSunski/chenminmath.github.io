(() => {
  'use strict';
  const root = document.querySelector('[data-comments]');
  const configured = window.BLOG_COMMENTS?.apiBase;
  if (!root || !configured) return; // Draft: no broken form before service activation.
  let base;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return;
    base = url.origin;
  } catch { return; }
  const post = root.dataset.post;
  function node(tag, text, cls) {
    const n = document.createElement(tag); if (text) n.textContent = text;
    if (cls) n.className = cls; return n;
  }
  const heading = node('h2', 'Comments'); heading.id = 'comments-title';
  root.append(heading); root.hidden = false;
  const note = node('p', 'Comments are reviewed by the author before publication. You do not need an account.');
  const status = node('p', '', 'comments-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const list = node('div', '', 'comments-list');
  const more = node('button', 'Load more comments'); more.type = 'button'; more.hidden = true;
  const retry = node('button', 'Retry'); retry.type = 'button'; retry.hidden = true;
  root.append(note, list, more, retry, status);
  let next = null; let fetching = false;
  async function api(path, body) {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Comments are temporarily unavailable.');
    return data;
  }
  function date(value) { return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  function render(comment) {
    const article = node('article', '', 'reader-comment');
    // Always render reader text with textContent, never HTML/Markdown.
    article.append(node('h3', comment.name), node('p', date(comment.created_at), 'comment-date'), node('p', comment.body, 'comment-text'));
    for (const r of comment.replies || []) {
      const reply = node('div', '', 'author-reply');
      reply.append(node('h4', r.author + ' · Author'), node('p', date(r.created_at), 'comment-date'), node('p', r.body, 'comment-text'));
      article.append(reply);
    }
    return article;
  }
  async function load(append = false) {
    if (fetching) return; fetching = true; more.disabled = true; retry.hidden = true;
    try {
      const query = new URLSearchParams({ post }); if (append && next) query.set('cursor', next);
      const data = await api('/api/comments?' + query);
      if (!append) list.replaceChildren();
      data.comments.forEach(c => list.append(render(c)));
      if (!append && !data.comments.length) list.append(node('p', 'No published comments yet.'));
      next = data.next; more.hidden = !next;
    } catch (e) { status.textContent = e.message; retry.hidden = false; }
    finally { fetching = false; more.disabled = false; }
  }
  more.addEventListener('click', () => load(true)); retry.addEventListener('click', () => load(Boolean(next)));
  load();
  async function formSetup() {
    const config = await api('/api/config');
    if (!config.enabled || !config.siteKey) { status.textContent = 'Comment submission is not available yet.'; return; }
    const form = node('form', '', 'comment-form');
    function input(labelText, id, type, max) {
      const label = node('label', labelText); label.htmlFor = id;
      const control = node(type === 'textarea' ? 'textarea' : 'input');
      control.id = id; control.name = id; control.required = true; control.maxLength = max;
      if (type === 'textarea') control.rows = 6; else { control.type = type; control.autocomplete = 'nickname'; }
      form.append(label, control); return control;
    }
    const name = input('Display name (public)', 'comment-name', 'text', 80);
    const body = input('Comment (up to 5,000 characters)', 'comment-body', 'textarea', 5000);
    const trapWrap = node('div', '', 'comment-honeypot'); trapWrap.setAttribute('aria-hidden', 'true');
    const trapLabel = node('label', 'Leave this field empty'); trapLabel.htmlFor = 'comment-website';
    const trap = node('input'); trap.type = 'text'; trap.id = 'comment-website'; trap.name = 'website'; trap.tabIndex = -1; trap.autocomplete = 'off';
    trapWrap.append(trapLabel, trap); form.append(trapWrap);
    const privacy = node('p', 'Your display name and comment become public only after approval. Please do not include private information. An anti-spam check is provided by Cloudflare.');
    const terms = node('a', 'Cloudflare privacy policy'); terms.href = 'https://www.cloudflare.com/privacypolicy/'; terms.rel = 'noopener noreferrer';
    privacy.append(document.createTextNode(' '), terms); form.append(privacy);
    const challenge = node('div'); form.append(challenge);
    const send = node('button', 'Submit for review'); send.type = 'submit'; send.disabled = true;
    const result = node('p'); result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
    form.append(send, result); root.append(form);
    let captchaToken = ''; let widget = null; let busy = false;
    function reset() { captchaToken = ''; send.disabled = true; if (widget !== null) window.turnstile.reset(widget); }
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!captchaToken || busy) return;
      busy = true; send.disabled = true; result.textContent = 'Submitting…';
      try {
        await api('/api/comments', { post, name: name.value, body: body.value, website: trap.value, token: captchaToken });
        body.value = ''; trap.value = '';
        result.textContent = 'Thank you. Your comment is awaiting review and is not publicly visible yet.';
        // Deliberately do not add the pending comment to the public list.
      } catch (e) { result.textContent = e.message; }
      finally { busy = false; reset(); }
    });
    const script = node('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true;
    script.onload = () => {
      try {
        widget = window.turnstile.render(challenge, { sitekey: config.siteKey, action: 'blog-comment',
          callback: token => { captchaToken = token; send.disabled = busy; },
          'expired-callback': () => { captchaToken = ''; send.disabled = true; },
          'error-callback': () => { captchaToken = ''; send.disabled = true; result.textContent = 'Anti-spam check failed. Please reload and try again.'; },
        });
      } catch { result.textContent = 'Unable to load the anti-spam check. Please try again.'; }
    };
    script.onerror = () => { result.textContent = 'Unable to load the anti-spam check. Please try again.'; };
    document.head.append(script);
  }
  formSetup().catch(e => { status.textContent = e.message; });
})();
