import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, fakeTurnstile, commentBody } from './helpers.mjs';
import worker from '../worker.mjs';

test('full workflow: private submission, owner approval, author reply, hide and delete', async t => {
  t.mock.method(globalThis, 'fetch', fakeTurnstile);
  const env = makeEnv(); t.after(() => env.sqlite.close());
  const submission = await call(env, '/api/comments', { body: commentBody({ status: 'approved', author: true }) });
  assert.equal(submission.status, 202); assert.deepEqual(submission.data, { pending: true });
  assert.deepEqual((await call(env, '/api/comments?post=after-rh')).data.comments, []);
  const pending = await call(env, '/api/admin/comments', { admin: true });
  assert.equal(pending.data.comments.length, 1); const id = pending.data.comments[0].id;
  assert.equal(pending.data.comments[0].status, 'pending');
  assert.equal((await call(env, `/api/admin/comments/${id}/reply`, { admin: true, body: { body: 'Too early.' } })).status, 409);
  assert.equal((await call(env, `/api/admin/comments/${id}/approve`, { body: {} })).status, 401);
  assert.equal((await call(env, `/api/admin/comments/${id}/approve`, { admin: true, body: {} })).status, 200);
  assert.equal((await call(env, `/api/admin/comments/${id}/reply`, { admin: true, body: { body: 'Thank you.', author: 'Impersonator' } })).status, 200);
  const published = (await call(env, '/api/comments?post=after-rh')).data.comments;
  assert.equal(published.length, 1); assert.equal(published[0].replies[0].author, 'Chenmin Sun');
  assert.equal(published[0].replies[0].body, 'Thank you.');
  assert.equal('status' in published[0], false);
  assert.equal((await call(env, '/api/comments?post=nothing-more-than-tools')).data.comments.length, 0);
  await call(env, `/api/admin/comments/${id}/reject`, { admin: true, body: {} });
  assert.equal((await call(env, '/api/comments?post=after-rh')).data.comments.length, 0);
  await call(env, `/api/admin/comments/${id}/delete`, { admin: true, body: {} });
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 0);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM replies').get().n, 0);
});

test('moderation reads/writes require the real key, even with no Origin header', async t => {
  const env = makeEnv(); t.after(() => env.sqlite.close());
  assert.equal((await call(env, '/api/admin/comments')).status, 401);
  assert.equal((await call(env, '/api/admin/comments', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await call(env, '/api/admin/comments', { admin: true, headers: { Origin: 'https://attacker.example' } })).status, 403);
  const response = await worker.fetch(new Request('https://comments.example/api/admin/comments'), env);
  assert.equal(response.status, 401);
  const page = await worker.fetch(new Request('https://comments.example/admin'), env);
  assert.equal(page.status, 200); assert.ok(!String(await page.text()).includes(env.ADMIN_TOKEN));
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
});

test('invalid/missing config fails closed; no public response contains credentials', async t => {
  const env = makeEnv(); t.after(() => env.sqlite.close());
  let result = await call(env, '/api/config');
  assert.deepEqual(result.data, { enabled: true, siteKey: env.TURNSTILE_SITE_KEY });
  assert.ok(!JSON.stringify(result.data).includes(env.ADMIN_TOKEN));
  env.TURNSTILE_SECRET_KEY = '';
  assert.equal((await call(env, '/api/comments', { body: commentBody() })).status, 503);
  assert.equal((await call(env, '/api/config')).data.enabled, false);
  env.ADMIN_TOKEN = 'short'; assert.equal((await call(env, '/api/admin/comments', { admin: true })).status, 503);
});

test('captcha checked server-side, including action and hostname; no private data leaked', async t => {
  const env = makeEnv(); t.after(() => env.sqlite.close());
  const mock = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(JSON.stringify({ success: true, hostname: 'attacker.example', action: 'blog-comment' }))));
  assert.equal((await call(env, '/api/comments', { body: commentBody() })).status, 400);
  mock.mock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ success: true, hostname: 'vladimirsunski.github.io', action: 'different-action' }))));
  assert.equal((await call(env, '/api/comments', { body: commentBody() })).status, 400);
  assert.equal((await call(env, '/api/comments', { body: commentBody({ token: '' }) })).status, 400);
  mock.mock.mockImplementation(() => Promise.reject(new Error('network down')));
  assert.equal((await call(env, '/api/comments', { body: commentBody() })).status, 503);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 0);
});

test('validation, injection attempts and size limits', async t => {
  t.mock.method(globalThis, 'fetch', fakeTurnstile);
  const env = makeEnv(); t.after(() => env.sqlite.close());
  for (const body of [commentBody({ post: '__proto__' }), commentBody({ post: "x' OR 1=1--" })])
    assert.equal((await call(env, '/api/comments', { body })).status, 404);
  for (const body of [commentBody({ name: '' }), commentBody({ body: 'x'.repeat(5001) }), commentBody({ name: '<script>\u0000' })])
    assert.equal((await call(env, '/api/comments', { body })).status, 400);
  assert.equal((await call(env, '/api/comments', { body: commentBody({ body: 'x'.repeat(40000) }) })).status, 413);
  assert.equal((await call(env, '/api/comments?post=after-rh&cursor=invalid')).status, 400);
  const injection = "<img src=x onerror=alert(1)> '); DROP TABLE comments;--";
  assert.equal((await call(env, '/api/comments', { body: commentBody({ body: injection }) })).status, 202);
  assert.equal(env.sqlite.prepare('SELECT body FROM comments').get().body, injection);
  assert.equal((await call(env, '/api/comments?post=after-rh')).data.comments.length, 0);
});

test('rate limiting, honeypot and expiry cleanup', async t => {
  t.mock.method(globalThis, 'fetch', fakeTurnstile);
  const env = makeEnv(); t.after(() => env.sqlite.close());
  assert.equal((await call(env, '/api/comments', { body: commentBody({ website: 'spam' }) })).status, 202);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 0);
  for (let i = 0; i < 4; i++) assert.equal((await call(env, '/api/comments', { body: commentBody() })).status, 202);
  assert.equal((await call(env, '/api/comments', { body: commentBody() })).status, 429);
  assert.ok(!JSON.stringify(env.sqlite.prepare('SELECT * FROM rate_limits').all()).includes('192.0.2.1'));
  env.sqlite.prepare('INSERT INTO rate_limits VALUES(?,?,?)').run('old', 1, 1);
  await worker.scheduled(null, env);
  assert.equal(env.sqlite.prepare("SELECT * FROM rate_limits WHERE key='old'").get(), undefined);
});

test('even concurrently accepted captcha tokens cannot be used twice', async t => {
  t.mock.method(globalThis, 'fetch', fakeTurnstile);
  const env = makeEnv(); t.after(() => env.sqlite.close());
  const payload = commentBody();
  const results = await Promise.all([call(env, '/api/comments', { body: payload }), call(env, '/api/comments', { body: payload })]);
  assert.deepEqual(results.map(r => r.status).sort(), [202, 400]);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 1);
  assert.ok(!JSON.stringify(env.sqlite.prepare('SELECT * FROM used_tokens').all()).includes(payload.token));
});

test('public pagination stays article-scoped and excludes pending/rejected records and replies', async t => {
  const env = makeEnv(); t.after(() => env.sqlite.close());
  const insert = env.sqlite.prepare('INSERT INTO comments VALUES(?,?,?,?,?,?,?)');
  const ids = [];
  for (let i = 0; i < 60; i++) {
    const id = crypto.randomUUID(); ids.push(id);
    insert.run(id, 'after-rh', 'Reader', 'Published ' + i, 'approved', '2026-11-20T00:00:00.000Z', '2026-11-24T00:00:00.000Z');
  }
  for (const status of ['pending', 'rejected']) insert.run(crypto.randomUUID(), 'after-rh', 'Secret', 'PRIVATE', status, '2026-11-20T00:00:00.000Z', null);
  insert.run(crypto.randomUUID(), 'nothing-more-than-tools', 'Other article', 'OTHER', 'approved', '2026-11-20T00:00:00.000Z', '2026-11-24T00:00:00.000Z');
  const first = await call(env, '/api/comments?post=after-rh'); assert.equal(first.data.comments.length, 50);
  const second = await call(env, '/api/comments?post=after-rh&cursor=' + encodeURIComponent(first.data.next));
  assert.equal(second.data.comments.length, 10); assert.equal(second.data.next, null);
  assert.equal(new Set([...first.data.comments, ...second.data.comments].map(r => r.id)).size, 60);
  assert.ok(!JSON.stringify([first.data, second.data]).includes('PRIVATE'));
});

test('CORS and browser submission policy', async t => {
  const env = makeEnv(); t.after(() => env.sqlite.close());
  const ok = await call(env, '/api/comments?post=after-rh');
  assert.equal(ok.response.headers.get('Access-Control-Allow-Origin'), env.SITE_ORIGIN);
  assert.equal(ok.response.headers.get('Cache-Control'), 'no-store');
  const evil = await call(env, '/api/comments?post=after-rh', { headers: { Origin: 'https://attacker.example' } });
  assert.equal(evil.status, 403); assert.equal(evil.response.headers.has('Access-Control-Allow-Origin'), false);
  const preflight = await worker.fetch(new Request('https://comments.example/api/comments', { method: 'OPTIONS', headers: { Origin: env.SITE_ORIGIN } }), env);
  assert.equal(preflight.status, 204);
  const missingOrigin = await worker.fetch(new Request('https://comments.example/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env);
  assert.equal(missingOrigin.status, 403);
});
