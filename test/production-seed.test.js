const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-production-seed-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-production-seed-data-'));
process.env.JWT_SECRET = 'production-seed-test-secret';
process.env.AUTH_LIMIT = '1000';
process.env.NODE_ENV = 'production';
process.env.SEED_DEMO = '1';
const app = require('../server');
let srv, base;
before(() => new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; r(); }); }));
after(() => {
  srv.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {}
});

test('SEED_DEMO=1 explicitly enables the demo account in production', async () => {
  assert.deepEqual(await fetch(base + '/config').then(r => r.json()), { demoEnabled: true });
  const login = await fetch(base + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@family.test', password: 'demo1234' })
  });
  assert.equal(login.status, 200);
});
