import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.mjs';

// A D1-shaped adapter backed by real SQLite, not hand-written query mocks.
export function makeEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_comments.sql', import.meta.url), 'utf8'));
  function prepare(sql) {
    let values = [];
    const statement = {
      bind(...args) { values = args; return statement; },
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
    };
    return statement;
  }
  return {
    DB: { prepare, async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    } },
    ADMIN_TOKEN: 'TEST-ONLY-' + 'x'.repeat(48),
    TURNSTILE_SECRET_KEY: 'TEST-ONLY-SECRET', TURNSTILE_SITE_KEY: 'TEST-ONLY-SITE-KEY',
    SITE_ORIGIN: 'https://vladimirsunski.github.io', AUTHOR_NAME: 'Chenmin Sun',
    sqlite,
  };
}
export async function call(env, path, { body, admin = false, method, headers = {} } = {}) {
  const request = new Request('https://comments.example' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { Origin: env.SITE_ORIGIN, 'CF-Connecting-IP': '192.0.2.1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(admin ? { Authorization: 'Bearer ' + env.ADMIN_TOKEN } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await worker.fetch(request, env);
  return { response, status: response.status, data: await response.json() };
}
export function fakeTurnstile() {
  return Promise.resolve(new Response(JSON.stringify({ success: true, hostname: 'vladimirsunski.github.io', action: 'blog-comment' }),
    { headers: { 'Content-Type': 'application/json' } }));
}
export function commentBody(overrides = {}) {
  return { post: 'after-rh', name: 'Reader', body: 'A thoughtful comment.', token: crypto.randomUUID(), website: '', ...overrides };
}
