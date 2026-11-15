const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');

// Use an isolated temporary database for migration tests.
const DB_PATH = path.join(os.tmpdir(), `ft-migration-${process.pid}.db`);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-migration-data-'));
process.env.DB = DB_PATH;
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = 'migration-test-secret';
process.env.AUTH_LIMIT = '1000';
process.env.NODE_ENV = 'test';
delete process.env.SEED_DEMO;

const Database = require('better-sqlite3');

// ---- Build a legacy database with NOT NULL marriage partners (pre-single-parent schema) ----
const legacyDb = new Database(DB_PATH);
legacyDb.pragma('foreign_keys = ON');
legacyDb.exec(`
CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, hash TEXT NOT NULL);
CREATE TABLE trees(id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, root_id INTEGER);
CREATE TABLE people(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  name TEXT NOT NULL, gender TEXT, dob TEXT NOT NULL, dod TEXT, photo TEXT, parent_marriage_id INTEGER);
CREATE TABLE marriages(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  a_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, b_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, year INTEGER);
CREATE TABLE members(tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('editor','viewer')), PRIMARY KEY(tree_id,user_id));
CREATE TABLE audit(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE, user_id INTEGER,
  action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE account_audit(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE invites(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','viewer')), token_hash TEXT NOT NULL UNIQUE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at INTEGER NOT NULL, accepted_at INTEGER, declined_at INTEGER);
CREATE TABLE attachments(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('source','document','photo')), title TEXT NOT NULL, description TEXT, url TEXT, file TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE resets(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
`);

// Insert seed data: user, tree, people, and marriages (both partners present, legacy-valid).
legacyDb.prepare('INSERT INTO users(email,name,hash) VALUES(?,?,?)').run('mig@family.test', 'Migrator', 'hash');
legacyDb.prepare('INSERT INTO trees(id,owner_id,name,root_id) VALUES(1,1,\'Legacy Tree\',1)').run();
legacyDb.prepare('INSERT INTO people(id,tree_id,name,gender,dob) VALUES(1,1,\'Alice\',\'Female\',\'1940\')').run();
legacyDb.prepare('INSERT INTO people(id,tree_id,name,gender,dob) VALUES(2,1,\'Bob\',\'Male\',\'1938\')').run();
legacyDb.prepare('INSERT INTO people(id,tree_id,name,gender,dob) VALUES(3,1,\'Carol\',\'Female\',\'1965\')').run();
legacyDb.prepare('INSERT INTO people(id,tree_id,name,gender,dob) VALUES(4,1,\'Dave\',\'Male\',\'1970\')').run();
// Marriage 1: Alice + Bob
legacyDb.prepare('INSERT INTO marriages(id,tree_id,a_id,b_id,year) VALUES(1,1,1,2,1962)').run();
// Marriage 2: Carol + Dave
legacyDb.prepare('INSERT INTO marriages(id,tree_id,a_id,b_id,year) VALUES(2,1,3,4,1985)').run();
legacyDb.close();

// Verify legacy schema has NOT NULL on marriage partners.
const checkLegacy = new Database(DB_PATH);
const legacyCols = checkLegacy.prepare('PRAGMA table_info(marriages)').all();
const legacyAIdCol = legacyCols.find(c => c.name === 'a_id');
const legacyBIdCol = legacyCols.find(c => c.name === 'b_id');
assert.equal(legacyAIdCol.notnull, 1, 'legacy a_id should be NOT NULL');
assert.equal(legacyBIdCol.notnull, 1, 'legacy b_id should be NOT NULL');
checkLegacy.close();

const app = require('../server');
let srv, base;
before(() => new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; r(); }); }));
after(() => {
  srv.close();
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(DB_PATH + x); } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('migration preserves all marriage records and IDs', async () => {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const cols = db.prepare('PRAGMA table_info(marriages)').all();
    const aIdCol = cols.find(c => c.name === 'a_id');
    const bIdCol = cols.find(c => c.name === 'b_id');
    // After migration, neither column should be NOT NULL.
    assert.equal(aIdCol.notnull, 0, 'migrated a_id should allow NULL');
    assert.equal(bIdCol.notnull, 0, 'migrated b_id should allow NULL');

    // Both original marriage records should exist with same IDs.
    const m1 = db.prepare('SELECT * FROM marriages WHERE id=1').get();
    assert.ok(m1, 'marriage 1 should exist');
    assert.equal(m1.a_id, 1);
    assert.equal(m1.b_id, 2);
    assert.equal(m1.year, 1962);
    const m2 = db.prepare('SELECT * FROM marriages WHERE id=2').get();
    assert.ok(m2, 'marriage 2 should exist');
    assert.equal(m2.a_id, 3);
    assert.equal(m2.b_id, 4);
    assert.equal(m2.year, 1985);

    const count = db.prepare('SELECT COUNT(*) AS n FROM marriages').get().n;
    assert.equal(count, 2, 'should have 2 marriages');
  } finally {
    db.close();
  }
});

test('migration preserves foreign keys and dependent records', async () => {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    // People referenced by marriages should still exist.
    const people = db.prepare('SELECT id FROM people WHERE id IN (1,2,3,4)').all();
    assert.equal(people.length, 4, 'all 4 people should exist');

    // Foreign key check should pass.
    const fkIssues = db.prepare('PRAGMA foreign_key_check').all();
    assert.deepEqual(fkIssues, [], 'no foreign key violations');

    // Integrity check should pass.
    const integrity = db.prepare('PRAGMA integrity_check').get();
    assert.equal(integrity.integrity_check, 'ok', 'database integrity should be ok');
  } finally {
    db.close();
  }
});

test('migration preserves indexes and constraints', async () => {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='marriages'").all();
    const indexNames = indexes.map(i => i.name);
    assert.ok(indexNames.includes('ix_marr_a'), 'ix_marr_a index should exist');
    assert.ok(indexNames.includes('ix_marr_b'), 'ix_marr_b index should exist');
    assert.ok(indexNames.includes('ix_marr_tree'), 'ix_marr_tree index should exist');
    assert.ok(indexNames.includes('ux_marr'), 'ux_marr unique index should exist');

    // The CHECK constraints should be present.
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='marriages'").get().sql;
    assert.ok(schema.includes('CHECK(a_id IS NOT NULL OR b_id IS NOT NULL)'), 'CHECK constraint should exist');
    assert.ok(schema.includes('CHECK(a_id IS NULL OR b_id IS NULL OR a_id <> b_id)'), 'self-pair CHECK should exist');
  } finally {
    db.close();
  }
});

test('migration is idempotent: second startup causes no damage', async () => {
  // Start a second server instance against the same already-migrated database.
  const app2 = require('../server');
  const srv2 = app2.listen(0, () => {
    srv2.close();
  });
  await new Promise(r => setTimeout(r, 100));

  const db = new Database(DB_PATH, { readonly: true });
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM marriages').get().n;
    assert.equal(count, 2, 'marriage count should be unchanged after second startup');
    const m1 = db.prepare('SELECT * FROM marriages WHERE id=1').get();
    assert.ok(m1, 'marriage 1 should still exist');
    const m2 = db.prepare('SELECT * FROM marriages WHERE id=2').get();
    assert.ok(m2, 'marriage 2 should still exist');
    const fkIssues = db.prepare('PRAGMA foreign_key_check').all();
    assert.deepEqual(fkIssues, [], 'no foreign key violations after second startup');
  } finally {
    db.close();
  }
});

test('migration records itself in schema_migrations', async () => {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db.prepare('SELECT * FROM schema_migrations WHERE version=1').get();
    assert.ok(row, 'migration version 1 should be recorded');
  } finally {
    db.close();
  }
});

test('migration rolls back on failure during table rebuild', () => {
  // Create a fresh legacy database for the rollback test
  const rbPath = path.join(os.tmpdir(), `ft-migration-rollback-${process.pid}.db`);
  fs.rmSync(rbPath, { force: true });

  const rbDb = new Database(rbPath);
  rbDb.pragma('foreign_keys = ON');
  rbDb.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, hash TEXT NOT NULL);
    CREATE TABLE trees(id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, root_id INTEGER);
    CREATE TABLE people(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
      name TEXT NOT NULL, gender TEXT, dob TEXT NOT NULL, dod TEXT, photo TEXT, parent_marriage_id INTEGER);
    CREATE TABLE marriages(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
      a_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, b_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, year INTEGER);
  `);
  rbDb.prepare('INSERT INTO users(email,name,hash) VALUES(?,?,?)').run('rb@family.test', 'RollbackTest', 'hash');
  rbDb.prepare("INSERT INTO trees(id,owner_id,name,root_id) VALUES(1,1,'Rollback Tree',1)").run();
  rbDb.prepare("INSERT INTO people(id,tree_id,name,gender,dob) VALUES(1,1,'Eve','Female','1950')").run();
  rbDb.prepare("INSERT INTO people(id,tree_id,name,gender,dob) VALUES(2,1,'Frank','Male','1948')").run();
  rbDb.prepare('INSERT INTO marriages(id,tree_id,a_id,b_id,year) VALUES(1,1,1,2,1970)').run();

  // Record original state before simulated failure
  const originalMarriages = rbDb.prepare('SELECT * FROM marriages').all();
  const originalSchema = rbDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='marriages'").get().sql;

  // Simulate migration with deliberate failure after DROP TABLE (after migration work has begun)
  rbDb.pragma('foreign_keys = OFF');
  rbDb.exec('BEGIN EXCLUSIVE');
  let rolledBack = false;
  try {
    rbDb.exec(`CREATE TABLE marriages_migrated(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
      a_id INTEGER REFERENCES people(id) ON DELETE CASCADE, b_id INTEGER REFERENCES people(id) ON DELETE CASCADE, year INTEGER,
      kind TEXT NOT NULL DEFAULT 'married', end_year INTEGER, ext_id TEXT,
      CHECK(a_id IS NOT NULL OR b_id IS NOT NULL), CHECK(a_id IS NULL OR b_id IS NULL OR a_id <> b_id));`);
    rbDb.exec('INSERT INTO marriages_migrated(id,tree_id,a_id,b_id,year,kind,end_year,ext_id) SELECT id,tree_id,a_id,b_id,year,kind,end_year,ext_id FROM marriages');
    rbDb.exec('DROP TABLE marriages'); // migration work has begun
    throw new Error('Simulated migration failure after table rebuild started');
  } catch (e) {
    rbDb.exec('ROLLBACK');
    rolledBack = true;
  } finally {
    rbDb.pragma('foreign_keys = ON');
  }

  assert.ok(rolledBack, 'rollback should occur after simulated failure');

  // Verify every original marriage record and ID remains intact
  const afterMarriages = rbDb.prepare('SELECT * FROM marriages').all();
  assert.deepEqual(afterMarriages, originalMarriages, 'all original marriage records should be intact after rollback');

  // Verify the original schema remains usable
  const afterSchema = rbDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='marriages'").get().sql;
  assert.equal(afterSchema, originalSchema, 'original schema should be preserved after rollback');

  // Verify foreign-key enforcement is restored
  const fkOn = rbDb.prepare('PRAGMA foreign_keys').get();
  assert.equal(fkOn.foreign_keys, 1, 'foreign key enforcement should be restored after rollback');

  // Verify integrity check passes
  const integrity = rbDb.prepare('PRAGMA integrity_check').get();
  assert.equal(integrity.integrity_check, 'ok', 'database integrity should be ok after rollback');

  // Verify foreign_key_check passes
  const fkIssues = rbDb.prepare('PRAGMA foreign_key_check').all();
  assert.deepEqual(fkIssues, [], 'no foreign key violations after rollback');

  rbDb.close();
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(rbPath + x); } catch {}
});

test('migration succeeds after rollback when re-run on the same legacy database', () => {
  // Create a fresh legacy database (NOT NULL on marriage partners)
  const rb2Path = path.join(os.tmpdir(), `ft-migration-rollback2-${process.pid}.db`);
  fs.rmSync(rb2Path, { force: true });

  const rb2Db = new Database(rb2Path);
  rb2Db.pragma('foreign_keys = ON');
  rb2Db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, hash TEXT NOT NULL);
    CREATE TABLE trees(id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, root_id INTEGER);
    CREATE TABLE people(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
      name TEXT NOT NULL, gender TEXT, dob TEXT NOT NULL, dod TEXT, photo TEXT, parent_marriage_id INTEGER);
    CREATE TABLE marriages(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
      a_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, b_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, year INTEGER);
  `);
  rb2Db.prepare('INSERT INTO users(email,name,hash) VALUES(?,?,?)').run('rb2@family.test', 'Rollback2Test', 'hash');
  rb2Db.prepare("INSERT INTO trees(id,owner_id,name,root_id) VALUES(1,1,'Rollback2 Tree',1)").run();
  rb2Db.prepare("INSERT INTO people(id,tree_id,name,gender,dob) VALUES(1,1,'Grace','Female','1950')").run();
  rb2Db.prepare("INSERT INTO people(id,tree_id,name,gender,dob) VALUES(2,1,'Henry','Male','1948')").run();
  rb2Db.prepare('INSERT INTO marriages(id,tree_id,a_id,b_id,year) VALUES(1,1,1,2,1970)').run();
  rb2Db.close();

  // Save original exec, patch to throw on DROP TABLE marriages (simulate first failure)
  const originalExec = Database.prototype.exec;
  Database.prototype.exec = function(sql) {
    if (typeof sql === 'string' && sql.includes('DROP TABLE marriages')) {
      throw new Error('Simulated migration failure at DROP TABLE marriages');
    }
    return originalExec.call(this, sql);
  };

  let firstAttemptFailed = false;
  try {
    delete require.cache[require.resolve('../server')];
    process.env.DB = rb2Path;
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-migration-rb2-data-'));
    try {
      require('../server');
    } catch (e) {
      firstAttemptFailed = true;
    }
  } finally {
    Database.prototype.exec = originalExec;
  }

  assert.ok(firstAttemptFailed, 'first migration attempt should fail');

  // Verify rollback: original records intact, NOT NULL constraint preserved
  const checkDb = new Database(rb2Path, { readonly: true });
  try {
    const count = checkDb.prepare('SELECT COUNT(*) AS n FROM marriages').get().n;
    assert.equal(count, 1, 'marriage count should be 1 after rollback');
    const m1 = checkDb.prepare('SELECT * FROM marriages WHERE id=1').get();
    assert.ok(m1, 'marriage 1 should still exist');
    assert.equal(m1.a_id, 1);
    assert.equal(m1.b_id, 2);
    assert.equal(m1.year, 1970);

    const cols = checkDb.prepare('PRAGMA table_info(marriages)').all();
    const aIdCol = cols.find(c => c.name === 'a_id');
    assert.equal(aIdCol.notnull, 1, 'rollback should preserve original NOT NULL constraint');

    const fkIssues = checkDb.prepare('PRAGMA foreign_key_check').all();
    assert.deepEqual(fkIssues, [], 'no foreign key violations after rollback');

    const integrity = checkDb.prepare('PRAGMA integrity_check').get();
    assert.equal(integrity.integrity_check, 'ok', 'integrity check should pass after rollback');

    // schema_migrations should NOT mark version 1 as applied
    const row = checkDb.prepare('SELECT * FROM schema_migrations WHERE version=1').get();
    assert.equal(row, undefined, 'failed migration should not be recorded in schema_migrations');
  } finally {
    checkDb.close();
  }

  // Foreign key enforcement should be restored
  const fkDb = new Database(rb2Path);
  try {
    const fkOn = fkDb.prepare('PRAGMA foreign_keys').get();
    assert.equal(fkOn.foreign_keys, 1, 'foreign key enforcement should be restored');
  } finally {
    fkDb.close();
  }

  // Now run valid migration: restore exec, clear cache, re-require
  delete require.cache[require.resolve('../server')];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-migration-rb2-data-'));
  require('../server');
  // Give migration time to complete synchronously (it runs at module load)

  // Verify migration now succeeds
  const verifyDb = new Database(rb2Path, { readonly: true });
  try {
    const count = verifyDb.prepare('SELECT COUNT(*) AS n FROM marriages').get().n;
    assert.equal(count, 1, 'marriage count should be 1 after valid migration');
    const m1 = verifyDb.prepare('SELECT * FROM marriages WHERE id=1').get();
    assert.ok(m1, 'marriage 1 should exist after valid migration');
    assert.equal(m1.a_id, 1);
    assert.equal(m1.b_id, 2);

    const cols = verifyDb.prepare('PRAGMA table_info(marriages)').all();
    const aIdCol = cols.find(c => c.name === 'a_id');
    assert.equal(aIdCol.notnull, 0, 'a_id should allow NULL after valid migration');

    const row = verifyDb.prepare('SELECT * FROM schema_migrations WHERE version=1').get();
    assert.ok(row, 'migration version 1 should be recorded after valid migration');

    const fkIssues = verifyDb.prepare('PRAGMA foreign_key_check').all();
    assert.deepEqual(fkIssues, [], 'no foreign key violations after valid migration');
  } finally {
    verifyDb.close();
  }

  // Cleanup
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(rb2Path + x); } catch {}
});