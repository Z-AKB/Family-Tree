const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-security-test-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-security-data-'));
process.env.JWT_SECRET = 'security-test-secret';
process.env.AUTH_LIMIT = '1000';
process.env.NODE_ENV = 'test';
delete process.env.SEED_DEMO;
const app = require('../server');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const Database = require('better-sqlite3');
let srv, base;
before(() => new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; r(); }); }));
after(() => {
  srv.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {}
});

const call = async (p, { method = 'GET', token, body, text, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: text ?? (body && JSON.stringify(body)) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, headers: r.headers };
};
const login = async (email, password) => (await call('/auth/login', { method: 'POST', body: { email, password } })).body.token;
const register = (email, password, name) => call('/auth/register', { method: 'POST', body: { email, password, name } });

test('config exposes only the demo flag', async () => {
  assert.deepEqual((await call('/config')).body, { demoEnabled: true });
});

test('registration validates and normalizes email, name, and password', async () => {
  const reg = await register('  Mixed.Case@Example.COM ', 'password1', '  Ada Lovelace  ');
  assert.equal(reg.status, 200);
  assert.equal(reg.body.user.email, 'mixed.case@example.com');
  assert.equal(reg.body.user.name, 'Ada Lovelace');
  assert.ok(await login('MIXED.CASE@EXAMPLE.COM ', 'password1'));
  assert.equal((await register('mixed.case@example.com', 'password1', 'Ada Again')).status, 409);

  for (const body of [
    { email: 'not-an-email', password: 'password1', name: 'A' },
    { email: 'x@y.test', password: 'short', name: 'A' },
    { email: 'x@y.test', password: 'a'.repeat(73), name: 'A' },
    { email: 'x@y.test', password: 'é'.repeat(37), name: 'A' },
    { email: 'x@y.test', password: 'password1', name: '   ' },
    { email: 'x@y.test', password: 'password1', name: 'x'.repeat(81) },
    { email: 'a'.repeat(250) + '@x.test', password: 'password1', name: 'A' }
  ]) assert.equal((await call('/auth/register', { method: 'POST', body })).status, 400);

  assert.equal((await register('bytes@family.test', 'é'.repeat(36), 'Bytes')).status, 200);
  assert.ok(await login('bytes@family.test', 'é'.repeat(36)));

  const t = await login('mixed.case@example.com', 'password1');
  assert.equal((await call('/me', { method: 'PATCH', token: t, body: { name: '  ' } })).status, 400);
  assert.equal((await call('/me', { method: 'PATCH', token: t, body: { name: 'x'.repeat(81) } })).status, 400);
  assert.equal((await call('/me', { method: 'PATCH', token: t, body: { name: '  Grace Hopper  ' } })).status, 200);
  assert.equal((await call('/me', { token: t })).body.name, 'Grace Hopper');
});

test('JWT verification is pinned to HS256', async () => {
  const reg = await register('jwt@family.test', 'password1', 'Jwt User');
  const id = reg.body.user.id;
  assert.equal((await call('/me', { token: reg.body.token })).status, 200);
  const hs384 = jwt.sign({ id, tv: 0 }, 'security-test-secret', { algorithm: 'HS384' });
  assert.equal((await call('/me', { token: hs384 })).status, 401);
});

test('password changes and resets invalidate outstanding reset links', async () => {
  const outbox = require('../server').outbox, email = 'reset-links@family.test';
  await register(email, 'password1', 'Reset Links');
  const forgot = async () => {
    const n = outbox.length;
    assert.equal((await call('/auth/forgot', { method: 'POST', body: { email } })).status, 200);
    assert.equal(outbox.length, n + 1);
    return outbox.at(-1).text.match(/token=([0-9a-f]+)/)[1];
  };

  const beforeChangeA = await forgot(), beforeChangeB = await forgot();
  const t = await login(email, 'password1');
  const changed = await call('/me/password', { method: 'POST', token: t, body: { current: 'password1', password: 'password2' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('/auth/reset', { method: 'POST', body: { token: beforeChangeA, password: 'password3' } })).status, 400);
  assert.equal((await call('/auth/reset', { method: 'POST', body: { token: beforeChangeB, password: 'password3' } })).status, 400);

  const afterChangeA = await forgot(), afterChangeB = await forgot();
  assert.equal((await call('/auth/reset', { method: 'POST', body: { token: afterChangeA, password: 'password4' } })).status, 200);
  assert.equal((await call('/auth/reset', { method: 'POST', body: { token: afterChangeB, password: 'password5' } })).status, 400);
  assert.ok(await login(email, 'password4'));
});

test('expected errors are safe and unexpected errors do not leak details', async () => {
  const bad = await call('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, text: '{"email":' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'Invalid JSON in the request body.' });

  const missing = await call('/does-not-exist');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Not found.' });

  const t = await login('mixed.case@example.com', 'password1');
  const emptyImport = await call('/trees/import?name=Bad', { method: 'POST', token: t, text: 'hello' });
  assert.equal(emptyImport.status, 400);
  assert.deepEqual(emptyImport.body, { error: 'No people found. Choose a GEDCOM (.ged) file.' });

  const { errorHandler } = require('../server');
  const res = () => ({ headersSent: false, statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const original = console.error; let logged = '';
  console.error = (...args) => { logged = args.join(' '); };
  try {
    const unexpected = res();
    errorHandler(new Error('SQLITE_ERROR: no such table: C:\\secret\\family.db'), { method: 'POST', originalUrl: '/api/private' }, unexpected, () => {});
    assert.equal(unexpected.statusCode, 500);
    assert.deepEqual(unexpected.body, { error: 'Something went wrong. Please try again.' });
    assert.match(logged, /SQLITE_ERROR/);

    const upload = res();
    errorHandler(new multer.MulterError('LIMIT_FILE_SIZE'), { method: 'POST', originalUrl: '/api/people/1/photo' }, upload, () => {});
    assert.equal(upload.statusCode, 400);
    assert.match(upload.body.error, /maximum 3 MB/);

    const attachment = res();
    errorHandler(new multer.MulterError('LIMIT_FILE_SIZE'), { method: 'POST', originalUrl: '/api/people/1/attachments' }, attachment, () => {});
    assert.equal(attachment.statusCode, 400);
    assert.match(attachment.body.error, /maximum 5 MB/);
  } finally { console.error = original; }
});

test('a failed password change rolls back and keeps the old hash and reset tokens', async () => {
  const outbox = require('../server').outbox, email = 'rollback-change@family.test';
  await register(email, 'password1', 'Rollback Change');
  const t = await login(email, 'password1');
  await call('/auth/forgot', { method: 'POST', body: { email } });
  const raw = outbox.at(-1).text.match(/token=([0-9a-f]+)/)[1];

  const side = new Database(process.env.DB);
  side.exec("CREATE TRIGGER fail_password_change BEFORE UPDATE OF hash ON users BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  try {
    const changed = await call('/me/password', { method: 'POST', token: t, body: { current: 'password1', password: 'password2' } });
    assert.equal(changed.status, 500);
    assert.deepEqual(changed.body, { error: 'Something went wrong. Please try again.' });
  } finally {
    side.exec('DROP TRIGGER fail_password_change');
    side.close();
  }

  assert.ok(await login(email, 'password1'));
  assert.equal((await call('/auth/login', { method: 'POST', body: { email, password: 'password2' } })).status, 401);
  assert.equal((await call('/auth/reset', { method: 'POST', body: { token: raw, password: 'password3' } })).status, 200);
  assert.ok(await login(email, 'password3'));
});

test('a failed reset rolls back and keeps the old hash and reset token', async () => {
  const outbox = require('../server').outbox, email = 'rollback-reset@family.test';
  await register(email, 'password1', 'Rollback Reset');
  await call('/auth/forgot', { method: 'POST', body: { email } });
  const raw = outbox.at(-1).text.match(/token=([0-9a-f]+)/)[1];

  const side = new Database(process.env.DB);
  side.exec("CREATE TRIGGER fail_reset BEFORE UPDATE OF hash ON users BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  try {
    const reset = await call('/auth/reset', { method: 'POST', body: { token: raw, password: 'password2' } });
    assert.equal(reset.status, 500);
    assert.deepEqual(reset.body, { error: 'Something went wrong. Please try again.' });
  } finally {
    side.exec('DROP TRIGGER fail_reset');
    side.close();
  }

  assert.ok(await login(email, 'password1'));
  assert.equal((await call('/auth/reset', { method: 'POST', body: { token: raw, password: 'password2' } })).status, 200);
  assert.ok(await login(email, 'password2'));
});
