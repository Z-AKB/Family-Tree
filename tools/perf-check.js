// Performance benchmark for the Family Tree app.
//
// Creates isolated trees with 100, 500 and 1000 people in a disposable database,
// then measures:
//   - backend latency for the main tree load, full tree payload, insights, search,
//     chart-depth payloads, a person branch, a pedigree, and a relationship query
//   - browser time-to-render in real Chrome for the tree, person, chart and insights views
//
// Reports medians, p95 and maxima, writes perf-report.json, and exits non-zero if
// a budget is exceeded. Budgets are generous audit ceilings, not product SLAs.
//
// Run: node tools/perf-check.js
//      BASE=... node tools/perf-check.js   (use an already-running app instead;
//                                           no seeding/cleanup is done then)

const fs = require('fs');
const os = require('os');
const path = require('path');

const USE_EXISTING = !!process.env.BASE;
const BUDGET = {
  backend: {
    'tree-depth2': { median: 600, p95: 1200 },
    'tree-full': { median: 1200, p95: 2500 },
    insights: { median: 1200, p95: 2500 },
    search: { median: 600, p95: 1200 },
    'chart-depth6': { median: 1800, p95: 3500 },
    'person-branch': { median: 600, p95: 1200 },
    'person-pedigree': { median: 600, p95: 1200 },
    'related': { median: 1200, p95: 2500 },
  },
  browser: {
    tree: { median: 3500, p95: 6000 },
    person: { median: 3500, p95: 6000 },
    chart: { median: 5000, p95: 8000 },
    insights: { median: 3000, p95: 5000 },
  },
};
const SIZES = [100, 500, 1000];
const MEASURED = 10;
const WARMUP = 3;
const BROWSER_MEASURED = 5;
const BROWSER_WARMUP = 2;

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function p95(xs) {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)];
}
function max(xs) { return Math.max(...xs); }
function round(x) { return Math.round(x * 10) / 10; }

(async () => {
  let srv = null, base = process.env.BASE, db = null, dataDir = null, browser = null, exitCode = 0;
  const Chrome = (() => {
    try { return require('playwright-core').chromium; } catch { return null; }
  })();
  const chromePaths = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const executablePath = chromePaths.find(p => { try { return fs.existsSync(p); } catch { return false; } });

  try {
    if (!USE_EXISTING) {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-perf-'));
      process.env.DB = path.join(dataDir, 'family.db');
      process.env.DATA_DIR = dataDir;
      process.env.AUTH_LIMIT = '1000';
      process.env.JWT_SECRET = 'perf-test-secret';
      const app = require('../server');
      await new Promise(r => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}`; r(); }); });
      db = new (require('better-sqlite3'))(process.env.DB);
    }

    const login = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@family.test', password: 'demo1234' }),
    });
    const token = (await login.json()).token;
    if (!token) throw new Error('Could not log in to seed performance data.');

    const authed = (url, opts = {}) => fetch(base + url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
    const json = async (url, opts) => { const r = await authed(url, opts); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null, bytes: Buffer.byteLength(t) }; };

    async function timed(fn) {
      const t0 = performance.now();
      const result = await fn();
      return { ms: performance.now() - t0, result };
    }

    const datasets = {};
    for (const size of SIZES) {
      const treeName = `Perf ${size} ${Date.now().toString(36)}`;
      const created = await json('/api/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: treeName, root: { name: 'Perf Root', gender: 'Female', dob: '1900' } }) });
      if (created.status !== 200) throw new Error(`Could not create perf tree ${size}: ${created.status}`);
      const tid = created.body.id;
      const rootId = (await json(`/api/trees/${tid}`)).body.tree.root_id;
      const spouse = await json(`/api/trees/${tid}/people`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Perf Spouse', gender: 'Male', dob: '1900', spouse_of: rootId }) });
      if (spouse.status !== 200) throw new Error(`Could not add perf spouse: ${spouse.status}`);
      const tree = (await json(`/api/trees/${tid}`)).body;
      const marriage = tree.marriages[0];

      // Bulk-insert the remaining people directly: the server validates normal
      // writes, but 1000 sequential HTTP writes would make the fixture itself the
      // bottleneck. Rows match exactly what the API would store.
      const insert = db.prepare('INSERT INTO people(tree_id,name,gender,dob,parent_marriage_id) VALUES(?,?,?,?,?)');
      const fill = db.transaction(n => {
        for (let i = 0; i < n; i++) insert.run(tid, `Perf Person ${String(i + 1).padStart(4, '0')}`, i % 2 ? 'Male' : 'Female', String(1940 + (i % 60)), marriage.id);
      });
      fill(size - 2);
      const count = db.prepare('SELECT COUNT(*) n FROM people WHERE tree_id=?').get(tid).n;
      if (count !== size) throw new Error(`Perf tree ${size} has ${count} people`);
      const personId = db.prepare('SELECT id FROM people WHERE tree_id=? ORDER BY id DESC LIMIT 1').get(tid).id;
      datasets[size] = { tid, name: treeName, rootId, personId };
    }

    const backend = {};
    for (const size of SIZES) {
      const { tid, rootId, personId } = datasets[size];
      const endpoints = [
        ['tree-depth2', `/api/trees/${tid}?depth=2`],
        ['tree-full', `/api/trees/${tid}`],
        ['insights', `/api/trees/${tid}/insights`],
        ['search', `/api/trees/${tid}/search?q=Perf`],
        ['chart-depth6', `/api/trees/${tid}?depth=6`],
        ['person-branch', `/api/people/${personId}/branch`],
        ['person-pedigree', `/api/people/${personId}/pedigree?depth=4`],
        ['related', `/api/people/${rootId}/related/${personId}`],
      ];
      backend[size] = {};
      for (const [name, url] of endpoints) {
        for (let i = 0; i < WARMUP; i++) await json(url);
        const samples = [];
        let bytes = 0;
        for (let i = 0; i < MEASURED; i++) {
          const { ms, result } = await timed(() => json(url));
          if (result.status !== 200) throw new Error(`${name} for ${size} returned ${result.status}`);
          samples.push(ms); bytes = result.bytes;
        }
        backend[size][name] = { median: round(median(samples)), p95: round(p95(samples)), max: round(max(samples)), bytes, samples: samples.map(round) };
      }
    }

    const browserResults = {};
    if (Chrome && executablePath) {
      browser = await Chrome.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' });
      await context.addInitScript(t => { try { localStorage.setItem('tok', t); } catch { /* ignore */ } }, token);
      await context.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
      const page = await context.newPage();
      for (const size of SIZES) {
        const { tid, personId } = datasets[size];
        const views = [
          ['tree', `#/t/${tid}`, '.tree-canvas'],
          ['person', `#/t/${tid}/p/${personId}`, '.profile-hero'],
          ['chart', `#/t/${tid}/chart`, 'svg.chart'],
          ['insights', `#/t/${tid}/insights`, '.stat-grid'],
        ];
        browserResults[size] = {};
        for (const [name, hash, ready] of views) {
          const run = async i => {
            const t0 = performance.now();
            await page.goto(`${base}/?perf=${size}-${name}-${i}${hash}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForSelector(ready, { timeout: 30000 });
            return performance.now() - t0;
          };
          for (let i = 0; i < BROWSER_WARMUP; i++) await run('warm' + i);
          const samples = [];
          for (let i = 0; i < BROWSER_MEASURED; i++) samples.push(await run(i));
          browserResults[size][name] = { median: round(median(samples)), p95: round(p95(samples)), max: round(max(samples)), samples: samples.map(round) };
        }
      }
      await context.close();
    }

    const failures = [];
    for (const size of SIZES) {
      for (const [name, m] of Object.entries(backend[size])) {
        const b = BUDGET.backend[name];
        if (b && (m.median > b.median || m.p95 > b.p95)) failures.push(`backend ${name} @${size}: median ${m.median}ms (budget ${b.median}), p95 ${m.p95}ms (budget ${b.p95})`);
      }
      for (const [name, m] of Object.entries(browserResults[size] || {})) {
        const b = BUDGET.browser[name];
        if (b && (m.median > b.median || m.p95 > b.p95)) failures.push(`browser ${name} @${size}: median ${m.median}ms (budget ${b.median}), p95 ${m.p95}ms (budget ${b.p95})`);
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      base,
      sizes: SIZES,
      runs: { backendWarmup: WARMUP, backendMeasured: MEASURED, browserWarmup: BROWSER_WARMUP, browserMeasured: BROWSER_MEASURED },
      budgets: BUDGET,
      backend,
      browser: browserResults,
      browserSkipped: !(Chrome && executablePath),
      failures,
      status: failures.length ? 'FAIL' : 'PASS',
    };
    fs.writeFileSync('perf-report.json', JSON.stringify(report, null, 2));

    console.log('Backend (ms) — median / p95 / max');
    for (const size of SIZES) for (const [name, m] of Object.entries(backend[size])) console.log(`  ${String(size).padStart(4)} ${name.padEnd(14)} ${String(m.median).padStart(7)} / ${String(m.p95).padStart(7)} / ${String(m.max).padStart(7)}  (${(m.bytes / 1024).toFixed(0)} KB)`);
    if (Object.keys(browserResults).length) {
      console.log('Browser render (ms) — median / p95 / max');
      for (const size of SIZES) for (const [name, m] of Object.entries(browserResults[size])) console.log(`  ${String(size).padStart(4)} ${name.padEnd(14)} ${String(m.median).padStart(7)} / ${String(m.p95).padStart(7)} / ${String(m.max).padStart(7)}`);
    } else {
      console.log('Browser render: skipped (Chrome/Edge not found)');
    }
    console.log(`\nStatus: ${report.status}${failures.length ? '\n' + failures.join('\n') : ' (all budgets met)'}`);
    console.log('Report written to perf-report.json');

    await browser.close().catch(() => {});
    browser = null;
    exitCode = failures.length ? 1 : 0;
  } catch (e) {
    console.error('Performance check failed:', e && e.stack || e);
    if (browser) await browser.close().catch(() => {});
    exitCode = 2;
  } finally {
    if (srv) srv.close();
    if (db) try { db.close(); } catch { /* ignore */ }
    if (!USE_EXISTING && dataDir) for (const x of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB + x); } catch { /* ignore */ }
    process.exit(exitCode);
  }
})();
