// Regression tests for JSON request-size scoping, backup restore validation and resource limits.
// These cover the defects found in the audit: the 1 MB global parser consuming restore bodies,
// cyclic/self-parent backups being accepted, and unbounded restore resource counts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-backup-test-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-backup-data-'));
process.env.JWT_SECRET = 'backup-test-secret';
process.env.AUTH_LIMIT = '1000';
process.env.NODE_ENV = 'test';
delete process.env.SEED_DEMO;
const app = require('../server');
const Database = require('better-sqlite3');
let srv, base, token, db;
const UPLOADS_DIR = path.join(process.env.DATA_DIR, 'uploads');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAIUdJ4AAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  await new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; r(); }); });
  db = new Database(process.env.DB);
  const r = await api('/auth/login', { method: 'POST', body: { email: 'demo@family.test', password: 'demo1234' } });
  assert.equal(r.status, 200);
  token = r.body.token;
});
after(() => {
  try { db.close(); } catch {}
  srv.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {}
});

async function api(p, { method = 'GET', token: auth = token, body, text, contentType } = {}) {
  const h = {}; if (auth) h.Authorization = 'Bearer ' + auth;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; text = JSON.stringify(body); }
  if (contentType) h['Content-Type'] = contentType;
  const r = await fetch(base + p, { method, headers: h, body: text });
  const raw = await r.text(); let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, headers: r.headers };
}
async function multipart(p, payload, filename = 'backup.json', type = 'application/json') {
  const fd = new FormData();
  fd.append('file', new Blob([payload], { type }), filename);
  const r = await fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const raw = await r.text(); let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed };
}
const treeCount = () => db.prepare('SELECT COUNT(*) n FROM trees').get().n;
const peopleCount = () => db.prepare('SELECT COUNT(*) n FROM people').get().n;
const uploadCount = () => (fs.existsSync(UPLOADS_DIR) ? fs.readdirSync(UPLOADS_DIR).length : 0);
const smallBackup = (extra = {}) => ({
  version: 2, tree: { name: 'Backup test tree' },
  people: [{ id: 1, name: 'Backup Root', gender: 'Other', dob: '1970' }],
  marriages: [], attachments: [], media: [], ...extra
});

test('a valid JSON backup larger than 1 MB can be previewed and restored', async () => {
  const people = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, name: 'Large Person ' + i, dob: '1950', notes: 'n'.repeat(3000) }));
  const backup = { version: 2, tree: { name: 'Large JSON restore' }, people, marriages: [] };
  const payload = JSON.stringify(backup);
  assert.ok(Buffer.byteLength(payload) > 1024 * 1024, 'fixture must exceed the global parser limit');

  const before = treeCount();
  const preview = await api('/trees/restore?preview=1', { method: 'POST', text: payload, contentType: 'application/json' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.valid, true);
  assert.equal(preview.body.counts.people, 500);
  assert.equal(treeCount(), before, 'preview creates no tree');

  const restored = await api('/trees/restore', { method: 'POST', text: payload, contentType: 'application/json' });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.counts.people, 500);
  assert.equal(treeCount(), before + 1);
  const tree = await api('/trees/' + restored.body.id);
  assert.equal(tree.status, 200);
  assert.equal(tree.body.people.length, 500);
  assert.equal(tree.body.people[0].notes.length, 3000);
});

test('a valid backup sent as text/plain above 1 MB is also accepted by the route parser', async () => {
  const backup = smallBackup({ tree: { name: 'Plain text restore' } });
  backup.people[0].notes = 't'.repeat(1_300_000);
  const r = await api('/trees/restore?preview=1', { method: 'POST', text: JSON.stringify(backup), contentType: 'text/plain' });
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, true);
  assert.equal(r.body.counts.people, 1);
});

test('other JSON endpoints retain the 1 MB global limit', async () => {
  const before = treeCount();
  const huge = await api('/trees', { method: 'POST', body: { name: 'x'.repeat(1_200_000), root: { name: 'Root', dob: '1980' } } });
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error, 'Request body is too large.');
  assert.equal(treeCount(), before);

  const auth = await api('/auth/login', { method: 'POST', body: { email: 'a'.repeat(1_100_000), password: 'password1' } });
  assert.equal(auth.status, 413);
  assert.equal(auth.body.error, 'Request body is too large.');
});

test('backup restore enforces its own 64 MB ceiling for multipart and raw JSON', async () => {
  const oversized = Buffer.alloc(64 * 1024 * 1024 + 4096, 0x78);
  const viaFile = await multipart('/trees/restore', oversized, 'too-big.json');
  assert.equal(viaFile.status, 413);
  assert.match(viaFile.body.error, /64 MB/);

  const json = '{"people":["' + 'x'.repeat(64 * 1024 * 1024 + 2048) + '"],"marriages":[]}';
  const viaJson = await api('/trees/restore', { method: 'POST', text: json, contentType: 'application/json' });
  assert.equal(viaJson.status, 413);
  assert.equal(viaJson.body.error, 'Request body is too large.');
  assert.equal((await api('/config')).status, 200, 'the server is still alive after oversized bodies');
});

test('malformed and deeply nested JSON are rejected safely', async () => {
  const malformed = await api('/trees/restore', { method: 'POST', text: '{"people":', contentType: 'application/json' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'Invalid JSON in the request body.');

  let deep = '';
  for (let i = 0; i < 200000; i++) deep += '[';
  deep += '0';
  for (let i = 0; i < 200000; i++) deep += ']';
  const nested = await api('/trees/restore', { method: 'POST', text: deep, contentType: 'application/json' });
  assert.equal(nested.status, 400);
  assert.equal(nested.body.error, 'That backup is nested too deeply.');

  assert.equal((await api('/config')).status, 200, 'the server survived malformed bodies');
  assert.equal((await api('/trees')).status, 200, 'authenticated routes still work');
});

test('invalid backup structures and unreasonable record counts are rejected before writes', async () => {
  const beforeTrees = treeCount(), beforePeople = peopleCount(), beforeFiles = uploadCount();
  const cases = [
    ['not an object', []],
    ['missing arrays', { tree: { name: 'x' } }],
    ['no people', { people: [], marriages: [] }],
    ['duplicate person ids', { people: [{ id: 1, name: 'A', dob: '1970' }, { id: '1', name: 'B', dob: '1971' }], marriages: [] }],
    ['duplicate marriage ids', { people: [{ id: 1, name: 'A', dob: '1970' }, { id: 2, name: 'B', dob: '1971' }], marriages: [{ id: 1, a_id: 1, b_id: 2 }, { id: '1', a_id: 1, b_id: 2 }] }],
    ['marriage references unknown person', { people: [{ id: 1, name: 'A', dob: '1970' }], marriages: [{ id: 1, a_id: 1, b_id: 99 }] }],
    ['parent link references unknown marriage', { people: [{ id: 1, name: 'A', dob: '1970', parent_marriage_id: 99 }], marriages: [] }],
    ['invalid person date', { people: [{ id: 1, name: 'A', dob: '2020-02-31' }], marriages: [] }],
    ['too many people', { people: Array.from({ length: 50001 }, (_, i) => ({ id: i + 1, name: 'P' + i, dob: '1950' })), marriages: [] }],
    ['too many marriages', { people: [{ id: 1, name: 'A', dob: '1970' }], marriages: Array.from({ length: 50001 }, (_, i) => ({ id: i + 1, a_id: 1, b_id: null })) }],
    ['too many media files', { people: [{ id: 1, name: 'A', dob: '1970' }], marriages: [], media: Array.from({ length: 2001 }, (_, i) => ({ name: 'm' + i + '.png', data: PNG.toString('base64') })) }],
    ['too many attachments', { people: [{ id: 1, name: 'A', dob: '1970' }], marriages: [], attachments: Array.from({ length: 50001 }, () => ({ person_id: 1, kind: 'source', title: 's' })) }]
  ];
  for (const [name, body] of cases) {
    const r = await api('/trees/restore', { method: 'POST', body });
    assert.equal(r.status, 400, name + ' should be rejected');
    assert.equal(r.body.valid, false, name + ' should report valid:false');
    assert.ok(r.body.errors.length > 0, name + ' should explain the problem');
  }
  assert.equal(treeCount(), beforeTrees);
  assert.equal(peopleCount(), beforePeople);
  assert.equal(uploadCount(), beforeFiles);
});

test('self-parent and multi-person parent-child cycles are rejected', async () => {
  const before = treeCount();
  const selfParent = {
    people: [{ id: 'p1', name: 'Own Parent', dob: '1970', parent_marriage_id: 'm1' }],
    marriages: [{ id: 'm1', a_id: 'p1', b_id: null }]
  };
  let r = await api('/trees/restore', { method: 'POST', body: selfParent });
  assert.equal(r.status, 400);
  assert.match(r.body.errors.join(' '), /own parent/i);

  const cycle = {
    people: [
      { id: 'a', name: 'Cycle A', dob: '1970', parent_marriage_id: 'mBC' },
      { id: 'b', name: 'Cycle B', dob: '1971', parent_marriage_id: 'mCA' },
      { id: 'c', name: 'Cycle C', dob: '1972', parent_marriage_id: 'mAB' }
    ],
    marriages: [
      { id: 'mAB', a_id: 'a', b_id: 'b' },
      { id: 'mBC', a_id: 'b', b_id: 'c' },
      { id: 'mCA', a_id: 'c', b_id: 'a' }
    ]
  };
  r = await api('/trees/restore', { method: 'POST', body: cycle });
  assert.equal(r.status, 400);
  assert.match(r.body.errors.join(' '), /parent-child loop/i);
  assert.equal(treeCount(), before, 'rejected cycles create no tree');
});

test('media names cannot escape uploads, and invalid or oversized media is skipped', async () => {
  const beforeFiles = uploadCount();
  const escape = smallBackup({
    tree: { name: 'Media traversal' },
    people: [{ id: 1, name: 'Media Person', dob: '1970', photo: '../../escape.png' }],
    media: [{ name: '../../escape.png', data: PNG.toString('base64') }]
  });
  const ok = await api('/trees/restore', { method: 'POST', body: escape });
  assert.equal(ok.status, 200);
  assert.equal(uploadCount(), beforeFiles + 1);
  const person = (await api('/trees/' + ok.body.id)).body.people[0];
  assert.match(person.photo, /^\/uploads\/[0-9]+-[0-9a-f]+\.png$/);
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, '..', 'escape.png')), false, 'no file outside uploads');
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'escape.png')), false, 'no file beside uploads');
  assert.equal(fs.existsSync(path.join(UPLOADS_DIR, 'escape.png')), false, 'the supplied name is not used on disk');

  const beforeSkipped = uploadCount();
  const badMedia = smallBackup({
    tree: { name: 'Bad media' },
    media: [
      { name: 'evil.png', data: Buffer.from('<html><script>alert(1)</script>').toString('base64') },
      { name: 'huge.png', data: Buffer.alloc(9 * 1024 * 1024, 0x41).toString('base64') }
    ]
  });
  const skipped = await api('/trees/restore', { method: 'POST', body: badMedia });
  assert.equal(skipped.status, 200);
  assert.ok(skipped.body.warnings.length >= 2);
  assert.equal(skipped.body.counts.media, 0);
  assert.equal(uploadCount(), beforeSkipped, 'no file was written for invalid or oversized media');
});

test('a failed restore leaves database records and copied media unchanged', async () => {
  const backup = smallBackup({
    tree: { name: 'Rollback probe' },
    media: [{ name: 'face.png', data: PNG.toString('base64') }],
    attachments: [{ person_id: 1, kind: 'source', title: 'FORCE FAIL' }]
  });
  backup.people[0].photo = 'face.png';
  const beforeTrees = treeCount(), beforePeople = peopleCount(), beforeFiles = uploadCount();
  db.exec(`CREATE TRIGGER force_backup_restore_fail BEFORE INSERT ON attachments WHEN NEW.title='FORCE FAIL'
    BEGIN SELECT RAISE(ABORT,'forced restore failure'); END;`);
  try {
    const r = await api('/trees/restore', { method: 'POST', body: backup });
    assert.equal(r.status, 400);
  } finally { db.exec('DROP TRIGGER IF EXISTS force_backup_restore_fail'); }
  assert.equal(treeCount(), beforeTrees);
  assert.equal(peopleCount(), beforePeople);
  assert.equal(uploadCount(), beforeFiles, 'copied media was removed after rollback');
});

test('restore requires authentication even for oversized bodies', async () => {
  const before = treeCount();
  const r = await api('/trees/restore', { method: 'POST', token: null, text: JSON.stringify(smallBackup()), contentType: 'application/json' });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'unauthenticated');
  assert.equal(treeCount(), before);
});
