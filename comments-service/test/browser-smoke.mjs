// Optional real-browser integration check. Requires Playwright + Chromium.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEnv, fakeTurnstile } from './helpers.mjs';
import worker from '../worker.mjs';

const env = makeEnv();
const nativeFetch = globalThis.fetch;
globalThis.fetch = (...args) => String(args[0]).startsWith('https://challenges.cloudflare.com/')
  ? fakeTurnstile() : nativeFetch(...args);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1080, height: 900 } });
const errors = [];
context.on('page', page => page.on('pageerror', e => errors.push(e.message)));
let configured = true;
const sitePath = '/chenminmath.github.io';
try {
  await context.route('https://challenges.cloudflare.com/**', route => route.fulfill({
    contentType: 'application/javascript', body: `window.turnstile={
      render(el,options){window.__captcha=options;options.callback(crypto.randomUUID());return 'widget';},
      reset(){setTimeout(()=>window.__captcha.callback(crypto.randomUUID()),0);}
    };`,
  }));
  await context.route('https://comments.example/**', async route => {
    const req = route.request();
    const response = await worker.fetch(new Request(req.url(), { method: req.method(),
      headers: { ...await req.allHeaders(), 'CF-Connecting-IP': '192.0.2.1' },
      ...(req.postData() ? { body: req.postData() } : {}) }), env);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await context.route(env.SITE_ORIGIN + '/**', async route => {
    const path = new URL(route.request().url()).pathname.slice(sitePath.length);
    if (path === '/assets/js/main.js') return route.fulfill({ contentType: 'application/javascript', body: '' });
    if (path === '/assets/js/comments-config.js') return route.fulfill({ contentType: 'application/javascript',
      body: `window.BLOG_COMMENTS={apiBase:${JSON.stringify(configured ? 'https://comments.example' : '')}};` });
    try {
      const body = await readFile(new URL('../..' + path, import.meta.url));
      await route.fulfill({ body, contentType: path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  const reader = await context.newPage();
  const url = env.SITE_ORIGIN + sitePath + '/blog/after-rh.html';
  await reader.goto(url);
  await reader.locator('#comment-name').fill('A reader');
  const xss = '<img src=x onerror="window.XSS=1">A comment awaiting approval.';
  await reader.locator('#comment-body').fill(xss);
  await reader.getByRole('button', { name: 'Submit for review' }).click();
  await reader.getByText('Thank you. Your comment is awaiting review and is not publicly visible yet.').waitFor();
  assert.equal(await reader.locator('.reader-comment').count(), 0);
  await reader.reload();
  await reader.locator('#comment-name').waitFor();
  assert.equal(await reader.locator('.reader-comment').count(), 0);

  const owner = await context.newPage(); await owner.goto('https://comments.example/admin');
  await owner.getByLabel('管理密钥').fill(env.ADMIN_TOKEN);
  await owner.getByRole('button', { name: '登录', exact: true }).click();
  await owner.getByRole('button', { name: '批准发布' }).waitFor();
  assert.equal(await owner.locator('#list article').count(), 1);
  await owner.getByRole('button', { name: '批准发布' }).click();
  await owner.getByText('已保存。', { exact: true }).waitFor();
  await owner.locator('#filter').selectOption('approved');
  await owner.getByLabel('以 Chenmin Sun 身份回复').fill('Thank you for reading.');
  await owner.getByRole('button', { name: '发布作者回复' }).click();
  await owner.getByText('作者回复已发布。', { exact: true }).waitFor();
  await reader.reload(); await reader.locator('.reader-comment').waitFor();
  assert.equal(await reader.locator('.reader-comment .comment-text').first().textContent(), xss);
  assert.equal(await reader.locator('.reader-comment img').count(), 0);
  assert.equal(await reader.evaluate(() => window.XSS), undefined);
  assert.equal(await reader.locator('.author-reply h4').textContent(), 'Chenmin Sun · Author');
  assert.equal(await reader.locator('.author-reply .comment-text').textContent(), 'Thank you for reading.');
  assert.equal(await owner.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await reader.setViewportSize({ width: 390, height: 844 });
  assert.ok(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.COMMENTS_SCREENSHOT_DIR) {
    await reader.locator('[data-comments]').screenshot({ path: process.env.COMMENTS_SCREENSHOT_DIR + '/reader.png' });
    await owner.screenshot({ path: process.env.COMMENTS_SCREENSHOT_DIR + '/admin.png', fullPage: true });
  }
  await owner.getByRole('button', { name: '隐藏评论' }).click();
  await owner.getByText('已保存。', { exact: true }).waitFor();
  await reader.reload(); await reader.locator('#comment-name').waitFor();
  assert.equal(await reader.locator('.reader-comment').count(), 0);
  await owner.getByRole('button', { name: '退出', exact: true }).click();
  assert.equal(await owner.locator('#key').inputValue(), '');
  configured = false;
  await reader.reload();
  assert.equal(await reader.locator('[data-comments]').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Browser passed: anonymous submission → private queue → owner approval → public author reply → hide; mobile layout, XSS, logout, disabled draft.');
} finally {
  globalThis.fetch = nativeFetch; await browser.close(); env.sqlite.close();
}
