const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-integrity-test-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-integrity-data-'));
process.env.JWT_SECRET = 'integrity-test-secret';
process.env.AUTH_LIMIT = '1000';
process.env.NODE_ENV = 'test';
delete process.env.SEED_DEMO;
const app = require('../server');
const Database = require('better-sqlite3');
let srv, base;
before(() => new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; r(); }); }));
after(() => {
  srv.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {}
});

const call = async (p, { method = 'GET', token, body, text } = {}) => {
  const h = {}; if (token) h.Authorization = 'Bearer ' + token;
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: text ?? (body && JSON.stringify(body)) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
let seq = 0;
const user = async () => {
  const r = await call('/auth/register', { method: 'POST', body: { email: `integrity${++seq}@test.local`, password: 'password1', name: 'User ' + seq } });
  assert.equal(r.status, 200);
  return r.body.token;
};
const newTree = async (token, root, name = 'Tree ' + (++seq)) => {
  const r = await call('/trees', { method: 'POST', token, body: { name, root } });
  assert.equal(r.status, 200);
  const d = await call('/trees/' + r.body.id, { token });
  return { id: r.body.id, root: d.body.people.find(p => p.name === root.name), people: d.body.people, marriages: d.body.marriages };
};
const add = (token, tid, body) => call(`/trees/${tid}/people`, { method: 'POST', token, body });

test('GEDCOM imports cannot create self-links or parent-child cycles', async () => {
  const token = await user();
  const ged = [
    '0 @I1@ INDI', '1 NAME Cycle One', '1 SEX M',
    '0 @I2@ INDI', '1 NAME Cycle Two', '1 SEX F',
    '0 @I3@ INDI', '1 NAME Cycle Three', '1 SEX M',
    '0 @I4@ INDI', '1 NAME Cycle Four', '1 SEX F',
    '0 @I5@ INDI', '1 NAME Self Spouse', '1 SEX M',
    '0 @I6@ INDI', '1 NAME Self Child', '1 SEX M',
    '0 @I7@ INDI', '1 NAME Self Parent', '1 SEX M',
    '0 @I8@ INDI', '1 NAME Other Parent', '1 SEX F',
    '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 CHIL @I3@',
    '0 @F2@ FAM', '1 HUSB @I3@', '1 WIFE @I4@', '1 CHIL @I1@',
    '0 @F3@ FAM', '1 HUSB @I5@', '1 WIFE @I5@', '1 CHIL @I6@',
    '0 @F4@ FAM', '1 HUSB @I7@', '1 WIFE @I8@', '1 CHIL @I7@'
  ].join('\n');
  const imported = await call('/trees/import?name=Cycle Test', { method: 'POST', token, text: ged });
  assert.equal(imported.status, 200);
  const tree = (await call('/trees/' + imported.body.id, { token })).body;
  assert.equal(tree.people.length, 8);
  assert.ok(tree.marriages.every(m => m.a_id !== m.b_id), 'no one is their own spouse');

  const people = Object.fromEntries(tree.people.map(p => [p.id, p])), marriages = Object.fromEntries(tree.marriages.map(m => [m.id, m]));
  const parents = id => { const m = marriages[people[id] && people[id].parent_marriage_id]; return m ? [m.a_id, m.b_id] : []; };
  const state = {};
  const visit = id => {
    if (state[id] === 1) return true;
    if (state[id] === 2) return false;
    state[id] = 1;
    for (const p of parents(id)) if (visit(p)) return true;
    state[id] = 2; return false;
  };
  assert.equal(tree.people.some(p => visit(p.id)), false, 'no parent-child cycle');
  assert.ok(tree.people.every(p => !parents(p.id).includes(p.id)), 'no one is their own parent');
  assert.equal(people[Object.keys(people).find(k => people[k].name === 'Self Child')].parent_marriage_id, null);
});

test('cross-tree and missing relationship references are rejected', async () => {
  const token = await user();
  const A = await newTree(token, { name: 'Root A', gender: 'Male', dob: '1950' });
  const B = await newTree(token, { name: 'Root B', gender: 'Male', dob: '1960' });
  assert.equal((await add(token, A.id, { name: 'Spouse A', gender: 'Female', dob: '1955', spouse_of: A.root.id, year: 1980 })).status, 200);
  const full = (await call('/trees/' + A.id, { token })).body;
  const mA = full.marriages.find(m => m.a_id === A.root.id || m.b_id === A.root.id);
  assert.ok(mA);
  assert.equal((await add(token, B.id, { name: 'Cross Child', dob: '1990', parent_marriage_id: mA.id })).status, 400);
  assert.equal((await add(token, B.id, { name: 'Cross Spouse', dob: '1990', spouse_of: A.root.id })).status, 400);
  assert.equal((await add(token, B.id, { name: 'Missing Child', dob: '1990', parent_marriage_id: 999999 })).status, 400);
  assert.equal((await add(token, B.id, { name: 'Missing Spouse', dob: '1990', spouse_of: 999999 })).status, 400);
  assert.equal((await call('/trees/' + B.id, { method: 'PATCH', token, body: { root_id: A.root.id } })).status, 400);
  assert.equal((await call('/trees/' + B.id, { method: 'PATCH', token, body: { root_id: 999999 } })).status, 400);
  assert.equal((await call('/trees/' + B.id, { method: 'PATCH', token, body: { root_id: 'not-a-number' } })).status, 400);
  assert.equal((await add(token, A.id, { name: 'Child A', dob: '1985', parent_marriage_id: mA.id })).status, 200);
});

test('impossible parent ages and marriage dates are rejected', async () => {
  const token = await user();
  const T = await newTree(token, { name: 'Grandpa', gender: 'Male', dob: '1900', dod: '1950' });
  assert.equal((await add(token, T.id, { name: 'Grandma', gender: 'Female', dob: '1905', dod: '1960', spouse_of: T.root.id, year: 1920 })).status, 200);
  const full = (await call('/trees/' + T.id, { token })).body;
  const m = full.marriages.find(x => x.a_id === T.root.id || x.b_id === T.root.id);
  assert.ok(m);
  assert.equal((await add(token, T.id, { name: 'After Death', dob: '1955', parent_marriage_id: m.id })).status, 400);
  assert.equal((await add(token, T.id, { name: 'Too Young', dob: '1910', parent_marriage_id: m.id })).status, 400);
  assert.equal((await add(token, T.id, { name: 'Step Child', dob: '1955', parent_marriage_id: m.id, parent_kind: 'step' })).status, 200);
  assert.equal((await add(token, T.id, { name: 'Valid Child', dob: '1930', parent_marriage_id: m.id })).status, 200);
  const valid = (await call('/trees/' + T.id, { token })).body.people.find(p => p.name === 'Valid Child');
  assert.equal((await call('/people/' + valid.id, { method: 'PUT', token, body: { name: 'Valid Child', gender: 'Male', dob: '1955' } })).status, 400);
  assert.equal((await add(token, T.id, { name: 'Early Marriage', dob: '1950', spouse_of: T.root.id, year: 1940 })).status, 400);
  assert.equal((await add(token, T.id, { name: 'Bad End', dob: '1950', spouse_of: T.root.id, year: 1945, end_year: 1940 })).status, 400);
  assert.equal((await add(token, T.id, { name: 'Bad Year', dob: '1950', spouse_of: T.root.id, year: 900 })).status, 400);
  assert.equal((await call('/marriages/' + m.id, { method: 'PUT', token, body: { year: 1970 } })).status, 400);
  assert.equal((await call('/marriages/' + m.id, { method: 'PUT', token, body: { year: 1945, end_year: 1940 } })).status, 400);

  const O = await newTree(token, { name: 'Orphan', gender: 'Male', dob: '1960' });
  assert.equal((await call(`/people/${O.root.id}/parents`, { method: 'POST', token, body: { father: { name: 'Father', dob: '1900' }, mother: { name: 'Mother', dob: '1905' }, year: 1850 } })).status, 400);
  assert.equal((await call(`/people/${O.root.id}/parents`, { method: 'POST', token, body: { father: { name: 'Young Father', dob: '2000' }, mother: { name: 'Mother Two', dob: '1905' }, year: 1990 } })).status, 400);
  assert.equal((await call(`/people/${O.root.id}/parents`, { method: 'POST', token, body: { father: { name: 'Father Good', dob: '1930' }, mother: { name: 'Mother Good', dob: '1935' }, year: 1955 } })).status, 200);
});

test('changing a step link to biological re-checks parent ages and death dates', async () => {
  const token = await user();
  const T = await newTree(token, { name: 'Old Parent', gender: 'Male', dob: '1900', dod: '1950' });
  assert.equal((await add(token, T.id, { name: 'Old Spouse', gender: 'Female', dob: '1905', dod: '1960', spouse_of: T.root.id, year: 1920 })).status, 200);
  const full = (await call('/trees/' + T.id, { token })).body;
  const m = full.marriages.find(x => x.a_id === T.root.id || x.b_id === T.root.id);
  assert.ok(m);
  const made = await add(token, T.id, { name: 'Late Child', dob: '1955', parent_marriage_id: m.id, parent_kind: 'step' });
  assert.equal(made.status, 200);
  const late = (await call('/trees/' + T.id, { token })).body.people.find(p => p.id === made.body.id);
  const convert = await call('/people/' + late.id, { method: 'PUT', token, body: { name: 'Late Child', gender: 'Other', dob: '1955', parent_kind: 'biological' } });
  assert.equal(convert.status, 400, 'step to biological must not bypass parent age/death validation');
  const stored = (await call('/trees/' + T.id, { token })).body.people.find(p => p.id === made.body.id);
  assert.equal(stored.parent_kind, 'step', 'the rejected edit must not change the stored relationship');
});

test('invalid references already in the database do not crash reads or leak across trees', async () => {
  const token = await user();
  const A = await newTree(token, { name: 'Root A', gender: 'Male', dob: '1950' });
  const B = await newTree(token, { name: 'Root B', gender: 'Male', dob: '1960' });
  assert.equal((await add(token, A.id, { name: 'Spouse A', gender: 'Female', dob: '1955', spouse_of: A.root.id, year: 1980 })).status, 200);
  const full = (await call('/trees/' + A.id, { token })).body;
  const mA = full.marriages.find(x => x.a_id === A.root.id || x.b_id === A.root.id);
  const side = new Database(process.env.DB);
  let dangling, cross;
  try {
    side.prepare('UPDATE trees SET root_id=? WHERE id=?').run(999999, B.id);
    dangling = side.prepare('INSERT INTO people(tree_id,name,dob,parent_marriage_id) VALUES(?,?,?,?)').run(B.id, 'Dangling Parent', '1970', 999999).lastInsertRowid;
    cross = side.prepare('INSERT INTO people(tree_id,name,dob,parent_marriage_id) VALUES(?,?,?,?)').run(B.id, 'Cross Child', '1975', mA.id).lastInsertRowid;
  } finally { side.close(); }

  const bTree = await call('/trees/' + B.id + '?depth=2', { token });
  assert.equal(bTree.status, 200);
  assert.notEqual(bTree.body.tree.root_id, 999999);
  assert.ok(bTree.body.people.some(p => p.name === 'Root B'));
  assert.equal((await call('/people/' + dangling + '/branch', { token })).status, 200);

  const aDeep = (await call('/trees/' + A.id + '?depth=20', { token })).body;
  assert.ok(!aDeep.people.some(p => p.name === 'Cross Child'));
  const crossBranch = (await call('/people/' + cross + '/branch', { token })).body;
  assert.ok(!crossBranch.people.some(p => p.name === 'Root A' || p.name === 'Spouse A'));
  assert.equal((await call('/people/' + cross + '/relatives', { token })).body.ancestors.length, 0);
  const ped = (await call('/people/' + cross + '/pedigree', { token })).body;
  assert.ok(!ped.people.some(p => p.name === 'Root A' || p.name === 'Spouse A'));
});

test('session failures are machine-readable and wrong passwords are not treated as logout', async () => {
  const missing = await call('/me');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, 'unauthenticated');
  const token = await user();
  const wrong = await call('/me/password', { method: 'POST', token, body: { current: 'not-the-password', password: 'password2' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, undefined);
});
