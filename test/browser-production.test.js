const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-production-test-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-production-data-'));
process.env.JWT_SECRET = 'production-test-secret';
process.env.AUTH_LIMIT = '1000';
process.env.NODE_ENV = 'production';
delete process.env.SEED_DEMO;
const app = require('../server');
const { chromium } = require('playwright-core');

const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const executablePath = candidates.find(p => p && fs.existsSync(p));
const browserOptions = executablePath ? { timeout: 30000 } : { skip: 'Chrome or Edge not found' };

let srv, base, browser;
const contexts = [];
before(async () => {
  await new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}`; r(); }); });
  if (executablePath) browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  if (browser) await browser.close();
  if (srv) srv.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {}
});

test('production does not seed the demo account or advertise it', async () => {
  assert.deepEqual(await fetch(base + '/api/config').then(r => r.json()), { demoEnabled: false });
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@family.test', password: 'demo1234' })
  });
  assert.equal(login.status, 401);
});

test('the production login page does not show demo credentials', browserOptions, async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  contexts.push(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/#/');
  await page.waitForFunction(() => document.querySelector('#app h2')?.textContent.trim() === 'Welcome back');
  const text = await page.locator('#app').innerText();
  assert.doesNotMatch(text, /demo@family\.test|demo1234/);
  assert.deepEqual(await page.evaluate(() => fetch('/api/config').then(r => r.json())), { demoEnabled: false });
  assert.deepEqual(errors, []);
});
