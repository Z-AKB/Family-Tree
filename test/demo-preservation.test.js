const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-demo-preserve-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-demo-preserve-data-'));
process.env.JWT_SECRET = 'demo-preserve-test-secret';
process.env.AUTH_LIMIT = '1000';
process.env.NODE_ENV = 'production';
process.env.SEED_DEMO = '1';

const Database = require('better-sqlite3');
const seed = new Database(process.env.DB);
seed.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, hash TEXT NOT NULL)');
seed.prepare('INSERT INTO users(email,name,hash) VALUES(?,?,?)').run('existing@family.test', 'Existing User', 'not-a-real-hash');
seed.close();

const app = require('../server');
let srv, base;
before(() => new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; r(); }); }));
after(() => {
  srv.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {}
});

test('existing accounts are preserved: the demo account is not seeded even with SEED_DEMO=1', async () => {
  assert.deepEqual(await fetch(base + '/config').then(r => r.json()), { demoEnabled: false });
  const login = await fetch(base + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@family.test', password: 'demo1234' })
  });
  assert.equal(login.status, 401);

  const db = new Database(process.env.DB);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE email=?').get('demo@family.test').n, 0);
  } finally { db.close(); }
});
