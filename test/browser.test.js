const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-browser-test-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-browser-data-'));
process.env.AUTH_LIMIT = '1000';
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

let srv, base, token, browser;
const contexts = [];
const delay = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  await new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}`; r(); }); });
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@family.test', password: 'demo1234' }) });
  token = (await login.json()).token;
  if (executablePath) browser = await chromium.launch({ executablePath, headless: true });
});

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  if (browser) await browser.close();
  if (srv) srv.close();
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {}
});

async function open(hash = '#/', setup) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  contexts.push(context);
  await context.addInitScript(t => localStorage.setItem('tok', t), token);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (setup) await setup(page);
  await page.goto(base + '/' + hash);
  await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0);
  return { page, errors };
}

const heading = text => page => page.waitForFunction(t => document.querySelector('#app h2')?.textContent.trim() === t, text);
const appText = page => page.locator('#app').innerText();
const clean = async (page, errors) => {
  assert.doesNotMatch(await appText(page), /That didn't work/);
  assert.deepEqual(errors, []);
};

test('person route renders and updates the header title', browserOptions, async () => {
  const { page, errors } = await open('#/t/1/p/4');
  await heading('Rosalind Whitmore')(page);
  assert.equal(await page.textContent('#title'), 'The Whitmore Family');
  await clean(page, errors);
});

test('normal navigation between routes stays clean', browserOptions, async () => {
  const { page, errors } = await open('#/');
  await heading('My Family Trees')(page);
  for (const [hash, title] of [['#/t/1', 'Where our family begins'], ['#/t/1/p/4', 'Rosalind Whitmore'], ['#/t/1/chart', 'Family chart'], ['#/t/1/insights', 'Family insights'], ['#/t/1/gc', 'The grandchildren'], ['#/account', 'Your account'], ['#/', 'My Family Trees']]) {
    await page.evaluate(h => { location.hash = h; }, hash);
    await heading(title)(page);
    await clean(page, errors);
  }
});

test('rapid route changes ignore late responses from obsolete views', browserOptions, async () => {
  const { page, errors } = await open('#/t/1/p/4', page => page.route(/\/api\/(?:trees\/1\?depth=|people\/\d+\/relatives)/, async route => {
    await delay(250);
    await route.continue();
  }));
  await heading('Rosalind Whitmore')(page);
  await page.evaluate(() => {
    location.hash = '#/t/1/chart';
    setTimeout(() => { location.hash = '#/t/1/insights'; }, 20);
    setTimeout(() => { location.hash = '#/'; }, 40);
  });
  await heading('My Family Trees')(page);
  await delay(500);
  await heading('My Family Trees')(page);
  await clean(page, errors);
});

test('relationship finder does not update a removed view after navigation', browserOptions, async () => {
  const { page, errors } = await open('#/t/1/p/4', page => page.route(/\/api\/people\/\d+\/related\/\d+/, async route => {
    await delay(400);
    await route.continue();
  }));
  await heading('Rosalind Whitmore')(page);
  await page.fill('#rq', 'Nora');
  await page.waitForSelector('#rres button');
  await page.click('#rres button');
  await page.evaluate(() => { location.hash = '#/t/1/insights'; });
  await heading('Family insights')(page);
  await delay(600);
  await heading('Family insights')(page);
  await clean(page, errors);
});

test('a route with no active nav item is tolerated', browserOptions, async () => {
  const { page, errors } = await open('#/forgot');
  await heading('Forgot your password?')(page);
  assert.equal(await page.locator('#nav [aria-current="page"]').count(), 0);
  await clean(page, errors);
});
