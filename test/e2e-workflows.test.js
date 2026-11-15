// End-to-end browser workflows for the Family Tree app.
//
// These tests drive the real UI in real Chrome/Edge (playwright-core) against a
// disposable SQLite database. They are intentionally separate from the API-level
// tests: each assertion here follows user-visible behaviour (clicks, forms,
// navigation, downloads), and console/page errors fail the workflow.
//
// Run all available browsers:        node --test test/e2e-workflows.test.js
// Run one browser:                   set E2E_BROWSERS=chrome & node --test ...
// (PowerShell: $env:E2E_BROWSERS='chrome'; node --test test/e2e-workflows.test.js)
//
// Fixtures create fresh accounts/trees through the API; anything a user would do
// in the workflow is performed through the page. The one exception is the
// invitation-acceptance test, where the emailed token is inserted directly
// (simulating the email link) because raw invite tokens are never returned by
// the API by design.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

process.env.DB = path.join(os.tmpdir(), `ft-e2e-test-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-e2e-data-'));
process.env.AUTH_LIMIT = '1000';
process.env.JWT_SECRET = 'e2e-test-secret';

const app = require('../server');
const { chromium } = require('playwright-core');
const Database = require('better-sqlite3');

const SHOT_DIR = 'e2e-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const BROWSER_DEFS = [
  {
    name: 'chrome',
    paths: [
      process.env.CHROME_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
  },
  {
    name: 'edge',
    paths: [
      process.env.EDGE_PATH,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  },
];
const wanted = (process.env.E2E_BROWSERS || 'chrome,edge').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const available = BROWSER_DEFS
  .filter(d => wanted.includes(d.name))
  .map(d => ({ name: d.name, executablePath: d.paths.find(p => { try { return !!p && fs.existsSync(p); } catch { return false; } }) }))
  .filter(d => !!d.executablePath);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAIUdJ4AAAAABJRU5ErkJggg==', 'base64');
const GEDCOM_HOME = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '0 @I1@ INDI', '1 NAME Imported /Home Person/', '1 SEX F', '1 BIRT', '2 DATE 12 APR 1901', '0 TRLR', ''].join('\n');
const GEDCOM_MERGE = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '0 @I1@ INDI', '1 NAME Imported /Merge Person/', '1 SEX M', '1 BIRT', '2 DATE 1911', '0 TRLR', ''].join('\n');

let srv, base, browserMap = new Map(), dbConn = null;
const contexts = [];
let accountSeq = 0;

const delay = ms => new Promise(r => setTimeout(r, ms));

function slug(s) { return String(s).replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase().slice(0, 70); }
function uniqueEmail() { return `e2e-${Date.now().toString(36)}-${++accountSeq}@family.test`; }

async function api(pathname, method = 'GET', body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

async function newAccount(name) {
  const email = uniqueEmail();
  const r = await api('/api/auth/register', 'POST', { email, password: 'password1', name });
  assert.equal(r.status, 200, `register fixture failed: ${JSON.stringify(r.data)}`);
  return { email, password: 'password1', token: r.data.token, id: r.data.user.id, name };
}

async function createTree(token, name, rootName, root = {}) {
  const r = await api('/api/trees', 'POST', { name, root: { name: rootName, gender: 'Female', dob: '1950-05-02', ...root } }, token);
  assert.equal(r.status, 200, `tree fixture failed: ${JSON.stringify(r.data)}`);
  return r.data.id;
}

async function addPerson(token, tid, body) {
  const r = await api(`/api/trees/${tid}/people`, 'POST', body, token);
  assert.equal(r.status, 200, `person fixture failed: ${JSON.stringify(r.data)}`);
  return r.data.id;
}

async function treeData(token, tid) {
  const r = await api(`/api/trees/${tid}`, 'GET', undefined, token);
  assert.equal(r.status, 200, `tree read failed: ${JSON.stringify(r.data)}`);
  return r.data;
}

function findPerson(data, name) {
  return data.people.find(p => p.name === name);
}

async function waitForRole(token, tid, role, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const data = await treeData(token, tid);
    if (data.role === role) return data;
    await delay(150);
  }
  throw new Error(`role for tree ${tid} did not become ${role}`);
}

async function waitForTree(token, tid, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const data = await treeData(token, tid);
    if (predicate(data)) return data;
    await delay(150);
  }
  throw new Error(`tree ${tid} did not reach the expected state`);
}

async function session(browser, token, viewport = { width: 1366, height: 900 }) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  contexts.push(context);
  await context.addInitScript(t => { try { if (t) localStorage.setItem('tok', t); else localStorage.removeItem('tok'); } catch { /* ignore */ } }, token || null);
  await context.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const page = await context.newPage();
  const errors = [], failed = [];
  page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 300)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/fonts\.g|Failed to load resource|ERR_FAILED|ERR_ABORTED/i.test(text)) return;
    errors.push('console: ' + text.slice(0, 300));
  });
  page.on('requestfailed', req => {
    const url = req.url();
    if (!url.startsWith(base) || /fonts\./.test(url)) return;
    const why = req.failure() ? req.failure().errorText : '';
    if (/ERR_ABORTED/.test(why)) return;
    failed.push(`${req.method()} ${url.replace(base, '')} ${why}`.slice(0, 250));
  });
  return { context, page, errors, failed };
}

let navSeq = 0;
async function open(page, hash, ready) {
  // A cache-busting query before the hash forces a real navigation even when the
  // same route was already open (important after role/permission changes).
  await page.goto(`${base}/?e2e=${++navSeq}${hash}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#app') && document.querySelector('#app').children.length > 0, { timeout: 12000 });
  if (ready) await page.waitForSelector(ready, { timeout: 12000 });
}

async function go(page, hash, ready) {
  await page.evaluate(h => { location.hash = h; }, hash);
  await page.waitForFunction(h => location.hash === h, hash, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#app') && document.querySelector('#app').children.length > 0, { timeout: 12000 });
  if (ready) await page.waitForSelector(ready, { timeout: 12000 });
}

async function heading(page, text, timeout = 10000) {
  await page.waitForFunction(t => {
    const h = document.querySelector('#app h2');
    return !!h && h.textContent.trim() === t;
  }, text, { timeout });
}

async function textOf(page, selector) {
  return (await page.locator(selector).first().innerText()).trim();
}

async function appText(page) {
  return page.locator('#app').innerText();
}

async function assertClean(s, label) {
  const txt = await appText(s.page);
  assert.doesNotMatch(txt, /That didn't work/, `${label}: route error visible`);
  assert.deepEqual(s.errors, [], `${label}: console/page errors`);
  assert.deepEqual(s.failed, [], `${label}: failed requests`);
}

async function shot(page, browserName, name) {
  try { await page.screenshot({ path: `${SHOT_DIR}/${browserName}-${slug(name)}.png`, fullPage: true }); } catch { /* screenshots are evidence, never assertions */ }
}

async function loginUI(page, email, password) {
  await open(page, '#/');
  await heading(page, 'Welcome back');
  await page.fill('#af-email', email);
  await page.fill('#af-password', password);
  await page.click('#af button');
  await heading(page, 'My Family Trees');
}

async function addSpouseUI(page, name, dob) {
  await page.getByRole('link', { name: /Add a spouse/i }).first().click();
  await heading(page, 'Add a spouse');
  await page.fill('#pf-name', name);
  await page.fill('#pf-dob', dob);
  await page.click('#pf button');
  await heading(page, 'Where our family begins');
}

async function addChildUI(page, name, dob) {
  await page.getByRole('link', { name: /Add a child/i }).first().click();
  await heading(page, 'Add a child');
  await page.fill('#pf-name', name);
  await page.fill('#pf-dob', dob);
  await page.click('#pf button');
  await heading(page, 'Where our family begins');
}

before(async () => {
  await new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}`; r(); }); });
  for (const def of available) browserMap.set(def.name, await chromium.launch({ executablePath: def.executablePath, headless: true, args: ['--no-sandbox'] }));
});

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  for (const b of browserMap.values()) await b.close().catch(() => {});
  if (srv) srv.close();
  if (dbConn) dbConn.close();
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch { /* ignore */ }
});

if (!available.length) {
  test('E2E workflows (browser unavailable)', { skip: 'Chrome or Edge not found. Set CHROME_PATH/EDGE_PATH or E2E_BROWSERS.' }, () => {});
}

for (const def of available) {
  const browser = () => browserMap.get(def.name);
  const name = def.name;

  test(`${name}: register, edit account, change password, sign out and back in`, async () => {
    const account = { email: uniqueEmail(), password: 'password1', name: 'E2E Account Owner' };
    const s = await session(browser(), null);
    const { page } = s;
    try {
      await open(page, '#/register');
      await heading(page, 'Start your family tree');
      await page.fill('#af-name', account.name);
      await page.fill('#af-email', account.email);
      await page.fill('#af-password', account.password);
      await page.click('#af button');
      await heading(page, 'My Family Trees');
      assert.ok(await page.evaluate(() => !!localStorage.getItem('tok')), 'token stored after registration');

      await go(page, '#/account', '.account-head');
      await heading(page, 'Your account');
      assert.match(await textOf(page, '#acct-who'), new RegExp(account.email.replace(/\./g, '\\.')));

      await page.fill('#nf2-name', 'E2E Renamed Owner');
      await page.click('#nf2 button');
      await page.waitForFunction(() => document.querySelector('#o1')?.textContent.includes('Saved.'), { timeout: 8000 });

      await page.fill('#pw-current', account.password);
      await page.fill('#pw-password', 'password2');
      await page.click('#pw button');
      await page.waitForFunction(() => document.querySelector('#o2')?.textContent.includes('changed'), { timeout: 8000 });

      await page.click('#out');
      await heading(page, 'Welcome back');
      assert.equal(await page.evaluate(() => localStorage.getItem('tok')), null);

      await page.fill('#af-email', account.email);
      await page.fill('#af-password', account.password);
      await page.click('#af button');
      await page.waitForFunction(() => document.querySelector('#err')?.textContent.includes('incorrect'), { timeout: 8000 });

      await page.fill('#af-email', account.email);
      await page.fill('#af-password', 'password2');
      await page.click('#af button');
      await heading(page, 'My Family Trees');
      await go(page, '#/account', '.account-head');
      assert.match(await textOf(page, '#acct-who'), /E2E Renamed Owner/);

      await shot(page, name, 'auth-account');
      await assertClean(s, 'auth/account');
    } catch (e) { await shot(page, name, 'auth-account-failure'); throw e; }
  });

  test(`${name}: create, rename and delete a family tree through the UI`, async () => {
    const owner = await newAccount('Tree Owner');
    const s = await session(browser(), owner.token);
    const { page } = s;
    try {
      await open(page, '#/', '#nf');
      await heading(page, 'My Family Trees');
      await page.fill('#nf-name', 'Browser Created Tree');
      await page.fill('#nf-rname', 'Browser Root Person');
      await page.selectOption('#nf-rgender', 'Female');
      await page.fill('#nf-rdob', '1940-02-03');
      await page.click('#nf button');
      await heading(page, 'Where our family begins');
      assert.equal(await page.textContent('#title'), 'Browser Created Tree');
      assert.match(await appText(page), /Browser Root Person/);

      page.once('dialog', d => d.accept('Browser Renamed Tree'));
      await page.click('#rn');
      await page.waitForFunction(() => document.querySelector('#title')?.textContent === 'Browser Renamed Tree', { timeout: 8000 });
      await page.waitForFunction(() => /Browser Renamed Tree/i.test(document.querySelector('#app')?.innerText || ''), { timeout: 8000 });

      const hash = await page.evaluate(() => location.hash);
      const tid = Number(hash.match(/^#\/t\/(\d+)/)[1]);
      await go(page, `#/t/${tid}/share`, '.settings-grid');
      await heading(page, 'Share and export');
      page.once('dialog', d => d.accept());
      await page.click('#deltree');
      await heading(page, 'My Family Trees');
      assert.doesNotMatch(await appText(page), /Browser Renamed Tree/);

      const gone = await api(`/api/trees/${tid}`, 'GET', undefined, owner.token);
      assert.equal(gone.status, 404);
      await shot(page, name, 'tree-crud');
      await assertClean(s, 'tree/crud');
    } catch (e) { await shot(page, name, 'tree-crud-failure'); throw e; }
  });

  test(`${name}: add spouse and child, edit profile notes, upload photo and attachment`, async () => {
    const owner = await newAccount('Profile Owner');
    const tid = await createTree(owner.token, 'Profile Family', 'Profile Root');
    const s = await session(browser(), owner.token);
    const { page } = s;
    try {
      await open(page, `#/t/${tid}`, '.tree-canvas');
      await heading(page, 'Where our family begins');
      await addSpouseUI(page, 'Profile Spouse', '1952-03-04');
      assert.match(await appText(page), /Profile Spouse/);

      await addChildUI(page, 'Profile Child', '1975-06-07');
      const more = page.locator('.branch .more').first();
      await more.click();
      await page.locator('.kids a.person').first().click();
      await heading(page, 'Profile Child');

      await page.getByRole('link', { name: /Edit details/i }).click();
      await heading(page, 'Edit Profile Child');
      await page.fill('#pf-notes', 'Grew up by the river.');
      await page.fill('#pf-birth-place', 'Bristol');
      await page.click('#pf button');
      await heading(page, 'Profile Child');
      assert.match(await appText(page), /Grew up by the river\./);
      assert.match(await appText(page), /Bristol/);

      await page.setInputFiles('#ph', { name: 'face.png', mimeType: 'image/png', buffer: PNG });
      await page.waitForFunction(() => /^url\("?blob:/.test(document.querySelector('.hero .av')?.style.backgroundImage || ''), { timeout: 12000 });

      await page.waitForSelector('details.addatt', { timeout: 12000 });
      await page.click('details.addatt summary');
      await page.fill('form#af input[name=title]', 'Profile Portrait');
      await page.setInputFiles('form#af input[type=file]', { name: 'portrait.png', mimeType: 'image/png', buffer: PNG });
      await page.click('form#af button');
      await page.waitForFunction(() => (document.querySelector('.album img')?.src || '').startsWith('blob:'), { timeout: 12000 });
      assert.match(await appText(page), /Profile Portrait/);

      page.once('dialog', d => d.accept());
      await page.locator('[data-att]').first().click();
      await page.waitForFunction(() => !document.querySelector('#app')?.innerText.includes('Profile Portrait'), { timeout: 12000 });
      assert.equal(await page.locator('.album figcaption').filter({ hasText: 'Profile Portrait' }).count(), 0);

      await shot(page, name, 'people-profile');
      await assertClean(s, 'people/profile');
    } catch (e) { await shot(page, name, 'people-profile-failure'); throw e; }
  });

  test(`${name}: relationship edit, duplicate detection and merge in Tidy up`, async () => {
    const owner = await newAccount('Merge Owner');
    const tid = await createTree(owner.token, 'Merge Family', 'Merge Root');
    const data0 = await treeData(owner.token, tid);
    const root = findPerson(data0, 'Merge Root');
    const spouseId = await addPerson(owner.token, tid, { name: 'Merge Spouse', gender: 'Male', dob: '1948', spouse_of: root.id });
    const data1 = await treeData(owner.token, tid);
    const marriage = data1.marriages.find(m => m.a_id === root.id || m.b_id === root.id);
    assert.ok(marriage, 'marriage fixture exists');
    const dupA = await addPerson(owner.token, tid, { name: 'Duplicate Child', gender: 'Female', dob: '1975-01-01', parent_marriage_id: marriage.id });
    const dupB = await addPerson(owner.token, tid, { name: 'Duplicate Child', gender: 'Female', dob: '1975-01-01', parent_marriage_id: marriage.id });
    assert.notEqual(dupA, dupB);
    const beforeMerge = await treeData(owner.token, tid);

    const s = await session(browser(), owner.token);
    const { page } = s;
    try {
      await open(page, `#/t/${tid}/tidy`, '.duplicate-list');
      await heading(page, 'Tidy up your tree');
      const before = await page.locator('[data-merge]').count();
      assert.ok(before >= 2, 'duplicate merge buttons rendered');

      page.once('dialog', d => d.accept());
      await page.locator('[data-merge]').first().click();
      await page.waitForFunction(() => document.querySelector('#app')?.innerText.includes('No duplicates found.'), { timeout: 12000 });
      const dups = await api(`/api/trees/${tid}/duplicates`, 'GET', undefined, owner.token);
      assert.equal(dups.status, 200);
      assert.equal(dups.data.length, 0);
      const after = await treeData(owner.token, tid);
      assert.equal(after.people.length, beforeMerge.people.length - 1, 'merge removes exactly one duplicate');

      await go(page, `#/t/${tid}/p/${root.id}`, '.profile-hero');
      await heading(page, 'Merge Root');
      await page.getByRole('link', { name: /Edit relationship with/i }).first().click();
      await page.waitForFunction(() => document.querySelector('#mf2'), { timeout: 10000 });
      await page.selectOption('#mf2-kind', 'divorced');
      await page.fill('#mf2-year', '1970');
      await page.click('#mf2 button');
      await page.waitForFunction(([id, pid]) => location.hash === `#/t/${id}/p/${pid}` || location.hash === `#/t/${id}`, [tid, root.id], { timeout: 10000 });
      const finalData = await treeData(owner.token, tid);
      const finalMarriage = finalData.marriages.find(m => m.id === marriage.id);
      assert.equal(finalMarriage.kind, 'divorced');
      assert.equal(finalMarriage.year, 1970);

      await shot(page, name, 'relationships-merge');
      await assertClean(s, 'relationships/merge');
    } catch (e) { await shot(page, name, 'relationships-merge-failure'); throw e; }
  });

  test(`${name}: chart zoom/generations, ancestor pedigree, insights and grandchildren`, async () => {
    const owner = await newAccount('Chart Owner');
    const tid = await createTree(owner.token, 'Chart Family', 'Chart Root');
    const data0 = await treeData(owner.token, tid);
    const root = findPerson(data0, 'Chart Root');
    const spouseId = await addPerson(owner.token, tid, { name: 'Chart Spouse', gender: 'Male', dob: '1948', spouse_of: root.id });
    const data1 = await treeData(owner.token, tid);
    const m1 = data1.marriages.find(m => m.a_id === root.id || m.b_id === root.id);
    const childId = await addPerson(owner.token, tid, { name: 'Chart Child', gender: 'Female', dob: '1972-04-05', parent_marriage_id: m1.id });
    const data2 = await treeData(owner.token, tid);
    const child = findPerson(data2, 'Chart Child');
    const childSpouseId = await addPerson(owner.token, tid, { name: 'Chart Child Spouse', gender: 'Male', dob: '1970', spouse_of: child.id });
    const data3 = await treeData(owner.token, tid);
    const m2 = data3.marriages.find(m => (m.a_id === child.id || m.b_id === child.id) && m.id !== m1.id);
    const grandId = await addPerson(owner.token, tid, { name: 'Chart Grandchild', gender: 'Female', dob: '2000-09-10', parent_marriage_id: m2.id });

    const s = await session(browser(), owner.token);
    const { page } = s;
    try {
      await open(page, `#/t/${tid}/chart`, 'svg.chart');
      await heading(page, 'Family chart');
      const nodes = await page.locator('svg.chart .cnode').count();
      assert.ok(nodes >= 4, `chart draws family nodes (${nodes})`);
      const widthBefore = Number(await page.locator('svg.chart').getAttribute('width'));
      await page.click('[data-z="+"]');
      await page.waitForFunction(w => Number(document.querySelector('svg.chart')?.getAttribute('width')) > w, widthBefore, { timeout: 8000 });
      await page.selectOption('#gsel', '4');
      await page.waitForFunction(() => location.hash.includes('g=4'), { timeout: 8000 });
      await heading(page, 'Family chart');

      await go(page, `#/t/${tid}/p/${childId}`, '.profile-hero');
      await heading(page, 'Chart Child');
      await page.getByRole('link', { name: /See ancestors/i }).click();
      await heading(page, 'Ancestors of Chart Child');
      const pedNodes = await page.locator('svg.chart .cnode').count();
      assert.ok(pedNodes >= 3, `pedigree draws ancestors (${pedNodes})`);

      await go(page, `#/t/${tid}/insights`, '.stat-grid');
      await heading(page, 'Family insights');
      assert.ok(await page.locator('.stat').count() >= 6, 'insight stat cards rendered');
      assert.match(await appText(page), /People/i);

      await go(page, `#/t/${tid}/gc`, '#app h2');
      await heading(page, 'The grandchildren');
      assert.match(await appText(page), /Chart Grandchild/);
      assert.match(await appText(page), /Children of Chart Child/);

      await go(page, `#/t/${tid}`, '.tree-canvas');
      await page.locator('.branch .more').first().click();
      await page.waitForSelector('.kids:not([hidden]) a.person', { timeout: 8000 });

      await shot(page, name, 'visualization');
      await assertClean(s, 'visualization');
    } catch (e) { await shot(page, name, 'visualization-failure'); throw e; }
  });

  test(`${name}: invite, role change, ownership transfer and link privacy`, async () => {
    const owner = await newAccount('Share Owner');
    const viewer = await newAccount('Share Viewer');
    const tid = await createTree(owner.token, 'Shared Family', 'Visible Person', { dob: '1990-04-12', gender: 'Female' });
    const data = await treeData(owner.token, tid);
    const person = findPerson(data, 'Visible Person');
    await api(`/api/people/${person.id}`, 'PUT', { notes: 'Private note for the family.' }, owner.token);

    const ownerSession = await session(browser(), owner.token);
    const viewerSession = await session(browser(), viewer.token);
    const anonSession = await session(browser(), null);
    const { page } = ownerSession;
    try {
      await open(page, `#/t/${tid}/share`, '.settings-grid');
      await heading(page, 'Share and export');
      const shareURL = base + '/#/t/' + tid;
      assert.equal(await page.inputValue('#shareurl'), shareURL, 'share link is shown');
      await ownerSession.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await page.click('#copyurl');
      await page.waitForFunction(() => document.querySelector('#copyurl')?.textContent?.includes('Copied'), { timeout: 8000 });
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), shareURL, 'share link is copied');

      await page.fill('#mf-email', viewer.email);
      await page.selectOption('#mf-role', 'viewer');
      await page.click('#mf button');
      await page.waitForFunction(email => document.querySelector('#app')?.innerText.includes(email), viewer.email, { timeout: 12000 });

      await page.locator(`select[data-role]`).first().selectOption('editor');
      await page.waitForFunction(() => document.querySelector('select[data-role]')?.value === 'editor', { timeout: 12000 });
      await waitForRole(viewer.token, tid, 'editor');

      await open(viewerSession.page, `#/t/${tid}`, '.tree-canvas');
      await heading(viewerSession.page, 'Where our family begins');
      assert.ok(await viewerSession.page.locator('a.btn', { hasText: 'Add a spouse' }).count() >= 1, 'editor sees editing controls');

      await page.locator(`select[data-role]`).first().selectOption('viewer');
      await page.waitForFunction(() => document.querySelector('select[data-role]')?.value === 'viewer', { timeout: 12000 });
      await waitForRole(viewer.token, tid, 'viewer');
      await open(viewerSession.page, `#/t/${tid}`, '.tree-canvas');
      await heading(viewerSession.page, 'Where our family begins');
      assert.equal(await viewerSession.page.locator('a.btn', { hasText: 'Add a spouse' }).count(), 0, 'viewer has no editing controls');

      await page.fill('#mf-email', 'pending-e2e@family.test');
      await page.selectOption('#mf-role', 'viewer');
      await page.click('#mf button');
      await page.waitForFunction(() => document.querySelector('#app')?.innerText.includes('pending-e2e@family.test'), { timeout: 12000 });
      await page.locator('[data-inv]').first().click();
      await page.waitForFunction(() => !document.querySelector('#app')?.innerText.includes('pending-e2e@family.test'), { timeout: 12000 });

      await page.selectOption('#ow-user', String(viewer.id));
      page.once('dialog', d => d.accept());
      await page.click('#ow button');
      await page.waitForFunction(() => document.querySelector('#app')?.innerText.includes('Only the owner can share this tree'), { timeout: 12000 });
      await waitForRole(owner.token, tid, 'editor');
      await waitForRole(viewer.token, tid, 'owner');

      await open(viewerSession.page, `#/t/${tid}/share`, '.settings-grid');
      await heading(viewerSession.page, 'Share and export');
      await viewerSession.page.selectOption('#vf-visibility', 'link');
      const hide = viewerSession.page.locator('input[name=hide_living]');
      if (!(await hide.isChecked())) await hide.check();
      await viewerSession.page.click('#vf button');
      await waitForTree(viewer.token, tid, data => data.tree.visibility === 'link' && data.tree.hide_living === 1);

      await open(anonSession.page, `#/t/${tid}`, '.tree-canvas');
      await heading(anonSession.page, 'Where our family begins');
      assert.match(await appText(anonSession.page), /Visible Person/);
      await open(anonSession.page, `#/t/${tid}/p/${person.id}`, '.profile-hero');
      await heading(anonSession.page, 'Visible Person');
      const publicText = await appText(anonSession.page);
      assert.match(publicText, /1990/, 'public profile keeps birth year');
      assert.doesNotMatch(publicText, /April/, 'public profile hides full birth date');
      assert.doesNotMatch(publicText, /Private note for the family\./, 'public profile hides notes');

      await shot(page, name, 'sharing-owner');
      await shot(anonSession.page, name, 'sharing-public');
      await assertClean(ownerSession, 'sharing/owner');
      await assertClean(viewerSession, 'sharing/viewer');
      await assertClean(anonSession, 'sharing/public');
    } catch (e) { await shot(page, name, 'sharing-failure'); throw e; }
  });

  test(`${name}: accept an emailed invitation through the invitation page`, async () => {
    const owner = await newAccount('Invite Owner');
    const invitee = await newAccount('Invite Guest');
    const tid = await createTree(owner.token, 'Invite Family', 'Invite Root');
    const raw = crypto.randomBytes(24).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    if (!dbConn) dbConn = new Database(process.env.DB);
    dbConn.prepare(`INSERT INTO invites(tree_id,email,role,token_hash,invited_by,expires_at) VALUES(?,?,?,?,?,?)`)
      .run(tid, invitee.email, 'viewer', hash, owner.id, Date.now() + 14 * 24 * 3600e3);

    const s = await session(browser(), invitee.token);
    const { page } = s;
    try {
      await open(page, `#/invite?token=${raw}`, '#iaccept');
      await heading(page, 'You are invited');
      assert.match(await appText(page), /Invite Family/);
      assert.match(await appText(page), /viewer/);
      await page.click('#iaccept');
      await heading(page, 'Where our family begins');
      assert.equal(await page.textContent('#title'), 'Invite Family');

      await go(page, '#/', '.tree-grid');
      await heading(page, 'My Family Trees');
      assert.match(await appText(page), /Invite Family/);
      await shot(page, name, 'invite-accept');
      await assertClean(s, 'invite/accept');
    } catch (e) { await shot(page, name, 'invite-accept-failure'); throw e; }
  });

  test(`${name}: JSON backup download/restore and GEDCOM export/import through the UI`, async () => {
    const owner = await newAccount('Backup Owner');
    const tid = await createTree(owner.token, 'Backup Family', 'Backup Root');
    const data0 = await treeData(owner.token, tid);
    const root = findPerson(data0, 'Backup Root');
    await addPerson(owner.token, tid, { name: 'Backup Spouse', gender: 'Male', dob: '1948', spouse_of: root.id });

    const s = await session(browser(), owner.token);
    const { page } = s;
    try {
      await open(page, `#/t/${tid}/share`, '.settings-grid');
      await heading(page, 'Share and export');

      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('[data-json]')]);
      const restorePath = path.join(process.env.DATA_DIR, 'backup-download.json');
      await download.saveAs(restorePath);
      const backup = JSON.parse(fs.readFileSync(restorePath, 'utf8'));
      assert.equal(backup.version, 2);
      assert.deepEqual(backup.people.map(p => p.name).sort(), ['Backup Root', 'Backup Spouse']);

      await page.setInputFiles('#rst', restorePath);
      await page.waitForFunction(() => document.querySelector('#rstout')?.innerText.includes('is ready to restore'), { timeout: 15000 });
      await page.click('#rstgo');
      await heading(page, 'Where our family begins');
      const restoredHash = await page.evaluate(() => location.hash);
      const restoredId = Number(restoredHash.match(/^#\/t\/(\d+)/)[1]);
      assert.notEqual(restoredId, tid);
      assert.equal(await page.textContent('#title'), 'Backup Family');
      assert.match(await appText(page), /Backup Root/);
      assert.match(await appText(page), /Backup Spouse/);

      await go(page, `#/t/${tid}/share`, '.settings-grid');
      await heading(page, 'Share and export');
      const [ged] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('[data-ged="0"]')]);
      const gedPath = path.join(process.env.DATA_DIR, 'export.ged');
      await ged.saveAs(gedPath);
      const gedText = fs.readFileSync(gedPath, 'utf8');
      assert.match(gedText, /0 HEAD/);
      assert.match(gedText, /Backup \/Root\//);

      await page.setInputFiles('#imp', { name: 'merge.ged', mimeType: 'text/plain', buffer: Buffer.from(GEDCOM_MERGE) });
      await page.waitForFunction(() => /Added \d+ new people/.test(document.querySelector('#impmsg')?.innerText || ''), { timeout: 15000 });
      const merged = await treeData(owner.token, tid);
      assert.ok(findPerson(merged, 'Imported Merge Person'), 'GEDCOM merge added the imported person');

      await go(page, '#/', '#gf');
      await heading(page, 'My Family Trees');
      await page.fill('#gf-name', 'GEDCOM Home Family');
      await page.setInputFiles('#gf-file', { name: 'home.ged', mimeType: 'text/plain', buffer: Buffer.from(GEDCOM_HOME) });
      await page.click('#gf button');
      await heading(page, 'Where our family begins');
      assert.equal(await page.textContent('#title'), 'GEDCOM Home Family');
      assert.match(await appText(page), /Imported Home Person/);

      await shot(page, name, 'backup-gedcom');
      await assertClean(s, 'backup/gedcom');
    } catch (e) { await shot(page, name, 'backup-gedcom-failure'); throw e; }
  });

  test(`${name}: user-supplied text is rendered as text, never executed`, async () => {
    const owner = await newAccount('XSS Owner');
    const tid = await createTree(owner.token, 'XSS Family', 'XSS Root');
    const payload = '<img src=x onerror="window.__xss1=1">';
    const notePayload = '<script>window.__xss2=1</script>';
    const treePayload = '<img src=x onerror="window.__xss3=1">';
    const s = await session(browser(), owner.token);
    const { page } = s;
    try {
      await open(page, `#/t/${tid}`, '.tree-canvas');
      await heading(page, 'Where our family begins');
      await addSpouseUI(page, payload, '1970-01-01');
      assert.equal(await page.evaluate(() => window.__xss1), undefined);
      assert.equal(await page.locator('.branch .person-info b').first().textContent(), payload);

      await page.locator('.branch a.person').first().click();
      await heading(page, payload);
      assert.equal(await page.locator('.profile-hero h2').textContent(), payload);

      await page.getByRole('link', { name: /Edit details/i }).click();
      await heading(page, 'Edit ' + payload);
      await page.fill('#pf-notes', notePayload);
      await page.click('#pf button');
      await heading(page, payload);
      assert.equal(await page.evaluate(() => window.__xss2), undefined);
      const notesText = await page.locator('.notes').textContent();
      assert.equal(notesText, notePayload);
      assert.equal(await page.locator('.notes script').count(), 0);

      await go(page, `#/t/${tid}`, '.tree-canvas');
      page.once('dialog', d => d.accept(treePayload));
      await page.click('#rn');
      await page.waitForFunction(t => document.querySelector('#title')?.textContent === t, treePayload, { timeout: 8000 });
      assert.equal(await page.evaluate(() => window.__xss3), undefined);
      await go(page, '#/', '.tree-grid');
      assert.equal(await page.locator('.tree-card-title').first().textContent(), treePayload);
      assert.equal(await page.locator('#app img[src="x"]').count(), 0);

      await shot(page, name, 'xss-escaped');
      await assertClean(s, 'xss');
    } catch (e) { await shot(page, name, 'xss-failure'); throw e; }
  });

  test(`${name}: search, filter and remove a person through the UI`, async () => {
    const owner = await newAccount('Search Owner');
    const tid = await createTree(owner.token, 'Search Family', 'Search Root', { dob: '1950-05-02', gender: 'Female' });
    const data0 = await treeData(owner.token, tid);
    const root = findPerson(data0, 'Search Root');
    await addPerson(owner.token, tid, { name: 'Search Spouse', gender: 'Male', dob: '1948-01-01', spouse_of: root.id });
    const data1 = await treeData(owner.token, tid);
    const marriage = data1.marriages.find(m => m.a_id === root.id || m.b_id === root.id);
    assert.ok(marriage, 'search fixture marriage exists');
    const childId = await addPerson(owner.token, tid, { name: 'Search Child', gender: 'Female', dob: '1975-03-04', parent_marriage_id: marriage.id });

    const s = await session(browser(), owner.token);
    const { page } = s;
    try {
      await open(page, `#/t/${tid}/search`, '#qsf');
      await heading(page, 'Find a person');
      await page.fill('#qsf-q', 'Search');
      await page.click('#qsf button');
      await heading(page, 'Search results');
      const allText = await appText(page);
      for (const n of ['Search Root', 'Search Spouse', 'Search Child']) assert.match(allText, new RegExp(n), `${n} in results`);

      await page.selectOption('#qsf-gender', 'Male');
      await page.click('#qsf button');
      await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1] || '').get('gender') === 'Male', { timeout: 8000 });
      await heading(page, 'Search results');
      const maleText = await appText(page);
      assert.match(maleText, /Search Spouse/);
      assert.doesNotMatch(maleText, /Search Root|Search Child/);

      await page.fill('#qsf-q', 'Zzz');
      await page.click('#qsf button');
      await page.waitForFunction(() => /No one matches/.test(document.querySelector('#app')?.innerText || ''), { timeout: 8000 });
      assert.match(await page.textContent('.empty-state'), /No one matches/);

      await page.fill('#qsf-q', 'Search');
      await page.click('#qsf button');
      await heading(page, 'Search results');
      await page.getByRole('link', { name: /Search Spouse/i }).first().click();
      await heading(page, 'Search Spouse');
      await go(page, `#/t/${tid}/p/${childId}`, '.profile-hero');
      await heading(page, 'Search Child');

      page.once('dialog', d => d.dismiss());
      await page.click('#rm');
      await delay(400);
      assert.ok(findPerson(await treeData(owner.token, tid), 'Search Child'), 'cancelling the dialog keeps the person');

      page.once('dialog', d => d.accept());
      await page.click('#rm');
      await heading(page, 'Where our family begins');
      await page.waitForFunction(() => !document.querySelector('#app')?.innerText.includes('Search Child'), { timeout: 10000 });
      const after = await treeData(owner.token, tid);
      assert.equal(findPerson(after, 'Search Child'), undefined, 'accepted removal deletes the person');
      assert.ok(findPerson(after, 'Search Root'), 'the rest of the tree is untouched');
      assert.ok(childId);

      await shot(page, name, 'search-remove');
      await assertClean(s, 'search/remove');
    } catch (e) { await shot(page, name, 'search-remove-failure'); throw e; }
  });

  test(`${name}: replace and remove a profile photo, and reject an invalid form value`, async () => {
    const owner = await newAccount('Photo Owner');
    const tid = await createTree(owner.token, 'Photo Family', 'Photo Root');
    const data0 = await treeData(owner.token, tid);
    const root = findPerson(data0, 'Photo Root');
    const s = await session(browser(), owner.token);
    const { page } = s;
    try {
      await open(page, `#/t/${tid}/p/${root.id}`, '.profile-hero');
      await heading(page, 'Photo Root');

      await page.setInputFiles('#ph', { name: 'one.png', mimeType: 'image/png', buffer: PNG });
      await page.waitForFunction(() => /^url\("?blob:/.test(document.querySelector('.hero .av')?.style.backgroundImage || ''), { timeout: 12000 });
      const firstUrl = await page.evaluate(() => document.querySelector('.hero .av')?.style.backgroundImage || '');
      const firstPerson = findPerson(await treeData(owner.token, tid), 'Photo Root');
      assert.ok(firstPerson.photo && firstPerson.photo.startsWith('/uploads/'), 'first photo stored');

      await page.setInputFiles('#ph', { name: 'two.png', mimeType: 'image/png', buffer: PNG });
      await page.waitForFunction(url => {
        const bg = document.querySelector('.hero .av')?.style.backgroundImage || '';
        return /^url\("?blob:/.test(bg) && bg !== url;
      }, firstUrl, { timeout: 12000 });
      await page.waitForSelector('#rmphoto', { timeout: 10000 });
      const secondPerson = findPerson(await treeData(owner.token, tid), 'Photo Root');
      assert.ok(secondPerson.photo && secondPerson.photo !== firstPerson.photo, 'replacement photo stored');

      page.once('dialog', d => d.accept());
      await page.click('#rmphoto');
      await page.waitForFunction(() => !/^url\("?blob:/.test(document.querySelector('.hero .av')?.style.backgroundImage || ''), { timeout: 12000 });
      const afterRemove = findPerson(await treeData(owner.token, tid), 'Photo Root');
      assert.equal(afterRemove.photo, null, 'photo column cleared');
      assert.equal(await page.locator('#rmphoto').count(), 0, 'remove control disappears without a photo');

      await go(page, `#/t/${tid}/new`, '#pf');
      await page.fill('#pf-name', 'Invalid Date Person');
      await page.fill('#pf-dob', '2020-02-31');
      await page.click('#pf button');
      await page.waitForFunction(() => /Enter a birth date/.test(document.querySelector('#err')?.textContent || ''), { timeout: 8000 });
      assert.doesNotMatch(await appText(page), /Invalid Date Person/);

      await page.fill('#pf-dob', '2010');
      await page.click('#pf button');
      await heading(page, 'Where our family begins');
      assert.ok(findPerson(await treeData(owner.token, tid), 'Invalid Date Person'), 'corrected form saves');

      await shot(page, name, 'photo-remove-validation');
      await assertClean(s, 'photo/remove-validation');
    } catch (e) { await shot(page, name, 'photo-remove-validation-failure'); throw e; }
  });
}
