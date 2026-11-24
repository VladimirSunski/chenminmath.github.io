import { posts } from './posts.mjs';
import { adminHTML, adminJS, adminCSS } from './admin-page.mjs';

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set(['pending', 'approved', 'rejected']);
const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

class HTTPError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new HTTPError(status, message); }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: API_HEADERS });
}
function siteOrigin(env) {
  const u = new URL(env.SITE_ORIGIN);
  if (u.protocol !== 'https:' || u.origin !== env.SITE_ORIGIN) fail(503, 'Service is not configured.');
  return u.origin;
}
function ready(env) {
  return Boolean(env.DB && env.ADMIN_TOKEN?.length >= 43 && env.TURNSTILE_SECRET_KEY &&
    env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SITE_KEY.startsWith('REPLACE_'));
}
function checkPost(post) {
  if (!Object.hasOwn(posts, post || '')) fail(404, 'Unknown article.');
  return post;
}
function text(value, max) {
  if (typeof value !== 'string') fail(400, 'Please enter text.');
  const s = value.trim();
  if (!s || s.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(s))
    fail(400, `Text must contain between 1 and ${max} characters.`);
  return s;
}
async function readJSON(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || ''))
    fail(415, 'JSON is required.');
  if (!request.body) fail(400, 'Request body is required.');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32768) { await reader.cancel(); fail(413, 'Request is too large.'); }
    chunks.push(value);
  }
  const joined = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { joined.set(c, offset); offset += c.length; }
  try {
    const data = JSON.parse(new TextDecoder().decode(joined));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch { fail(400, 'Invalid JSON.'); }
}
async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
async function authenticate(request, env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 43) fail(503, 'Administration is not configured.');
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ') || header.length > 512) fail(401, 'Invalid administration key.');
  const [actual, expected] = await Promise.all([digest(header.slice(7)), digest(env.ADMIN_TOKEN)]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual[i] ^ expected[i];
  if (difference) fail(401, 'Invalid administration key.');
}
async function quota(env, label, value, max, seconds) {
  // Store only a keyed digest, never the raw IP. Old rate-limit data expires.
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.ADMIN_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(`${label}:${value}`));
  const hash = Array.from(new Uint8Array(signed), b => b.toString(16).padStart(2, '0')).join('');
  const bucket = Math.floor(Date.now() / (seconds * 1000)) * seconds;
  const row = await env.DB.prepare(`INSERT INTO rate_limits(key,bucket,count) VALUES(?,?,1)
    ON CONFLICT(key,bucket) DO UPDATE SET count=count+1 RETURNING count`).bind(hash, bucket).first();
  if (row.count > max) fail(429, 'Too many attempts. Please try again later.');
}
function encodeCursor(row, field) { return btoa(JSON.stringify([row[field], row.id])); }
function cursor(url) {
  const c = url.searchParams.get('cursor');
  if (!c) return null;
  try {
    if (c.length > 256) throw new Error();
    const pair = JSON.parse(atob(c));
    if (!Array.isArray(pair) || pair.length !== 2 || !UUID.test(pair[1]) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(pair[0])) throw new Error();
    return pair;
  } catch { fail(400, 'Invalid page cursor.'); }
}
async function listPublic(url, env) {
  const post = checkPost(url.searchParams.get('post'));
  const after = cursor(url);
  const args = [post];
  let condition = '';
  if (after) { condition = 'AND (published_at > ? OR (published_at = ? AND id > ?))'; args.push(after[0], after[0], after[1]); }
  const { results } = await env.DB.prepare(`SELECT id,name,body,created_at,published_at
    FROM comments WHERE post=? AND status='approved' ${condition}
    ORDER BY published_at,id LIMIT 51`).bind(...args).all();
  const rows = results.slice(0, 50);
  if (rows.length) {
    const replies = await env.DB.prepare(`SELECT id,comment_id,body,created_at FROM replies
      WHERE comment_id IN (${rows.map(() => '?').join(',')}) ORDER BY created_at,id`)
      .bind(...rows.map(r => r.id)).all();
    for (const row of rows) row.replies = replies.results.filter(r => r.comment_id === row.id)
      .map(({ comment_id, ...r }) => ({ ...r, author: env.AUTHOR_NAME || 'Chenmin Sun' }));
  }
  return json({ comments: rows, next: results.length > 50 ? encodeCursor(rows.at(-1), 'published_at') : null });
}
async function submit(request, env) {
  if (!ready(env)) fail(503, 'Comments are not available yet.');
  const data = await readJSON(request);
  const post = checkPost(data.post);
  const name = text(data.name, 80);
  const body = text(data.body, 5000);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  await quota(env, 'submission', ip, 5, 3600);
  if (data.website) return json({ pending: true }, 202); // Honeypot: no record is stored.
  if (typeof data.token !== 'string' || !data.token || data.token.length > 2048)
    fail(400, 'Please complete the anti-spam check.');
  let verification;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: data.token, remoteip: ip }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    verification = await response.json();
  } catch { fail(503, 'Anti-spam service is unavailable. Please try again.'); }
  if (!verification.success || verification.hostname !== new URL(siteOrigin(env)).hostname ||
    verification.action !== 'blog-comment') fail(400, 'Anti-spam check expired or failed. Please try again.');
  // Turnstile replay detection is eventually consistent; enforce single-use here too.
  const tokenDigest = Array.from(await digest(data.token), b => b.toString(16).padStart(2, '0')).join('');
  const claimed = await env.DB.prepare('INSERT OR IGNORE INTO used_tokens(digest,created_at) VALUES(?,?)')
    .bind(tokenDigest, Math.floor(Date.now() / 1000)).run();
  if (!claimed.meta.changes) fail(400, 'Anti-spam check has already been used. Please try again.');
  await quota(env, 'global-submission', 'all', 1000, 86400);
  await env.DB.prepare(`INSERT INTO comments(id,post,name,body,status,created_at)
    VALUES(?,?,?,?,'pending',?)`).bind(crypto.randomUUID(), post, name, body, new Date().toISOString()).run();
  // Never echo a private comment or a moderation identifier into a public response.
  return json({ pending: true }, 202);
}
async function adminList(url, env) {
  const status = url.searchParams.get('status') || 'pending';
  if (!STATUSES.has(status)) fail(400, 'Invalid status.');
  const before = cursor(url); const args = [status];
  let condition = '';
  if (before) { condition = 'AND (created_at < ? OR (created_at = ? AND id < ?))'; args.push(before[0], before[0], before[1]); }
  const { results } = await env.DB.prepare(`SELECT id,post,name,body,status,created_at,published_at
    FROM comments WHERE status=? ${condition} ORDER BY created_at DESC,id DESC LIMIT 51`).bind(...args).all();
  const rows = results.slice(0, 50);
  for (const row of rows) {
    const r = await env.DB.prepare('SELECT id,body,created_at FROM replies WHERE comment_id=? ORDER BY created_at,id').bind(row.id).all();
    row.replies = r.results;
  }
  const counts = await env.DB.prepare('SELECT status,COUNT(*) AS count FROM comments GROUP BY status').all();
  return json({ comments: rows, counts: counts.results, posts,
    next: results.length > 50 ? encodeCursor(rows.at(-1), 'created_at') : null });
}
async function adminChange(request, env, id, action) {
  if (!UUID.test(id)) fail(404, 'Comment not found.');
  const row = await env.DB.prepare('SELECT id,status FROM comments WHERE id=?').bind(id).first();
  if (!row) fail(404, 'Comment not found.');
  if (action === 'approve') {
    await env.DB.prepare(`UPDATE comments SET status='approved',published_at=COALESCE(published_at,?) WHERE id=?`)
      .bind(new Date().toISOString(), id).run();
  } else if (action === 'reject') {
    await env.DB.prepare("UPDATE comments SET status='rejected' WHERE id=?").bind(id).run();
  } else if (action === 'reply') {
    const data = await readJSON(request);
    const body = text(data.body, 5000);
    // INSERT SELECT rechecks status atomically if a second admin tab hides the comment.
    const result = await env.DB.prepare(`INSERT INTO replies(id,comment_id,body,created_at)
      SELECT ?,id,?,? FROM comments WHERE id=? AND status='approved'`)
      .bind(crypto.randomUUID(), body, new Date().toISOString(), id).run();
    if (!result.meta.changes) fail(409, 'Approve the comment before replying.');
  } else if (action === 'delete') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM replies WHERE comment_id=?').bind(id),
      env.DB.prepare('DELETE FROM comments WHERE id=?').bind(id),
    ]);
  } else fail(404, 'Unknown action.');
  return json({ ok: true });
}
function asset(content, type) {
  return new Response(content, { headers: {
    'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  } });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    try {
      const allowed = siteOrigin(env);
      const origin = request.headers.get('Origin');
      // The admin UI runs on this Worker's origin. No wildcard CORS, cookies or query-string credentials.
      if (origin && origin !== allowed && origin !== url.origin) fail(403, 'Origin not allowed.');
      if (request.method === 'OPTIONS') {
        response = new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Cache-Control': 'no-store',
        } });
      } else if (url.pathname.startsWith('/api/admin/')) {
        if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 43) fail(503, 'Administration is not configured.');
        await quota(env, 'admin', request.headers.get('CF-Connecting-IP') || 'unknown', 200, 900);
        await authenticate(request, env);
        if (url.pathname === '/api/admin/comments' && request.method === 'GET') response = await adminList(url, env);
        else {
          const match = url.pathname.match(/^\/api\/admin\/comments\/([^/]+)\/(approve|reject|reply|delete)$/);
          if (!match || request.method !== 'POST') fail(404, 'Route not found.');
          response = await adminChange(request, env, match[1], match[2]);
        }
      } else if (url.pathname === '/api/config' && request.method === 'GET') {
        response = json({ enabled: ready(env), siteKey: ready(env) ? env.TURNSTILE_SITE_KEY : null });
      } else if (url.pathname === '/api/comments' && request.method === 'GET') {
        if (!env.DB) fail(503, 'Service is not configured.');
        response = await listPublic(url, env);
      } else if (url.pathname === '/api/comments' && request.method === 'POST') {
        if (origin !== allowed) fail(403, 'Submit from the blog page.');
        response = await submit(request, env);
      } else if (url.pathname === '/admin' && request.method === 'GET') response = asset(adminHTML, 'text/html');
      else if (url.pathname === '/admin.js' && request.method === 'GET') response = asset(adminJS, 'text/javascript');
      else if (url.pathname === '/admin.css' && request.method === 'GET') response = asset(adminCSS, 'text/css');
      else fail(404, 'Route not found.');
    } catch (error) {
      // Do not log requests, comment text, keys, or captcha tokens.
      response = json({ error: error instanceof HTTPError ? error.message : 'Service unavailable. Please try again.' },
        error instanceof HTTPError ? error.status : 503);
    }
    if (request.headers.get('Origin') === env.SITE_ORIGIN) response.headers.set('Access-Control-Allow-Origin', env.SITE_ORIGIN);
    response.headers.set('Vary', 'Origin');
    return response;
  },
  async scheduled(_event, env) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM rate_limits WHERE bucket < ?').bind(Math.floor(Date.now() / 1000) - 7 * 86400),
      env.DB.prepare('DELETE FROM used_tokens WHERE created_at < ?').bind(Math.floor(Date.now() / 1000) - 86400),
    ]);
  },
};
