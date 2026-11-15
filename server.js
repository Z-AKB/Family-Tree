const crypto = require('crypto'), express = require('express'), Database = require('better-sqlite3'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), multer = require('multer'), path = require('path'), fs = require('fs');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me', PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEMO_ENABLED = !IS_PRODUCTION || process.env.SEED_DEMO === '1';
const DEMO_EMAIL = 'demo@family.test';
if (IS_PRODUCTION && !process.env.JWT_SECRET) { console.error('Set JWT_SECRET before running in production.'); process.exit(1); }
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
  a_id INTEGER REFERENCES people(id) ON DELETE CASCADE, b_id INTEGER REFERENCES people(id) ON DELETE CASCADE, year INTEGER,
  CHECK(a_id IS NOT NULL OR b_id IS NOT NULL), CHECK(a_id IS NULL OR b_id IS NULL OR a_id <> b_id));`);

const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
addCol('trees', 'visibility', "TEXT NOT NULL DEFAULT 'private'");
addCol('trees', 'hide_living', 'INTEGER NOT NULL DEFAULT 1');
addCol('people', 'dob_q', 'TEXT'); addCol('people', 'dod_q', 'TEXT'); // about / before / after
addCol('people', 'ext_id', 'TEXT'); addCol('people', 'birth_place', 'TEXT'); addCol('people', 'death_place', 'TEXT'); addCol('people', 'notes', 'TEXT');
addCol('marriages', 'kind', "TEXT NOT NULL DEFAULT 'married'"); addCol('marriages', 'end_year', 'INTEGER'); // married / partner / divorced / separated
addCol('people', 'parent_kind', "TEXT NOT NULL DEFAULT 'biological'"); // biological / adopted / step / foster
addCol('users', 'tv', 'INTEGER NOT NULL DEFAULT 0'); // bumped on password change to end old sessions
addCol('marriages', 'ext_id', 'TEXT'); // id from an imported GEDCOM file
// Schema migration tracking for idempotency.
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);

const migrationApplied = (version) => !!db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version);

// Migration 1: Relax NOT NULL on marriage a_id/b_id columns for single-parent families.
// Pre-existing databases created the marriages table with NOT NULL a_id and b_id.
// SQLite cannot relax a NOT NULL constraint in place, so the table must be rebuilt.
const MIGRATION_RELAX_MARRIAGE_NULLS = 1;

if (!migrationApplied(MIGRATION_RELAX_MARRIAGE_NULLS)) {
  const marriageColumns = db.prepare('PRAGMA table_info(marriages)').all();
  const needsMigration = ['a_id', 'b_id'].some(c => (marriageColumns.find(x => x.name === c) || {}).notnull);
  if (needsMigration) {
    // Disable foreign-key enforcement before starting the exclusive transaction.
    db.pragma('foreign_keys = OFF');
    let locked = false;
    try {
      db.exec('BEGIN EXCLUSIVE');
      locked = true;
      try {
        // Re-check inside the lock: another process may have migrated already.
        const cols = db.prepare('PRAGMA table_info(marriages)').all();
        const stillNeeds = ['a_id', 'b_id'].some(c => (cols.find(x => x.name === c) || {}).notnull);
        if (!stillNeeds) {
          db.exec('COMMIT');
          locked = false;
          return;
        }
        const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM marriages').get().n;
        db.exec(`CREATE TABLE marriages_migrated(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
          a_id INTEGER REFERENCES people(id) ON DELETE CASCADE, b_id INTEGER REFERENCES people(id) ON DELETE CASCADE, year INTEGER,
          kind TEXT NOT NULL DEFAULT 'married', end_year INTEGER, ext_id TEXT,
          CHECK(a_id IS NOT NULL OR b_id IS NOT NULL), CHECK(a_id IS NULL OR b_id IS NULL OR a_id <> b_id));`);
        db.exec('INSERT INTO marriages_migrated(id,tree_id,a_id,b_id,year,kind,end_year,ext_id) SELECT id,tree_id,a_id,b_id,year,kind,end_year,ext_id FROM marriages');
        const afterCount = db.prepare('SELECT COUNT(*) AS n FROM marriages_migrated').get().n;
        if (afterCount !== beforeCount) {
          const e = new Error(`Marriage migration lost records: ${beforeCount} before, ${afterCount} after`);
          e.safeMessage = true;
          throw e;
        }
        db.exec('DROP TABLE marriages');
        db.exec('ALTER TABLE marriages_migrated RENAME TO marriages');
        // Verify foreign-key integrity after the rebuild.
        const fkIssues = db.prepare('PRAGMA foreign_key_check').all();
        if (fkIssues.length > 0) {
          const e = new Error(`Foreign-key violations after migration: ${JSON.stringify(fkIssues)}`);
          e.safeMessage = true;
          throw e;
        }
        db.exec('COMMIT');
        locked = false;
        db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(MIGRATION_RELAX_MARRIAGE_NULLS);
      } catch (e) {
        if (locked) { try { db.exec('ROLLBACK'); } catch {} locked = false; }
        if (!e.safeMessage) console.error('Marriage migration failed:', e.message);
        throw e;
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}
db.exec(`
CREATE TABLE IF NOT EXISTS members(tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('editor','viewer')), PRIMARY KEY(tree_id,user_id));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE, user_id INTEGER,
  action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS account_audit(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS invites(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','viewer')), token_hash TEXT NOT NULL UNIQUE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at INTEGER NOT NULL, accepted_at INTEGER, declined_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_people_tree ON people(tree_id);
CREATE INDEX IF NOT EXISTS ix_people_pm ON people(parent_marriage_id);
CREATE INDEX IF NOT EXISTS ix_marr_a ON marriages(a_id);
CREATE INDEX IF NOT EXISTS ix_marr_b ON marriages(b_id);
CREATE INDEX IF NOT EXISTS ix_marr_tree ON marriages(tree_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_marr ON marriages(tree_id, min(a_id,b_id), max(a_id,b_id));
CREATE UNIQUE INDEX IF NOT EXISTS ux_people_ext ON people(tree_id, ext_id) WHERE ext_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS attachments(id INTEGER PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('source','document','photo')), title TEXT NOT NULL, description TEXT, url TEXT, file TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_att_person ON attachments(person_id);
CREATE INDEX IF NOT EXISTS ix_att_tree ON attachments(tree_id);
CREATE INDEX IF NOT EXISTS ix_audit_tree ON audit(tree_id, id);
CREATE INDEX IF NOT EXISTS ix_account_audit_user ON account_audit(user_id, id);
CREATE INDEX IF NOT EXISTS ix_invites_tree ON invites(tree_id);
CREATE INDEX IF NOT EXISTS ix_invites_email ON invites(email);
CREATE TABLE IF NOT EXISTS resets(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);`); // a couple can only be recorded once

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => { // basic security headers; scripts and styles only from this site (plus Google Fonts)
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; frame-ancestors 'none'" });
  // API responses contain private family data and session-dependent answers: never let a shared cache keep them.
  if (_req.path.startsWith('/api/') || _req.path.startsWith('/uploads/')) res.set('Cache-Control', 'no-store');
  next();
});
// In-memory, per-process limiter. The key is the direct socket IP, so changing the email
// address cannot bypass it. No trust proxy setting is enabled: X-Forwarded-For is not trusted.
const AUTH_WINDOW = 15 * 60 * 1000;
const AUTH_LIMIT = Math.max(1, Math.floor(Number(process.env.AUTH_LIMIT) || 20));
const authHits = new Map();
const authKey = (req, scope) => req.ip + ':' + scope;
const recentHits = key => (authHits.get(key) || []).filter(t => Date.now() - t < AUTH_WINDOW);
const limited = (res, key) => {
  const h = recentHits(key);
  if (h.length < AUTH_LIMIT) return false;
  res.set('Retry-After', String(Math.max(1, Math.ceil((AUTH_WINDOW - (Date.now() - h[0])) / 1000))));
  res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  return true;
};
const authFailureGuard = scope => (req, res, next) => limited(res, authKey(req, scope)) || next();
const authRequestGuard = scope => (req, res, next) => {
  const key = authKey(req, scope);
  if (limited(res, key)) return;
  const h = recentHits(key); h.push(Date.now()); authHits.set(key, h); next();
};
const noteAuthFailure = (req, scope) => {
  const key = authKey(req, scope), h = recentHits(key); h.push(Date.now()); authHits.set(key, h);
};
const clearAuthFailures = (req, scope) => authHits.delete(authKey(req, scope));
setInterval(() => authHits.clear(), 3600e3).unref();
app.use('/api/auth/register', authRequestGuard('register'));
app.use('/api/auth/forgot', authRequestGuard('forgot'));
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/config', (_req, res) => {
  const demoEnabled = DEMO_ENABLED && !!db.prepare('SELECT id FROM users WHERE email=?').get(DEMO_EMAIL);
  res.set('Cache-Control', 'no-store').json({ demoEnabled });
});

const uid = req => {
  try { const d = jwt.verify((req.headers.authorization || '').slice(7), SECRET, { algorithms: ['HS256'] }), u = q('SELECT tv FROM users WHERE id=?', d.id); return u && u.tv === (d.tv || 0) ? d.id : null; } catch { return null; }
};
const need = (req, res, next) => { const id = uid(req); if (!id) return res.status(401).json({ error: 'Please log in.', code: 'unauthenticated' }); req.uid = id; next(); };
const fail = (res, code, error) => { res.status(code).json({ error }); return null; };
const q = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
// Query-string numbers are user input too: reject negative/NaN depths instead of silently treating them as 0.
const depthParam = (req, res, def, min, max) => {
  const raw = req.query.depth;
  if (raw === undefined) return def;
  if (raw === '') { fail(res, 400, `Depth must be a whole number between ${min} and ${max}.`); return null; }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(res, 400, `Depth must be a whole number between ${min} and ${max}.`);
    return null;
  }
  return n;
};
const idNum = v => /^\d+$/.test(String(v)) ? Number(v) : null;

// ---- Uploads: accept only real images/PDFs, check magic bytes plus the declared name and type ----
const MEDIA_TYPES = {
  png: { exts: ['.png'], mimes: ['image/png'] },
  jpeg: { exts: ['.jpg', '.jpeg'], mimes: ['image/jpeg', 'image/jpg'] },
  gif: { exts: ['.gif'], mimes: ['image/gif'] },
  webp: { exts: ['.webp'], mimes: ['image/webp'] },
  pdf: { exts: ['.pdf'], mimes: ['application/pdf'] }
};
const IMAGE_TYPES = ['png', 'jpeg', 'gif', 'webp'];
const detectMediaType = b => {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6) { const s = b.toString('ascii', 0, 6); if (s === 'GIF87a' || s === 'GIF89a') return 'gif'; }
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  return null;
};
const inspectUpload = (file, allowed) => {
  let head;
  try {
    const fd = fs.openSync(file.path, 'r');
    try { const b = Buffer.alloc(16), n = fs.readSync(fd, b, 0, b.length, 0); head = b.subarray(0, n); } finally { fs.closeSync(fd); }
  } catch { return { error: 'That file could not be read.' }; }
  const type = detectMediaType(head);
  if (!type || !allowed.includes(type)) return { error: 'That file type is not supported. Choose a PNG, JPG, WEBP, GIF' + (allowed.includes('pdf') ? ' or PDF' : '') + '.' };
  const info = MEDIA_TYPES[type], ext = path.extname(file.originalname || '').toLowerCase(), mime = String(file.mimetype || '').toLowerCase();
  if (!info.exts.includes(ext)) return { error: 'The file extension does not match the file contents.' };
  if (!info.mimes.includes(mime)) return { error: 'The file type does not match the file contents.' };
  return { type };
};
const discardUpload = file => {
  if (!file || !file.path) return;
  try { fs.unlinkSync(file.path); } catch (e) { if (e.code !== 'ENOENT') console.error('Could not remove rejected upload:', e.message); }
};
const removeUpload = rel => {
  if (!rel) return;
  try { fs.unlinkSync(path.resolve(UPLOADS, path.basename(rel))); } catch (e) { if (e.code !== 'ENOENT') console.error('Could not remove upload:', e.message); }
};
const uploadInUse = rel => !!(q('SELECT 1 FROM people WHERE photo=? LIMIT 1', rel) || q('SELECT 1 FROM attachments WHERE file=? LIMIT 1', rel));
const removeUploadIfUnused = rel => { if (rel && !uploadInUse(rel)) removeUpload(rel); };
const uploadPathsForPerson = pid => all('SELECT photo AS f FROM people WHERE id=? AND photo IS NOT NULL UNION ALL SELECT file AS f FROM attachments WHERE person_id=? AND file IS NOT NULL', pid, pid).map(r => r.f).filter(Boolean);
const uploadPathsForTree = tid => all('SELECT photo AS f FROM people WHERE tree_id=? AND photo IS NOT NULL UNION ALL SELECT file AS f FROM attachments WHERE tree_id=? AND file IS NOT NULL', tid, tid).map(r => r.f).filter(Boolean);
const uploadPathsForUser = userId => all(`SELECT photo AS f FROM people WHERE tree_id IN (SELECT id FROM trees WHERE owner_id=?) AND photo IS NOT NULL
  UNION ALL SELECT file AS f FROM attachments WHERE tree_id IN (SELECT id FROM trees WHERE owner_id=?) AND file IS NOT NULL`, userId, userId).map(r => r.f).filter(Boolean);
const sendUpload = (res, rel) => {
  if (!rel) return res.status(404).end();
  const name = path.basename(rel), root = path.resolve(UPLOADS), full = path.resolve(root, name);
  if (!full.startsWith(root + path.sep) || !fs.existsSync(full)) return res.status(404).end();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' }[path.extname(name).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', (mime.startsWith('image/') || mime === 'application/pdf') ? 'inline' : 'attachment');
  const stream = fs.createReadStream(full);
  stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
  stream.pipe(res);
};

// Dates may be partial (1932, 1932-03, 1932-03-04) and marked about/before/after. dod 'unknown' = deceased, date not known.
const full = d => d.length === 4 ? d + '-01-01' : d.length === 7 ? d + '-01' : d;
const okDate = (d, unk) => (/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(d) && new Date(full(d)).toISOString().slice(0, 10) === full(d)) || (unk && d === 'unknown');
const QS = ['about', 'before', 'after'], qOf = v => QS.includes(v) ? v : null;
const PK = ['biological', 'adopted', 'step', 'foster'], MK = ['married', 'partner', 'divorced', 'separated', 'single'];
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
const clean = (b = {}, strict = true, base = null) => {
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  const pick = (k, fallback) => has(k) ? b[k] : fallback;
  const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;
  const name = String(pick('name', base ? base.name : '') || '').trim();
  let gender = pick('gender', base ? base.gender : null);
  if (gender === '' || gender == null) gender = null;
  else if (!['Male', 'Female', 'Other'].includes(gender)) return { error: 'Choose Male, Female or Other.' };
  let dob = pick('dob', base ? base.dob : '');
  dob = dob == null ? '' : String(dob).trim();
  let dod = pick('dod', base ? base.dod : null);
  dod = dod == null || dod === '' ? null : String(dod).trim();
  if (!name) return { error: 'Name is required.' };
  if ((strict || dob) && !okDate(dob)) return { error: 'Enter a birth date like 1932-03-04, 1932-03 or 1932.' };
  if (dod && !okDate(dod, true)) return { error: 'Enter a death date like 2011-09-17, 2011-09 or 2011.' };
  if (dod && dob && dod !== 'unknown' && full(dod) < full(dob)) return { error: 'Date of death cannot be before date of birth.' };
  let dob_q = has('dob_q') ? qOf(b.dob_q) : (base ? base.dob_q : null);
  let dod_q = has('dod_q') ? qOf(b.dod_q) : (base ? base.dod_q : null);
  if (!dob) dob_q = null;
  if (!dod) dod_q = null;
  let parent_kind = has('parent_kind') ? b.parent_kind : (base ? base.parent_kind : null);
  if (parent_kind === '' || parent_kind == null) parent_kind = base && base.parent_marriage_id ? 'biological' : (base ? (base.parent_kind || 'biological') : 'biological');
  else if (!PK.includes(parent_kind)) return { error: 'Choose a valid relationship to the parents.' };
  const birth_place = has('birth_place') ? txt(b.birth_place, 120) : (base ? base.birth_place : null);
  const death_place = dod ? (has('death_place') ? txt(b.death_place, 120) : (base ? base.death_place : null)) : null;
  const notes = has('notes') ? txt(b.notes, 4000) : (base ? base.notes : null);
  return { name, gender, dob, dod, dob_q, dod_q, parent_kind, birth_place, death_place, notes };
};
const roleOf = (tid, u) => {
  const t = q('SELECT owner_id FROM trees WHERE id=?', tid);
  if (!t || !u) return null;
  if (t.owner_id === u) return 'owner';
  const m = q('SELECT role FROM members WHERE tree_id=? AND user_id=?', tid, u);
  return m ? m.role : null;
};
// Existing databases may contain a root_id that no longer points at a person in the tree.
// Fall back to the oldest person so reads keep working instead of returning an empty tree.
const treeRoot = t => {
  if (!t) return null;
  if (t.root_id && q('SELECT id FROM people WHERE id=? AND tree_id=?', t.root_id, t.id)) return t.root_id;
  const first = q('SELECT id FROM people WHERE tree_id=? ORDER BY id LIMIT 1', t.id);
  return first ? first.id : null;
};
const log = (tid, u, action, detail) => db.prepare('INSERT INTO audit(tree_id,user_id,action,detail) VALUES(?,?,?,?)').run(tid, u, action, detail || null);
const alog = (u, action, detail) => db.prepare('INSERT INTO account_audit(user_id,action,detail) VALUES(?,?,?)').run(u, action, detail || null);
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
const EMAIL_MAX = 254, NAME_MAX = 80, PASSWORD_MIN = 8, PASSWORD_MAX_BYTES = 72;
const normEmail = v => String(v == null ? '' : v).trim().toLowerCase();
const validEmail = e => e.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const cleanName = v => {
  const name = String(v == null ? '' : v).trim();
  if (!name) return { error: 'Enter your name.' };
  if (name.length > NAME_MAX) return { error: `Name must be ${NAME_MAX} characters or fewer.` };
  return { name };
};
const passwordError = p => {
  if (typeof p !== 'string' || p.length < PASSWORD_MIN) return 'Enter a password of at least 8 characters.';
  if (Buffer.byteLength(p, 'utf8') > PASSWORD_MAX_BYTES) return `Password must be ${PASSWORD_MAX_BYTES} bytes or fewer.`;
  return null;
};
const token = u => jwt.sign({ id: u.id, tv: u.tv || 0 }, SECRET, { algorithm: 'HS256', expiresIn: '7d' });
app.post('/api/auth/register', (req, res) => {
  const body = req.body || {}, email = normEmail(body.email), nameCheck = cleanName(body.name);
  if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
  const pe = passwordError(body.password); if (pe) return fail(res, 400, pe);
  if (nameCheck.error) return fail(res, 400, nameCheck.error);
  if (q('SELECT id FROM users WHERE email=?', email)) return fail(res, 409, 'That email is already registered.');
  const id = db.prepare('INSERT INTO users(email,name,hash) VALUES(?,?,?)').run(email, nameCheck.name, bcrypt.hashSync(body.password, 10)).lastInsertRowid;
  alog(id, 'created account', email);
  res.json({ token: token({ id }), user: { id, email, name: nameCheck.name } });
});
app.post('/api/auth/login', authFailureGuard('login'), (req, res) => {
  const body = req.body || {}, email = normEmail(body.email), password = body.password;
  if (!validEmail(email) || typeof password !== 'string' || password.length < PASSWORD_MIN) {
    noteAuthFailure(req, 'login');
    return fail(res, 401, 'Email or password is incorrect.');
  }
  const u = q('SELECT * FROM users WHERE email=?', email);
  if (!u || !bcrypt.compareSync(password, u.hash)) {
    noteAuthFailure(req, 'login');
    return fail(res, 401, 'Email or password is incorrect.');
  }
  res.json({ token: token(u), user: { id: u.id, email: u.email, name: u.name } });
});

// ---- Trees ----
app.get('/api/trees', need, (req, res) => res.json(all(
  `SELECT id,name,'owner' role,(SELECT COUNT(*) FROM people p WHERE p.tree_id=trees.id) people FROM trees WHERE owner_id=?
   UNION SELECT t.id,t.name,m.role,(SELECT COUNT(*) FROM people p WHERE p.tree_id=t.id) FROM trees t JOIN members m ON m.tree_id=t.id WHERE m.user_id=?`, req.uid, req.uid)));
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
  const want = new Set(ids); marriages.forEach(m => { if (m.a_id != null) want.add(m.a_id); if (m.b_id != null) want.add(m.b_id); });
  all('SELECT id FROM people WHERE tree_id=? AND parent_marriage_id IN (SELECT value FROM json_each(?))', tid, JSON.stringify(marriages.map(m => m.id))).forEach(k => want.add(k.id));
  return { people: all('SELECT * FROM people WHERE tree_id=? AND id IN (SELECT value FROM json_each(?))', tid, JSON.stringify([...want])), marriages };
};
const present = (t, role, b) => { const hide = !role && t.hide_living; return { people: b.people.map(derive).map(p => hide ? redact(p) : p), marriages: b.marriages }; };
app.get('/api/trees/:id', (req, res) => {
  const t = q('SELECT * FROM trees WHERE id=?', req.params.id), role = t && roleOf(t.id, uid(req));
  if (!t || (!role && t.visibility !== 'link')) return fail(res, 404, 'Tree not found.');
  const depth = depthParam(req, res, 0, 0, 20); if (depth === null) return;
  const root = treeRoot(t), total = q('SELECT COUNT(*) n FROM people WHERE tree_id=?', t.id).n;
  const b = depth > 0 ? bundle(t.id, all(`WITH RECURSIVE d(id,gen) AS (SELECT ?,0 UNION SELECT k.id,d.gen+1 FROM d JOIN marriages m ON d.id IN (m.a_id,m.b_id) AND m.tree_id=?
      JOIN people k ON k.parent_marriage_id=m.id AND k.tree_id=? WHERE d.gen<?) SELECT id FROM d`, root, t.id, t.id, depth - 1).map(r => r.id))
    : { people: all('SELECT * FROM people WHERE tree_id=?', t.id), marriages: all('SELECT * FROM marriages WHERE tree_id=?', t.id) };
  res.json({ tree: { ...t, root_id: root }, role, canEdit: role === 'owner' || role === 'editor', total, ...present(t, role, b) });
});
app.get('/api/people/:id/branch', (req, res) => {
  const p = q('SELECT * FROM people WHERE id=?', req.params.id), t = p && q('SELECT * FROM trees WHERE id=?', p.tree_id), role = t && roleOf(t.id, uid(req));
  if (!p || (!role && t.visibility !== 'link')) return fail(res, 404, 'Person not found.');
  const b = bundle(t.id, [p.id]); // also bring the person's parents so their page can show them
  const pm = p.parent_marriage_id && q('SELECT * FROM marriages WHERE id=? AND tree_id=?', p.parent_marriage_id, t.id);
  if (pm) {
    if (!b.marriages.some(x => x.id === pm.id)) b.marriages.push(pm);
    [pm.a_id, pm.b_id].forEach(i => { if (!b.people.some(x => x.id === i)) { const par = q('SELECT * FROM people WHERE id=? AND tree_id=?', i, t.id); if (par) b.people.push(par); } });
  }
  res.json(present(t, role, b));
});
app.patch('/api/trees/:id', need, (req, res) => {
  const t = ownTree(req, res, 'owner'); if (!t) return;
  const b = req.body, name = b.name === undefined ? t.name : String(b.name).trim();
  const vis = b.visibility === undefined ? t.visibility : b.visibility;
  if (!name) return fail(res, 400, 'Give your family tree a name.');
  if (!['private', 'link'].includes(vis)) return fail(res, 400, 'Visibility must be private or link.');
  let root = t.root_id;
  if (b.root_id !== undefined) {
    root = Number(b.root_id);
    if (!Number.isInteger(root) || !q('SELECT id FROM people WHERE id=? AND tree_id=?', root, t.id)) return fail(res, 400, 'That person is not in this tree.');
  }
  db.prepare('UPDATE trees SET name=?,visibility=?,hide_living=?,root_id=? WHERE id=?').run(name, vis, b.hide_living === undefined ? t.hide_living : (b.hide_living ? 1 : 0), root, t.id);
  log(t.id, req.uid, 'changed tree settings', `${name}, ${vis}`);
  res.json({ ok: true });
});
app.delete('/api/trees/:id', need, (req, res) => {
  const t = ownTree(req, res, 'owner'); if (!t) return;
  const files = uploadPathsForTree(t.id);
  db.prepare('DELETE FROM trees WHERE id=?').run(t.id);
  files.forEach(removeUploadIfUnused);
  res.json({ ok: true });
});

// ---- Search by name (works with lazy loading, since it queries the database, not the loaded page) ----
app.get('/api/trees/:id/search', (req, res) => {
  const t = q('SELECT * FROM trees WHERE id=?', req.params.id), role = t && roleOf(t.id, uid(req));
  if (!t || (!role && t.visibility !== 'link')) return fail(res, 404, 'Tree not found.');
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.set('X-Total-Count', '0').json([]);
  const num = (v, def, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : def; };
  const limit = num(req.query.limit, 50, 1, 100), offset = num(req.query.offset, 0, 0, 1000000);
  const gender = ['Male', 'Female', 'Other'].includes(req.query.gender) ? req.query.gender : null;
  const status = ['living', 'deceased'].includes(req.query.status) ? req.query.status : null;
  const year = v => /^\d{4}$/.test(String(v || '')) ? String(v) : null;
  const from = year(req.query.from), to = year(req.query.to);
  const sort = { name: 'name', born: 'dob', born_desc: 'dob DESC' }[req.query.sort] || 'name';
  const where = ['tree_id=?', "name LIKE ? ESCAPE '\\'"], args = [t.id, '%' + term.replace(/[\\%_]/g, '\\$&') + '%'];
  if (gender) { where.push('gender=?'); args.push(gender); }
  if (status) where.push(status === 'living' ? 'dod IS NULL' : 'dod IS NOT NULL');
  if (from) { where.push('substr(dob,1,4)>=?'); args.push(from); }
  if (to) { where.push('substr(dob,1,4)<=?'); args.push(to); }
  const total = q(`SELECT COUNT(*) n FROM people WHERE ${where.join(' AND ')}`, ...args).n;
  const hide = !role && t.hide_living;
  res.set('X-Total-Count', String(total)).json(all(`SELECT * FROM people WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...args, limit, offset)
    .map(derive).map(p => hide ? redact(p) : p).map(({ id, name, dob, dod, dob_q, dod_q, gender }) => ({ id, name, dob, dod, dob_q, dod_q, gender })));
});


// ---- Add both parents to someone (lets a tree grow upward, and lets in-laws have families) ----
app.post('/api/people/:id/parents', need, (req, res) => {
  const p = ownPerson(req, res); if (!p) return;
  if (p.parent_marriage_id) return fail(res, 409, 'This person already has parents in the tree.');
  const body = req.body || {}, hasFather = !!body.father, hasMother = !!body.mother;
  if (!hasFather && !hasMother) return fail(res, 400, 'Enter at least one parent.');
  const f = hasFather ? clean({ ...body.father, gender: 'Male' }, false) : null;
  const m = hasMother ? clean({ ...body.mother, gender: 'Female' }, false) : null;
  if (f && f.error) return fail(res, 400, 'Father: ' + f.error);
  if (m && m.error) return fail(res, 400, 'Mother: ' + m.error);
  const kind = PK.includes(body.parent_kind) ? body.parent_kind : 'biological';
  const years = marriageYears(body.year, null);
  if (years.error) return fail(res, 400, years.error);
  const parents = [f, m].filter(Boolean);
  const ageErr = parents.map(x => parentAgeError(p, x, kind)).find(Boolean);
  if (ageErr) return fail(res, 400, ageErr);
  const dateErr = marriageDateError(years.year, parents);
  if (dateErr) return fail(res, 400, dateErr);
  const out = db.transaction(() => {
    const a = f ? addPerson(p.tree_id, f) : null, b = m ? addPerson(p.tree_id, m) : null;
    const mid = db.prepare('INSERT INTO marriages(tree_id,a_id,b_id,year,kind) VALUES(?,?,?,?,?)').run(p.tree_id, a, b, years.year, f && m ? 'married' : 'single').lastInsertRowid;
    db.prepare('UPDATE people SET parent_marriage_id=?,parent_kind=? WHERE id=?').run(mid, kind, p.id);
    const bad = relationshipIntegrityError(p.tree_id); if (bad) { const e = new Error(bad); e.safeMessage = true; throw e; }
    return { father: a, mother: b, parent_marriage_id: mid };
  })();
  log(p.tree_id, req.uid, 'added parents of', p.name);
  res.json(out);
});

// ---- Change or remove an existing parent link, or link a person to an existing couple ----
app.put('/api/people/:id/parents', need, (req, res) => {
  const p = ownPerson(req, res); if (!p) return;
  const body = req.body || {}, kind = hasOwn(body, 'parent_kind') ? body.parent_kind : (p.parent_kind || 'biological');
  if (!PK.includes(kind)) return fail(res, 400, 'Choose a valid relationship to the parents.');
  if (hasOwn(body, 'parent_marriage_id')) {
    const mid = body.parent_marriage_id === null || body.parent_marriage_id === '' ? null : idNum(body.parent_marriage_id);
    if (body.parent_marriage_id !== null && body.parent_marriage_id !== '' && mid == null) return fail(res, 400, 'Choose a valid set of parents.');
    if (mid != null) {
      const m = q('SELECT * FROM marriages WHERE id=? AND tree_id=?', mid, p.tree_id);
      if (!m) return fail(res, 400, 'Those parents are not in this tree.');
      if (m.a_id === p.id || m.b_id === p.id) return fail(res, 409, 'Someone cannot be their own parent.');
      for (const id of [m.a_id, m.b_id].filter(x => x != null)) {
        const err = parentAgeError(p, q('SELECT * FROM people WHERE id=? AND tree_id=?', id, p.tree_id), kind);
        if (err) return fail(res, 400, err);
      }
    }
    try {
      db.transaction(() => {
        db.prepare('UPDATE people SET parent_marriage_id=?,parent_kind=? WHERE id=?').run(mid, mid == null ? 'biological' : kind, p.id);
        const bad = relationshipIntegrityError(p.tree_id); if (bad) { const e = new Error(bad); e.safeMessage = true; throw e; }
      })();
    } catch (e) { if (e && e.safeMessage) return fail(res, 409, e.message); throw e; }
    log(p.tree_id, req.uid, mid == null ? 'removed parents of' : 'changed parents of', p.name);
    return res.json({ ok: true, parent_marriage_id: mid });
  }
  const hasFather = !!body.father, hasMother = !!body.mother;
  if (!hasFather && !hasMother) return fail(res, 400, 'Enter at least one parent, or remove the existing parents.');
  const f = hasFather ? clean({ ...body.father, gender: 'Male' }, false) : null;
  const m = hasMother ? clean({ ...body.mother, gender: 'Female' }, false) : null;
  if (f && f.error) return fail(res, 400, 'Father: ' + f.error);
  if (m && m.error) return fail(res, 400, 'Mother: ' + m.error);
  const parents = [f, m].filter(Boolean);
  const ageErr = parents.map(x => parentAgeError(p, x, kind)).find(Boolean);
  if (ageErr) return fail(res, 400, ageErr);
  const years = marriageYears(body.year, null);
  if (years.error) return fail(res, 400, years.error);
  const dateErr = marriageDateError(years.year, parents);
  if (dateErr) return fail(res, 400, dateErr);
  const mid = db.transaction(() => {
    const a = f ? addPerson(p.tree_id, f) : null, b = m ? addPerson(p.tree_id, m) : null;
    const id = db.prepare('INSERT INTO marriages(tree_id,a_id,b_id,year,kind) VALUES(?,?,?,?,?)').run(p.tree_id, a, b, years.year, f && m ? 'married' : 'single').lastInsertRowid;
    db.prepare('UPDATE people SET parent_marriage_id=?,parent_kind=? WHERE id=?').run(id, kind, p.id);
    return id;
  })();
  log(p.tree_id, req.uid, 'changed parents of', p.name);
  res.json({ ok: true, parent_marriage_id: mid });
});
app.delete('/api/people/:id/parents', need, (req, res) => {
  const p = ownPerson(req, res); if (!p) return;
  db.prepare('UPDATE people SET parent_marriage_id=NULL,parent_kind=? WHERE id=?').run('biological', p.id);
  log(p.tree_id, req.uid, 'removed parents of', p.name);
  res.json({ ok: true });
});

// ---- Ancestors for the pedigree chart ----
app.get('/api/people/:id/pedigree', (req, res) => {
  const p = q('SELECT * FROM people WHERE id=?', req.params.id), t = p && q('SELECT * FROM trees WHERE id=?', p.tree_id), role = t && roleOf(t.id, uid(req));
  if (!p || (!role && t.visibility !== 'link')) return fail(res, 404, 'Person not found.');
  const d = depthParam(req, res, 4, 1, 8); if (d === null) return;
  const ids = all(`WITH RECURSIVE a(id,gen) AS (SELECT ?,0 UNION SELECT x.id,a.gen+1 FROM a JOIN people c ON c.id=a.id AND c.tree_id=?
    JOIN marriages m ON m.id=c.parent_marriage_id AND m.tree_id=? JOIN people x ON x.id IN (m.a_id,m.b_id) AND x.tree_id=? WHERE a.gen<?)
    SELECT id FROM a`, p.id, t.id, t.id, t.id, d).map(r => r.id), j = JSON.stringify(ids);
  const hide = !role && t.hide_living;
  res.json({ people: all('SELECT * FROM people WHERE tree_id=? AND id IN (SELECT value FROM json_each(?))', t.id, j).map(derive).map(x => hide ? redact(x) : x),
    marriages: all('SELECT * FROM marriages WHERE tree_id=? AND id IN (SELECT parent_marriage_id FROM people WHERE tree_id=? AND id IN (SELECT value FROM json_each(?)))', t.id, t.id, j) });
});

// ---- "How are we related?" Works out blood relationships from the nearest shared ancestor, plus marriage links. ----
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
const great = n => n > 0 ? 'great-'.repeat(n) : '';
const word = (g, m, f, n) => g === 'Male' ? m : g === 'Female' ? f : n;
const kinship = (people, marriages) => {
  const P = Object.fromEntries(people.map(x => [x.id, x])), M = Object.fromEntries(marriages.map(x => [x.id, x]));
  const parents = id => { const m = M[P[id] && P[id].parent_marriage_id]; return m ? [m.a_id, m.b_id].filter(x => x != null) : []; };
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
  const mates = id => marriages.filter(m => m.a_id === id || m.b_id === id).map(m => m.a_id === id ? m.b_id : m.a_id).filter(x => x != null);
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
const generationCount = (people, marriages) => {
  const P = Object.fromEntries(people.map(p => [p.id, p])), M = Object.fromEntries(marriages.map(m => [m.id, m]));
  const memo = new Map(), visiting = new Set();
  const parentsOf = id => { const p = P[id], m = p && M[p.parent_marriage_id]; return m ? [m.a_id, m.b_id].filter(x => x != null && P[x]) : []; };
  const depth = id => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const par = parentsOf(id), d = par.length ? 1 + Math.max(...par.map(depth)) : 1;
    visiting.delete(id); memo.set(id, d); return d;
  };
  return people.reduce((max, p) => Math.max(max, depth(p.id)), 0);
};
app.get('/api/trees/:id/insights', (req, res) => {
  const t = q('SELECT * FROM trees WHERE id=?', req.params.id), role = t && roleOf(t.id, uid(req));
  if (!t || (!role && t.visibility !== 'link')) return fail(res, 404, 'Tree not found.');
  const hide = !role && t.hide_living, ps = all('SELECT * FROM people WHERE tree_id=?', t.id).map(derive), ms = all('SELECT * FROM marriages WHERE tree_id=?', t.id);
  const living = ps.filter(p => !p.dod), gone = ps.filter(p => p.dod), by = {};
  ps.forEach(p => { const k = p.gender || 'Not set'; by[k] = (by[k] || 0) + 1; });
  const lived = gone.filter(p => p.age != null), top = (a, f) => a.reduce((x, p) => (!x || f(p) > f(x)) ? p : x, null);
  const short = p => p && { id: p.id, name: p.name, age: p.age };
  const names = {}; ps.forEach(p => { const n = p.name.split(/\s+/)[0]; names[n] = (names[n] || 0) + 1; });
  const gens = generationCount(ps, ms);
  const today = new Date(), t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const birthdays = hide || !role ? [] : living.filter(p => (p.dob || '').length === 10).map(p => {
    const [y, m, d] = p.dob.split('-').map(Number); let n = Date.UTC(today.getUTCFullYear(), m - 1, d); if (n < t0) n = Date.UTC(today.getUTCFullYear() + 1, m - 1, d);
    return { id: p.id, name: p.name, date: new Date(n).toISOString().slice(5, 10), turns: new Date(n).getUTCFullYear() - y, inDays: Math.round((n - t0) / 864e5) };
  }).filter(b => b.inDays <= 60).sort((a, b) => a.inDays - b.inDays).slice(0, 8);
  res.json({ people: ps.length, living: living.length, deceased: gone.length, marriages: ms.length, generations: gens, gender: by,
    averageLifespan: lived.length ? Math.round(lived.reduce((s, p) => s + p.age, 0) / lived.length) : null,
    longestLived: short(top(lived, p => p.age)), oldestLiving: hide ? null : short(top(living.filter(p => p.age != null), p => p.age)),
    commonNames: Object.entries(names).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([name, count]) => ({ name, count })), birthdays });
});

// ---- Full backup as JSON (tree, people, relationships, attachments, media, members and history) ----
const MIME_FOR = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const mimeFor = name => MIME_FOR[path.extname(name).toLowerCase()] || 'application/octet-stream';
const backupFiles = (people, attachments) => {
  const names = new Set();
  people.forEach(p => { if (p.photo) names.add(path.basename(p.photo)); });
  attachments.forEach(a => { if (a.file) names.add(path.basename(a.file)); });
  const root = path.resolve(UPLOADS), out = [];
  for (const name of names) {
    const full = path.resolve(root, name), st = fs.existsSync(full) && fs.statSync(full);
    if (!st || !full.startsWith(root + path.sep) || st.size > 8 * 1024 * 1024) continue;
    out.push({ name, mime: mimeFor(name), data: fs.readFileSync(full).toString('base64') });
  }
  return out;
};
app.get('/api/trees/:id/export.json', need, (req, res) => {
  const t = ownTree(req, res); if (!t) return;
  const people = all('SELECT * FROM people WHERE tree_id=?', t.id), marriages = all('SELECT * FROM marriages WHERE tree_id=?', t.id),
    attachments = all('SELECT * FROM attachments WHERE tree_id=?', t.id);
  const members = all('SELECT u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.tree_id=? ORDER BY u.email', t.id);
  const history = all(`SELECT a.action,a.detail,a.at,u.email,u.name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.tree_id=? ORDER BY a.id`, t.id);
  const backup = { version: 2, exportedAt: new Date().toISOString(),
    tree: { name: t.name, visibility: t.visibility, hide_living: !!t.hide_living, root_id: t.root_id },
    people, marriages, attachments, members, history, media: backupFiles(people, attachments) };
  res.set('Content-Disposition', 'attachment; filename="family-tree-backup.json"').json(backup);
});

// Validate a backup without changing anything. Used both by the preview and by the restore itself.
const inspectBackup = b => {
  const errors = [], warnings = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { errors: ['That file is not a Family Tree backup.'], warnings, counts: {} };
  const people = Array.isArray(b.people) ? b.people : null, marriages = Array.isArray(b.marriages) ? b.marriages : null;
  if (!people || !marriages) return { errors: ['That backup is missing people or relationships.'], warnings, counts: {} };
  if (!people.length) errors.push('That backup does not contain any people.');
  if (people.length > 50000 || marriages.length > 50000) errors.push('That backup is too large to restore.');
  const media = Array.isArray(b.media) ? b.media : [], attachments = Array.isArray(b.attachments) ? b.attachments : [];
  const pids = new Set(), mids = new Set();
  for (const p of people) {
    if (!p || typeof p !== 'object' || p.id == null || pids.has(String(p.id))) { errors.push('Every person in the backup needs a unique id.'); continue; }
    pids.add(String(p.id));
    const c = clean(p, false);
    if (c.error) errors.push(`Person “${String(p.name || 'unknown').slice(0, 60)}”: ${c.error}`);
  }
  for (const m of marriages) {
    if (!m || typeof m !== 'object' || m.id == null || mids.has(String(m.id))) { errors.push('Every relationship in the backup needs a unique id.'); continue; }
    mids.add(String(m.id));
    const a = m.a_id, bb = m.b_id;
    if (a == null && bb == null) errors.push('A relationship in the backup has no people.');
    else if (a != null && bb != null && String(a) === String(bb)) errors.push('A relationship in the backup links someone to themselves.');
    for (const id of [a, bb]) if (id != null && !pids.has(String(id))) warnings.push('A relationship refers to someone who is not in the backup and was skipped.');
  }
  for (const p of people) if (p && p.parent_marriage_id != null && !mids.has(String(p.parent_marriage_id))) warnings.push(`The parents of “${String(p.name || 'a person').slice(0, 60)}” are not in the backup.`);
  let mediaCount = 0;
  for (const m of media) {
    if (!m || typeof m.name !== 'string' || typeof m.data !== 'string') { warnings.push('A media file in the backup was not valid and was skipped.'); continue; }
    if (Buffer.byteLength(m.data, 'base64') > 8 * 1024 * 1024) { warnings.push(`“${path.basename(m.name).slice(0, 60)}” is too large to restore.`); continue; }
    const head = Buffer.from(m.data, 'base64').subarray(0, 16);
    if (!detectMediaType(head)) { warnings.push(`“${path.basename(m.name).slice(0, 60)}” is not a supported file and was skipped.`); continue; }
    mediaCount++;
  }
  for (const a of attachments) if (!a || !pids.has(String(a.person_id))) warnings.push('An attachment refers to someone who is not in the backup and was skipped.');
  const members = Array.isArray(b.members) ? b.members.filter(x => x && x.email && ['editor', 'viewer'].includes(x.role)) : [];
  const counts = { people: people.length, marriages: marriages.length, attachments: attachments.length, media: mediaCount, members: members.length, history: Array.isArray(b.history) ? b.history.length : 0 };
  return { errors, warnings: [...new Set(warnings)], counts };
};
const restoreBackup = (uid, b, counts) => {
  const people = b.people, marriages = b.marriages, attachments = Array.isArray(b.attachments) ? b.attachments : [];
  const media = Array.isArray(b.media) ? b.media : [], history = Array.isArray(b.history) ? b.history : [];
  const members = Array.isArray(b.members) ? b.members : [];
  const name = String((b.tree && b.tree.name) || 'Restored family tree').trim().slice(0, 120) || 'Restored family tree';
  const visibility = b.tree && ['private', 'link'].includes(b.tree.visibility) ? b.tree.visibility : 'private';
  const wrote = [], mediaMap = new Map(), pMap = new Map(), mMap = new Map(), warnings = [...counts.warnings];
  try {
    // Files are written first under generated names; the user-supplied path is never used directly.
    for (const m of media) {
      const decoded = Buffer.from(m.data, 'base64'), type = detectMediaType(decoded.subarray(0, 16));
      if (!type || decoded.length > 8 * 1024 * 1024) continue;
      const filename = Date.now() + '-' + crypto.randomBytes(8).toString('hex') + (MEDIA_TYPES[type].exts[0] || '.bin');
      fs.writeFileSync(path.join(UPLOADS, filename), decoded);
      wrote.push(filename); mediaMap.set(path.basename(m.name), '/uploads/' + filename);
    }
    const tid = db.transaction(() => {
      const newTid = db.prepare('INSERT INTO trees(owner_id,name,visibility,hide_living) VALUES(?,?,?,?)').run(uid, name, visibility, b.tree && b.tree.hide_living ? 1 : 0).lastInsertRowid;
      const extSeen = new Set();
      for (const p of people) {
        const c = clean(p, false); if (c.error) throw Object.assign(new Error(c.error), { safeMessage: true });
        const ext = p.ext_id != null && !extSeen.has(String(p.ext_id)) ? String(p.ext_id) : null;
        if (ext) extSeen.add(ext);
        const id = addPerson(newTid, c, null, ext);
        pMap.set(String(p.id), id);
        const photo = p.photo && mediaMap.get(path.basename(p.photo));
        if (photo) db.prepare('UPDATE people SET photo=? WHERE id=?').run(photo, id);
      }
      const couple = (a, b) => q('SELECT * FROM marriages WHERE tree_id=? AND ((a_id IS ? AND b_id IS ?) OR (a_id IS ? AND b_id IS ?))', newTid, a, b, b, a);
      for (const m of marriages) {
        const a = m.a_id != null ? pMap.get(String(m.a_id)) : null, bb = m.b_id != null ? pMap.get(String(m.b_id)) : null;
        if (a == null && bb == null) { warnings.push('A relationship with no people was skipped.'); continue; }
        if (a != null && bb != null && a === bb) { warnings.push('A relationship linking someone to themselves was skipped.'); continue; }
        const found = couple(a, bb);
        if (found) { mMap.set(String(m.id), found.id); continue; }
        const years = marriageYears(m.year, m.end_year), oneParent = a == null || bb == null, kind = oneParent ? 'single' : MK.includes(m.kind) ? m.kind : 'married';
        const newId = db.prepare('INSERT INTO marriages(tree_id,a_id,b_id,year,kind,end_year,ext_id) VALUES(?,?,?,?,?,?,?)')
          .run(newTid, a, bb, years.error ? null : years.year, kind, years.error ? null : years.end_year, m.ext_id != null ? String(m.ext_id).slice(0, 80) : null).lastInsertRowid;
        if (years.error) warnings.push('A relationship had impossible dates; its years were cleared.');
        mMap.set(String(m.id), newId);
      }
      for (const p of people) {
        const id = pMap.get(String(p.id)), mid = p.parent_marriage_id != null ? mMap.get(String(p.parent_marriage_id)) : null;
        if (mid) db.prepare('UPDATE people SET parent_marriage_id=?,parent_kind=? WHERE id=?').run(mid, PK.includes(p.parent_kind) ? p.parent_kind : 'biological', id);
      }
      for (const a of attachments) {
        const personId = pMap.get(String(a.person_id)); if (!personId) continue;
        const kind = ['source', 'document', 'photo'].includes(a.kind) ? a.kind : 'source', title = String(a.title || '').trim().slice(0, 160) || 'Untitled';
        const url = /^https?:\/\//i.test(String(a.url || '')) ? String(a.url).slice(0, 2000) : null;
        const file = a.file && mediaMap.get(path.basename(a.file)) || null;
        db.prepare('INSERT INTO attachments(tree_id,person_id,kind,title,description,url,file) VALUES(?,?,?,?,?,?,?)')
          .run(newTid, personId, kind, title, String(a.description || '').trim().slice(0, 2000) || null, url, file);
      }
      if (b.tree && b.tree.root_id != null && pMap.get(String(b.tree.root_id))) db.prepare('UPDATE trees SET root_id=? WHERE id=?').run(pMap.get(String(b.tree.root_id)), newTid);
      else { const first = q('SELECT id FROM people WHERE tree_id=? ORDER BY id LIMIT 1', newTid); if (first) db.prepare('UPDATE trees SET root_id=? WHERE id=?').run(first.id, newTid); }
      for (const m of members) {
        const u = q('SELECT id FROM users WHERE email=?', String(m.email).toLowerCase());
        if (!u) { warnings.push(`No account uses ${String(m.email).slice(0, 80)}, so they were not added as a member.`); continue; }
        if (u.id !== uid) db.prepare('INSERT INTO members(tree_id,user_id,role) VALUES(?,?,?) ON CONFLICT(tree_id,user_id) DO UPDATE SET role=excluded.role').run(newTid, u.id, m.role);
      }
      for (const h of history.slice(0, 5000)) {
        const u = h && h.email ? q('SELECT id FROM users WHERE email=?', String(h.email).toLowerCase()) : null;
        if (!h || !h.action) continue;
        db.prepare('INSERT INTO audit(tree_id,user_id,action,detail,at) VALUES(?,?,?,?,?)').run(newTid, u ? u.id : null, String(h.action).slice(0, 200), h.detail ? String(h.detail).slice(0, 1000) : null, h.at ? String(h.at).slice(0, 40) : new Date().toISOString());
      }
      log(newTid, uid, 'restored a backup', `${people.length} people, ${marriages.length} relationships`);
      return newTid;
    })();
    return { id: tid, warnings: [...new Set(warnings)] };
  } catch (e) {
    for (const f of wrote) try { fs.unlinkSync(path.join(UPLOADS, f)); } catch {}
    throw e;
  }
};
const uploadBackup = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });
app.post('/api/trees/restore', need, uploadBackup.single('file'), express.json({ limit: '64mb' }), express.text({ type: ['text/plain', 'application/octet-stream'], limit: '64mb' }), (req, res) => {
  let raw = req.file ? req.file.buffer.toString('utf8') : req.body;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return fail(res, 400, 'That file is not valid JSON.'); } }
  const preview = req.query.preview === '1' || (raw && raw.mode === 'preview') || req.body && req.body.mode === 'preview';
  const info = inspectBackup(raw);
  if (info.errors.length) return res.status(400).json({ valid: false, errors: info.errors.slice(0, 20), warnings: info.warnings, counts: info.counts });
  if (preview || (req.body && req.body.mode === 'preview')) return res.json({ valid: true, preview: true, tree: String((raw.tree && raw.tree.name) || 'Restored family tree').slice(0, 120), counts: info.counts, warnings: info.warnings });
  try {
    const out = restoreBackup(req.uid, raw, info);
    res.json({ valid: true, id: out.id, counts: info.counts, warnings: out.warnings });
  } catch (e) {
    if (!e || !e.safeMessage) console.error('Backup restore failed:', e && e.stack || e);
    fail(res, 400, e && e.safeMessage ? e.message : 'That backup could not be restored.');
  }
});


// ---- Relationship types: married, partner, divorced, separated ----
app.put('/api/marriages/:id', need, (req, res) => {
  const m = q('SELECT * FROM marriages WHERE id=?', req.params.id);
  if (!m) return fail(res, 404, 'Relationship not found.');
  if (!['owner', 'editor'].includes(roleOf(m.tree_id, req.uid))) return fail(res, 403, 'You do not have permission to edit this tree.');
  const body = req.body || {};
  // Only fields the client actually sent are changed, so a small edit cannot wipe the other fields.
  const year = hasOwn(body, 'year') ? body.year : m.year, end = hasOwn(body, 'end_year') ? body.end_year : m.end_year;
  const years = marriageYears(year, end);
  if (years.error) return fail(res, 400, years.error);
  let kind = m.kind;
  if (hasOwn(body, 'kind')) {
    if (!MK.includes(body.kind)) return fail(res, 400, 'Choose a valid relationship type.');
    kind = body.kind;
  }
  const y = years.year, e = years.end_year;
  const people = [q('SELECT * FROM people WHERE id=? AND tree_id=?', m.a_id, m.tree_id), q('SELECT * FROM people WHERE id=? AND tree_id=?', m.b_id, m.tree_id)].filter(Boolean);
  if (people.length !== (m.a_id != null) + (m.b_id != null)) return fail(res, 400, 'That relationship links invalid people.');
  const oneParent = (m.a_id == null) !== (m.b_id == null);
  if (kind === 'single' && !oneParent) return fail(res, 400, 'A single-parent family needs one parent.');
  if (kind !== 'single' && oneParent) return fail(res, 400, 'A relationship with one parent is a single-parent family.');
  if (y !== m.year) { for (const p of people) { const err = marriageDateError(y, [p]); if (err) return fail(res, 400, err); } }
  if (e !== m.end_year) { for (const p of people) { const err = marriageDateError(e, [p]); if (err) return fail(res, 400, err); } }
  db.prepare('UPDATE marriages SET kind=?,year=?,end_year=? WHERE id=?').run(kind, y, e, m.id);
  log(m.tree_id, req.uid, 'updated a relationship', kind);
  res.json({ ok: true });
});
// ---- Link two people who are already in the tree as a couple (one parent is allowed) ----
app.post('/api/marriages', need, (req, res) => {
  const body = req.body || {}, aId = body.a_id == null || body.a_id === '' ? null : idNum(body.a_id), bId = body.b_id == null || body.b_id === '' ? null : idNum(body.b_id);
  if (aId == null && bId == null) return fail(res, 400, 'Choose at least one person for this relationship.');
  if (aId == null || bId == null) {
    if ((body.a_id != null && body.a_id !== '' && aId == null) || (body.b_id != null && body.b_id !== '' && bId == null)) return fail(res, 400, 'Choose people who are in this tree.');
  }
  if (aId != null && bId != null && aId === bId) return fail(res, 400, 'Someone cannot be their own partner.');
  const seed = q('SELECT * FROM people WHERE id=?', aId != null ? aId : bId);
  if (!seed) return fail(res, 404, 'Person not found.');
  const t = q('SELECT * FROM trees WHERE id=?', seed.tree_id);
  if (!t || !['owner', 'editor'].includes(roleOf(t.id, req.uid))) return fail(res, 403, 'You do not have permission to edit this tree.');
  const a = aId != null ? q('SELECT * FROM people WHERE id=? AND tree_id=?', aId, t.id) : null;
  const b = bId != null ? q('SELECT * FROM people WHERE id=? AND tree_id=?', bId, t.id) : null;
  if ((aId != null && !a) || (bId != null && !b)) return fail(res, 400, 'Choose people who are in this tree.');
  if (a && b && a.id === b.id) return fail(res, 400, 'Someone cannot be their own partner.');
  const years = marriageYears(body.year, body.end_year);
  if (years.error) return fail(res, 400, years.error);
  const oneParent = aId == null || bId == null;
  if (!oneParent && body.kind === 'single') return fail(res, 400, 'A single-parent family needs one parent.');
  // One-parent unions are always labelled accurately, even when the client omits the type.
  const kind = oneParent ? 'single' : MK.includes(body.kind) ? body.kind : 'married';
  const dateErr = marriageDateError(years.year, [a, b].filter(Boolean)) || marriageDateError(years.end_year, [a, b].filter(Boolean));
  if (dateErr) return fail(res, 400, dateErr);
  const dup = q('SELECT id FROM marriages WHERE tree_id=? AND ((a_id IS ? AND b_id IS ?) OR (a_id IS ? AND b_id IS ?))', t.id, aId, bId, bId, aId);
  if (dup) return fail(res, 409, 'These people are already recorded together.');
  const id = db.prepare('INSERT INTO marriages(tree_id,a_id,b_id,year,kind,end_year) VALUES(?,?,?,?,?,?)').run(t.id, aId, bId, years.year, kind, years.end_year).lastInsertRowid;
  log(t.id, req.uid, 'added a relationship', [a && a.name, b && b.name].filter(Boolean).join(' and '));
  res.json({ id });
});
// ---- Link a person who is already in the tree as a child of an existing couple/parent ----
app.post('/api/marriages/:id/children', need, (req, res) => {
  const m = q('SELECT * FROM marriages WHERE id=?', req.params.id);
  if (!m) return fail(res, 404, 'Relationship not found.');
  if (!['owner', 'editor'].includes(roleOf(m.tree_id, req.uid))) return fail(res, 403, 'You do not have permission to edit this tree.');
  const child = q('SELECT * FROM people WHERE id=? AND tree_id=?', idNum(req.body && req.body.person_id), m.tree_id);
  if (!child) return fail(res, 400, 'Choose a person in this tree.');
  if (child.id === m.a_id || child.id === m.b_id) return fail(res, 409, 'Someone cannot be their own child.');
  if (child.parent_marriage_id) return fail(res, 409, 'This person already has parents in the tree.');
  const kind = PK.includes(req.body && req.body.parent_kind) ? req.body.parent_kind : 'biological';
  const parents = [m.a_id, m.b_id].filter(x => x != null).map(id => q('SELECT * FROM people WHERE id=? AND tree_id=?', id, m.tree_id));
  const ageErr = parents.map(p => parentAgeError(child, p, kind)).find(Boolean);
  if (ageErr) return fail(res, 400, ageErr);
  if (parents.some(p => ancestorOf(m.tree_id, child.id, p.id))) return fail(res, 409, 'That would create a parent-child loop.');
  try {
    db.transaction(() => {
      db.prepare('UPDATE people SET parent_marriage_id=?,parent_kind=? WHERE id=?').run(m.id, kind, child.id);
      const bad = relationshipIntegrityError(m.tree_id); if (bad) { const e = new Error(bad); e.safeMessage = true; throw e; }
    })();
  } catch (e) { if (e && e.safeMessage) return fail(res, 409, e.message); throw e; }
  log(m.tree_id, req.uid, 'linked a child', `${child.name} to ${[m.a_id, m.b_id].filter(x => x != null).length === 1 ? 'a single parent' : 'a couple'}`);
  res.json({ ok: true });
});
// Remove a relationship without deleting anybody; children become unlinked so no dangling parent ids remain.
app.delete('/api/marriages/:id', need, (req, res) => {
  const m = q('SELECT * FROM marriages WHERE id=?', req.params.id);
  if (!m) return fail(res, 404, 'Relationship not found.');
  if (!['owner', 'editor'].includes(roleOf(m.tree_id, req.uid))) return fail(res, 403, 'You do not have permission to edit this tree.');
  db.transaction(() => {
    db.prepare('UPDATE people SET parent_marriage_id=NULL WHERE tree_id=? AND parent_marriage_id=?').run(m.tree_id, m.id);
    db.prepare('DELETE FROM marriages WHERE id=?').run(m.id);
  })();
  log(m.tree_id, req.uid, 'removed a relationship', 'The people themselves were kept.');
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
  const into = idNum(req.body && req.body.into);
  if (into == null) return fail(res, 400, 'Choose a different person in this tree to keep.');
  const b = q('SELECT * FROM people WHERE id=? AND tree_id=?', into, a.tree_id);
  if (!b || b.id === a.id) return fail(res, 400, 'Choose a different person in this tree to keep.');
  if (q('SELECT id FROM marriages WHERE (a_id=? AND b_id=?) OR (a_id=? AND b_id=?)', a.id, b.id, b.id, a.id)) return fail(res, 409, 'These two are recorded as a couple, so they cannot be the same person.');
  if (ancestorOf(a.tree_id, a.id, b.id) || ancestorOf(a.tree_id, b.id, a.id)) return fail(res, 409, 'A person cannot be merged with their own ancestor or descendant.');
  const oldPhoto = a.photo;
  try {
    db.transaction(() => {
      const t = q('SELECT * FROM trees WHERE id=?', a.tree_id), f = {};
      for (const k of ['gender', 'dob', 'dod', 'dob_q', 'dod_q', 'birth_place', 'death_place', 'photo']) if (!b[k] && a[k]) f[k] = a[k];
      if (a.notes && a.notes !== b.notes) f.notes = [b.notes, a.notes].filter(Boolean).join('\n\n');
      if (!b.parent_marriage_id && a.parent_marriage_id) { f.parent_marriage_id = a.parent_marriage_id; f.parent_kind = a.parent_kind; }
      const ext = !b.ext_id && a.ext_id ? a.ext_id : null;
      db.prepare('UPDATE people SET ext_id=NULL WHERE id=?').run(a.id);
      for (const m of all('SELECT * FROM marriages WHERE a_id=? OR b_id=?', a.id, a.id)) {
        const other = m.a_id === a.id ? m.b_id : m.a_id;
        const dup = q('SELECT * FROM marriages WHERE id<>? AND ((a_id IS ? AND b_id IS ?) OR (a_id IS ? AND b_id IS ?))', m.id, b.id, other, other, b.id);
        if (dup) { // both already have this couple: keep one record and move the children across
          db.prepare('UPDATE people SET parent_marriage_id=? WHERE parent_marriage_id=?').run(dup.id, m.id);
          db.prepare('UPDATE marriages SET year=COALESCE(year,?),end_year=COALESCE(end_year,?),ext_id=COALESCE(ext_id,?) WHERE id=?').run(m.year, m.end_year, m.ext_id, dup.id);
          db.prepare('DELETE FROM marriages WHERE id=?').run(m.id);
        } else db.prepare(m.a_id === a.id ? 'UPDATE marriages SET a_id=? WHERE id=?' : 'UPDATE marriages SET b_id=? WHERE id=?').run(b.id, m.id);
      }
      db.prepare('UPDATE attachments SET person_id=? WHERE person_id=?').run(b.id, a.id);
      if (t.root_id === a.id) db.prepare('UPDATE trees SET root_id=? WHERE id=?').run(b.id, t.id);
      db.prepare('DELETE FROM people WHERE id=?').run(a.id);
      const keys = Object.keys(f); if (keys.length) db.prepare(`UPDATE people SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => f[k]), b.id);
      if (ext) db.prepare('UPDATE people SET ext_id=? WHERE id=?').run(ext, b.id);
      const bad = relationshipIntegrityError(a.tree_id);
      if (bad) throw Object.assign(new Error(bad), { safeMessage: true });
    })();
  } catch (e) {
    if (e && e.safeMessage) return fail(res, 409, e.message);
    throw e;
  }
  removeUploadIfUnused(oldPhoto);
  log(a.tree_id, req.uid, 'merged', `${a.name} into ${b.name}`);
  res.json({ id: b.id });
});

// ---- Relationship integrity: reject links that could never be true ----
const yearOf = d => /^\d{4}/.test(d || '') ? +d.slice(0, 4) : null;
const deathYear = p => p && p.dod && p.dod !== 'unknown' ? yearOf(p.dod) : null;
const marriageYears = (year, end) => {
  const num = v => v === '' || v == null ? null : +v;
  const y = num(year), e = num(end);
  if ([y, e].some(v => v !== null && (!Number.isInteger(v) || v < 1000 || v > 2200))) return { error: 'Enter a four-digit year.' };
  if (y && e && e < y) return { error: 'The end year cannot be before the start year.' };
  return { year: y, end_year: e };
};
const marriageDateError = (year, people) => {
  if (!year) return null;
  for (const p of people) {
    if (!p) continue;
    const by = yearOf(p.dob), dy = deathYear(p);
    if (by && year < by) return `The relationship year cannot be before ${p.name} was born.`;
    if (dy && year > dy) return `The relationship year cannot be after ${p.name} died.`;
  }
  return null;
};
const parentAgeError = (child, parent, kind) => {
  if (!child || !parent || (kind && kind !== 'biological')) return null;
  const cy = yearOf(child.dob), py = yearOf(parent.dob);
  if (cy && py) {
    const age = cy - py;
    if (age < 0) return `${parent.name} was born after ${child.name}.`;
    if (age < 12) return `${parent.name} would have been only ${age} when ${child.name} was born.`;
  }
  const dy = deathYear(parent);
  if (cy && dy && cy > dy + (parent.gender === 'Female' ? 0 : 1)) return `${child.name} was born after ${parent.name} died.`;
  return null;
};
// Is `ancestorId` somewhere above `personId` in this tree? Used to stop parent-child cycles.
const ancestorOf = (treeId, ancestorId, personId) => !!q(`WITH RECURSIVE anc(id) AS (
  SELECT id FROM people WHERE id=? AND tree_id=?
  UNION
  SELECT p.id FROM anc JOIN people c ON c.id=anc.id AND c.tree_id=?
  JOIN marriages m ON m.id=c.parent_marriage_id AND m.tree_id=?
  JOIN people p ON p.id IN (m.a_id,m.b_id) AND p.tree_id=?
) SELECT 1 FROM anc WHERE id=? LIMIT 1`, personId, treeId, treeId, treeId, treeId, ancestorId);
// A last line of defence for bulk operations (merges, imports): refuse a state with self-parents or loops.
const relationshipIntegrityError = treeId => {
  const self = q(`SELECT p.id FROM people p JOIN marriages m ON m.id=p.parent_marriage_id
    WHERE p.tree_id=? AND (m.a_id=p.id OR m.b_id=p.id) LIMIT 1`, treeId);
  if (self) return 'That change would make someone their own parent.';
  const n = q('SELECT COUNT(*) n FROM people WHERE tree_id=?', treeId).n;
  const cycle = q(`WITH RECURSIVE anc(root,id,path,cycle) AS (
      SELECT p.id,p.id,','||p.id||',',0 FROM people p WHERE p.tree_id=? AND p.parent_marriage_id IS NOT NULL
      UNION ALL
      SELECT a.root,x.id,a.path||x.id||',',instr(a.path, ','||x.id||',')>0 FROM anc a
        JOIN people c ON c.id=a.id AND c.tree_id=?
        JOIN marriages m ON m.id=c.parent_marriage_id AND m.tree_id=?
        JOIN people x ON x.id IN (m.a_id,m.b_id) AND x.tree_id=?
        WHERE a.cycle=0 AND length(a.path) < ?
    ) SELECT 1 FROM anc WHERE cycle=1 LIMIT 1`, treeId, treeId, treeId, treeId, n * 3 + 10);
  return cycle ? 'That change would create a parent-child loop.' : null;
};
// Editing dates or the parent link can make an existing relationship impossible; only check when one of
// those actually changes, so legacy records with odd dates can still have names or notes corrected.
const relationshipDateError = (p0, c) => {
  const datesChanged = c.dob !== p0.dob || c.dod !== p0.dod;
  const kindChanged = c.parent_kind != null && c.parent_kind !== p0.parent_kind;
  if (!datesChanged && !kindChanged) return null;
  const np = { ...p0, ...c }, kind = c.parent_kind || p0.parent_kind || 'biological';
  if (p0.parent_marriage_id) {
    const m = q('SELECT * FROM marriages WHERE id=? AND tree_id=?', p0.parent_marriage_id, p0.tree_id);
    if (m) for (const id of [m.a_id, m.b_id]) {
      const err = parentAgeError(np, q('SELECT * FROM people WHERE id=? AND tree_id=?', id, p0.tree_id), kind);
      if (err) return err;
    }
  }
  // A change to the parent link only affects the person's own parents, not their children or marriages.
  if (!datesChanged) return null;
  for (const kid of all(`SELECT p.* FROM people p JOIN marriages m ON p.parent_marriage_id=m.id
      WHERE m.tree_id=? AND (m.a_id=? OR m.b_id=?)`, p0.tree_id, p0.id, p0.id)) {
    const err = parentAgeError(kid, np, kid.parent_kind);
    if (err) return err;
  }
  for (const m of all('SELECT * FROM marriages WHERE tree_id=? AND (a_id=? OR b_id=?)', p0.tree_id, p0.id, p0.id))
    for (const v of [m.year, m.end_year]) {
      const err = marriageDateError(v, [np]);
      if (err) return err;
    }
  return null;
};
app.get('/api/trees/:id/checks', need, (req, res) => {
  const t = ownTree(req, res); if (!t) return;
  const ps = all('SELECT * FROM people WHERE tree_id=?', t.id), ms = all('SELECT * FROM marriages WHERE tree_id=?', t.id), out = [];
  const P = Object.fromEntries(ps.map(p => [p.id, p])), M = Object.fromEntries(ms.map(m => [m.id, m])), year = new Date().getUTCFullYear();
  const add = (level, p, text) => out.push({ level, person: p && { id: p.id, name: p.name }, text });
  for (const p of ps) {
    const by = yearOf(p.dob), m = M[p.parent_marriage_id];
    if (!p.dob) add('info', p, 'No birth date yet.');
    if (by && !p.dod && year - by > 110) add('warning', p, `Marked as alive but would be ${year - by} years old.`);
    if (m && by && p.parent_kind === 'biological') for (const id of [m.a_id, m.b_id].filter(x => x != null)) {
      const par = P[id], py = par && yearOf(par.dob); if (!py) continue;
      const age = by - py, mother = par.gender === 'Female', pd = par.dod && par.dod !== 'unknown' ? yearOf(par.dod) : null;
      if (age < 12) add('warning', p, `${par.name} would have been only ${age} when ${p.name} was born.`);
      else if (age > (mother ? 55 : 80)) add('warning', p, `${par.name} would have been ${age} when ${p.name} was born.`);
      if (pd && by > pd + (mother ? 0 : 1)) add('warning', p, `${p.name} was born after the death of ${par.name}.`);
    }
  }
  for (const m of ms) if (m.year) for (const x of [P[m.a_id], P[m.b_id]].filter(Boolean)) { const by = x && yearOf(x.dob); if (by && m.year - by < 14) add('warning', x, `Married in ${m.year}, when they would have been ${m.year - by}.`); }
  const adj = {}; const link = (x, y) => { if (x == null || y == null || x === y) return; (adj[x] = adj[x] || []).push(y); (adj[y] = adj[y] || []).push(x); };
  ms.forEach(m => link(m.a_id, m.b_id)); ps.forEach(p => { const m = M[p.parent_marriage_id]; if (m) { link(p.id, m.a_id); link(p.id, m.b_id); } });
  const root = treeRoot(t), seen = new Set([root]), stack = [root]; while (stack.length) for (const n of adj[stack.pop()] || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  ps.filter(p => !seen.has(p.id)).slice(0, 20).forEach(p => add('warning', p, 'Not connected to the first person in the tree.'));
  res.json({ issues: out.slice(0, 150), warnings: out.filter(i => i.level === 'warning').length, notes: out.filter(i => i.level === 'info').length });
});

// ---- Sources, documents and a photo album for each person ----
const uploadAtt = multer({
  storage: multer.diskStorage({ destination: UPLOADS, filename: (_, f, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(f.originalname).toLowerCase()) }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, f, cb) => { if (/^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/.test(f.mimetype)) return cb(null, true); req.badUploadType = true; cb(null, false); }
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
  if (req.badUploadType) { discardUpload(req.file); return fail(res, 400, 'That file type is not supported. Choose a PNG, JPG, WEBP, GIF or PDF.'); }
  if (!title) { discardUpload(req.file); return fail(res, 400, 'Give it a title.'); }
  if (url && !/^https?:\/\//i.test(url)) { discardUpload(req.file); return fail(res, 400, 'A web link must start with http:// or https://.'); }
  if (kind === 'photo' && !(req.file && /^image\//.test(req.file.mimetype))) { discardUpload(req.file); return fail(res, 400, 'Choose an image to add to the album.'); }
  if (!req.file && !url && !desc) return fail(res, 400, 'Add a file, a web link, or a description.');
  if (req.file) {
    const check = inspectUpload(req.file, kind === 'photo' ? IMAGE_TYPES : IMAGE_TYPES.concat('pdf'));
    if (check.error) { discardUpload(req.file); return fail(res, 400, check.error); }
  }
  let id;
  try {
    id = db.prepare('INSERT INTO attachments(tree_id,person_id,kind,title,description,url,file) VALUES(?,?,?,?,?,?,?)')
      .run(p.tree_id, p.id, kind, title, desc || null, url || null, req.file ? '/uploads/' + req.file.filename : null).lastInsertRowid;
  } catch (e) { discardUpload(req.file); throw e; }
  log(p.tree_id, req.uid, 'added a ' + kind + ' for', p.name);
  res.json({ id });
});
app.delete('/api/attachments/:id', need, (req, res) => {
  const a = q('SELECT * FROM attachments WHERE id=?', req.params.id);
  if (!a) return fail(res, 404, 'Not found.');
  if (!['owner', 'editor'].includes(roleOf(a.tree_id, req.uid))) return fail(res, 403, 'You do not have permission to edit this tree.');
  db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
  removeUploadIfUnused(a.file);
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
  const email = normEmail((req.body || {}).email);
  const u = validEmail(email) && q('SELECT * FROM users WHERE email=?', email);
  if (u) {
    const raw = crypto.randomBytes(24).toString('hex');
    db.prepare('DELETE FROM resets WHERE expires_at<?').run(Date.now());
    db.prepare('INSERT INTO resets(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(raw), u.id, Date.now() + 3600e3);
    await sendMail(u.email, 'Reset your Family Tree password', `Hello${u.name ? ' ' + u.name : ''},\n\nOpen this link within one hour to choose a new password:\n${process.env.APP_URL || `http://localhost:${PORT}`}/#/reset?token=${raw}\n\nIf you did not ask for this, you can ignore this message.`);
  }
  res.json({ ok: true }); // same answer whether or not the email exists
});
app.post('/api/auth/reset', authFailureGuard('reset'), (req, res) => {
  const body = req.body || {}, r = q('SELECT * FROM resets WHERE token_hash=? AND expires_at>?', sha(String(body.token || '')), Date.now());
  if (!r) { noteAuthFailure(req, 'reset'); return fail(res, 400, 'That reset link has expired or was already used. Ask for a new one.'); }
  const pe = passwordError(body.password); if (pe) { noteAuthFailure(req, 'reset'); return fail(res, 400, pe); }
  db.transaction(() => {
    db.prepare('UPDATE users SET hash=?, tv=tv+1 WHERE id=?').run(bcrypt.hashSync(body.password, 10), r.user_id);
    db.prepare('DELETE FROM resets WHERE user_id=?').run(r.user_id);
  })();
  clearAuthFailures(req, 'reset');
  alog(r.user_id, 'reset password', 'Other sessions were signed out');
  res.json({ ok: true });
});
app.get('/api/me', need, (req, res) => res.json(q('SELECT id,email,name FROM users WHERE id=?', req.uid)));
app.patch('/api/me', need, (req, res) => {
  const nameCheck = cleanName((req.body || {}).name);
  if (nameCheck.error) return fail(res, 400, nameCheck.error);
  db.prepare('UPDATE users SET name=? WHERE id=?').run(nameCheck.name, req.uid);
  alog(req.uid, 'changed name', nameCheck.name);
  res.json({ ok: true });
});
// Changing the login email needs the current password, just like a password change. Other devices are signed out.
app.post('/api/me/email', authFailureGuard('email'), need, (req, res) => {
  const body = req.body || {}, email = normEmail(body.email), u = q('SELECT * FROM users WHERE id=?', req.uid);
  if (typeof body.password !== 'string' || !bcrypt.compareSync(body.password, u.hash)) { noteAuthFailure(req, 'email'); return fail(res, 401, 'Your password is not correct.'); }
  if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
  if (email === u.email) return fail(res, 400, 'That is already your email address.');
  if (q('SELECT id FROM users WHERE email=? AND id<>?', email, u.id)) return fail(res, 409, 'That email is already registered.');
  const nextTv = (u.tv || 0) + 1;
  db.prepare('UPDATE users SET email=?, tv=? WHERE id=?').run(email, nextTv, u.id);
  alog(u.id, 'changed email', `${u.email} to ${email}`);
  clearAuthFailures(req, 'email');
  res.json({ token: token({ id: u.id, tv: nextTv }), email });
});
app.get('/api/me/activity', need, (req, res) => res.json(all('SELECT action,detail,at FROM account_audit WHERE user_id=? ORDER BY id DESC LIMIT 50', req.uid)));
app.post('/api/me/password', authFailureGuard('password'), need, (req, res) => {
  const body = req.body || {}, u = q('SELECT * FROM users WHERE id=?', req.uid);
  const current = body.current;
  if (typeof current !== 'string' || !bcrypt.compareSync(current, u.hash)) {
    noteAuthFailure(req, 'password');
    return fail(res, 401, 'Your current password is not correct.');
  }
  const pe = passwordError(body.password); if (pe) return fail(res, 400, pe);
  const nextTv = (u.tv || 0) + 1;
  db.transaction(() => {
    db.prepare('UPDATE users SET hash=?, tv=? WHERE id=?').run(bcrypt.hashSync(body.password, 10), nextTv, u.id);
    db.prepare('DELETE FROM resets WHERE user_id=?').run(u.id);
  })();
  clearAuthFailures(req, 'password');
  alog(u.id, 'changed password', 'Other sessions were signed out');
  res.json({ token: token({ id: u.id, tv: nextTv }) }); // other devices are signed out; this one stays in
});
app.delete('/api/me', need, (req, res) => {
  const u = q('SELECT * FROM users WHERE id=?', req.uid), password = (req.body || {}).password;
  if (typeof password !== 'string' || !bcrypt.compareSync(password, u.hash)) return fail(res, 401, 'Your password is not correct.');
  const files = uploadPathsForUser(u.id);
  db.transaction(() => { db.prepare('DELETE FROM trees WHERE owner_id=?').run(u.id); db.prepare('DELETE FROM users WHERE id=?').run(u.id); })();
  files.forEach(removeUploadIfUnused);
  res.json({ ok: true });
});

// ---- Collaborators (family group): owner invites people as editor or viewer ----
app.get('/api/trees/:id/members', need, (req, res) => {
  if (!ownTree(req, res, 'owner')) return;
  res.json(all('SELECT u.id,u.email,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.tree_id=? ORDER BY u.email', req.params.id));
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
// Pending invitations work for people who have not signed up yet. The raw token is only sent by email;
// the database stores its hash, so a copied database cannot be used to join a tree.
const INVITE_DAYS = 14;
const inviteExpiry = () => Date.now() + INVITE_DAYS * 24 * 3600e3;
app.get('/api/trees/:id/invites', need, (req, res) => {
  const t = ownTree(req, res, 'owner'); if (!t) return;
  res.json(all(`SELECT id,email,role,created_at,expires_at,accepted_at,declined_at FROM invites
    WHERE tree_id=? ORDER BY id DESC LIMIT 100`, t.id).map(i => ({ ...i, expired: i.expires_at <= Date.now(), pending: !i.accepted_at && !i.declined_at && i.expires_at > Date.now() })));
});
app.post('/api/trees/:id/invites', need, async (req, res) => {
  const t = ownTree(req, res, 'owner'); if (!t) return;
  const email = normEmail((req.body || {}).email), role = (req.body || {}).role;
  if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
  if (!['editor', 'viewer'].includes(role)) return fail(res, 400, 'Choose editor or viewer.');
  const u = q('SELECT id,email FROM users WHERE email=?', email);
  if (u && u.id === t.owner_id) return fail(res, 400, 'That person already owns this tree.');
  if (u) {
    const already = q('SELECT role FROM members WHERE tree_id=? AND user_id=?', t.id, u.id);
    if (already && already.role === role) return fail(res, 409, 'They already have that role in this tree.');
    db.prepare('INSERT INTO members(tree_id,user_id,role) VALUES(?,?,?) ON CONFLICT(tree_id,user_id) DO UPDATE SET role=excluded.role').run(t.id, u.id, role);
    log(t.id, req.uid, 'invited', `${email} as ${role}`);
    return res.json({ ok: true, member: true });
  }
  const now = Date.now(), existing = q(`SELECT * FROM invites WHERE tree_id=? AND email=? AND accepted_at IS NULL AND declined_at IS NULL AND expires_at>?`, t.id, email, now);
  if (existing) return fail(res, 409, 'An invitation is already waiting for that email address.');
  const raw = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO invites(tree_id,email,role,token_hash,invited_by,expires_at) VALUES(?,?,?,?,?,?)').run(t.id, email, role, sha(raw), req.uid, inviteExpiry());
  log(t.id, req.uid, 'invited', `${email} as ${role} (invitation sent)`);
  const link = `${process.env.APP_URL || `http://localhost:${PORT}`}/#/invite?token=${raw}`;
  await sendMail(email, `You are invited to ${t.name}`, `Hello,\n\n${q('SELECT name FROM users WHERE id=?', req.uid).name || 'Someone'} invited you to help with the family tree “${t.name}” as ${role}.\n\nOpen this link within ${INVITE_DAYS} days:\n${link}\n\nIf you were not expecting this, you can ignore this message.`);
  res.json({ ok: true, invited: true });
});
app.delete('/api/trees/:id/invites/:inviteId', need, (req, res) => {
  const t = ownTree(req, res, 'owner'); if (!t) return;
  db.prepare('DELETE FROM invites WHERE id=? AND tree_id=? AND accepted_at IS NULL').run(req.params.inviteId, t.id);
  res.json({ ok: true });
});
// Public status for the invitation page (no token hash or owner details are exposed).
app.get('/api/invites/:token', (req, res) => {
  const i = q('SELECT * FROM invites WHERE token_hash=?', sha(String(req.params.token || '')));
  if (!i) return fail(res, 404, 'That invitation was not found.');
  const t = q('SELECT id,name FROM trees WHERE id=?', i.tree_id);
  if (!t) return fail(res, 404, 'That invitation is no longer available.');
  const status = i.accepted_at ? 'accepted' : i.declined_at ? 'declined' : i.expires_at <= Date.now() ? 'expired' : 'pending';
  res.json({ status, tree: { id: t.id, name: t.name }, role: i.role, email: i.email.replace(/^(.).*?(.?@)/, '$1***$2'), expires_at: i.expires_at });
});
const inviteFor = (req, token) => {
  const i = q('SELECT * FROM invites WHERE token_hash=?', sha(String(token || '')));
  if (!i) return { error: [404, 'That invitation was not found.'] };
  if (i.accepted_at) return { error: [409, 'That invitation has already been accepted.'] };
  if (i.declined_at) return { error: [409, 'That invitation was declined.'] };
  if (i.expires_at <= Date.now()) return { error: [410, 'That invitation has expired. Ask the owner for a new one.'] };
  const u = q('SELECT * FROM users WHERE id=?', req.uid);
  if (!u || normEmail(u.email) !== i.email) return { error: [403, `This invitation was sent to ${i.email}. Log in with that email address to accept it.`] };
  const t = q('SELECT * FROM trees WHERE id=?', i.tree_id);
  if (!t) return { error: [404, 'That tree is no longer available.'] };
  return { invite: i, tree: t, user: u };
};
app.post('/api/invites/accept', need, (req, res) => {
  const f = inviteFor(req, (req.body || {}).token); if (f.error) return fail(res, ...f.error);
  const { invite, tree } = f;
  db.transaction(() => {
    db.prepare('INSERT INTO members(tree_id,user_id,role) VALUES(?,?,?) ON CONFLICT(tree_id,user_id) DO UPDATE SET role=excluded.role').run(tree.id, req.uid, invite.role);
    db.prepare('UPDATE invites SET accepted_at=? WHERE id=?').run(Date.now(), invite.id);
  })();
  log(tree.id, req.uid, 'accepted an invitation', invite.role);
  res.json({ ok: true, tree: { id: tree.id, name: tree.name }, role: invite.role });
});
app.post('/api/invites/decline', need, (req, res) => {
  const f = inviteFor(req, (req.body || {}).token); if (f.error) return fail(res, ...f.error);
  db.prepare('UPDATE invites SET declined_at=? WHERE id=?').run(Date.now(), f.invite.id);
  res.json({ ok: true });
});
// Change a member's role (owner only).
app.patch('/api/trees/:id/members/:uid', need, (req, res) => {
  const t = ownTree(req, res, 'owner'); if (!t) return;
  const role = (req.body || {}).role;
  if (!['editor', 'viewer'].includes(role)) return fail(res, 400, 'Choose editor or viewer.');
  const u = q('SELECT id FROM users WHERE id=?', req.params.uid);
  if (!u) return fail(res, 404, 'Member not found.');
  if (u.id === t.owner_id) return fail(res, 400, 'The owner keeps full access.');
  if (!q('SELECT 1 FROM members WHERE tree_id=? AND user_id=?', t.id, u.id)) return fail(res, 404, 'Member not found.');
  db.prepare('UPDATE members SET role=? WHERE tree_id=? AND user_id=?').run(role, t.id, u.id);
  log(t.id, req.uid, 'changed a member role', `${u.email} is now ${role}`);
  res.json({ ok: true });
});
app.delete('/api/trees/:id/members/:uid', need, (req, res) => {
  const t = q('SELECT * FROM trees WHERE id=?', req.params.id);
  if (!t) return fail(res, 404, 'Tree not found.');
  const r = roleOf(t.id, req.uid), target = Number(req.params.uid);
  if (r !== 'owner' && !(r && target === req.uid)) return fail(res, 403, 'Only the tree owner can do that.');
  if (target === t.owner_id) return fail(res, 400, 'The owner cannot be removed. Transfer ownership first.');
  const removed = db.prepare('DELETE FROM members WHERE tree_id=? AND user_id=?').run(t.id, target).changes;
  if (!removed) return fail(res, 404, 'Member not found.');
  log(t.id, req.uid, target === req.uid ? 'left the tree' : 'removed a member', String(target));
  res.json({ ok: true });
});
// Move ownership to a current editor/viewer. The old owner becomes an editor so they do not lose access.
app.post('/api/trees/:id/owner', need, (req, res) => {
  const t = ownTree(req, res, 'owner'); if (!t) return;
  const email = normEmail((req.body || {}).email), user_id = (req.body || {}).user_id;
  const u = email ? q('SELECT * FROM users WHERE email=?', email) : user_id != null ? q('SELECT * FROM users WHERE id=?', user_id) : null;
  if (!u) return fail(res, 404, 'That person does not have an account.');
  if (u.id === t.owner_id) return fail(res, 400, 'You already own this tree.');
  const member = q('SELECT role FROM members WHERE tree_id=? AND user_id=?', t.id, u.id);
  if (!member) return fail(res, 400, 'Add them to the tree before making them the owner.');
  db.transaction(() => {
    db.prepare('UPDATE trees SET owner_id=? WHERE id=?').run(u.id, t.id);
    db.prepare('INSERT INTO members(tree_id,user_id,role) VALUES(?,?,?) ON CONFLICT(tree_id,user_id) DO UPDATE SET role=excluded.role').run(t.id, t.owner_id, 'editor');
    db.prepare('DELETE FROM members WHERE tree_id=? AND user_id=?').run(t.id, u.id);
  })();
  log(t.id, req.uid, 'transferred ownership', u.email);
  res.json({ ok: true });
});

// ---- Change history (who changed what) ----
app.get('/api/trees/:id/history', need, (req, res) => {
  if (!ownTree(req, res)) return;
  const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  const where = ['a.tree_id=?'], args = [req.params.id];
  if (req.query.action) { where.push('a.action LIKE ?'); args.push('%' + String(req.query.action).slice(0, 80) + '%'); }
  if (req.query.user) { where.push('(u.email LIKE ? OR u.name LIKE ?)'); args.push('%' + String(req.query.user).slice(0, 80) + '%', '%' + String(req.query.user).slice(0, 80) + '%'); }
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? req.query.to : null;
  if (from) { where.push('substr(a.at,1,10)>=?'); args.push(from); }
  if (to) { where.push('substr(a.at,1,10)<=?'); args.push(to); }
  const total = q(`SELECT COUNT(*) n FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE ${where.join(' AND ')}`, ...args).n;
  res.set('X-Total-Count', String(total)).json(all(`SELECT a.action,a.detail,a.at,u.name,u.email FROM audit a LEFT JOIN users u ON u.id=a.user_id
    WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset));
});

// ---- Ancestors and descendants via recursive CTEs, depth-capped so huge trees stay cheap ----
app.get('/api/people/:id/relatives', (req, res) => {
  const p = q('SELECT * FROM people WHERE id=?', req.params.id), t = p && q('SELECT * FROM trees WHERE id=?', p.tree_id);
  if (!p || (!roleOf(t.id, uid(req)) && t.visibility !== 'link')) return fail(res, 404, 'Person not found.');
  const d = depthParam(req, res, 6, 1, 10); if (d === null) return;
  const ancestors = all(`WITH RECURSIVE a(id,gen) AS (SELECT ?,0 UNION ALL
    SELECT x.id, a.gen+1 FROM a JOIN people c ON c.id=a.id AND c.tree_id=? JOIN marriages m ON m.id=c.parent_marriage_id AND m.tree_id=?
    JOIN people x ON x.id IN (m.a_id,m.b_id) AND x.tree_id=? WHERE a.gen<?)
    SELECT p.id,p.name,a.gen FROM a JOIN people p ON p.id=a.id AND p.tree_id=? WHERE a.gen>0 ORDER BY a.gen`, p.id, t.id, t.id, t.id, d, t.id);
  const descendants = all(`WITH RECURSIVE d(id,gen) AS (SELECT ?,0 UNION ALL
    SELECT k.id, d.gen+1 FROM d JOIN marriages m ON d.id IN (m.a_id,m.b_id) AND m.tree_id=?
    JOIN people k ON k.parent_marriage_id=m.id AND k.tree_id=? WHERE d.gen<?)
    SELECT p.id,p.name,d.gen FROM d JOIN people p ON p.id=d.id AND p.tree_id=? WHERE d.gen>0 ORDER BY d.gen`, p.id, t.id, t.id, d, t.id);
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
const gedVal = node => {
  if (!node) return '';
  let s = node.val || '';
  for (const k of node.kids || []) {
    if (k.tag === 'CONT') s += '\n' + gedVal(k);
    else if (k.tag === 'CONC') s += gedVal(k);
  }
  return s;
};
const parseDate = s => {
  if (!s) return null;
  let qual = null, t = s.trim().toUpperCase();
  const range = t.match(/^(?:BET|BETWEEN)\s+(.+?)\s+AND\s+(.+)$/);
  if (range) t = range[1];
  else { const from = t.match(/^FROM\s+(.+)$/); if (from) { qual = 'after'; t = from[1]; } const to = t.match(/^TO\s+(.+)$/); if (to) { qual = 'before'; t = to[1]; } }
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
      const nm = (gedVal(sub(r, 'NAME')) || '').replace(/\//g, ' ').replace(/\s+/g, ' ').trim() || 'Unknown';
      const sx = (sub(r, 'SEX') || {}).val, birt = dateOf(sub(r, 'BIRT')), deat = sub(r, 'DEAT'), dd = dateOf(deat);
      const plac = n => { const x = n && sub(n, 'PLAC'); return x ? gedVal(x).replace(/\s+/g, ' ').slice(0, 120) : null; }, note = sub(r, 'NOTE');
      const c = { name: nm, gender: sx === 'M' ? 'Male' : sx === 'F' ? 'Female' : null, dob: birt ? birt.d : '', dob_q: birt && birt.q,
        dod: deat ? (dd ? dd.d : 'unknown') : null, dod_q: dd && dd.q, birth_place: plac(sub(r, 'BIRT')), death_place: plac(deat), notes: note ? gedVal(note).slice(0, 4000) : null };
      const hit = q(`SELECT id,ext_id FROM people WHERE tree_id=? AND (ext_id=? OR (?<>'' AND name=? AND dob=?)) ORDER BY ext_id=? DESC`, tid, r.xref, c.dob, c.name, c.dob, r.xref);
      if (hit) { out.map[r.xref] = hit.id; out.existing++; if (!hit.ext_id) db.prepare('UPDATE people SET ext_id=? WHERE id=?').run(r.xref, hit.id); }
      else { out.map[r.xref] = addPerson(tid, c, null, r.xref); out.added++; }
    }
    for (const f of fams) {
      const h = out.map[(sub(f, 'HUSB') || {}).val], w = out.map[(sub(f, 'WIFE') || {}).val];
      const kids = f.kids.filter(k => k.tag === 'CHIL').map(k => [out.map[k.val], k.val]).filter(x => x[0]);
      let m = q('SELECT * FROM marriages WHERE tree_id=? AND ext_id=?', tid, f.xref), a = h, b = w;
      if (!m) {
        if (!a && !b) { if (kids.length) out.notes.push('A family with children but no parents was skipped.'); continue; }
        if (a && b && a === b) { out.notes.push('A person was listed as their own spouse and was skipped.'); continue; }
        m = q('SELECT * FROM marriages WHERE tree_id=? AND ((a_id IS ? AND b_id IS ?) OR (a_id IS ? AND b_id IS ?))', tid, a || null, b || null, b || null, a || null);
        if (!m) {
          const my = dateOf(sub(f, 'MARR')), dv = sub(f, 'DIV'), mt = sub(f, 'MARR') && sub(sub(f, 'MARR'), 'TYPE'), dy = dv && dateOf(dv);
          const kind = !a || !b ? 'single' : dv ? 'divorced' : mt && ['partner', 'separated'].includes(gedVal(mt).toLowerCase()) ? gedVal(mt).toLowerCase() : 'married';
          const years = marriageYears(my ? +my.d.slice(0, 4) : null, dy ? +dy.d.slice(0, 4) : null);
          let year = years.year, endYear = years.end_year;
          const aP = a ? q('SELECT * FROM people WHERE id=? AND tree_id=?', a, tid) : null, bP = b ? q('SELECT * FROM people WHERE id=? AND tree_id=?', b, tid) : null;
          const dateErr = years.error || marriageDateError(year, [aP, bP]) || marriageDateError(endYear, [aP, bP]);
          if (dateErr) { out.notes.push('A relationship had impossible dates, so its years were not imported.'); year = endYear = null; }
          m = { id: db.prepare('INSERT INTO marriages(tree_id,a_id,b_id,year,ext_id,kind,end_year) VALUES(?,?,?,?,?,?,?)').run(tid, a || null, b || null, year, f.xref, kind, endYear).lastInsertRowid, a_id: a || null, b_id: b || null };
          out.families++;
        }
      }
      for (const [kid, xr] of kids) {
        const existing = q('SELECT parent_marriage_id FROM people WHERE id=? AND tree_id=?', kid, tid);
        if (!existing || existing.parent_marriage_id != null) continue;
        if (kid === m.a_id || kid === m.b_id || (m.a_id != null && ancestorOf(tid, kid, m.a_id)) || (m.b_id != null && ancestorOf(tid, kid, m.b_id))) {
          out.notes.push('A parent-child cycle was skipped.'); continue;
        }
        const fc = byX[xr] && sub(byX[xr], 'FAMC'), pd = fc && sub(fc, 'PEDI'), pk = pd ? { adopted: 'adopted', foster: 'foster', step: 'step' }[gedVal(pd).toLowerCase()] : null;
        const kind = pk || 'biological', child = q('SELECT * FROM people WHERE id=? AND tree_id=?', kid, tid);
        let ageErr = null;
        for (const id of [m.a_id, m.b_id].filter(x => x != null)) { ageErr = parentAgeError(child, q('SELECT * FROM people WHERE id=? AND tree_id=?', id, tid), kind); if (ageErr) break; }
        if (ageErr) { out.notes.push(ageErr); continue; }
        db.prepare('UPDATE people SET parent_marriage_id=?,parent_kind=? WHERE id=? AND parent_marriage_id IS NULL').run(m.id, kind, kid);
      }
    }
    // Inline OBJE/SOUR records become attachments. Only titles, links and text are restored; a referenced
    // local file is kept only when the exact basename already exists in the uploads folder.
    const addAtt = (personId, kind, title, description, url, file) => {
      if (!personId || !title) return;
      if (q('SELECT id FROM attachments WHERE person_id=? AND kind=? AND title=? AND COALESCE(url,\'\')=? AND COALESCE(file,\'\')=?', personId, kind, title, url || '', file || '')) return;
      db.prepare('INSERT INTO attachments(tree_id,person_id,kind,title,description,url,file) VALUES(?,?,?,?,?,?,?)').run(tid, personId, kind, title, description || null, url || null, file || null);
    };
    for (const r of indis) {
      const personId = out.map[r.xref]; if (!personId) continue;
      for (const o of r.kids.filter(k => k.tag === 'OBJE')) {
        const fileNode = sub(o, 'FILE'), title = (gedVal(sub(o, 'TITL')) || (fileNode && gedVal(fileNode)) || 'Attached file').replace(/\s+/g, ' ').slice(0, 160);
        const name = fileNode ? path.basename(gedVal(fileNode).replace(/\\/g, '/')) : '', file = name && fs.existsSync(path.join(UPLOADS, name)) ? '/uploads/' + name : null;
        addAtt(personId, 'photo', title, gedVal(sub(o, 'NOTE')).slice(0, 2000), null, file);
      }
      for (const o of r.kids.filter(k => k.tag === 'SOUR')) {
        const title = (gedVal(sub(o, 'TITL')) || 'Source').replace(/\s+/g, ' ').slice(0, 160), u = gedVal(sub(o, 'WWW') || sub(o, 'URL'));
        addAtt(personId, 'source', title, gedVal(sub(o, 'NOTE')).slice(0, 2000), /^https?:\/\//i.test(u) ? u : null, null);
      }
    }
  })();
  return out;
};
const gedText = express.text({ type: () => true, limit: '5mb' });
app.get('/api/attachments/:id/file', function(req,res){
  const a = q('SELECT * FROM attachments WHERE id=?', req.params.id);
  if(!a) return res.status(404).end();
  const person = q('SELECT * FROM people WHERE id=?', a.person_id);
  const t = person && q('SELECT * FROM trees WHERE id=?', person.tree_id);
  if(!person || !t) return res.status(404).end();
  const role = roleOf(t.id, uid(req));
  if(!role){
    if(t.visibility !== 'link') return res.status(404).end();
    if(!person.dod && t.hide_living) return res.status(404).end();
  }
  sendUpload(res, a.file);
});
app.post('/api/trees/import', need, gedText, (req, res) => { // new tree from a GEDCOM file; its first top ancestor becomes the first person
  const name = String(req.query.name || '').trim();
  if (!name) return fail(res, 400, 'Give your family tree a name.');
  try {
    const id = db.transaction(() => {
      const tid = db.prepare('INSERT INTO trees(owner_id,name) VALUES(?,?)').run(req.uid, name).lastInsertRowid;
      const out = importInto(tid, String(req.body || ''));
      if (!out.indis.length) {
        const empty = new Error('No people found. Choose a GEDCOM (.ged) file.'); empty.safeMessage = true; throw empty;
      }
      const has = (i, tag) => i.kids.some(k => k.tag === tag);
      const top = out.indis.find(i => has(i, 'FAMS') && !has(i, 'FAMC')) || out.indis[0];
      db.prepare('UPDATE trees SET root_id=? WHERE id=?').run(out.map[top.xref], tid);
      log(tid, req.uid, 'imported a GEDCOM file', `${out.added} people`);
      return tid;
    })();
    res.json({ id });
  } catch (e) {
    if (!e || !e.safeMessage) console.error('GEDCOM import failed:', e && e.stack || e);
    fail(res, 400, e && e.safeMessage ? e.message : 'That GEDCOM file could not be imported. Check that it is a valid .ged file.');
  }
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
// Values are user content: never let a newline (or other control character) start a new GEDCOM record.
const gedClean = v => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const gedOne = v => gedClean(v).replace(/\s+/g, ' ').trim();
const gedChunks = (s, n) => (s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) || []);
// Long text uses NOTE + CONT for new lines and CONC for over-long lines, as GEDCOM expects.
const gedLong = (lvl, tag, value) => {
  const text = gedClean(value).replace(/\s+$/g, '');
  if (!text) return [`${lvl} ${tag}`];
  const lines = text.split('\n'), out = [], first = gedChunks(lines[0], 180);
  out.push(`${lvl} ${tag}${first.length ? ' ' + first[0] : ''}`);
  for (const part of first.slice(1)) out.push(`${lvl + 1} CONC ${part}`);
  for (const line of lines.slice(1)) {
    const parts = gedChunks(line, 180);
    if (!parts.length) { out.push(`${lvl + 1} CONT`); continue; }
    out.push(`${lvl + 1} CONT ${parts[0]}`);
    for (const part of parts.slice(1)) out.push(`${lvl + 2} CONC ${part}`);
  }
  return out;
};
app.get('/api/trees/:id/export.ged', need, (req, res) => {
  const t = ownTree(req, res); if (!t) return;
  const hide = req.query.hideLiving === '1';
  const ps = all('SELECT * FROM people WHERE tree_id=?', t.id), ms = all('SELECT * FROM marriages WHERE tree_id=?', t.id);
  const atts = all('SELECT * FROM attachments WHERE tree_id=? ORDER BY id', t.id);
  const byPerson = {};
  atts.forEach(a => { (byPerson[a.person_id] = byPerson[a.person_id] || []).push(a); });
  const L = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '2 FORM LINEAGE-LINKED', '1 CHAR UTF-8', '1 SOUR FAMILYTREEAPP'];
  for (const p of ps) {
    const priv = hide && !p.dod, w = gedOne(p.name).split(/\s+/).filter(Boolean), sur = w.length > 1 ? w.pop() : '', given = w.join(' ');
    L.push(`0 @I${p.id}@ INDI`, `1 NAME ${priv ? 'Living' : given} /${priv ? '' : sur}/`, `1 SEX ${p.gender === 'Male' ? 'M' : p.gender === 'Female' ? 'F' : 'U'}`);
    if (!priv) {
      const b = gedDate(p.dob, p.dob_q), d = gedDate(p.dod, p.dod_q), bp = gedOne(p.birth_place), dp = gedOne(p.death_place);
      if (b || bp) L.push('1 BIRT', ...(b ? [`2 DATE ${b}`] : []), ...(bp ? [`2 PLAC ${bp}`] : []));
      if (p.dod) L.push(d || dp ? '1 DEAT' : '1 DEAT Y', ...(d ? [`2 DATE ${d}`] : []), ...(dp ? [`2 PLAC ${dp}`] : []));
      if (p.notes) L.push(...gedLong(1, 'NOTE', p.notes));
      for (const a of byPerson[p.id] || []) {
        const title = gedOne(a.title).slice(0, 160), desc = a.description ? String(a.description).trim() : '', url = a.url && /^https?:\/\//i.test(a.url) ? gedOne(a.url) : '';
        if (a.kind === 'source') {
          L.push('1 SOUR', ...(title ? [`2 TITL ${title}`] : []), ...(url ? [`2 WWW ${url}`] : []), ...(desc ? gedLong(2, 'NOTE', desc) : []));
        } else {
          const file = a.file ? 'uploads/' + path.basename(a.file) : '';
          L.push('1 OBJE', ...(file ? [`2 FILE ${file}`] : []), ...(title ? [`2 TITL ${title}`] : []), ...(desc ? gedLong(2, 'NOTE', desc) : []));
        }
      }
      if (p.photo) L.push('1 OBJE', `2 FILE uploads/${path.basename(p.photo)}`);
    }
    ms.filter(m => m.a_id === p.id || m.b_id === p.id).forEach(m => L.push(`1 FAMS @F${m.id}@`));
    if (p.parent_marriage_id) L.push(`1 FAMC @F${p.parent_marriage_id}@`, ...(p.parent_kind && p.parent_kind !== 'biological' ? [`2 PEDI ${p.parent_kind}`] : []));
  }
  const byId = Object.fromEntries(ps.map(p => [p.id, p]));
  for (const m of ms) {
    // A one-parent family only writes the parent that exists; no placeholder people are invented.
    let h = m.a_id != null ? byId[m.a_id] : null, w = m.b_id != null ? byId[m.b_id] : null;
    if (h && w) { if (h.gender === 'Female' || w.gender === 'Male') [h, w] = [w, h]; }
    else if (h && h.gender === 'Female') { w = h; h = null; }
    else if (w && w.gender === 'Male') { h = w; w = null; }
    L.push(`0 @F${m.id}@ FAM`);
    if (h) L.push(`1 HUSB @I${h.id}@`);
    if (w) L.push(`1 WIFE @I${w.id}@`);
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
  if (spouse_of != null && parent_marriage_id != null) return fail(res, 400, 'Choose one: this person is either a spouse or a child, not both.');
  const spouse = spouse_of ? q('SELECT * FROM people WHERE id=? AND tree_id=?', spouse_of, t.id) : null;
  if (spouse_of && !spouse) return fail(res, 400, 'Spouse not found in this tree.');
  const pm = parent_marriage_id ? q('SELECT * FROM marriages WHERE id=? AND tree_id=?', parent_marriage_id, t.id) : null;
  if (parent_marriage_id && !pm) return fail(res, 400, 'Marriage not found in this tree.');
  const years = marriageYears(year, req.body.end_year);
  if (spouse && years.error) return fail(res, 400, years.error);
  if (spouse && req.body.kind === 'single') return fail(res, 400, 'A single-parent family needs one parent.');
  if (spouse) {
    const np = { name: c.name, gender: c.gender, dob: c.dob, dod: c.dod };
    const dateErr = marriageDateError(years.year, [spouse, np]) || marriageDateError(years.end_year, [spouse, np]);
    if (dateErr) return fail(res, 400, dateErr);
  }
  if (pm) for (const id of [pm.a_id, pm.b_id]) {
    const ageErr = parentAgeError({ name: c.name, dob: c.dob, dod: c.dod }, q('SELECT * FROM people WHERE id=? AND tree_id=?', id, t.id), c.parent_kind);
    if (ageErr) return fail(res, 400, ageErr);
  }
  const id = db.transaction(() => {
    const pid = addPerson(t.id, c, spouse_of ? null : parent_marriage_id);
    if (spouse_of) db.prepare('INSERT INTO marriages(tree_id,a_id,b_id,year,kind,end_year) VALUES(?,?,?,?,?,?)').run(t.id, spouse_of, pid, years.year, MK.includes(req.body.kind) ? req.body.kind : 'married', years.end_year);
    return pid;
  })();
  log(t.id, req.uid, spouse_of ? 'added a spouse' : parent_marriage_id ? 'added a child' : 'added a person', c.name);
  res.json({ id });
});
app.put('/api/people/:id', need, (req, res) => {
  const p0 = ownPerson(req, res); if (!p0) return;
  // `base` makes PUT behave like a partial update: omitted fields keep their stored value,
  // while an explicit empty value still clears an optional field.
  const c = clean(req.body, false, p0); if (c.error) return fail(res, 400, c.error);
  const dateErr = relationshipDateError(p0, c);
  if (dateErr) return fail(res, 400, dateErr);
  db.prepare('UPDATE people SET name=?,gender=?,dob=?,dod=?,dob_q=?,dod_q=?,birth_place=?,death_place=?,notes=?,parent_kind=? WHERE id=?')
    .run(c.name, c.gender, c.dob, c.dod, c.dob_q, c.dod_q, c.birth_place, c.death_place, c.notes, c.parent_kind || 'biological', req.params.id);
  log(p0.tree_id, req.uid, 'edited', c.name);
  res.json(derive(q('SELECT * FROM people WHERE id=?', req.params.id)));
});
app.delete('/api/people/:id', need, (req, res) => {
  const p = ownPerson(req, res); if (!p) return;
  if (q('SELECT id FROM trees WHERE root_id=?', p.id)) return fail(res, 409, 'The first person in a tree cannot be removed. Delete the tree instead.');
  const kids = q(`SELECT COUNT(*) n FROM people WHERE parent_marriage_id IN (SELECT id FROM marriages WHERE a_id=? OR b_id=?)`, p.id, p.id).n;
  if (kids) return fail(res, 409, 'Remove their children first.');
  const files = uploadPathsForPerson(p.id);
  db.prepare('DELETE FROM people WHERE id=?').run(p.id);
  files.forEach(removeUploadIfUnused);
  log(p.tree_id, req.uid, 'removed', p.name);
  res.json({ ok: true });
});

// ---- Profile pictures ----
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOADS,
    filename: (_, f, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(f.originalname).toLowerCase()) }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, f, cb) => { if (/^image\/(png|jpe?g|webp|gif)$/.test(f.mimetype)) return cb(null, true); req.badUploadType = true; cb(null, false); }
});
app.post('/api/people/:id/photo', need, (req, res, next) => { if (!ownPerson(req, res)) return; next(); }, upload.single('photo'), (req, res) => {
  if (req.badUploadType) { discardUpload(req.file); return fail(res, 400, 'Choose a PNG, JPG, WEBP or GIF image under 3 MB.'); }
  if (!req.file) return fail(res, 400, 'Choose a PNG, JPG, WEBP or GIF image under 3 MB.');
  const check = inspectUpload(req.file, IMAGE_TYPES);
  if (check.error) { discardUpload(req.file); return fail(res, 400, check.error); }
  const old = q('SELECT photo FROM people WHERE id=?', req.params.id);
  try {
    db.prepare('UPDATE people SET photo=? WHERE id=?').run('/uploads/' + req.file.filename, req.params.id);
  } catch (e) { discardUpload(req.file); throw e; }
  if (old && old.photo) removeUploadIfUnused(old.photo);
  res.json({ photo: '/uploads/' + req.file.filename });
});
app.get('/api/people/:id/photo', (req, res) => {
  const p = q('SELECT * FROM people WHERE id=?', req.params.id);
  const t = p && q('SELECT * FROM trees WHERE id=?', p.tree_id);
  if (!p || !t) return res.status(404).end();
  const role = roleOf(t.id, uid(req));
  if (!role) {
    if (t.visibility !== 'link') return res.status(404).end();
    if (!p.dod && t.hide_living) return res.status(404).end();
  }
  sendUpload(res, p.photo);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON in the request body.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  if (err instanceof multer.MulterError) {
    if (err.code !== 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'That upload could not be accepted.' });
    const attachments = String(req.originalUrl || '').includes('/attachments');
    return res.status(400).json({ error: attachments ? 'That file is too large (maximum 5 MB).' : 'That image is too large (maximum 3 MB).' });
  }
  if (err && err.expose === true && Number(err.status) >= 400 && Number(err.status) < 500) {
    return res.status(Number(err.status)).json({ error: 'That request could not be accepted.' });
  }
  console.error('Unhandled request error:', req.method, req.originalUrl, err && err.stack || err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
};
app.use(errorHandler);

// ---- Demo data (development, or when SEED_DEMO=1): demo@family.test / demo1234 ----
if (DEMO_ENABLED && !q('SELECT id FROM users LIMIT 1')) {
  const u = db.prepare('INSERT INTO users(email,name,hash) VALUES(?,?,?)').run(DEMO_EMAIL, 'Demo', bcrypt.hashSync('demo1234', 10)).lastInsertRowid;
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
module.exports.errorHandler = errorHandler;
