const crypto = require('crypto'), express = require('express'), Database = require('better-sqlite3'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), multer = require('multer'), path = require('path'), fs = require('fs');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me', PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) { console.error('Set JWT_SECRET before running in production.'); process.exit(1); }
const DATA = process.env.DATA_DIR || __dirname, UPLOADS = path.join(DATA, 'uploads'); // point DATA_DIR at a persistent volume when hosting
fs.mkdirSync(UPLOADS, { recursive: true });
const db = new Database(process.env.DB || path.join(DATA, 'family.db'));
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trees(id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, root_id INTEGER);
CREATE TABLE IF NOT EXISTS people(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  name TEXT NOT NULL, gender TEXT, dob TEXT NOT NULL, dod TEXT, photo TEXT, parent_marriage_id INTEGER);
CREATE TABLE IF NOT EXISTS marriages(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  a_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, b_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, year INTEGER);`);

const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
addCol('trees', 'visibility', "TEXT NOT NULL DEFAULT 'private'");
addCol('trees', 'hide_living', 'INTEGER NOT NULL DEFAULT 1');
addCol('people', 'dob_q', 'TEXT'); addCol('people', 'dod_q', 'TEXT'); // about / before / after
addCol('people', 'ext_id', 'TEXT'); addCol('people', 'birth_place', 'TEXT'); addCol('people', 'death_place', 'TEXT'); addCol('people', 'notes', 'TEXT');
addCol('marriages', 'kind', "TEXT NOT NULL DEFAULT 'married'"); addCol('marriages', 'end_year', 'INTEGER'); // married / partner / divorced / separated
addCol('people', 'parent_kind', "TEXT NOT NULL DEFAULT 'biological'"); // biological / adopted / step / foster
addCol('users', 'tv', 'INTEGER NOT NULL DEFAULT 0'); // bumped on password change to end old sessions
addCol('marriages', 'ext_id', 'TEXT'); // id from an imported GEDCOM file
db.exec(`
CREATE TABLE IF NOT EXISTS members(tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('editor','viewer')), PRIMARY KEY(tree_id,user_id));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE, user_id INTEGER,
  action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_people_tree ON people(tree_id);
CREATE INDEX IF NOT EXISTS ix_people_pm ON people(parent_marriage_id);
CREATE INDEX IF NOT EXISTS ix_marr_a ON marriages(a_id);
CREATE INDEX IF NOT EXISTS ix_marr_b ON marriages(b_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_marr ON marriages(tree_id, min(a_id,b_id), max(a_id,b_id));
CREATE UNIQUE INDEX IF NOT EXISTS ux_people_ext ON people(tree_id, ext_id) WHERE ext_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS attachments(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('source','document','photo')), title TEXT NOT NULL, description TEXT, url TEXT, file TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_att_person ON attachments(person_id);
CREATE TABLE IF NOT EXISTS resets(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);`); // a couple can only be recorded once

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => { // basic security headers; scripts and styles only from this site (plus Google Fonts)
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'" });
  next();
});
const hits = new Map(); // simple in-memory limiter against password guessing
const limiter = (max, ms) => (req, res, next) => {
  const k = req.ip, now = Date.now(), h = (hits.get(k) || []).filter(t => now - t < ms);
  if (h.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  h.push(now); hits.set(k, h); next();
};
setInterval(() => hits.clear(), 3600e3).unref();
app.use('/api/auth', limiter(Number(process.env.AUTH_LIMIT) || 20, 15 * 60 * 1000));
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const uid = req => {
  try { const d = jwt.verify((req.headers.authorization || '').slice(7), SECRET), u = q('SELECT tv FROM users WHERE id=?', d.id); return u && u.tv === (d.tv || 0) ? d.id : null; } catch { return null; }
};
const need = (req, res, next) => { const id = uid(req); if (!id) return res.status(401).json({ error: 'Please log in.' }); req.uid = id; next(); };
const fail = (res, code, error) => { res.status(code).json({ error }); return null; };
const q = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

// Dates may be partial (1932, 1932-03, 1932-03-04) and marked about/before/after. dod 'unknown' = deceased, date not known.
const full = d => d.length === 4 ? d + '-01-01' : d.length === 7 ? d + '-01' : d;
const okDate = (d, unk) => (/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(d) && new Date(full(d)).toISOString().slice(0, 10) === full(d)) || (unk && d === 'unknown');
const QS = ['about', 'before', 'after'], qOf = v => QS.includes(v) ? v : null;
const PK = ['biological', 'adopted', 'step', 'foster'], MK = ['married', 'partner', 'divorced', 'separated'];
// Status and age are always derived from the dates, never stored.
const derive = p => {
  let age = null;
  if (/^\d{4}/.test(p.dob || '') && p.dod !== 'unknown') {
    const e = p.dod || new Date().toISOString().slice(0, 10);
    age = +e.slice(0, 4) - +p.dob.slice(0, 4);
    if (p.dob.length === 10 && e.length === 10 && e.slice(5) < p.dob.slice(5)) age--;
  }
  return { ...p, status: p.dod ? 'Deceased' : 'Alive', age };
};
const clean = (b, strict = true) => {
  const name = (b.name || '').trim(), dod = b.dod || null, dob = b.dob || '';
  const gender = ['Male', 'Female', 'Other'].includes(b.gender) ? b.gender : null;
  if (!name) return { error: 'Name is required.' };
  if ((strict || dob) && !okDate(dob)) return { error: 'Enter a birth date like 1932-03-04, 1932-03 or 1932.' };
  if (dod && !okDate(dod, true)) return { error: 'Enter a death date like 2011-09-17, 2011-09 or 2011.' };
  if (dod && dob && dod !== 'unknown' && full(dod) < full(dob)) return { error: 'Date of death cannot be before date of birth.' };
  const txt = (v, n) => String(v || '').trim().slice(0, n) || null;
  return { name, gender, dob, dod, dob_q: dob ? qOf(b.dob_q) : null, dod_q: dod ? qOf(b.dod_q) : null,
    parent_kind: PK.includes(b.parent_kind) ? b.parent_kind : null, birth_place: txt(b.birth_place, 120), death_place: dod ? txt(b.death_place, 120) : null, notes: txt(b.notes, 4000) };
};
const roleOf = (tid, u) => {
  const t = q('SELECT owner_id FROM trees WHERE id=?', tid);
  if (!t || !u) return null;
  if (t.owner_id === u) return 'owner';
  const m = q('SELECT role FROM members WHERE tree_id=? AND user_id=?', tid, u);
  return m ? m.role : null;
};
const log = (tid, u, action, detail) => db.prepare('INSERT INTO audit(tree_id,user_id,action,detail) VALUES(?,?,?,?)').run(tid, u, action, detail || null);
const ownTree = (req, res, min = 'editor') => { // min 'owner' = owner only; 'editor' = owner or editor
  const t = q('SELECT * FROM trees WHERE id=?', req.params.id);
  if (!t) return fail(res, 404, 'Tree not found.');
  const r = roleOf(t.id, req.uid);
  if (r !== 'owner' && !(min === 'editor' && r === 'editor')) return fail(res, 403, min === 'owner' ? 'Only the tree owner can do that.' : 'You do not have permission to edit this tree.');
  return t;
};
const ownPerson = (req, res) => {
  const p = q('SELECT * FROM people WHERE id=?', req.params.id);
  if (!p) return fail(res, 404, 'Person not found.');
  if (!['owner', 'editor'].includes(roleOf(p.tree_id, req.uid))) return fail(res, 403, 'You do not have permission to edit this tree.');
  return p;
};
const addPerson = (treeId, c, pm = null, ext = null) =>
  db.prepare('INSERT INTO people(tree_id,name,gender,dob,dod,dob_q,dod_q,parent_marriage_id,ext_id,birth_place,death_place,notes,parent_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(treeId, c.name, c.gender, c.dob, c.dod, c.dob_q || null, c.dod_q || null, pm, ext, c.birth_place || null, c.death_place || null, c.notes || null, c.parent_kind || 'biological').lastInsertRowid;

// ---- Auth ----
const token = u => jwt.sign({ id: u.id, tv: u.tv || 0 }, SECRET, { expiresIn: '7d' });
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || password.length < 8) return fail(res, 400, 'Enter an email and a password of at least 8 characters.');
  if (q('SELECT id FROM users WHERE email=?', email.toLowerCase())) return fail(res, 409, 'That email is already registered.');
  const id = db.prepare('INSERT INTO users(email,name,hash) VALUES(?,?,?)').run(email.toLowerCase(), name || '', bcrypt.hashSync(password, 10)).lastInsertRowid;
  res.json({ token: token({ id }), user: { id, email, name } });
});
app.post('/api/auth/login', (req, res) => {
  const u = q('SELECT * FROM users WHERE email=?', (req.body.email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.password || '', u.hash)) return fail(res, 401, 'Email or password is incorrect.');
  res.json({ token: token(u), user: { id: u.id, email: u.email, name: u.name } });
});

// ---- Trees ----
app.get('/api/trees', need, (req, res) => res.json(all(
  `SELECT id,name,'owner' role FROM trees WHERE owner_id=? UNION SELECT t.id,t.name,m.role FROM trees t JOIN members m ON m.tree_id=t.id WHERE m.user_id=?`, req.uid, req.uid)));
app.post('/api/trees', need, (req, res) => {
  const name = (req.body.name || '').trim(), c = clean(req.body.root || {});
  if (!name) return fail(res, 400, 'Give your family tree a name.');
  if (c.error) return fail(res, 400, c.error);
  const id = db.transaction(() => {
    const tid = db.prepare('INSERT INTO trees(owner_id,name) VALUES(?,?)').run(req.uid, name).lastInsertRowid;
    db.prepare('UPDATE trees SET root_id=? WHERE id=?').run(addPerson(tid, c), tid);
    return tid;
  })();
  log(id, req.uid, 'created the tree', name);
  res.json({ id });
});
// Privacy: trees are private by default. Visitors to a shared link never see full birth dates or photos of living people.
const redact = p => p.dod ? p : { ...p, dob: (p.dob || '').slice(0, 4), photo: null, birth_place: null, notes: null };
// Loading is generation by generation: ?depth=N returns the first person and N generations below them (with spouses).
// Anyone deeper is fetched on demand from /api/people/:id/branch, one ring at a time.
const bundle = (tid, ids) => {
  const j = JSON.stringify(ids);
  const marriages = all('SELECT * FROM marriages WHERE tree_id=? AND (a_id IN (SELECT value FROM json_each(?)) OR b_id IN (SELECT value FROM json_each(?)))', tid, j, j);
  const want = new Set(ids); marriages.forEach(m => { want.add(m.a_id); want.add(m.b_id); });
  all('SELECT id FROM people WHERE parent_marriage_id IN (SELECT value FROM json_each(?))', JSON.stringify(marriages.map(m => m.id))).forEach(k => want.add(k.id));
  return { people: all('SELECT * FROM people WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify([...want])), marriages };
};
const present = (t, role, b) => { const hide = !role && t.hide_living; return { people: b.people.map(derive).map(p => hide ? redact(p) : p), marriages: b.marriages }; };
app.get('/api/trees/:id', (req, res) => {
  const t = q('SELECT * FROM trees WHERE id=?', req.params.id), role = t && roleOf(t.id, uid(req));
  if (!t || (!role && t.visibility !== 'link')) return fail(res, 404, 'Tree not found.');
  const depth = Math.min(+req.query.depth || 0, 20);
  const b = depth > 0 ? bundle(t.id, all(`WITH RECURSIVE d(id,gen) AS (SELECT ?,0 UNION SELECT k.id,d.gen+1 FROM d JOIN marriages m ON d.id IN (m.a_id,m.b_id)
      JOIN people k ON k.parent_marriage_id=m.id WHERE d.gen<?) SELECT id FROM d`, t.root_id, depth - 1).map(r => r.id))
    : { people: all('SELECT * FROM people WHERE tree_id=?', t.id), marriages: all('SELECT * FROM marriages WHERE tree_id=?', t.id) };
  res.json({ tree: t, role, canEdit: role === 'owner' || role === 'editor', ...present(t, role, b) });
});
app.get('/api/people/:id/branch', (req, res) => {
  const p = q('SELECT * FROM people WHERE id=?', req.params.id), t = p && q('SELECT * FROM trees WHERE id=?', p.tree_id), role = t && roleOf(t.id, uid(req));
  if (!p || (!role && t.visibility !== 'link')) return fail(res, 404, 'Person not found.');
  const b = bundle(t.id, [p.id]); // also bring the person's parents so their page can show them
  const pm = p.parent_marriage_id && q('SELECT * FROM marriages WHERE id=?', p.parent_marriage_id);
  if (pm) { b.marriages.push(pm); [pm.a_id, pm.b_id].forEach(i => { if (!b.people.some(x => x.id === i)) b.people.push(q('SELECT * FROM people WHERE id=?', i)); }); }
  res.json(present(t, role, b));
});
app.patch('/api/trees/:id', need, (req, res) => {
  const t = ownTree(req, res, 'owner'); if (!t) return;
  const b = req.body, name = b.name === undefined ? t.name : String(b.name).trim();
  const vis = b.visibility === undefined ? t.visibility : b.visibility;
  if (!name) return fail(res, 400, 'Give your family tree a name.');
  if (!['private', 'link'].includes(vis)) return fail(res, 400, 'Visibility must be private or link.');
  const root = b.root_id === undefined ? t.root_id : +b.root_id;
  if (root !== t.root_id && !q('SELECT id FROM people WHERE id=? AND tree_id=?', root, t.id)) return fail(res, 400, 'That person is not in this tree.');
  db.prepare('UPDATE trees SET name=?,visibility=?,hide_living=?,root_id=? WHERE id=?').run(name, vis, b.hide_living === undefined ? t.hide_living : (b.hide_living ? 1 : 0), root, t.id);
  log(t.id, req.uid, 'changed tree settings', `${name}, ${vis}`);
  res.json({ ok: true });
});
app.delete('/api/trees/:id', need, (req, res) => {
  if (!ownTree(req, res, 'owner')) return;
  db.prepare('DELETE FROM trees WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Search by name (works with lazy loading, since it queries the database, not the loaded page) ----
app.get('/api/trees/:id/search', (req, res) => {
  const t = q('SELECT * FROM trees WHERE id=?', req.params.id), role = t && roleOf(t.id, uid(req));
  if (!t || (!role && t.visibility !== 'link')) return fail(res, 404, 'Tree not found.');
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json([]);
  const hide = !role && t.hide_living;
  res.json(all("SELECT * FROM people WHERE tree_id=? AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 20", t.id, '%' + term.replace(/[\\%_]/g, '\\$&') + '%')
    .map(derive).map(p => hide ? redact(p) : p).map(({ id, name, dob, dod, dob_q, dod_q }) => ({ id, name, dob, dod, dob_q, dod_q })));
});


// ---- Add both parents to someone (lets a tree grow upward, and lets in-laws have families) ----
app.post('/api/people/:id/parents', need, (req, res) => {
  const p = ownPerson(req, res); if (!p) return;
  if (p.parent_marriage_id) return fail(res, 409, 'This person already has parents in the tree.');
  const f = clean({ ...req.body.father, gender: 'Male' }, false), m = clean({ ...req.body.mother, gender: 'Female' }, false);
  if (f.error) return fail(res, 400, 'Father: ' + f.error);
  if (m.error) return fail(res, 400, 'Mother: ' + m.error);
  const out = db.transaction(() => {
    const a = addPerson(p.tree_id, f), b = addPerson(p.tree_id, m);
    const mid = db.prepare('INSERT INTO marriages(tree_id,a_id,b_id,year) VALUES(?,?,?,?)').run(p.tree_id, a, b, +req.body.year || null).lastInsertRowid;
    db.prepare('UPDATE people SET parent_marriage_id=? WHERE id=?').run(mid, p.id);
    return { father: a, mother: b };
  })();
  log(p.tree_id, req.uid, 'added parents of', p.name);
  res.json(out);
});

// ---- Ancestors for the pedigree chart ----
app.get('/api/people/:id/pedigree', (req, res) => {
  const p = q('SELECT * FROM people WHERE id=?', req.params.id), t = p && q('SELECT * FROM trees WHERE id=?', p.tree_id), role = t && roleOf(t.id, uid(req));
  if (!p || (!role && t.visibility !== 'link')) return fail(res, 404, 'Person not found.');
  const d = Math.min(Math.max(+req.query.depth || 4, 1), 8);
  const ids = all(`WITH RECURSIVE a(id,gen) AS (SELECT ?,0 UNION SELECT x.id,a.gen+1 FROM a JOIN people c ON c.id=a.id JOIN marriages m ON m.id=c.parent_marriage_id
    JOIN people x ON x.id IN (m.a_id,m.b_id) WHERE a.gen<?) SELECT id FROM a`, p.id, d).map(r => r.id), j = JSON.stringify(ids);
  const hide = !role && t.hide_living;
  res.json({ people: all('SELECT * FROM people WHERE id IN (SELECT value FROM json_each(?))', j).map(derive).map(x => hide ? redact(x) : x),
    marriages: all('SELECT * FROM marriages WHERE id IN (SELECT parent_marriage_id FROM people WHERE id IN (SELECT value FROM json_each(?)))', j) });
});

// ---- "How are we related?" Works out blood relationships from the nearest shared ancestor, plus marriage links. ----
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
const great = n => n > 0 ? 'great-'.repeat(n) : '';
const word = (g, m, f, n) => g === 'Male' ? m : g === 'Female' ? f : n;
const kinship = (people, marriages) => {
  const P = Object.fromEntries(people.map(x => [x.id, x])), M = Object.fromEntries(marriages.map(x => [x.id, x]));
  const parents = id => { const m = M[P[id] && P[id].parent_marriage_id]; return m ? [m.a_id, m.b_id] : []; };
  const bloodParents = id => P[id].parent_kind === 'step' ? [] : parents(id); // step links are family, not blood
  const up = id => { const seen = new Map([[id, 0]]); let layer = [id]; for (let g = 1; layer.length && g < 40; g++) { const nx = []; for (const x of layer) for (const y of bloodParents(x)) if (!seen.has(y)) { seen.set(y, g); nx.push(y); } layer = nx; } return seen; };
  // what b is to a, by blood; null if no shared ancestor
  const blood = (a, b) => {
    const A = up(a), B = up(b); let best = null;
    for (const [c, da] of A) if (B.has(c) && (!best || da + B.get(c) < best.da + best.db)) best = { c, da, db: B.get(c) };
    if (!best) return null;
    const { da, db } = best, g = P[b].gender;
    if (da === 0) return db === 1 ? word(g, 'son', 'daughter', 'child') : db === 2 ? word(g, 'grandson', 'granddaughter', 'grandchild') : great(db - 2) + word(g, 'grandson', 'granddaughter', 'grandchild');
    if (db === 0) return da === 1 ? word(g, 'father', 'mother', 'parent') : da === 2 ? word(g, 'grandfather', 'grandmother', 'grandparent') : great(da - 2) + word(g, 'grandfather', 'grandmother', 'grandparent');
    if (da === 1 && db === 1) { const shared = [...A.keys()].filter(k => A.get(k) === 1 && B.get(k) === 1).length; return (shared < 2 ? 'half-' : '') + word(g, 'brother', 'sister', 'sibling'); }
    if (da === 1) return great(db - 2) + word(g, 'nephew', 'niece', 'nephew or niece');
    if (db === 1) return great(da - 2) + word(g, 'uncle', 'aunt', 'uncle or aunt');
    const k = Math.min(da, db) - 1, r = Math.abs(da - db);
    return `${ord(k)} cousin` + (r ? ` ${r === 1 ? 'once' : r === 2 ? 'twice' : r + ' times'} removed` : '');
  };
  const mates = id => marriages.filter(m => m.a_id === id || m.b_id === id).map(m => m.a_id === id ? m.b_id : m.a_id);
  return (a, b) => {
    if (a === b) return { sentence: 'That is the same person.' };
    if (mates(a).includes(b)) return { rel: word(P[b].gender, 'husband', 'wife', 'partner') };
    const r = blood(a, b); if (r) return { rel: r };
    if (P[b].parent_kind === 'step' && parents(b).includes(a)) return { rel: word(P[b].gender, 'stepson', 'stepdaughter', 'stepchild') };
    if (P[a].parent_kind === 'step' && parents(a).includes(b)) return { rel: word(P[b].gender, 'stepfather', 'stepmother', 'stepparent') };
    for (const s of mates(b)) { const x = blood(a, s); if (x) return { sentence: `${P[b].name} is the ${word(P[b].gender, 'husband', 'wife', 'spouse')} of ${P[a].name}'s ${x}.` }; }
    for (const s of mates(a)) { const x = blood(s, b); if (x) return { sentence: `${P[b].name} is ${P[a].name}'s spouse's ${x}.` }; }
    return null;
  };
};
app.get('/api/people/:a/related/:b', (req, res) => {
  const a = q('SELECT * FROM people WHERE id=?', req.params.a), b = q('SELECT * FROM people WHERE id=?', req.params.b), t = a && q('SELECT * FROM trees WHERE id=?', a.tree_id);
  if (!a || !b || a.tree_id !== b.tree_id || (!roleOf(t.id, uid(req)) && t.visibility !== 'link')) return fail(res, 404, 'Person not found.');
  const rel = kinship(all('SELECT id,name,gender,parent_marriage_id,parent_kind FROM people WHERE tree_id=?', t.id), all('SELECT * FROM marriages WHERE tree_id=?', t.id))(a.id, b.id);
  res.json({ text: rel ? (rel.sentence || `${b.name} is ${a.name}'s ${rel.rel}.`) : `No family connection between ${a.name} and ${b.name} was found in this tree.` });
});

// ---- Insights: counts, generations, lifespans, common names, upcoming birthdays ----
app.get('/api/trees/:id/insights', (req, res) => {
  const t = q('SELECT * FROM trees WHERE id=?', req.params.id), role = t && roleOf(t.id, uid(req));
  if (!t || (!role && t.visibility !== 'link')) return fail(res, 404, 'Tree not found.');
  const hide = !role && t.hide_living, ps = all('SELECT * FROM people WHERE tree_id=?', t.id).map(derive), ms = all('SELECT * FROM marriages WHERE tree_id=?', t.id);
  const living = ps.filter(p => !p.dod), gone = ps.filter(p => p.dod), by = {};
  ps.forEach(p => { const k = p.gender || 'Not set'; by[k] = (by[k] || 0) + 1; });
  const lived = gone.filter(p => p.age != null), top = (a, f) => a.reduce((x, p) => (!x || f(p) > f(x)) ? p : x, null);
  const short = p => p && { id: p.id, name: p.name, age: p.age };
  const names = {}; ps.forEach(p => { const n = p.name.split(/\s+/)[0]; names[n] = (names[n] || 0) + 1; });
  let gens = 0, layer = [t.root_id], seen = new Set(layer); // generations below the first person
  while (layer.length && gens < 40) {
    const kids = ps.filter(p => !seen.has(p.id) && ms.some(m => m.id === p.parent_marriage_id && layer.some(x => x === m.a_id || x === m.b_id))).map(p => p.id);
    if (!kids.length) break; kids.forEach(k => seen.add(k)); layer = kids; gens++;
  }
  const today = new Date(), t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const birthdays = hide || !role ? [] : living.filter(p => (p.dob || '').length === 10).map(p => {
    const [y, m, d] = p.dob.split('-').map(Number); let n = Date.UTC(today.getUTCFullYear(), m - 1, d); if (n < t0) n = Date.UTC(today.getUTCFullYear() + 1, m - 1, d);
    return { id: p.id, name: p.name, date: new Date(n).toISOString().slice(5, 10), turns: new Date(n).getUTCFullYear() - y, inDays: Math.round((n - t0) / 864e5) };
  }).filter(b => b.inDays <= 60).sort((a, b) => a.inDays - b.inDays).slice(0, 8);
  res.json({ people: ps.length, living: living.length, deceased: gone.length, marriages: ms.length, generations: gens + 1, gender: by,
    averageLifespan: lived.length ? Math.round(lived.reduce((s, p) => s + p.age, 0) / lived.length) : null,
    longestLived: short(top(lived, p => p.age)), oldestLiving: hide ? null : short(top(living.filter(p => p.age != null), p => p.age)),
    commonNames: Object.entries(names).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([name, count]) => ({ name, count })), birthdays });
});

// ---- Full backup as JSON ----
app.get('/api/trees/:id/export.json', need, (req, res) => {
  const t = ownTree(req, res); if (!t) return;
  res.set('Content-Disposition', 'attachment; filename="family-tree-backup.json"').json({ tree: t, people: all('SELECT * FROM people WHERE tree_id=?', t.id), marriages: all('SELECT * FROM marriages WHERE tree_id=?', t.id) });
});

// ---- Relationship types: married, partner, divorced, separated ----
app.put('/api/marriages/:id', need, (req, res) => {
  const m = q('SELECT * FROM marriages WHERE id=?', req.params.id);
  if (!m) return fail(res, 404, 'Relationship not found.');
  if (!['owner', 'editor'].includes(roleOf(m.tree_id, req.uid))) return fail(res, 403, 'You do not have permission to edit this tree.');
  const yr = v => v === '' || v == null ? null : +v, y = yr(req.body.year), e = yr(req.body.end_year), kind = MK.includes(req.body.kind) ? req.body.kind : m.kind;
  if ([y, e].some(v => v !== null && (!Number.isInteger(v) || v < 1000 || v > 2200))) return fail(res, 400, 'Enter a four-digit year.');
  if (y && e && e < y) return fail(res, 400, 'The end year cannot be before the start year.');
  db.prepare('UPDATE marriages SET kind=?,year=?,end_year=? WHERE id=?').run(kind, y, e, m.id);
  log(m.tree_id, req.uid, 'updated a relationship', kind);
  res.json({ ok: true });
});

// ---- Duplicates: find likely repeats, and merge one person into another ----
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
app.get('/api/trees/:id/duplicates', need, (req, res) => {
  const t = ownTree(req, res); if (!t) return;
  const ps = all('SELECT id,name,dob,dod FROM people WHERE tree_id=?', t.id), out = [], seen = new Set(), byName = {}, byYear = {};
  const push = (a, b, reason) => { const k = a.id + '-' + b.id; if (!seen.has(k) && out.length < 50) { seen.add(k); out.push({ a, b, reason }); } };
  const yr = p => (p.dob || '').slice(0, 4);
  ps.forEach(p => { (byName[norm(p.name)] = byName[norm(p.name)] || []).push(p); if (yr(p)) (byYear[yr(p)] = byYear[yr(p)] || []).push(p); });
  for (const g of Object.values(byName)) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++)
    if (!yr(g[i]) || !yr(g[j]) || yr(g[i]) === yr(g[j])) push(g[i], g[j], 'Same name' + (yr(g[i]) && yr(g[j]) ? ' and birth year' : ''));
  for (const g of Object.values(byYear)) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const x = norm(g[i].name), y = norm(g[j].name); if (x !== y && x.length > 5 && Math.abs(x.length - y.length) <= 2 && lev(x, y) <= 2) push(g[i], g[j], 'Very similar names, same birth year');
  }
  res.json(out);
});
app.post('/api/people/:id/merge', need, (req, res) => { // merge :id (the repeat) into body.into (the one to keep)
  const a = ownPerson(req, res); if (!a) return;
  const b = q('SELECT * FROM people WHERE id=? AND tree_id=?', +req.body.into, a.tree_id);
  if (!b || b.id === a.id) return fail(res, 400, 'Choose a different person in this tree to keep.');
  if (q('SELECT id FROM marriages WHERE (a_id=? AND b_id=?) OR (a_id=? AND b_id=?)', a.id, b.id, b.id, a.id)) return fail(res, 409, 'These two are recorded as a couple, so they cannot be the same person.');
  db.transaction(() => {
    const t = q('SELECT * FROM trees WHERE id=?', a.tree_id), f = {};
    for (const k of ['gender', 'dob', 'dod', 'dob_q', 'dod_q', 'birth_place', 'death_place', 'photo']) if (!b[k] && a[k]) f[k] = a[k];
    if (a.notes && a.notes !== b.notes) f.notes = [b.notes, a.notes].filter(Boolean).join('\n\n');
    if (!b.parent_marriage_id && a.parent_marriage_id) { f.parent_marriage_id = a.parent_marriage_id; f.parent_kind = a.parent_kind; }
    const ext = !b.ext_id && a.ext_id ? a.ext_id : null;
    db.prepare('UPDATE people SET ext_id=NULL WHERE id=?').run(a.id);
    for (const m of all('SELECT * FROM marriages WHERE a_id=? OR b_id=?', a.id, a.id)) {
      const other = m.a_id === a.id ? m.b_id : m.a_id, dup = q('SELECT * FROM marriages WHERE id<>? AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?))', m.id, b.id, other, other, b.id);
      if (dup) { // both already have this couple: keep one record and move the children across
        db.prepare('UPDATE people SET parent_marriage_id=? WHERE parent_marriage_id=?').run(dup.id, m.id);
        db.prepare('UPDATE marriages SET year=COALESCE(year,?),end_year=COALESCE(end_year,?) WHERE id=?').run(m.year, m.end_year, dup.id);
        db.prepare('DELETE FROM marriages WHERE id=?').run(m.id);
      } else db.prepare(m.a_id === a.id ? 'UPDATE marriages SET a_id=? WHERE id=?' : 'UPDATE marriages SET b_id=? WHERE id=?').run(b.id, m.id);
    }
    db.prepare('UPDATE attachments SET person_id=? WHERE person_id=?').run(b.id, a.id);
    if (t.root_id === a.id) db.prepare('UPDATE trees SET root_id=? WHERE id=?').run(b.id, t.id);
    db.prepare('DELETE FROM people WHERE id=?').run(a.id);
    const keys = Object.keys(f); if (keys.length) db.prepare(`UPDATE people SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => f[k]), b.id);
    if (ext) db.prepare('UPDATE people SET ext_id=? WHERE id=?').run(ext, b.id);
  })();
  log(a.tree_id, req.uid, 'merged', `${a.name} into ${b.name}`);
  res.json({ id: b.id });
});

// ---- Tree checks: things that look wrong or are missing ----
const yearOf = d => /^\d{4}/.test(d || '') ? +d.slice(0, 4) : null;
app.get('/api/trees/:id/checks', need, (req, res) => {
  const t = ownTree(req, res); if (!t) return;
  const ps = all('SELECT * FROM people WHERE tree_id=?', t.id), ms = all('SELECT * FROM marriages WHERE tree_id=?', t.id), out = [];
  const P = Object.fromEntries(ps.map(p => [p.id, p])), M = Object.fromEntries(ms.map(m => [m.id, m])), year = new Date().getUTCFullYear();
  const add = (level, p, text) => out.push({ level, person: p && { id: p.id, name: p.name }, text });
  for (const p of ps) {
    const by = yearOf(p.dob), m = M[p.parent_marriage_id];
    if (!p.dob) add('info', p, 'No birth date yet.');
    if (by && !p.dod && year - by > 110) add('warning', p, `Marked as alive but would be ${year - by} years old.`);
    if (m && by && p.parent_kind === 'biological') for (const id of [m.a_id, m.b_id]) {
      const par = P[id], py = par && yearOf(par.dob); if (!py) continue;
      const age = by - py, mother = par.gender === 'Female', pd = par.dod && par.dod !== 'unknown' ? yearOf(par.dod) : null;
      if (age < 12) add('warning', p, `${par.name} would have been only ${age} when ${p.name} was born.`);
      else if (age > (mother ? 55 : 80)) add('warning', p, `${par.name} would have been ${age} when ${p.name} was born.`);
      if (pd && by > pd + (mother ? 0 : 1)) add('warning', p, `${p.name} was born after the death of ${par.name}.`);
    }
  }
  for (const m of ms) if (m.year) for (const x of [P[m.a_id], P[m.b_id]]) { const by = yearOf(x.dob); if (by && m.year - by < 14) add('warning', x, `Married in ${m.year}, when they would have been ${m.year - by}.`); }
  const adj = {}; const link = (x, y) => { (adj[x] = adj[x] || []).push(y); (adj[y] = adj[y] || []).push(x); };
  ms.forEach(m => link(m.a_id, m.b_id)); ps.forEach(p => { const m = M[p.parent_marriage_id]; if (m) { link(p.id, m.a_id); link(p.id, m.b_id); } });
  const seen = new Set([t.root_id]), stack = [t.root_id]; while (stack.length) for (const n of adj[stack.pop()] || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  ps.filter(p => !seen.has(p.id)).slice(0, 20).forEach(p => add('warning', p, 'Not connected to the first person in the tree.'));
  res.json({ issues: out.slice(0, 150), warnings: out.filter(i => i.level === 'warning').length, notes: out.filter(i => i.level === 'info').length });
});

// ---- Sources, documents and a photo album for each person ----
const uploadAtt = multer({
  storage: multer.diskStorage({ destination: UPLOADS, filename: (_, f, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(f.originalname).toLowerCase()) }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, f, cb) => cb(null, /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/.test(f.mimetype))
});
app.get('/api/people/:id/attachments', (req, res) => {
  const p = q('SELECT * FROM people WHERE id=?', req.params.id), t = p && q('SELECT * FROM trees WHERE id=?', p.tree_id), role = t && roleOf(t.id, uid(req));
  if (!p || (!role && t.visibility !== 'link')) return fail(res, 404, 'Person not found.');
  if (!role && t.hide_living && !p.dod) return res.json([]); // living people stay private for visitors
  res.json(all('SELECT id,kind,title,description,url,file FROM attachments WHERE person_id=? ORDER BY id', p.id));
});
app.post('/api/people/:id/attachments', need, (req, res, next) => { if (!ownPerson(req, res)) return; next(); }, uploadAtt.single('file'), (req, res) => {
  const p = q('SELECT * FROM people WHERE id=?', req.params.id), b = req.body || {}, kind = ['source', 'document', 'photo'].includes(b.kind) ? b.kind : 'source';
  const title = String(b.title || '').trim().slice(0, 160), url = String(b.url || '').trim(), desc = String(b.description || '').trim().slice(0, 2000);
  if (!title) return fail(res, 400, 'Give it a title.');
  if (url && !/^https?:\/\//i.test(url)) return fail(res, 400, 'A web link must start with http:// or https://.');
  if (kind === 'photo' && !(req.file && /^image\//.test(req.file.mimetype))) return fail(res, 400, 'Choose an image to add to the album.');
  if (!req.file && !url && !desc) return fail(res, 400, 'Add a file, a web link, or a description.');
  const id = db.prepare('INSERT INTO attachments(tree_id,person_id,kind,title,description,url,file) VALUES(?,?,?,?,?,?,?)')
    .run(p.tree_id, p.id, kind, title, desc || null, url || null, req.file ? '/uploads/' + req.file.filename : null).lastInsertRowid;
  log(p.tree_id, req.uid, 'added a ' + kind + ' for', p.name);
  res.json({ id });
});
app.delete('/api/attachments/:id', need, (req, res) => {
  const a = q('SELECT * FROM attachments WHERE id=?', req.params.id);
  if (!a) return fail(res, 404, 'Not found.');
  if (!['owner', 'editor'].includes(roleOf(a.tree_id, req.uid))) return fail(res, 403, 'You do not have permission to edit this tree.');
  db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
  if (a.file) fs.unlink(path.join(UPLOADS, path.basename(a.file)), () => {});
  res.json({ ok: true });
});

// ---- Password reset by email, and account settings ----
// With SMTP_URL set, mail is sent through that server. Without it, messages are kept in memory (and printed outside production) so you can test.
let mailer = null; try { if (process.env.SMTP_URL) mailer = require('nodemailer').createTransport(process.env.SMTP_URL); } catch { console.error('Install nodemailer to send email.'); }
const outbox = [];
const sendMail = async (to, subject, text) => {
  if (mailer) return mailer.sendMail({ from: process.env.MAIL_FROM || 'Family Tree <no-reply@localhost>', to, subject, text }).catch(e => console.error('Email failed:', e.message));
  if (process.env.NODE_ENV === 'production') return console.error('SMTP_URL is not set, so the email to ' + to + ' was not sent.');
  outbox.push({ to, subject, text }); if (outbox.length > 50) outbox.shift(); console.log(`[mail to ${to}] ${subject}\n${text}`);
};
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
app.post('/api/auth/forgot', async (req, res) => {
  const u = q('SELECT * FROM users WHERE email=?', String(req.body.email || '').toLowerCase());
  if (u) {
    const raw = crypto.randomBytes(24).toString('hex');
    db.prepare('DELETE FROM resets WHERE expires_at<?').run(Date.now());
    db.prepare('INSERT INTO resets(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(raw), u.id, Date.now() + 3600e3);
    await sendMail(u.email, 'Reset your Family Tree password', `Hello${u.name ? ' ' + u.name : ''},\n\nOpen this link within one hour to choose a new password:\n${process.env.APP_URL || `http://localhost:${PORT}`}/#/reset?token=${raw}\n\nIf you did not ask for this, you can ignore this message.`);
  }
  res.json({ ok: true }); // same answer whether or not the email exists
});
app.post('/api/auth/reset', (req, res) => {
  const r = q('SELECT * FROM resets WHERE token_hash=? AND expires_at>?', sha(String(req.body.token || '')), Date.now());
  if (!r) return fail(res, 400, 'That reset link has expired or was already used. Ask for a new one.');
  if (String(req.body.password || '').length < 8) return fail(res, 400, 'Choose a password of at least 8 characters.');
  db.prepare('UPDATE users SET hash=?, tv=tv+1 WHERE id=?').run(bcrypt.hashSync(req.body.password, 10), r.user_id);
  db.prepare('DELETE FROM resets WHERE user_id=?').run(r.user_id);
  res.json({ ok: true });
});
app.use('/api/me/password', limiter(Number(process.env.AUTH_LIMIT) || 20, 15 * 60 * 1000));
app.get('/api/me', need, (req, res) => res.json(q('SELECT id,email,name FROM users WHERE id=?', req.uid)));
app.patch('/api/me', need, (req, res) => { db.prepare('UPDATE users SET name=? WHERE id=?').run(String(req.body.name || '').trim().slice(0, 80), req.uid); res.json({ ok: true }); });
app.post('/api/me/password', need, (req, res) => {
  const u = q('SELECT * FROM users WHERE id=?', req.uid);
  if (!bcrypt.compareSync(req.body.current || '', u.hash)) return fail(res, 401, 'Your current password is not correct.');
  if (String(req.body.password || '').length < 8) return fail(res, 400, 'Choose a password of at least 8 characters.');
  db.prepare('UPDATE users SET hash=?, tv=tv+1 WHERE id=?').run(bcrypt.hashSync(req.body.password, 10), u.id);
  res.json({ token: token({ id: u.id, tv: u.tv + 1 }) }); // other devices are signed out; this one stays in
});
app.delete('/api/me', need, (req, res) => {
  const u = q('SELECT * FROM users WHERE id=?', req.uid);
  if (!bcrypt.compareSync(req.body.password || '', u.hash)) return fail(res, 401, 'Your password is not correct.');
  db.transaction(() => { db.prepare('DELETE FROM trees WHERE owner_id=?').run(u.id); db.prepare('DELETE FROM users WHERE id=?').run(u.id); })();
  res.json({ ok: true });
});

// ---- Collaborators (family group): owner invites existing accounts as editor or viewer ----
app.get('/api/trees/:id/members', need, (req, res) => {
  if (!ownTree(req, res, 'owner')) return;
  res.json(all('SELECT u.id,u.email,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.tree_id=?', req.params.id));
});
app.post('/api/trees/:id/members', need, (req, res) => {
  const t = ownTree(req, res, 'owner'); if (!t) return;
  const u = q('SELECT id FROM users WHERE email=?', (req.body.email || '').toLowerCase()), role = req.body.role;
  if (!['editor', 'viewer'].includes(role)) return fail(res, 400, 'Choose editor or viewer.');
  if (!u) return fail(res, 404, 'No account uses that email yet. Ask them to sign up first.');
  if (u.id === t.owner_id) return fail(res, 400, 'That person already owns this tree.');
  db.prepare('INSERT INTO members(tree_id,user_id,role) VALUES(?,?,?) ON CONFLICT(tree_id,user_id) DO UPDATE SET role=excluded.role').run(t.id, u.id, role);
  log(t.id, req.uid, 'invited', `${req.body.email} as ${role}`);
  res.json({ ok: true });
});
app.delete('/api/trees/:id/members/:uid', need, (req, res) => {
  if (!ownTree(req, res, 'owner')) return;
  db.prepare('DELETE FROM members WHERE tree_id=? AND user_id=?').run(req.params.id, req.params.uid);
  res.json({ ok: true });
});

// ---- Change history (who changed what) ----
app.get('/api/trees/:id/history', need, (req, res) => {
  if (!ownTree(req, res)) return;
  res.json(all('SELECT a.action,a.detail,a.at,u.name,u.email FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.tree_id=? ORDER BY a.id DESC LIMIT 100', req.params.id));
});

// ---- Ancestors and descendants via recursive CTEs, depth-capped so huge trees stay cheap ----
app.get('/api/people/:id/relatives', (req, res) => {
  const p = q('SELECT * FROM people WHERE id=?', req.params.id), t = p && q('SELECT * FROM trees WHERE id=?', p.tree_id);
  if (!p || (!roleOf(t.id, uid(req)) && t.visibility !== 'link')) return fail(res, 404, 'Person not found.');
  const d = Math.min(Math.max(+req.query.depth || 6, 1), 10);
  const ancestors = all(`WITH RECURSIVE a(id,gen) AS (SELECT ?,0 UNION ALL
    SELECT x.id, a.gen+1 FROM a JOIN people c ON c.id=a.id JOIN marriages m ON m.id=c.parent_marriage_id JOIN people x ON x.id IN (m.a_id,m.b_id) WHERE a.gen<?)
    SELECT p.id,p.name,a.gen FROM a JOIN people p ON p.id=a.id WHERE a.gen>0 ORDER BY a.gen`, p.id, d);
  const descendants = all(`WITH RECURSIVE d(id,gen) AS (SELECT ?,0 UNION ALL
    SELECT k.id, d.gen+1 FROM d JOIN marriages m ON d.id IN (m.a_id,m.b_id) JOIN people k ON k.parent_marriage_id=m.id WHERE d.gen<?)
    SELECT p.id,p.name,d.gen FROM d JOIN people p ON p.id=d.id WHERE d.gen>0 ORDER BY d.gen`, p.id, d);
  res.json({ ancestors, descendants });
});

// ---- GEDCOM import. Safe to repeat: people already in the tree (same GEDCOM id, or same name and birth date) are left untouched. ----
const parseGed = text => {
  const recs = []; let stack = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d+)\s+(@[^@]+@\s+)?(\w+)\s?(.*)$/); if (!m) continue;
    const lvl = +m[1], node = { xref: m[2] && m[2].trim(), tag: m[3], val: (m[4] || '').trim(), kids: [] };
    if (lvl === 0) { recs.push(node); stack = [node]; } else if (stack[lvl - 1]) { stack[lvl - 1].kids.push(node); stack[lvl] = node; }
  }
  return recs;
};
const parseDate = s => {
  if (!s) return null;
  let qual = null, t = s.trim().toUpperCase();
  const mq = t.match(/^(ABT|ABOUT|CAL|EST|BEF|AFT)\s+(.*)$/);
  if (mq) { qual = mq[1] === 'BEF' ? 'before' : mq[1] === 'AFT' ? 'after' : 'about'; t = mq[2]; }
  const m = t.match(/^(?:(\d{1,2})\s+)?(?:([A-Z]{3})\s+)?(\d{4})$/);
  if (!m || (m[2] && !MON.includes(m[2])) || (m[1] && !m[2])) return null;
  const mo = m[2] ? MON.indexOf(m[2]) + 1 : 0;
  const d = m[3] + (mo ? '-' + String(mo).padStart(2, '0') : '') + (m[1] ? '-' + m[1].padStart(2, '0') : '');
  return okDate(d) ? { d, q: qual } : null;
};
const importInto = (tid, text) => {
  const recs = parseGed(text), indis = recs.filter(r => r.tag === 'INDI'), fams = recs.filter(r => r.tag === 'FAM');
  const out = { added: 0, existing: 0, families: 0, notes: [], map: {}, indis }, byX = Object.fromEntries(indis.map(i => [i.xref, i]));
  const sub = (r, tag) => r.kids.find(k => k.tag === tag), dateOf = n => (n && sub(n, 'DATE')) ? parseDate(sub(n, 'DATE').val) : null;
  db.transaction(() => {
    for (const r of indis) {
      const nm = ((sub(r, 'NAME') || {}).val || '').replace(/\//g, ' ').replace(/\s+/g, ' ').trim() || 'Unknown';
      const sx = (sub(r, 'SEX') || {}).val, birt = dateOf(sub(r, 'BIRT')), deat = sub(r, 'DEAT'), dd = dateOf(deat);
      const plac = n => { const x = n && sub(n, 'PLAC'); return x ? x.val.slice(0, 120) : null; }, note = sub(r, 'NOTE');
      const c = { name: nm, gender: sx === 'M' ? 'Male' : sx === 'F' ? 'Female' : null, dob: birt ? birt.d : '', dob_q: birt && birt.q,
        dod: deat ? (dd ? dd.d : 'unknown') : null, dod_q: dd && dd.q, birth_place: plac(sub(r, 'BIRT')), death_place: plac(deat), notes: note ? note.val.slice(0, 4000) : null };
      const hit = q(`SELECT id,ext_id FROM people WHERE tree_id=? AND (ext_id=? OR (?<>'' AND name=? AND dob=?)) ORDER BY ext_id=? DESC`, tid, r.xref, c.dob, c.name, c.dob, r.xref);
      if (hit) { out.map[r.xref] = hit.id; out.existing++; if (!hit.ext_id) db.prepare('UPDATE people SET ext_id=? WHERE id=?').run(r.xref, hit.id); }
      else { out.map[r.xref] = addPerson(tid, c, null, r.xref); out.added++; }
    }
    for (const f of fams) {
      const h = out.map[(sub(f, 'HUSB') || {}).val], w = out.map[(sub(f, 'WIFE') || {}).val];
      const kids = f.kids.filter(k => k.tag === 'CHIL').map(k => [out.map[k.val], k.val]).filter(x => x[0]);
      let m = q('SELECT id FROM marriages WHERE tree_id=? AND ext_id=?', tid, f.xref), a = h, b = w;
      if (!m) {
        if (!a && !b) { if (kids.length) out.notes.push('A family with children but no parents was skipped.'); continue; }
        if (!a || !b) { if (!kids.length) continue; const ph = addPerson(tid, { name: 'Unknown spouse', gender: null, dob: '', dod: null }); a = a || ph; b = b || ph; }
        if (a === b) continue;
        m = q('SELECT id FROM marriages WHERE tree_id=? AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?))', tid, a, b, b, a);
        if (!m) {
          const my = dateOf(sub(f, 'MARR')), dv = sub(f, 'DIV'), mt = sub(f, 'MARR') && sub(sub(f, 'MARR'), 'TYPE'), dy = dv && dateOf(dv);
          const kind = dv ? 'divorced' : mt && ['partner', 'separated'].includes(mt.val.toLowerCase()) ? mt.val.toLowerCase() : 'married';
          m = { id: db.prepare('INSERT INTO marriages(tree_id,a_id,b_id,year,ext_id,kind,end_year) VALUES(?,?,?,?,?,?,?)').run(tid, a, b, my ? +my.d.slice(0, 4) : null, f.xref, kind, dy ? +dy.d.slice(0, 4) : null).lastInsertRowid };
          out.families++;
        }
      }
      for (const [kid, xr] of kids) {
        const fc = byX[xr] && sub(byX[xr], 'FAMC'), pd = fc && sub(fc, 'PEDI'), pk = pd ? { adopted: 'adopted', foster: 'foster', step: 'step' }[pd.val.toLowerCase()] : null;
        db.prepare('UPDATE people SET parent_marriage_id=?,parent_kind=? WHERE id=? AND parent_marriage_id IS NULL').run(m.id, pk || 'biological', kid);
      }
    }
  })();
  return out;
};
const gedText = express.text({ type: () => true, limit: '5mb' });
app.get('/api/attachments/:id/file', need, function(req,res){
  const a = q('SELECT * FROM attachments WHERE id=?', req.params.id);
  if(!a) return res.status(404).end();
  const person = q('SELECT * FROM people WHERE id=?', a.person_id);
  const t = person && q('SELECT * FROM trees WHERE id=?', person.tree_id);
  if(!person || !t) return res.status(404).end();
  const role = roleOf(t.id, req.uid);
  if(!role){
    if(t.visibility !== 'link') return res.status(404).end();
    if(!person.dod && t.hide_living) return res.status(404).end();
  }
  if(!a.file) return res.status(404).end();
  const fname = path.basename(a.file);
  const full = path.resolve(UPLOADS, fname);
  try {
    if(!full.startsWith(path.resolve(UPLOADS))) return res.status(404).end();
    if(!fs.existsSync(full)) return res.status(404).end();
    const ext = path.extname(fname).toLowerCase().replace('.','');
    const mimeMap = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',pdf:'application/pdf'};
    const m = mimeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', m);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', (m.startsWith('image/') || m === 'application/pdf') ? 'inline' : 'attachment');
    const stream = fs.createReadStream(full);
    stream.on('error', function(){res.status(404).end();});
    stream.pipe(res);
  } catch(e){ return res.status(404).end(); }
});
app.post('/api/trees/import', need, gedText, (req, res) => { // new tree from a GEDCOM file; its first top ancestor becomes the first person
  const name = String(req.query.name || '').trim();
  if (!name) return fail(res, 400, 'Give your family tree a name.');
  try {
    const id = db.transaction(() => {
      const tid = db.prepare('INSERT INTO trees(owner_id,name) VALUES(?,?)').run(req.uid, name).lastInsertRowid;
      const out = importInto(tid, String(req.body || ''));
      if (!out.indis.length) throw new Error('No people found. Choose a GEDCOM (.ged) file.');
      const has = (i, tag) => i.kids.some(k => k.tag === tag);
      const top = out.indis.find(i => has(i, 'FAMS') && !has(i, 'FAMC')) || out.indis[0];
      db.prepare('UPDATE trees SET root_id=? WHERE id=?').run(out.map[top.xref], tid);
      log(tid, req.uid, 'imported a GEDCOM file', `${out.added} people`);
      return tid;
    })();
    res.json({ id });
  } catch (e) { fail(res, 400, e.message); }
});
app.post('/api/trees/:id/import', need, gedText, (req, res) => { // merge into an existing tree
  const t = ownTree(req, res); if (!t) return;
  const out = importInto(t.id, String(req.body || ''));
  if (!out.indis.length) return fail(res, 400, 'No people found. Choose a GEDCOM (.ged) file.');
  log(t.id, req.uid, 'imported a GEDCOM file', `${out.added} new people`);
  res.json({ added: out.added, existing: out.existing, families: out.families, notes: [...new Set(out.notes)] });
});

// ---- GEDCOM 5.5.1 export (INDI + FAM records) so the tree opens in other genealogy software ----
const MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const gedDate = (d, qual) => { if (!d || d === 'unknown') return null; const [y, m, dd] = d.split('-'); return (qual ? { about: 'ABT', before: 'BEF', after: 'AFT' }[qual] + ' ' : '') + (dd ? +dd + ' ' : '') + (m ? MON[m - 1] + ' ' : '') + y; };
app.get('/api/trees/:id/export.ged', need, (req, res) => {
  const t = ownTree(req, res); if (!t) return;
  const hide = req.query.hideLiving === '1';
  const ps = all('SELECT * FROM people WHERE tree_id=?', t.id), ms = all('SELECT * FROM marriages WHERE tree_id=?', t.id);
  const L = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '2 FORM LINEAGE-LINKED', '1 CHAR UTF-8', '1 SOUR FAMILYTREEAPP'];
  for (const p of ps) {
    const w = p.name.trim().split(/\s+/), sur = w.length > 1 ? w.pop() : '', priv = hide && !p.dod; if (priv) { p.birth_place = null; p.notes = null; }
    L.push(`0 @I${p.id}@ INDI`, `1 NAME ${priv ? 'Living' : w.join(' ')} /${sur}/`, `1 SEX ${p.gender === 'Male' ? 'M' : p.gender === 'Female' ? 'F' : 'U'}`);
    if (!priv) { const b = gedDate(p.dob, p.dob_q), d = gedDate(p.dod, p.dod_q); if (b || p.birth_place) L.push('1 BIRT', ...(b ? [`2 DATE ${b}`] : []), ...(p.birth_place ? [`2 PLAC ${p.birth_place}`] : [])); if (p.dod) L.push(d || p.death_place ? '1 DEAT' : '1 DEAT Y', ...(d ? [`2 DATE ${d}`] : []), ...(p.death_place ? [`2 PLAC ${p.death_place}`] : [])); if (p.notes) L.push(`1 NOTE ${p.notes.replace(/\s+/g, ' ')}`); }
    ms.filter(m => m.a_id === p.id || m.b_id === p.id).forEach(m => L.push(`1 FAMS @F${m.id}@`));
    if (p.parent_marriage_id) L.push(`1 FAMC @F${p.parent_marriage_id}@`, ...(p.parent_kind && p.parent_kind !== 'biological' ? [`2 PEDI ${p.parent_kind}`] : []));
  }
  const byId = Object.fromEntries(ps.map(p => [p.id, p]));
  for (const m of ms) {
    let [h, w] = [m.a_id, m.b_id];
    if (byId[h].gender === 'Female' || byId[w].gender === 'Male') [h, w] = [w, h];
    L.push(`0 @F${m.id}@ FAM`, `1 HUSB @I${h}@`, `1 WIFE @I${w}@`);
    const mk = m.kind || 'married';
    if (m.year || mk === 'partner' || mk === 'separated') L.push('1 MARR', ...(m.year ? [`2 DATE ${m.year}`] : []), ...(mk === 'partner' || mk === 'separated' ? [`2 TYPE ${mk}`] : []));
    if (mk === 'divorced') L.push(m.end_year ? '1 DIV' : '1 DIV Y', ...(m.end_year ? [`2 DATE ${m.end_year}`] : []));
    ps.filter(p => p.parent_marriage_id === m.id).forEach(p => L.push(`1 CHIL @I${p.id}@`));
  }
  L.push('0 TRLR');
  res.type('text/plain; charset=utf-8').set('Content-Disposition', 'attachment; filename="family-tree.ged"').send(L.join('\r\n') + '\r\n');
});

// ---- People and branches ----
// Body: person fields plus either spouse_of (adds a spouse + marriage, optional year) or parent_marriage_id (adds a child).
app.post('/api/trees/:id/people', need, (req, res) => {
  const t = ownTree(req, res); if (!t) return;
  const c = clean(req.body); if (c.error) return fail(res, 400, c.error);
  const { spouse_of, parent_marriage_id, year } = req.body;
  if (spouse_of && !q('SELECT id FROM people WHERE id=? AND tree_id=?', spouse_of, t.id)) return fail(res, 400, 'Spouse not found in this tree.');
  if (parent_marriage_id && !q('SELECT id FROM marriages WHERE id=? AND tree_id=?', parent_marriage_id, t.id)) return fail(res, 400, 'Marriage not found in this tree.');
  if (!spouse_of && !parent_marriage_id) return fail(res, 400, 'Choose who this person is a spouse or child of.');
  const id = db.transaction(() => {
    const pid = addPerson(t.id, c, spouse_of ? null : parent_marriage_id);
    if (spouse_of) db.prepare('INSERT INTO marriages(tree_id,a_id,b_id,year,kind,end_year) VALUES(?,?,?,?,?,?)').run(t.id, spouse_of, pid, year || null, MK.includes(req.body.kind) ? req.body.kind : 'married', +req.body.end_year || null);
    return pid;
  })();
  log(t.id, req.uid, spouse_of ? 'added a spouse' : 'added a child', c.name);
  res.json({ id });
});
app.put('/api/people/:id', need, (req, res) => {
  const p0 = ownPerson(req, res); if (!p0) return;
  const c = clean(req.body, false); if (c.error) return fail(res, 400, c.error);
  db.prepare('UPDATE people SET name=?,gender=?,dob=?,dod=?,dob_q=?,dod_q=?,birth_place=?,death_place=?,notes=?,parent_kind=COALESCE(?,parent_kind) WHERE id=?').run(c.name, c.gender, c.dob, c.dod, c.dob_q, c.dod_q, c.birth_place, c.death_place, c.notes, c.parent_kind, req.params.id);
  log(p0.tree_id, req.uid, 'edited', c.name);
  res.json(derive(q('SELECT * FROM people WHERE id=?', req.params.id)));
});
app.delete('/api/people/:id', need, (req, res) => {
  const p = ownPerson(req, res); if (!p) return;
  if (q('SELECT id FROM trees WHERE root_id=?', p.id)) return fail(res, 409, 'The first person in a tree cannot be removed. Delete the tree instead.');
  const kids = q(`SELECT COUNT(*) n FROM people WHERE parent_marriage_id IN (SELECT id FROM marriages WHERE a_id=? OR b_id=?)`, p.id, p.id).n;
  if (kids) return fail(res, 409, 'Remove their children first.');
  db.prepare('DELETE FROM people WHERE id=?').run(p.id);
  log(p.tree_id, req.uid, 'removed', p.name);
  res.json({ ok: true });
});

// ---- Profile pictures ----
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOADS,
    filename: (_, f, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(f.originalname).toLowerCase()) }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_, f, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(f.mimetype))
});
app.post('/api/people/:id/photo', need, (req, res, next) => { if (!ownPerson(req, res)) return; next(); }, upload.single('photo'), (req, res) => {
  if (!req.file) return fail(res, 400, 'Choose a PNG, JPG, WEBP or GIF image under 3 MB.');
  db.prepare('UPDATE people SET photo=? WHERE id=?').run('/uploads/' + req.file.filename, req.params.id);
  res.json({ photo: '/uploads/' + req.file.filename });
});
app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));

// ---- Demo data (first run only): demo@family.test / demo1234 ----
if (!q('SELECT id FROM users LIMIT 1')) {
  const u = db.prepare('INSERT INTO users(email,name,hash) VALUES(?,?,?)').run('demo@family.test', 'Demo', bcrypt.hashSync('demo1234', 10)).lastInsertRowid;
  const tid = db.prepare('INSERT INTO trees(owner_id,name) VALUES(?,?)').run(u, 'The Whitmore Family').lastInsertRowid;
  db.prepare("UPDATE trees SET visibility='link' WHERE id=?").run(tid);
  const P = (n, g, dob, dod, pm) => addPerson(tid, { name: n, gender: g, dob, dod }, pm || null);
  const M = (a, b, y) => db.prepare('INSERT INTO marriages(tree_id,a_id,b_id,year) VALUES(?,?,?,?)').run(tid, a, b, y).lastInsertRowid;
  const elias = P('Elias Whitmore', 'Male', '1932-03-04', '2011-09-17');
  db.prepare('UPDATE trees SET root_id=? WHERE id=?').run(elias, tid);
  const m1 = M(elias, P('Margaret Whitmore', 'Female', '1934-06-21', '2019-02-02'), 1954);
  const m2 = M(elias, P('Clara Whitmore', 'Female', '1948-01-09'), 1980);
  const ros = P('Rosalind Whitmore', 'Female', '1956-08-14', null, m1), tom = P('Thomas Whitmore', 'Male', '1959-01-03', null, m1);
  P('Helen Whitmore', 'Female', '1962-09-22', null, m1);
  const jam = P('James Whitmore', 'Male', '1982-04-10', null, m2), sop = P('Sophie Whitmore', 'Female', '1985-07-05', null, m2);
  P('Oscar Whitmore', 'Male', '1988-11-19', null, m2);
  const sp = (n, g, dob, y, parent) => { const s = P(n, g, dob); return M(parent, s, y); };
  const rm = sp('Daniel Bell', 'Male', '1955-02-11', 1998, ros); P('Nora Bell', 'Female', '2001-05-12', null, rm); P('Liam Bell', 'Male', '2004-11-30', null, rm);
  P('Grace Whitmore', 'Female', '2015-03-19', null, sp('Amy Whitmore', 'Female', '1960-05-05', 2012, tom));
  P('Ella Whitmore', 'Female', '2010-02-03', null, sp('Lena Whitmore', 'Female', '1983-09-09', 2008, jam));
  const sm = sp('Paul Foster', 'Male', '1984-12-01', 2010, sop); P('Mia Foster', 'Female', '2012-02-08', null, sm); P('Jack Foster', 'Male', '2015-06-27', null, sm);
}
if (require.main === module) app.listen(PORT, () => console.log(`Family tree running at http://localhost:${PORT}`));
module.exports = app; // exported for tests
module.exports.kinship = kinship;
module.exports.outbox = outbox;
