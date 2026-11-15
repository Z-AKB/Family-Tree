// Regression tests for the relationship, sharing, restore and GEDCOM workflows added in this repair pass.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-workflows-test-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-workflows-data-'));
process.env.JWT_SECRET = 'workflows-test-secret';
process.env.AUTH_LIMIT = '1000';
process.env.NODE_ENV = 'test';
delete process.env.SEED_DEMO;
const app = require('../server');
const Database = require('better-sqlite3');
const outbox = app.outbox;
let srv, base, db;
before(() => new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; db = new Database(process.env.DB); r(); }); }));
after(() => {
  try { db.close(); } catch {}
  srv.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {}
});

const call = async (p, { method = 'GET', token, body, text } = {}) => {
  const h = {}; if (token) h.Authorization = 'Bearer ' + token;
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: text ?? (body && JSON.stringify(body)) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, headers: r.headers };
};
const upload = async (p, token, field, filename, type, bytes) => {
  const fd = new FormData();
  fd.append(field, new Blob([bytes], { type }), filename);
  const h = {}; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method: 'POST', headers: h, body: fd });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const uploadCount = () => (fs.existsSync(path.join(process.env.DATA_DIR, 'uploads')) ? fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads')).length : 0);

let seq = 0;
const register = async (email, name) => {
  const r = await call('/auth/register', { method: 'POST', body: { email: email || `wf${++seq}@test.local`, password: 'password1', name: name || 'User ' + seq } });
  assert.equal(r.status, 200);
  return { token: r.body.token, id: r.body.user.id, email: r.body.user.email };
};
// A tree with a root, one established couple and a helper that makes people with no parents.
const fixture = async () => {
  const u = await register();
  const r = await call('/trees', { method: 'POST', token: u.token, body: { name: 'Workflow ' + (++seq), root: { name: 'Root ' + seq, gender: 'Male', dob: '1950' } } });
  assert.equal(r.status, 200);
  const tid = r.body.id;
  const d = (await call('/trees/' + tid, { token: u.token })).body;
  const root = d.people[0];
  const sp = await call(`/trees/${tid}/people`, { method: 'POST', token: u.token, body: { name: 'Spouse ' + seq, gender: 'Female', dob: '1952', spouse_of: root.id, year: 1975 } });
  assert.equal(sp.status, 200);
  const full = (await call('/trees/' + tid, { token: u.token })).body;
  const baseMarriage = full.marriages.find(m => (m.a_id === root.id && m.b_id === sp.body.id) || (m.b_id === root.id && m.a_id === sp.body.id));
  assert.ok(baseMarriage);
  return { ...u, tid, root, spouseId: sp.body.id, baseMarriage };
};
const standalone = async (f, name, dob = '1980', gender = 'Other', dod = null) => {
  const made = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name, gender, dob, dod, parent_marriage_id: f.baseMarriage.id } });
  assert.equal(made.status, 200);
  assert.equal((await call(`/people/${made.body.id}/parents`, { method: 'DELETE', token: f.token })).status, 200);
  return made.body.id;
};
const tree = async f => (await call('/trees/' + f.tid, { token: f.token })).body;
const person = async (f, id) => (await tree(f)).people.find(p => p.id === id);

test('partial person and relationship edits keep fields the client did not send', async () => {
  const f = await fixture();
  const made = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Partial Person', gender: 'Female', dob: '1985-04-03', birth_place: 'Lagos', notes: 'Original note' } });
  assert.equal(made.status, 200);
  const id = made.body.id;

  assert.equal((await call('/people/' + id, { method: 'PUT', token: f.token, body: { name: 'Renamed Person' } })).status, 200);
  let p = await person(f, id);
  assert.deepEqual([p.name, p.gender, p.dob, p.birth_place, p.notes], ['Renamed Person', 'Female', '1985-04-03', 'Lagos', 'Original note']);

  assert.equal((await call('/people/' + id, { method: 'PUT', token: f.token, body: { notes: 'New note' } })).status, 200);
  p = await person(f, id);
  assert.deepEqual([p.name, p.gender, p.dob, p.birth_place, p.notes], ['Renamed Person', 'Female', '1985-04-03', 'Lagos', 'New note']);

  // Clearing an optional field on purpose still works.
  assert.equal((await call('/people/' + id, { method: 'PUT', token: f.token, body: { birth_place: '' } })).status, 200);
  p = await person(f, id);
  assert.equal(p.birth_place, null);

  const m = f.baseMarriage;
  assert.equal((await call('/marriages/' + m.id, { method: 'PUT', token: f.token, body: { year: 1976 } })).status, 200);
  let mm = (await tree(f)).marriages.find(x => x.id === m.id);
  assert.deepEqual([mm.year, mm.kind, mm.end_year], [1976, m.kind, m.end_year]);

  assert.equal((await call('/marriages/' + m.id, { method: 'PUT', token: f.token, body: { end_year: 1990 } })).status, 200);
  mm = (await tree(f)).marriages.find(x => x.id === m.id);
  assert.deepEqual([mm.year, mm.kind, mm.end_year], [1976, m.kind, 1990]);
});

test('merging cannot create a parent-child cycle and leaves the tree untouched', async () => {
  const f = await fixture();
  const great = await call(`/people/${f.root.id}/parents`, { method: 'POST', token: f.token, body: { father: { name: 'Great ' + seq, dob: '1900' } } });
  assert.equal(great.status, 200);
  const kid = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Kid ' + seq, dob: '1978', parent_marriage_id: f.baseMarriage.id } });
  assert.equal(kid.status, 200);
  const before = await tree(f);

  for (const [a, b] of [[great.body.father, kid.body.id], [kid.body.id, great.body.father], [f.root.id, great.body.father], [great.body.father, f.root.id]]) {
    const r = await call(`/people/${a}/merge`, { method: 'POST', token: f.token, body: { into: b } });
    assert.equal(r.status, 409, 'ancestor merges must be refused');
  }
  const afterTree = await tree(f);
  assert.equal(afterTree.people.length, before.people.length);
  assert.equal(afterTree.marriages.length, before.marriages.length);
  assert.equal((await person(f, kid.body.id)).parent_marriage_id, f.baseMarriage.id);
});

test('single-parent families are labelled and validated accurately', async () => {
  const f = await fixture();
  const child = await standalone(f, 'Single Child', '1990');
  const add = await call(`/people/${child}/parents`, { method: 'POST', token: f.token, body: { mother: { name: 'Single Mother', dob: '1965' } } });
  assert.equal(add.status, 200);
  assert.ok(add.body.parent_marriage_id);

  let t = await tree(f);
  let single = t.marriages.find(m => m.id === add.body.parent_marriage_id);
  assert.equal(single.kind, 'single');
  assert.equal((single.a_id == null) !== (single.b_id == null), true, 'exactly one parent is recorded');
  const motherId = single.a_id == null ? single.b_id : single.a_id;
  assert.equal(t.people.find(p => p.id === child).parent_marriage_id, single.id);

  // A second existing person can be linked to the same single-parent family.
  const child2 = await standalone(f, 'Second Child', '1992');
  assert.equal((await call(`/marriages/${single.id}/children`, { method: 'POST', token: f.token, body: { person_id: child2 } })).status, 200);
  assert.equal((await person(f, child2)).parent_marriage_id, single.id);
  assert.equal((await call(`/marriages/${single.id}/children`, { method: 'POST', token: f.token, body: { person_id: child2 } })).status, 409);

  // Linking one existing person produces a single-parent family automatically.
  const lone = await call('/marriages', { method: 'POST', token: f.token, body: { a_id: f.root.id } });
  assert.equal(lone.status, 200);
  single = (await tree(f)).marriages.find(m => m.id === lone.body.id);
  assert.equal(single.kind, 'single');
  assert.equal(single.b_id, null);
  assert.equal((await call('/marriages/' + single.id, { method: 'PUT', token: f.token, body: { kind: 'married' } })).status, 400);
  assert.equal((await call('/marriages/' + single.id, { method: 'PUT', token: f.token, body: { kind: 'single', year: 1970 } })).status, 200);

  // A two-person relationship cannot call itself a single-parent family.
  assert.equal((await call('/marriages', { method: 'POST', token: f.token, body: { a_id: f.root.id, b_id: f.spouseId, kind: 'single' } })).status, 400);
  assert.equal((await call('/marriages/' + f.baseMarriage.id, { method: 'PUT', token: f.token, body: { kind: 'single' } })).status, 400);
  assert.equal((await call('/trees/' + f.tid + '/people', { method: 'POST', token: f.token, body: { name: 'Bad Spouse', dob: '1980', spouse_of: f.root.id, kind: 'single' } })).status, 400);

  assert.ok(motherId);
});

test('existing people can be linked as a spouse or child, with cross-tree, self and loop checks', async () => {
  const f = await fixture(), other = await fixture();
  const partner = await standalone(f, 'Linked Partner', '1975');

  const linked = await call('/marriages', { method: 'POST', token: f.token, body: { a_id: f.root.id, b_id: partner, kind: 'partner', year: 1999 } });
  assert.equal(linked.status, 200);
  assert.equal((await call('/marriages', { method: 'POST', token: f.token, body: { a_id: f.root.id, b_id: partner, kind: 'partner' } })).status, 409);
  assert.equal((await call('/marriages', { method: 'POST', token: f.token, body: { a_id: f.root.id, b_id: f.root.id } })).status, 400);
  assert.equal((await call('/marriages', { method: 'POST', token: f.token, body: { a_id: f.root.id, b_id: other.root.id } })).status, 400);
  assert.equal((await call('/marriages', { method: 'POST', token: f.token, body: {} })).status, 400);

  const child = await standalone(f, 'Linked Child', '1985');
  assert.equal((await call(`/marriages/${f.baseMarriage.id}/children`, { method: 'POST', token: f.token, body: { person_id: child } })).status, 200);
  assert.equal((await person(f, child)).parent_marriage_id, f.baseMarriage.id);
  assert.equal((await call(`/marriages/${f.baseMarriage.id}/children`, { method: 'POST', token: f.token, body: { person_id: child } })).status, 409);
  assert.equal((await call(`/marriages/${f.baseMarriage.id}/children`, { method: 'POST', token: f.token, body: { person_id: f.root.id } })).status, 409);
  assert.equal((await call(`/marriages/${f.baseMarriage.id}/children`, { method: 'POST', token: f.token, body: { person_id: other.root.id } })).status, 400);

  // A descendant cannot become the parent of their own ancestor; adopted links skip the age rule so the loop check itself is exercised.
  const childUnion = await call('/marriages', { method: 'POST', token: f.token, body: { a_id: child } });
  assert.equal(childUnion.status, 200);
  assert.equal((await call(`/marriages/${childUnion.body.id}/children`, { method: 'POST', token: f.token, body: { person_id: f.root.id, parent_kind: 'adopted' } })).status, 409);
  assert.equal((await person(f, f.root.id)).parent_marriage_id, null);
});

test('parents can be changed, relinked or removed without deleting anyone', async () => {
  const f = await fixture();
  const kid = await standalone(f, 'Changing Child', '1985');

  const added = await call(`/people/${kid}/parents`, { method: 'POST', token: f.token, body: { father: { name: 'Dad ' + seq, dob: '1955' }, mother: { name: 'Mum ' + seq, dob: '1958' }, year: 1980 } });
  assert.equal(added.status, 200);
  assert.equal((await person(f, kid)).parent_marriage_id, added.body.parent_marriage_id);

  assert.equal((await call(`/people/${kid}/parents`, { method: 'PUT', token: f.token, body: { parent_marriage_id: null } })).status, 200);
  assert.equal((await person(f, kid)).parent_marriage_id, null);

  assert.equal((await call(`/people/${kid}/parents`, { method: 'POST', token: f.token, body: { mother: { name: 'Mum Two ' + seq, dob: '1960' } } })).status, 200);
  const single = (await person(f, kid)).parent_marriage_id;
  assert.ok(single);
  assert.equal((await tree(f)).marriages.find(m => m.id === single).kind, 'single');

  assert.equal((await call(`/people/${kid}/parents`, { method: 'PUT', token: f.token, body: { parent_kind: 'nonsense' } })).status, 400);
  assert.equal((await call(`/people/${kid}/parents`, { method: 'PUT', token: f.token, body: { parent_marriage_id: 999999 } })).status, 400);

  // Link an already recorded couple as the parents.
  assert.equal((await call(`/people/${kid}/parents`, { method: 'PUT', token: f.token, body: { parent_marriage_id: f.baseMarriage.id, parent_kind: 'adopted' } })).status, 200);
  let p = await person(f, kid);
  assert.deepEqual([p.parent_marriage_id, p.parent_kind], [f.baseMarriage.id, 'adopted']);

  assert.equal((await call(`/people/${kid}/parents`, { method: 'DELETE', token: f.token })).status, 200);
  p = await person(f, kid);
  assert.deepEqual([p.parent_marriage_id, p.parent_kind], [null, 'biological']);
  assert.ok((await tree(f)).people.some(x => x.id === kid), 'removing parents does not delete the person');

  // Someone cannot become their own parent.
  const other = await standalone(f, 'Own Parent Partner', '1980');
  const ownUnion = await call('/marriages', { method: 'POST', token: f.token, body: { a_id: kid, b_id: other } });
  assert.equal(ownUnion.status, 200);
  assert.equal((await call(`/people/${kid}/parents`, { method: 'PUT', token: f.token, body: { parent_marriage_id: ownUnion.body.id } })).status, 409);

  // A loop is refused by the final integrity check even when dates would otherwise pass.
  const descendant = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Descendant', dob: '1980', parent_marriage_id: f.baseMarriage.id } });
  assert.equal(descendant.status, 200);
  const descendantUnion = await call('/marriages', { method: 'POST', token: f.token, body: { a_id: descendant.body.id } });
  assert.equal(descendantUnion.status, 200);
  assert.equal((await call(`/people/${f.root.id}/parents`, { method: 'PUT', token: f.token, body: { parent_marriage_id: descendantUnion.body.id, parent_kind: 'adopted' } })).status, 409);
});

test('removing a relationship keeps everyone and unlinks their children', async () => {
  const f = await fixture();
  const kid = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Union Child', dob: '1980', parent_marriage_id: f.baseMarriage.id } });
  assert.equal(kid.status, 200);
  const before = await tree(f);
  assert.equal((await call('/marriages/' + f.baseMarriage.id, { method: 'DELETE', token: f.token })).status, 200);
  const afterTree = await tree(f);
  assert.equal(afterTree.people.length, before.people.length);
  assert.ok(afterTree.people.some(p => p.id === f.root.id) && afterTree.people.some(p => p.id === f.spouseId) && afterTree.people.some(p => p.id === kid.body.id));
  assert.equal(afterTree.marriages.some(m => m.id === f.baseMarriage.id), false);
  assert.equal(afterTree.people.find(p => p.id === kid.body.id).parent_marriage_id, null);
  assert.equal((await call('/marriages/' + f.baseMarriage.id, { method: 'DELETE', token: f.token })).status, 404);
});

test('invitations: pending, accept, decline, expiry, roles, self-leave and ownership transfer', async () => {
  const f = await fixture();
  const inviteEmail = `future${++seq}@test.local`;

  const created = await call(`/trees/${f.tid}/invites`, { method: 'POST', token: f.token, body: { email: inviteEmail, role: 'editor' } });
  assert.equal(created.status, 200);
  assert.equal(created.body.invited, true);
  const mail = outbox.filter(m => m.to === inviteEmail).at(-1);
  assert.ok(mail);
  const raw = mail.text.match(/token=([0-9a-f]+)/)[1];

  const pub = await call('/invites/' + raw);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.status, 'pending');
  assert.equal(pub.body.role, 'editor');
  assert.equal(pub.body.tree.id, f.tid);
  assert.ok(pub.body.email.includes('***'), 'the public invitation hides most of the address');
  assert.ok(!pub.body.email.includes(inviteEmail.split('@')[0] + '@'));

  assert.equal((await call(`/trees/${f.tid}/invites`, { method: 'POST', token: f.token, body: { email: inviteEmail, role: 'viewer' } })).status, 409);
  assert.equal((await call(`/trees/${f.tid}/invites`, { method: 'POST', token: f.token, body: { email: inviteEmail, role: 'owner' } })).status, 400);
  assert.equal((await call(`/trees/${f.tid}/invites`, { method: 'POST', token: f.token, body: { email: 'bad-email', role: 'editor' } })).status, 400);

  const future = await register(inviteEmail, 'Future Member');
  const outsider = await register();
  assert.equal((await call('/invites/accept', { method: 'POST', token: outsider.token, body: { token: raw } })).status, 403);
  const accepted = await call('/invites/accept', { method: 'POST', token: future.token, body: { token: raw } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.tree.id, f.tid);
  let memberTree = await call('/trees/' + f.tid, { token: future.token });
  assert.equal(memberTree.status, 200);
  assert.deepEqual([memberTree.body.role, memberTree.body.canEdit], ['editor', true]);
  assert.equal((await call('/invites/accept', { method: 'POST', token: future.token, body: { token: raw } })).status, 409);
  assert.equal((await call('/invites/' + raw)).body.status, 'accepted');

  // Declining works and cannot be reversed.
  const declineEmail = `decline${++seq}@test.local`;
  assert.equal((await call(`/trees/${f.tid}/invites`, { method: 'POST', token: f.token, body: { email: declineEmail, role: 'viewer' } })).status, 200);
  const declineRaw = outbox.filter(m => m.to === declineEmail).at(-1).text.match(/token=([0-9a-f]+)/)[1];
  const decliner = await register(declineEmail, 'Declining Member');
  assert.equal((await call('/invites/decline', { method: 'POST', token: decliner.token, body: { token: declineRaw } })).status, 200);
  assert.equal((await call('/invites/' + declineRaw)).body.status, 'declined');
  assert.equal((await call('/invites/accept', { method: 'POST', token: decliner.token, body: { token: declineRaw } })).status, 409);

  // Expired invitations are reported and cannot be accepted.
  const lateEmail = `late${++seq}@test.local`;
  assert.equal((await call(`/trees/${f.tid}/invites`, { method: 'POST', token: f.token, body: { email: lateEmail, role: 'viewer' } })).status, 200);
  const lateRaw = outbox.filter(m => m.to === lateEmail).at(-1).text.match(/token=([0-9a-f]+)/)[1];
  db.prepare('UPDATE invites SET expires_at=? WHERE email=?').run(Date.now() - 1000, lateEmail);
  const late = await register(lateEmail, 'Late Member');
  assert.equal((await call('/invites/' + lateRaw)).body.status, 'expired');
  assert.equal((await call('/invites/accept', { method: 'POST', token: late.token, body: { token: lateRaw } })).status, 410);

  // Inviting an existing account adds them straight away; roles can be changed by the owner.
  const directEmail = `direct${++seq}@test.local`;
  const direct = await register(directEmail, 'Direct Member');
  const directInvite = await call(`/trees/${f.tid}/invites`, { method: 'POST', token: f.token, body: { email: directEmail, role: 'editor' } });
  assert.equal(directInvite.body.member, true);
  assert.equal((await call('/trees/' + f.tid, { token: direct.token })).body.role, 'editor');
  assert.equal((await call(`/trees/${f.tid}/members/${direct.id}`, { method: 'PATCH', token: f.token, body: { role: 'viewer' } })).status, 200);
  assert.equal((await call('/trees/' + f.tid, { token: direct.token })).body.canEdit, false);
  assert.equal((await call(`/trees/${f.tid}/members/${direct.id}`, { method: 'PATCH', token: future.token, body: { role: 'editor' } })).status, 403);
  assert.equal((await call(`/trees/${f.tid}/members/${direct.id}`, { method: 'PATCH', token: f.token, body: { role: 'owner' } })).status, 400);
  assert.equal((await call(`/trees/${f.tid}/members/${f.id}`, { method: 'PATCH', token: f.token, body: { role: 'editor' } })).status, 400);

  // A member can leave; the owner cannot be removed and must transfer ownership first.
  assert.equal((await call(`/trees/${f.tid}/members/${direct.id}`, { method: 'DELETE', token: direct.token })).status, 200);
  assert.equal((await call('/trees/' + f.tid, { token: direct.token })).status, 404);
  assert.equal((await call(`/trees/${f.tid}/members/${f.id}`, { method: 'DELETE', token: f.token })).status, 400);
  assert.equal((await call(`/trees/${f.tid}/owner`, { method: 'POST', token: f.token, body: { user_id: direct.id } })).status, 400);

  // Transfer ownership to a current member: the old owner becomes an editor, not a stranger.
  assert.equal((await call(`/trees/${f.tid}/owner`, { method: 'POST', token: f.token, body: { user_id: future.id } })).status, 200);
  const newOwner = await call('/trees/' + f.tid, { token: future.token });
  assert.equal(newOwner.body.role, 'owner');
  const oldOwner = await call('/trees/' + f.tid, { token: f.token });
  assert.deepEqual([oldOwner.body.role, oldOwner.body.canEdit], ['editor', true]);
  assert.equal((await call('/trees/' + f.tid, { method: 'PATCH', token: f.token, body: { name: 'Not allowed' } })).status, 403);
  assert.equal((await call('/trees/' + f.tid, { method: 'PATCH', token: future.token, body: { name: 'Renamed by owner' } })).status, 200);
  const members = (await call(`/trees/${f.tid}/members`, { token: future.token })).body;
  assert.ok(members.some(m => m.id === f.id && m.role === 'editor'));
});

test('backup preview changes nothing, restore remaps a new tree, and a failed restore rolls back', async () => {
  const f = await fixture();
  const photo = await upload(`/people/${f.root.id}/photo`, f.token, 'photo', 'me.png', 'image/png', PNG);
  assert.equal(photo.status, 200);
  assert.equal((await call('/people/' + f.root.id, { method: 'PUT', token: f.token, body: { notes: 'A note that must survive' } })).status, 200);
  const att = new FormData();
  att.append('kind', 'source'); att.append('title', 'Census'); att.append('description', 'Two households'); att.append('url', 'https://example.org/census');
  const attRes = await fetch(`${base}/people/${f.root.id}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + f.token }, body: att });
  assert.equal(attRes.status, 200);

  const backup = await call('/trees/' + f.tid + '/export.json', { token: f.token });
  assert.equal(backup.status, 200);
  assert.equal(backup.body.version, 2);
  assert.ok(backup.body.media.length >= 1, 'backup carries media');

  const treeCount = async () => (await call('/trees', { token: f.token })).body.length;
  const countBefore = await treeCount();
  const preview = await call('/trees/restore?preview=1', { method: 'POST', token: f.token, body: backup.body });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.valid, true);
  assert.equal(preview.body.preview, true);
  assert.equal(preview.body.counts.people, backup.body.people.length);
  assert.equal(await treeCount(), countBefore, 'preview creates no tree');

  const restored = await call('/trees/restore', { method: 'POST', token: f.token, body: backup.body });
  assert.equal(restored.status, 200);
  assert.ok(restored.body.id);
  const copy = (await call('/trees/' + restored.body.id, { token: f.token })).body;
  const copiedRoot = copy.people.find(p => p.name === f.root.name);
  assert.ok(copiedRoot);
  assert.equal(copy.tree.root_id, copiedRoot.id, 'root_id points at the restored copy');
  assert.equal(copiedRoot.notes, 'A note that must survive');
  assert.ok(copiedRoot.photo && copiedRoot.photo.startsWith('/uploads/'));
  const photoRes = await fetch(`${base.replace('/api', '')}/api/people/${copiedRoot.id}/photo`, { headers: { Authorization: 'Bearer ' + f.token } });
  assert.equal(photoRes.status, 200);
  assert.ok((await call(`/people/${copiedRoot.id}/attachments`, { token: f.token })).body.some(a => a.title === 'Census' && a.url === 'https://example.org/census' && a.description === 'Two households'));

  // Invalid backups are rejected before anything is written.
  const filesBefore = uploadCount();
  const noPeople = await call('/trees/restore', { method: 'POST', token: f.token, body: { people: [], marriages: [] } });
  assert.equal(noPeople.status, 400);
  assert.equal(noPeople.body.valid, false);
  const badPerson = await call('/trees/restore', { method: 'POST', token: f.token, body: { people: [{ id: 1, name: '', dob: '2000' }], marriages: [] } });
  assert.equal(badPerson.status, 400);
  assert.equal(badPerson.body.valid, false);
  assert.equal(await treeCount(), countBefore + 1);
  assert.equal(uploadCount(), filesBefore);

  // Force a database failure after media has been copied: the tree and files must both be rolled back.
  db.exec(`CREATE TRIGGER force_restore_fail BEFORE INSERT ON attachments WHEN NEW.title='FORCE FAIL'
    BEGIN SELECT RAISE(ABORT,'forced restore failure'); END;`);
  try {
    const forced = JSON.parse(JSON.stringify(backup.body));
    forced.tree.name = 'Forced failure tree';
    forced.attachments = [{ person_id: forced.people[0].id, kind: 'source', title: 'FORCE FAIL' }];
    const r = await call('/trees/restore', { method: 'POST', token: f.token, body: forced });
    assert.equal(r.status, 400);
    assert.equal(await treeCount(), countBefore + 1, 'the failed restore left no tree behind');
    assert.equal(uploadCount(), filesBefore, 'the failed restore removed copied media');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS force_restore_fail');
  }
});

test('GEDCOM round-trips long text, sources, media and date ranges without record injection', async () => {
  const f = await fixture();
  const longNote = 'First line\nSecond line\n' + 'x'.repeat(220);
  const made = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Gedcom Person', gender: 'Male', dob: '1976', notes: longNote, parent_marriage_id: f.baseMarriage.id } });
  assert.equal(made.status, 200);
  const pid = made.body.id;
  const source = new FormData();
  source.append('kind', 'source'); source.append('title', 'Parish register'); source.append('description', 'Line A\nLine B'); source.append('url', 'https://example.org/parish');
  assert.equal((await fetch(`${base}/people/${pid}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + f.token }, body: source })).status, 200);
  assert.equal((await upload(`/people/${pid}/photo`, f.token, 'photo', 'ged.png', 'image/png', PNG)).status, 200);
  // A newline in user content must never start a new GEDCOM record on export.
  const evil = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Evil\n0 @I999@ INDI', dob: '1980', parent_marriage_id: f.baseMarriage.id } });
  assert.equal(evil.status, 200);

  const gedRes = await fetch(`${base}/trees/${f.tid}/export.ged`, { headers: { Authorization: 'Bearer ' + f.token } });
  const ged = await gedRes.text();
  assert.equal(gedRes.status, 200);
  assert.match(ged, /1 NOTE First line/);
  assert.match(ged, /2 CONT Second line/);
  assert.match(ged, /\d CONC /);
  assert.match(ged, /1 SOUR/);
  assert.match(ged, /2 TITL Parish register/);
  assert.match(ged, /2 WWW https:\/\/example\.org\/parish/);
  assert.match(ged, /3 CONT Line B/);
  assert.match(ged, /1 OBJE/);
  assert.match(ged, /2 FILE uploads\//);
  assert.ok(!/^0 @I999@ INDI$/m.test(ged), 'a newline in a name cannot inject a record');

  const copy = await call('/trees/import?name=GEDCOM Copy', { method: 'POST', token: f.token, text: ged });
  assert.equal(copy.status, 200);
  const c = (await call('/trees/' + copy.body.id, { token: f.token })).body;
  const imported = c.people.find(p => p.name === 'Gedcom Person');
  assert.ok(imported);
  assert.equal(imported.notes, longNote);
  const atts = (await call(`/people/${imported.id}/attachments`, { token: f.token })).body;
  assert.ok(atts.some(a => a.kind === 'source' && a.title === 'Parish register' && a.url === 'https://example.org/parish' && /Line A\nLine B/.test(a.description)));
  assert.ok(atts.some(a => a.kind === 'photo' && a.file));
  assert.equal(c.people.filter(p => p.name === 'Evil 0 @I999@ INDI').length, 1);
  assert.equal(c.people.length, (await tree(f)).people.length);

  // Date ranges and qualifiers are understood.
  const rangeGed = [
    '0 @I1@ INDI', '1 NAME Between Person', '1 SEX M', '1 BIRT', '2 DATE BET 1900 AND 1910',
    '0 @I2@ INDI', '1 NAME From Person', '1 SEX F', '1 BIRT', '2 DATE FROM 1920',
    '0 @I3@ INDI', '1 NAME To Person', '1 SEX M', '1 BIRT', '2 DATE TO 1930',
    '0 @I4@ INDI', '1 NAME About Person', '1 SEX F', '1 BIRT', '2 DATE ABT 1940'
  ].join('\n');
  const ranged = await call('/trees/import?name=Date Ranges', { method: 'POST', token: f.token, text: rangeGed });
  assert.equal(ranged.status, 200);
  const rp = (await call('/trees/' + ranged.body.id, { token: f.token })).body.people;
  const byName = n => rp.find(p => p.name === n);
  assert.deepEqual([byName('Between Person').dob, byName('Between Person').dob_q], ['1900', null]);
  assert.deepEqual([byName('From Person').dob, byName('From Person').dob_q], ['1920', 'after']);
  assert.deepEqual([byName('To Person').dob, byName('To Person').dob_q], ['1930', 'before']);
  assert.deepEqual([byName('About Person').dob, byName('About Person').dob_q], ['1940', 'about']);
});

test('depth parameters are validated everywhere they are accepted', async () => {
  const f = await fixture();
  for (const d of ['-1', '99', 'abc', '1.5', '']) {
    assert.equal((await call(`/trees/${f.tid}?depth=${encodeURIComponent(d)}`, { token: f.token })).status, 400, 'tree depth ' + JSON.stringify(d));
  }
  assert.equal((await call('/trees/' + f.tid + '?depth=2', { token: f.token })).status, 200);
  for (const d of ['0', '9', 'x', '-2']) {
    assert.equal((await call(`/people/${f.root.id}/pedigree?depth=${encodeURIComponent(d)}`, { token: f.token })).status, 400, 'pedigree depth ' + JSON.stringify(d));
  }
  assert.equal((await call(`/people/${f.root.id}/pedigree?depth=4`, { token: f.token })).status, 200);
  for (const d of ['0', '11', 'x', '-1']) {
    assert.equal((await call(`/people/${f.root.id}/relatives?depth=${encodeURIComponent(d)}`, { token: f.token })).status, 400, 'relative depth ' + JSON.stringify(d));
  }
  assert.equal((await call(`/people/${f.root.id}/relatives?depth=3`, { token: f.token })).status, 200);
});

test('search supports pagination, filters, sorting and a total count', async () => {
  const f = await fixture();
  await standalone(f, 'Zephyr Alpha', '1965', 'Male');
  await standalone(f, 'Zephyr Beta', '1980', 'Female', '2020');
  await standalone(f, 'Zephyr Gamma', '1990', 'Female');

  const q = async params => call('/trees/' + f.tid + '/search?' + new URLSearchParams(params).toString(), { token: f.token });
  let r = await q({ q: 'Zephyr' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-total-count'), '3');
  assert.deepEqual(r.body.map(p => p.name), ['Zephyr Alpha', 'Zephyr Beta', 'Zephyr Gamma']);

  r = await q({ q: 'Zephyr', gender: 'Female' });
  assert.deepEqual([r.body.map(p => p.name), r.headers.get('x-total-count')], [['Zephyr Beta', 'Zephyr Gamma'], '2']);

  r = await q({ q: 'Zephyr', status: 'deceased' });
  assert.deepEqual([r.body.map(p => p.name), r.headers.get('x-total-count')], [['Zephyr Beta'], '1']);

  r = await q({ q: 'Zephyr', from: '1975' });
  assert.deepEqual(r.body.map(p => p.name), ['Zephyr Beta', 'Zephyr Gamma']);
  r = await q({ q: 'Zephyr', to: '1975' });
  assert.deepEqual(r.body.map(p => p.name), ['Zephyr Alpha']);

  r = await q({ q: 'Zephyr', sort: 'born_desc' });
  assert.deepEqual(r.body.map(p => p.name), ['Zephyr Gamma', 'Zephyr Beta', 'Zephyr Alpha']);

  r = await q({ q: 'Zephyr', limit: '1', offset: '1' });
  assert.deepEqual(r.body.map(p => p.name), ['Zephyr Beta']);
  assert.equal(r.headers.get('x-total-count'), '3');

  r = await q({ q: 'Zephyr', limit: '0', offset: '-5' });
  assert.equal(r.body.length, 3, 'invalid paging falls back to safe defaults');

  r = await q({ q: '%' });
  assert.deepEqual([r.body, r.headers.get('x-total-count')], [[], '0']);
});

test('history paginates, filters and records account activity', async () => {
  const f = await fixture();
  await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'History Child', dob: '1980', parent_marriage_id: f.baseMarriage.id } });
  const all = await call('/trees/' + f.tid + '/history?limit=200', { token: f.token });
  assert.equal(all.status, 200);
  assert.ok(all.body.length >= 2);
  assert.equal(all.headers.get('x-total-count'), String(all.body.length));

  const page = await call('/trees/' + f.tid + '/history?limit=1&offset=0', { token: f.token });
  assert.equal(page.body.length, 1);
  assert.equal(page.headers.get('x-total-count'), String(all.body.length));

  const added = await call('/trees/' + f.tid + '/history?action=added', { token: f.token });
  assert.ok(added.body.length >= 1);
  assert.ok(added.body.every(x => /added/.test(x.action)));
  assert.ok(Number(added.headers.get('x-total-count')) >= added.body.length);

  assert.equal((await call('/trees/' + f.tid + '/history?from=2999-01-01', { token: f.token })).headers.get('x-total-count'), '0');
  assert.equal((await call('/trees/' + f.tid + '/history?to=2000-01-01', { token: f.token })).headers.get('x-total-count'), '0');
  assert.equal((await call('/trees/' + f.tid + '/history', { token: f.token })).status, 200);

  const acts = await call('/me/activity', { token: f.token });
  assert.equal(acts.status, 200);
  assert.ok(acts.body.some(a => /account/.test(a.action)));
  assert.ok((await call('/me/activity')).status === 401);
});

test('insights count the longest parent chain', async () => {
  const f = await fixture();
  // Great-grandparent above the root.
  const gp = await call(`/people/${f.root.id}/parents`, { method: 'POST', token: f.token, body: { father: { name: 'Great ' + seq, dob: '1900' } } });
  assert.equal(gp.status, 200);
  // child of the root couple, their spouse, and a grandchild.
  const kid = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Gen Child', dob: '1978', parent_marriage_id: f.baseMarriage.id } });
  assert.equal(kid.status, 200);
  const kidSpouse = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Gen Spouse', dob: '1979', spouse_of: kid.body.id } });
  assert.equal(kidSpouse.status, 200);
  const t = await tree(f);
  const kidUnion = t.marriages.find(m => (m.a_id === kid.body.id && m.b_id === kidSpouse.body.id) || (m.b_id === kid.body.id && m.a_id === kidSpouse.body.id));
  assert.ok(kidUnion);
  assert.equal((await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Grandchild', dob: '2005', parent_marriage_id: kidUnion.id } })).status, 200);

  const i = (await call('/trees/' + f.tid + '/insights', { token: f.token })).body;
  assert.equal(i.generations, 4);
  assert.equal(i.living + i.deceased, i.people);
  assert.ok(i.commonNames.length >= 1);
});

test('a deep person can still receive a photo and the server keeps cache headers strict', async () => {
  const f = await fixture();
  const kid = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Deep Child', dob: '1978', parent_marriage_id: f.baseMarriage.id } });
  assert.equal(kid.status, 200);
  const kidSpouse = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Deep Spouse', dob: '1979', spouse_of: kid.body.id } });
  assert.equal(kidSpouse.status, 200);
  const t = await tree(f);
  const u = t.marriages.find(m => (m.a_id === kid.body.id && m.b_id === kidSpouse.body.id) || (m.b_id === kid.body.id && m.a_id === kidSpouse.body.id));
  assert.ok(u);
  const deep = await call(`/trees/${f.tid}/people`, { method: 'POST', token: f.token, body: { name: 'Deep Grandchild', dob: '2005', parent_marriage_id: u.id } });
  assert.equal(deep.status, 200);

  assert.equal((await upload(`/people/${deep.body.id}/photo`, f.token, 'photo', 'deep.png', 'image/png', PNG)).status, 200);
  const shown = await person(f, deep.body.id);
  assert.ok(shown.photo && shown.photo.startsWith('/uploads/'));
  const img = await fetch(`${base.replace('/api', '')}/api/people/${deep.body.id}/photo`, { headers: { Authorization: 'Bearer ' + f.token } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('cache-control'), 'no-store');
  const api = await fetch(base + '/trees/' + f.tid, { headers: { Authorization: 'Bearer ' + f.token } });
  assert.equal(api.headers.get('cache-control'), 'no-store');
});
