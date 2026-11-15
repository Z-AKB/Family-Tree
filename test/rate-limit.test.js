const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-rate-test-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-rate-data-'));
process.env.JWT_SECRET = 'rate-test-secret';
process.env.AUTH_LIMIT = '3';
process.env.NODE_ENV = 'test';
delete process.env.SEED_DEMO;
const app = require('../server');
let srv, base;
before(() => new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; r(); }); }));
after(() => {
  srv.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {}
});

const login = (email, password, forwardedFor) => {
  const headers = { 'Content-Type': 'application/json' };
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;
  return fetch(base + '/auth/login', { method: 'POST', headers, body: JSON.stringify({ email, password }) });
};

test('failed logins are limited per IP and a successful login cannot reset the limit', async () => {
  assert.equal((await login('demo@family.test', 'demo1234')).status, 200); // success is not counted
  assert.equal((await login('one@example.test', 'wrongpass')).status, 401);
  assert.equal((await login('two@example.test', 'wrongpass')).status, 401);
  // A successful login between failures must not clear the accumulated failures.
  assert.equal((await login('demo@family.test', 'demo1234')).status, 200);
  assert.equal((await login('three@example.test', 'wrongpass')).status, 401);

  const blocked = await login('four@example.test', 'wrongpass');
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /Too many attempts/);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // Even a valid login is rejected while the limit is reached, proving success cannot reset it.
  assert.equal((await login('demo@family.test', 'demo1234')).status, 429);
  // X-Forwarded-For is ignored (trust proxy off), so a spoofed header cannot bypass the IP limit.
  assert.equal((await login('five@example.test', 'wrongpass', '198.51.100.9')).status, 429);
});
