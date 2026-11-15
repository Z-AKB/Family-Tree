const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-test-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-data-'));
process.env.AUTH_LIMIT = '1000';
const app = require('../server');
const Database = require('better-sqlite3');
let srv, base;
before(() => new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; r(); }); }));
after(() => { srv.close(); for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {} });

const call = async (p, { method = 'GET', token, body, text } = {}) => {
  const h = {}; if (token) h.Authorization = 'Bearer ' + token;
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: text ?? (body && JSON.stringify(body)) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const login = async (email, password) => (await call('/auth/login', { method: 'POST', body: { email, password } })).body.token;
const demo = () => login('demo@family.test', 'demo1234');

test('login rejects a wrong password and accepts the demo account', async () => {
  assert.equal((await call('/auth/login', { method: 'POST', body: { email: 'demo@family.test', password: 'nope' } })).status, 401);
  assert.ok(await demo());
});

test('status and age come from the dates; partial and approximate dates work; bad dates are rejected', async () => {
  const t = await demo();
  const add = body => call('/trees/1/people', { method: 'POST', token: t, body: { parent_marriage_id: 1, ...body } });
  assert.equal((await add({ name: 'A', dob: '1960-13' })).status, 400);
  assert.equal((await add({ name: 'B', dob: '2020-02-31' })).status, 400);
  assert.equal((await add({ name: 'C', dob: '1960', dod: '1950' })).status, 400);
  assert.equal((await add({ name: 'Old Aunt', dob: '1946', dob_q: 'about', dod: '2016-05' })).status, 200);
  const p = (await call('/trees/1', { token: t })).body.people.find(x => x.name === 'Old Aunt');
  assert.deepEqual([p.status, p.age, p.dob_q], ['Deceased', 70, 'about']);
});

test('visitors to a shared link do not see full birth dates of living people; private trees are hidden', async () => {
  const t = await demo();
  const anon = (await call('/trees/1')).body;
  assert.equal(anon.people.find(p => p.name === 'Clara Whitmore').dob, '1948');
  assert.equal(anon.people.find(p => p.name === 'Elias Whitmore').dob, '1932-03-04');
  await call('/trees/1', { method: 'PATCH', token: t, body: { visibility: 'private' } });
  assert.equal((await call('/trees/1')).status, 404);
  await call('/trees/1', { method: 'PATCH', token: t, body: { visibility: 'link' } });
});

test('roles: viewers cannot edit, editors can, only the owner can rename', async () => {
  const t = await demo();
  const reg = await call('/auth/register', { method: 'POST', body: { email: 'nia@family.test', password: 'password1', name: 'Nia' } });
  const n = reg.body.token, edit = () => call('/people/3', { method: 'PUT', token: n, body: { name: 'Clara Whitmore', gender: 'Female', dob: '1948-01-09' } });
  assert.equal((await call('/trees/1/members', { method: 'POST', token: t, body: { email: 'nobody@x.com', role: 'editor' } })).status, 404);
  await call('/trees/1/members', { method: 'POST', token: t, body: { email: 'nia@family.test', role: 'viewer' } });
  assert.equal((await edit()).status, 403);
  await call('/trees/1/members', { method: 'POST', token: t, body: { email: 'nia@family.test', role: 'editor' } });
  assert.equal((await edit()).status, 200);
  assert.equal((await call('/trees/1', { method: 'PATCH', token: n, body: { name: 'Hacked' } })).status, 403);
});

test('people with children and the first person cannot be removed', async () => {
  const t = await demo();
  assert.equal((await call('/people/2', { method: 'DELETE', token: t })).status, 409);
  assert.equal((await call('/people/1', { method: 'DELETE', token: t })).status, 409);
});

test('generation loading and branch fetch', async () => {
  const t = await demo(), n = r => r.body.people.length;
  assert.ok(n(await call('/trees/1?depth=1', { token: t })) < n(await call('/trees/1?depth=2', { token: t })));
  const rosalind = (await call('/trees/1', { token: t })).body.people.find(p => p.name === 'Rosalind Whitmore');
  const b = await call(`/people/${rosalind.id}/branch`, { token: t });
  assert.ok(b.body.people.some(p => p.name === 'Nora Bell') && b.body.people.some(p => p.name === 'Elias Whitmore') && b.body.marriages.length === 2); // her own marriage and her parents'
});

test('search finds people by name and needs two letters', async () => {
  assert.ok((await call('/trees/1/search?q=whit')).body.length > 3);
  assert.deepEqual((await call('/trees/1/search?q=w')).body, []);
  assert.deepEqual((await call('/trees/1/search?q=%25')).body, []);
});

test('GEDCOM export imports back as a new tree, and re-importing changes nothing', async () => {
  const t = await demo();
  const ged = await (await fetch(`${base}/trees/1/export.ged`, { headers: { Authorization: 'Bearer ' + t } })).text();
  const same = await call('/trees/1/import', { method: 'POST', token: t, text: ged });
  assert.equal(same.body.added, 0);
  const copy = await call('/trees/import?name=Copy', { method: 'POST', token: t, text: ged });
  const total = (await call(`/trees/${copy.body.id}`, { token: t })).body.people.length;
  assert.equal(total, (await call('/trees/1', { token: t })).body.people.length);
  assert.equal((await call(`/trees/${copy.body.id}/import`, { method: 'POST', token: t, text: ged })).body.added, 0);
  assert.equal((await call('/trees/import?name=X', { method: 'POST', token: t, text: 'hello' })).status, 400);
});

const idOf = async (t, name) => (await call('/trees/1', { token: t })).body.people.find(p => p.name === name).id;
const rel = async (a, b) => { const t = await demo(); return (await call(`/people/${await idOf(t, a)}/related/${await idOf(t, b)}`)).body.text; };

test('how are we related: blood, in-law and half relationships', async () => {
  assert.equal(await rel('Nora Bell', 'Liam Bell'), "Liam Bell is Nora Bell's brother.");
  assert.equal(await rel('Nora Bell', 'Grace Whitmore'), "Grace Whitmore is Nora Bell's 1st cousin.");
  assert.equal(await rel('Nora Bell', 'Helen Whitmore'), "Helen Whitmore is Nora Bell's aunt.");
  assert.equal(await rel('Nora Bell', 'Elias Whitmore'), "Elias Whitmore is Nora Bell's grandfather.");
  assert.equal(await rel('Elias Whitmore', 'Nora Bell'), "Nora Bell is Elias Whitmore's granddaughter.");
  assert.equal(await rel('Rosalind Whitmore', 'Daniel Bell'), "Daniel Bell is Rosalind Whitmore's husband.");
  assert.equal(await rel('Nora Bell', 'Clara Whitmore'), "Clara Whitmore is the wife of Nora Bell's grandfather.");
  assert.equal(await rel('Helen Whitmore', 'Oscar Whitmore'), "Oscar Whitmore is Helen Whitmore's half-brother.");
});

test('parents can be added once, the pedigree grows upward, and the finder follows', async () => {
  const t = await demo(), daniel = await idOf(t, 'Daniel Bell');
  const add = () => call(`/people/${daniel}/parents`, { method: 'POST', token: t, body: { father: { name: 'Joseph Bell' }, mother: { name: 'Ruth Bell', dob: '1930' }, year: 1950 } });
  assert.equal((await add()).status, 200);
  assert.equal((await add()).status, 409);
  const nora = await idOf(t, 'Nora Bell'), ped = (await call(`/people/${nora}/pedigree?depth=4`)).body;
  assert.ok(ped.people.some(p => p.name === 'Joseph Bell') && ped.people.some(p => p.name === 'Elias Whitmore'));
  assert.equal(await rel('Nora Bell', 'Joseph Bell'), "Joseph Bell is Nora Bell's grandfather.");
  assert.equal((await call('/trees/1', { method: 'PATCH', token: t, body: { root_id: 999999 } })).status, 400);
});

test('places and notes are saved, hidden from visitors for living people, and exported', async () => {
  const t = await demo();
  const r = await call('/trees/1/people', { method: 'POST', token: t, body: { name: 'Place Tester', dob: '1999-01-01', birth_place: 'Abuja', notes: 'Loves football.', parent_marriage_id: 1 } });
  assert.equal(r.status, 200);
  const owner = (await call('/trees/1', { token: t })).body.people.find(p => p.name === 'Place Tester');
  assert.deepEqual([owner.birth_place, owner.notes], ['Abuja', 'Loves football.']);
  const anon = (await call('/trees/1')).body.people.find(p => p.name === 'Place Tester');
  assert.deepEqual([anon.birth_place, anon.notes], [null, null]);
  const ged = await (await fetch(`${base}/trees/1/export.ged`, { headers: { Authorization: 'Bearer ' + t } })).text();
  assert.match(ged, /2 PLAC Abuja/); assert.match(ged, /1 NOTE Loves football\./);
});

test('insights and JSON backup', async () => {
  const t = await demo(), i = (await call('/trees/1/insights', { token: t })).body;
  assert.ok(i.people >= 19 && i.generations >= 3 && i.living + i.deceased === i.people);
  assert.deepEqual((await call('/trees/1/insights')).body.birthdays, []);
  const b = await call('/trees/1/export.json', { token: t });
  assert.ok(b.status === 200 && b.body.people.length === i.people);
  assert.equal((await call('/trees/1/export.json')).status, 401);
});

test('relationship types: partner, divorced, step and adopted children, and they survive GEDCOM', async () => {
  const t = await demo(), elias = await idOf(t, 'Elias Whitmore');
  assert.equal((await call('/trees/1/people', { method: 'POST', token: t, body: { name: 'Pat Partner', gender: 'Female', dob: '1950', spouse_of: elias, kind: 'partner', year: 1990 } })).status, 200);
  const m = (await call('/trees/1', { token: t })).body.marriages.find(x => x.kind === 'partner');
  assert.equal(m.year, 1990);
  assert.equal((await call(`/marriages/${m.id}`, { method: 'PUT', token: t, body: { kind: 'divorced', year: 1990, end_year: 1985 } })).status, 400);
  assert.equal((await call(`/marriages/${m.id}`, { method: 'PUT', token: t, body: { kind: 'divorced', year: 1990, end_year: 1995 } })).status, 200);
  assert.equal((await call('/trees/1/people', { method: 'POST', token: t, body: { name: 'Sam Stepson', gender: 'Male', dob: '1985', parent_marriage_id: 1, parent_kind: 'step' } })).status, 200);
  assert.equal(await rel('Elias Whitmore', 'Sam Stepson'), "Sam Stepson is Elias Whitmore's stepson.");
  assert.equal((await call('/trees/1/people', { method: 'POST', token: t, body: { name: 'Ada Adopted', gender: 'Female', dob: '1986', parent_marriage_id: 1, parent_kind: 'adopted' } })).status, 200);
  const ged = await (await fetch(`${base}/trees/1/export.ged`, { headers: { Authorization: 'Bearer ' + t } })).text();
  assert.match(ged, /2 PEDI adopted/); assert.match(ged, /1 DIV\r?\n2 DATE 1995/);
  const copy = await call('/trees/import?name=Kinds', { method: 'POST', token: t, text: ged });
  const c = (await call(`/trees/${copy.body.id}`, { token: t })).body;
  assert.ok(c.marriages.some(x => x.kind === 'divorced' && x.end_year === 1995));
  assert.ok(c.people.some(p => p.name === 'Ada Adopted' && p.parent_kind === 'adopted'));
});

test('duplicates are found, and merging keeps one record and moves relationships', async () => {
  const t = await demo(), rosalind = await idOf(t, 'Rosalind Whitmore'), n0 = (await call('/trees/1', { token: t })).body;
  const dup = await call('/trees/1/people', { method: 'POST', token: t, body: { name: 'Daniel  Bell', dob: '1955-02-11', spouse_of: rosalind, notes: 'Extra note' } });
  assert.equal(dup.status, 200);
  const pairs = (await call('/trees/1/duplicates', { token: t })).body;
  assert.ok(pairs.some(p => p.a.name.replace(/\s+/g, ' ') === 'Daniel Bell' && p.b.name.replace(/\s+/g, ' ') === 'Daniel Bell'));
  const keep = await idOf(t, 'Daniel Bell');
  assert.equal((await call(`/people/${rosalind}/merge`, { method: 'POST', token: t, body: { into: keep } })).status, 409);
  assert.equal((await call(`/people/${dup.body.id}/merge`, { method: 'POST', token: t, body: { into: keep } })).status, 200);
  const n1 = (await call('/trees/1', { token: t })).body;
  assert.equal(n1.people.length, n0.people.length);
  assert.equal(n1.marriages.length, n0.marriages.length);
  assert.equal(n1.people.find(p => p.id === keep).notes, 'Extra note');
});

test('sources, documents and a photo album with privacy for living people', async () => {
  const t = await demo(), nora = await idOf(t, 'Nora Bell');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAIUdJ4AAAAABJRU5ErkJggg==', 'base64');
  const post = (fields, file) => { const fd = new FormData(); Object.entries(fields).forEach(([k, v]) => fd.append(k, v)); if (file) fd.append('file', new Blob([file], { type: 'image/png' }), 'a.png');
    return fetch(`${base}/people/${nora}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: fd }).then(async r => ({ status: r.status, body: await r.json() })); };
  assert.equal((await post({ kind: 'source', title: 'Birth certificate' })).status, 400);
  assert.equal((await post({ kind: 'source', title: 'Parish record', url: 'ftp://x' })).status, 400);
  assert.equal((await post({ kind: 'photo', title: 'No image' })).status, 400);
  const a = await post({ kind: 'photo', title: 'First day of school' }, png);
  assert.equal((await post({ kind: 'source', title: 'Census 1911', description: 'Listed at 12 Main Street', url: 'https://example.org/census' })).status, 200);
  const list = (await call(`/people/${nora}/attachments`, { token: t })).body;
  assert.equal(list.length, 2);
  const f1 = await fetch(base.replace('/api', '') + '/api/attachments/' + list[0].id + '/file', { headers: { Authorization: 'Bearer ' + t } });
  assert.equal(f1.status, 200);
  assert.deepEqual((await call(`/people/${nora}/attachments`)).body, []);
  assert.equal((await call(`/attachments/${a.body.id}`, { method: 'DELETE', token: t })).status, 200);
  assert.equal((await call(`/people/${nora}/attachments`, { token: t })).body.length, 1);
});

test('password reset by email, changing a password, and deleting an account', async () => {
  const email = 'ada@family.test', mail = require('../server').outbox;
  const old = (await call('/auth/register', { method: 'POST', body: { email, password: 'password1', name: 'Ada' } })).body.token;
  const before = mail.length;
  assert.equal((await call('/auth/forgot', { method: 'POST', body: { email: 'nobody@x.test' } })).status, 200);
  assert.equal(mail.length, before);
  await call('/auth/forgot', { method: 'POST', body: { email } });
  assert.equal(mail.length, before + 1);
  const raw = mail.at(-1).text.match(/token=([0-9a-f]+)/)[1];
  assert.equal((await call('/auth/reset', { method: 'POST', body: { token: 'bad', password: 'newpassword1' } })).status, 400);
  assert.equal((await call('/auth/reset', { method: 'POST', body: { token: raw, password: 'short' } })).status, 400);
  assert.equal((await call('/auth/reset', { method: 'POST', body: { token: raw, password: 'newpassword1' } })).status, 200);
  assert.equal((await call('/auth/reset', { method: 'POST', body: { token: raw, password: 'newpassword2' } })).status, 400);
  assert.equal((await call('/me', { token: old })).status, 401);
  const t = await login(email, 'newpassword1');
  assert.equal((await call('/me/password', { method: 'POST', token: t, body: { current: 'wrong', password: 'another123' } })).status, 401);
  const ch = await call('/me/password', { method: 'POST', token: t, body: { current: 'newpassword1', password: 'another123' } });
  assert.equal(ch.status, 200);
  assert.equal((await call('/me', { token: t })).status, 401);
  const n = ch.body.token; assert.equal((await call('/me', { token: n })).status, 200);
  const tree = await call('/trees', { method: 'POST', token: n, body: { name: 'Temp', root: { name: 'Root', dob: '1970' } } });
  assert.equal((await call('/me', { method: 'DELETE', token: n, body: { password: 'another123' } })).status, 200);
  assert.equal((await call(`/trees/${tree.body.id}`)).status, 404);
  assert.equal((await call('/me', { token: n })).status, 401);
});

test('tree checks flag impossible dates in existing records', async () => {
  const t = await demo(), side = new Database(process.env.DB);
  try { side.prepare("INSERT INTO people(tree_id,name,dob,parent_marriage_id) VALUES(1,'Too Early','1940',1)").run(); }
  finally { side.close(); }
  const c = (await call('/trees/1/checks', { token: t })).body;
  assert.ok(c.issues.some(i => /only 6 when Too Early was born/.test(i.text)));
  assert.equal((await call('/trees/1/checks')).status, 401);
});

test('translations: every language has every phrase, and each phrase is used by the app', () => {
  const D = require('../public/i18n-data.js'), n = D.languages.length;
  const src = ['app.js', 'index.html', 'i18n.js'].map(f => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8')).join('\n');
  const fromServer = ['Alive', 'Deceased', 'Status will be Alive', 'Status will be Deceased'];
  for (const r of D.words) { assert.equal(r.length, n, 'missing translation for: ' + r[0]); assert.ok(r.every(x => x && x.trim()), r[0]); }
  for (const p of D.patterns) { assert.equal(p.length, n, 'pattern ' + p[0]); new RegExp(p[0]); }
  assert.deepEqual(D.words.map(r => r[0]).filter(k => !fromServer.includes(k) && !src.includes(k)), []);
});
