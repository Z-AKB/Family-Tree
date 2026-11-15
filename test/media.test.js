const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DB = path.join(os.tmpdir(), `ft-media-test-${process.pid}.db`);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-media-data-'));
process.env.JWT_SECRET = 'media-test-secret';
process.env.AUTH_LIMIT = '1000';
process.env.NODE_ENV = 'test';
delete process.env.SEED_DEMO;
const app = require('../server');
const Database = require('better-sqlite3');
let srv, base, db;
before(() => new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; db = new Database(process.env.DB); r(); }); }));
after(() => {
  try { db.close(); } catch {}
  srv.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch {}
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const call = async (p, { method = 'GET', token, body } = {}) => {
  const h = {}; if (token) h.Authorization = 'Bearer ' + token;
  if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body && JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const media = async (p, token) => {
  const h = {}; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { headers: h });
  return { status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) };
};
const upload = async (p, token, field, filename, type, bytes, extra) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra || {})) fd.append(k, v);
  fd.append(field, new Blob([bytes], { type }), filename);
  const h = {}; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method: 'POST', headers: h, body: fd });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const upPath = rel => path.join(process.env.DATA_DIR, 'uploads', path.basename(rel));
const exists = rel => fs.existsSync(upPath(rel));
const count = () => fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads')).length;
let seq = 0;
const newUser = async () => {
  const email = `u${++seq}@media.test`;
  const r = await call('/auth/register', { method: 'POST', body: { email, password: 'password1', name: 'User ' + seq } });
  assert.equal(r.status, 200);
  return r.body.token;
};
const newTree = async (token, root, name = 'Tree ' + (++seq)) => {
  const r = await call('/trees', { method: 'POST', token, body: { name, root } });
  assert.equal(r.status, 200);
  const d = await call('/trees/' + r.body.id, { token });
  return { id: r.body.id, root: d.body.people[0], people: d.body.people, marriages: d.body.marriages };
};
const addSpouse = async (token, tree, rootId, name = 'Spouse') => {
  const r = await call('/trees/' + tree.id + '/people', { method: 'POST', token, body: { name, gender: 'Other', dob: '1970', spouse_of: rootId } });
  assert.equal(r.status, 200);
  const d = await call('/trees/' + tree.id, { token });
  const m = d.body.marriages.find(x => (x.a_id === rootId && x.b_id === r.body.id) || (x.b_id === rootId && x.a_id === r.body.id));
  return { id: r.body.id, marriageId: m && m.id };
};
const addChild = async (token, tree, marriageId, name = 'Child') => {
  const r = await call('/trees/' + tree.id + '/people', { method: 'POST', token, body: { name, gender: 'Other', dob: '1990', parent_marriage_id: marriageId } });
  assert.equal(r.status, 200);
  return r.body.id;
};

test('profile photos require a real image and are served only to people who may see them', async () => {
  const token = await newUser();
  const tree = await newTree(token, { name: 'Private Root', gender: 'Other', dob: '1950' });
  const start = count();

  const ok = await upload(`/people/${tree.root.id}/photo`, token, 'photo', 'me.png', 'image/png', PNG);
  assert.equal(ok.status, 200);
  assert.match(ok.body.photo, /^\/uploads\/.+\.png$/);
  assert.ok(exists(ok.body.photo));

  const img = await media(`/people/${tree.root.id}/photo`, token);
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/png');
  assert.deepEqual(img.body, PNG);
  assert.equal((await media(`/people/${tree.root.id}/photo`)).status, 404);

  assert.equal((await upload(`/people/${tree.root.id}/photo`, token, 'photo', 'fake.png', 'image/png', Buffer.from('not an image'))).status, 400);
  assert.equal((await upload(`/people/${tree.root.id}/photo`, token, 'photo', 'me.png', 'image/jpeg', PNG)).status, 400);
  assert.equal((await upload(`/people/${tree.root.id}/photo`, token, 'photo', 'me.jpg', 'image/png', PNG)).status, 400);
  assert.equal((await upload(`/people/${tree.root.id}/photo`, token, 'photo', 'me.pdf', 'application/pdf', PDF)).status, 400);
  assert.equal(count(), start + 1);

  const replaced = await upload(`/people/${tree.root.id}/photo`, token, 'photo', 'new.jpg', 'image/jpeg', JPG);
  assert.equal(replaced.status, 200);
  assert.ok(exists(replaced.body.photo));
  assert.equal(exists(ok.body.photo), false);
  assert.equal((await media(`/people/${tree.root.id}/photo`, token)).type, 'image/jpeg');
});

test('attachments accept images and PDFs, reject disguised files, and honor share-link privacy', async () => {
  const token = await newUser();
  const tree = await newTree(token, { name: 'Public Root', gender: 'Other', dob: '1900', dod: '1980' });
  const p = tree.root.id;
  const png = await upload(`/people/${p}/attachments`, token, 'file', 'pic.png', 'image/png', PNG, { kind: 'photo', title: 'Portrait' });
  assert.equal(png.status, 200);
  const pdf = await upload(`/people/${p}/attachments`, token, 'file', 'doc.pdf', 'application/pdf', PDF, { kind: 'document', title: 'Certificate' });
  assert.equal(pdf.status, 200);
  const list = (await call(`/people/${p}/attachments`, { token })).body;
  assert.equal(list.length, 2);
  const photo = list.find(a => a.kind === 'photo'), doc = list.find(a => a.kind === 'document');
  assert.ok(photo.file && doc.file);
  const gotPhoto = await media(`/attachments/${photo.id}/file`, token);
  assert.equal(gotPhoto.status, 200);
  assert.equal(gotPhoto.type, 'image/png');
  const gotDoc = await media(`/attachments/${doc.id}/file`, token);
  assert.equal(gotDoc.status, 200);
  assert.equal(gotDoc.type, 'application/pdf');

  assert.equal((await upload(`/people/${p}/attachments`, token, 'file', 'fake.pdf', 'application/pdf', Buffer.from('plain text'), { kind: 'document', title: 'Bad' })).status, 400);
  assert.equal((await upload(`/people/${p}/attachments`, token, 'file', 'doc.pdf', 'application/pdf', PDF, { kind: 'photo', title: 'Bad photo' })).status, 400);
  assert.equal((await upload(`/people/${p}/attachments`, token, 'file', 'pic.png', 'image/png', Buffer.from('nope'), { kind: 'document', title: 'Bad image' })).status, 400);

  await call('/trees/' + tree.id, { method: 'PATCH', token, body: { visibility: 'link' } });
  assert.equal((await media(`/attachments/${photo.id}/file`)).status, 200);
  await call('/trees/' + tree.id, { method: 'PATCH', token, body: { visibility: 'private' } });
  assert.equal((await media(`/attachments/${photo.id}/file`)).status, 404);
  const outsider = await newUser();
  assert.equal((await media(`/attachments/${photo.id}/file`, outsider)).status, 404);
});

test('shared links keep living people hidden when hide_living is on', async () => {
  const token = await newUser();
  const tree = await newTree(token, { name: 'Living Root', gender: 'Other', dob: '1990' });
  const ph = await upload(`/people/${tree.root.id}/photo`, token, 'photo', 'me.png', 'image/png', PNG);
  assert.equal(ph.status, 200);
  await upload(`/people/${tree.root.id}/attachments`, token, 'file', 'pic.png', 'image/png', PNG, { kind: 'photo', title: 'Living' });
  const att = (await call(`/people/${tree.root.id}/attachments`, { token })).body[0];
  await call('/trees/' + tree.id, { method: 'PATCH', token, body: { visibility: 'link' } });
  assert.equal((await media(`/people/${tree.root.id}/photo`)).status, 404);
  assert.equal((await media(`/attachments/${att.id}/file`)).status, 404);
  await call('/trees/' + tree.id, { method: 'PATCH', token, body: { visibility: 'link', hide_living: false } });
  assert.equal((await media(`/people/${tree.root.id}/photo`)).status, 200);
  assert.equal((await media(`/attachments/${att.id}/file`)).status, 200);
});

test('deleting an attachment removes its stored file', async () => {
  const token = await newUser();
  const tree = await newTree(token, { name: 'Attachment Cleanup', gender: 'Other', dob: '1950' });
  await upload(`/people/${tree.root.id}/attachments`, token, 'file', 'pic.png', 'image/png', PNG, { kind: 'photo', title: 'Temp' });
  const a = (await call(`/people/${tree.root.id}/attachments`, { token })).body[0];
  assert.ok(exists(a.file));
  assert.equal((await call('/attachments/' + a.id, { method: 'DELETE', token })).status, 200);
  assert.equal(exists(a.file), false);
});

test('deleting a person removes their photo and attachment files', async () => {
  const token = await newUser();
  const tree = await newTree(token, { name: 'Person Cleanup', gender: 'Other', dob: '1950' });
  const spouse = await addSpouse(token, tree, tree.root.id, 'Temp Spouse');
  const ph = await upload(`/people/${spouse.id}/photo`, token, 'photo', 's.png', 'image/png', PNG);
  await upload(`/people/${spouse.id}/attachments`, token, 'file', 's.pdf', 'application/pdf', PDF, { kind: 'document', title: 'Doc' });
  const att = (await call(`/people/${spouse.id}/attachments`, { token })).body[0];
  assert.ok(exists(ph.body.photo) && exists(att.file));
  assert.equal((await call('/people/' + spouse.id, { method: 'DELETE', token })).status, 200);
  assert.equal(exists(ph.body.photo), false);
  assert.equal(exists(att.file), false);
});

test('deleting a tree removes all of its upload files', async () => {
  const token = await newUser();
  const tree = await newTree(token, { name: 'Tree Cleanup', gender: 'Other', dob: '1950' });
  const ph = await upload(`/people/${tree.root.id}/photo`, token, 'photo', 'r.png', 'image/png', PNG);
  await upload(`/people/${tree.root.id}/attachments`, token, 'file', 'r.pdf', 'application/pdf', PDF, { kind: 'document', title: 'Doc' });
  const att = (await call(`/people/${tree.root.id}/attachments`, { token })).body[0];
  assert.ok(exists(ph.body.photo) && exists(att.file));
  assert.equal((await call('/trees/' + tree.id, { method: 'DELETE', token })).status, 200);
  assert.equal(exists(ph.body.photo), false);
  assert.equal(exists(att.file), false);
});

test('account deletion removes owned files and a failed transaction keeps them', async () => {
  const token = await newUser();
  const tree = await newTree(token, { name: 'Account Cleanup', gender: 'Other', dob: '1950' });
  const ph = await upload(`/people/${tree.root.id}/photo`, token, 'photo', 'a.png', 'image/png', PNG);
  await upload(`/people/${tree.root.id}/attachments`, token, 'file', 'a.pdf', 'application/pdf', PDF, { kind: 'document', title: 'Doc' });
  const att = (await call(`/people/${tree.root.id}/attachments`, { token })).body[0];
  assert.ok(exists(ph.body.photo) && exists(att.file));

  db.exec("CREATE TRIGGER media_block_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
  const failed = await call('/me', { method: 'DELETE', token, body: { password: 'password1' } });
  assert.equal(failed.status, 500);
  assert.ok(exists(ph.body.photo) && exists(att.file));
  db.exec('DROP TRIGGER media_block_user_delete');

  assert.equal((await call('/me', { method: 'DELETE', token, body: { password: 'password1' } })).status, 200);
  assert.equal(exists(ph.body.photo), false);
  assert.equal(exists(att.file), false);
});

test('merging people removes only photos that are no longer referenced', async () => {
  const token = await newUser();
  const tree = await newTree(token, { name: 'Merge Keep', gender: 'Other', dob: '1950' });
  const spouse = await addSpouse(token, tree, tree.root.id, 'Merge Spouse');
  const a = await addChild(token, tree, spouse.marriageId, 'Child A');
  const b = await addChild(token, tree, spouse.marriageId, 'Child B');
  const childPhoto = await upload(`/people/${a}/photo`, token, 'photo', 'c.png', 'image/png', PNG);
  assert.equal((await call(`/people/${a}/merge`, { method: 'POST', token, body: { into: b } })).status, 200);
  assert.ok(exists(childPhoto.body.photo));
  const kept = (await call('/trees/' + tree.id, { token })).body.people.find(p => p.id === b);
  assert.equal(kept.photo, childPhoto.body.photo);

  const tree2 = await newTree(token, { name: 'Merge Orphan', gender: 'Other', dob: '1950' });
  const spouse2 = await addSpouse(token, tree2, tree2.root.id, 'Merge Spouse 2');
  const c = await addChild(token, tree2, spouse2.marriageId, 'Child C');
  const d = await addChild(token, tree2, spouse2.marriageId, 'Child D');
  const keepPhoto = await upload(`/people/${d}/photo`, token, 'photo', 'keep.png', 'image/png', PNG);
  const dropPhoto = await upload(`/people/${c}/photo`, token, 'photo', 'drop.png', 'image/png', PNG);
  assert.ok(exists(keepPhoto.body.photo) && exists(dropPhoto.body.photo));
  assert.equal((await call(`/people/${c}/merge`, { method: 'POST', token, body: { into: d } })).status, 200);
  assert.equal(exists(dropPhoto.body.photo), false);
  assert.ok(exists(keepPhoto.body.photo));
});

test('stored file paths cannot escape the uploads directory', async () => {
  const token = await newUser();
  const tree = await newTree(token, { name: 'Traversal', gender: 'Other', dob: '1950' });
  db.prepare('UPDATE people SET photo=? WHERE id=?').run('/uploads/../../server.js', tree.root.id);
  assert.equal((await media(`/people/${tree.root.id}/photo`, token)).status, 404);
});

test('oversized uploads are rejected and leave no partial files', async () => {
  const token = await newUser();
  const tree = await newTree(token, { name: 'Limits', gender: 'Other', dob: '1950' });
  const start = count();
  const bigImage = Buffer.alloc(3 * 1024 * 1024 + 1); PNG.copy(bigImage);
  const profile = await upload(`/people/${tree.root.id}/photo`, token, 'photo', 'big.png', 'image/png', bigImage);
  assert.equal(profile.status, 400);
  assert.match(String(profile.body.error), /3 MB/);
  const bigDoc = Buffer.alloc(5 * 1024 * 1024 + 1); PDF.copy(bigDoc);
  const att = await upload(`/people/${tree.root.id}/attachments`, token, 'file', 'big.pdf', 'application/pdf', bigDoc, { kind: 'document', title: 'Big' });
  assert.equal(att.status, 400);
  assert.match(String(att.body.error), /5 MB/);
  assert.equal(count(), start);
});
