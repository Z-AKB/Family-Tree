// Responsive + overflow check for the Family Tree UI.
//
// Starts from a running app (npm start) and drives real Chrome/Edge via playwright-core.
// Required viewports: 1440x900, 1366x768, 768x1024, 390x844, 360x800.
// Pages: dashboard, tree, profile, chart, grandchildren, insights, share/export,
// history, search form and results, add/edit person, marriage editor, ancestors,
// tidy-up and account.
//
// For every page it measures:
//   - document horizontal overflow (documentElement / body scrollWidth vs client width)
//   - elements painted outside the viewport, classified as:
//       document-overflow  -> not contained by any scroll/clip ancestor (real bug)
//       clipping           -> contained by an overflow:hidden/clip ancestor (content cut off)
//       component-scroll   -> contained by an overflow:auto/scroll ancestor (intentional scroller)
//   - touch-target heights on touch viewports
//   - console/page errors and same-origin failed requests
// It also exercises the mobile navigation drawer: closed, open, and after navigating.
//
// The drawer is an off-canvas panel that is intentionally translated off-screen and
// visibility:hidden when closed, so it is excluded only when it is actually closed
// (body.nav-open is the source of truth). When open it is measured like any other UI.
//
// Options (env):
//   BASE=http://localhost:3000
//   BROWSERS=chrome,edge          (default: both)
//   CHROME_PATH / EDGE_PATH       override executables
//   VIEWS=1440x900,390x844        subset
//   THEMES=sunny,clean            default: sunny for all, all themes on phone-390
//   PAGES=home,tree,person        subset
//   SHOTS=0                       skip screenshots
//
// Output: responsive-shots/<browser>-<viewport>-<page>.png + responsive-shots/report.json

const fs = require('fs');
const { chromium } = require('playwright-core');

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/+$/, '');
const SHOTS = process.env.SHOTS !== '0';
const SHOT_DIR = 'responsive-shots';
const ONLY_VIEWS = process.env.VIEWS ? process.env.VIEWS.split(',').map(s => s.trim()) : null;
const EXPLICIT_THEMES = process.env.THEMES ? process.env.THEMES.split(',').map(s => s.trim()).filter(Boolean) : null;
const ONLY_PAGES = process.env.PAGES ? process.env.PAGES.split(',').map(s => s.trim()) : null;

const ALL_THEMES = ['sunny', 'heritage', 'midnight', 'blossom', 'clean'];
const VIEWS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, touch: false },
  { name: 'laptop-1366x768', width: 1366, height: 768, touch: false },
  { name: 'tablet-768x1024', width: 768, height: 1024, touch: true },
  { name: 'phone-390x844', width: 390, height: 844, touch: true },
  { name: 'phone-360x800', width: 360, height: 800, touch: true },
];
const PAGES = [
  { name: 'home', hash: '#/', ready: '.tree-card, .empty-state, .page-title' },
  { name: 'tree', hash: '#/t/1', ready: '.tree-canvas, .empty-state' },
  { name: 'person', hash: '#/t/1/p/4', ready: '.profile-hero, .route-error' },
  { name: 'chart', hash: '#/t/1/chart', ready: '.chartwrap, .route-error' },
  { name: 'grandchildren', hash: '#/t/1/gc', ready: '#app .page, .route-error' },
  { name: 'insights', hash: '#/t/1/insights', ready: '.stat-grid, #app .page, .route-error' },
  { name: 'share', hash: '#/t/1/share', ready: '.settings-grid, .empty-state, .route-error' },
  { name: 'history', hash: '#/t/1/history', ready: '.timeline, .empty-state, .route-error' },
  { name: 'search', hash: '#/t/1/search', ready: '#app form, .page-title, .route-error' },
  { name: 'search-results', hash: '#/t/1/search?q=a', ready: '.search-results, .empty-state, .route-error' },
  { name: 'new-person', hash: '#/t/1/new', ready: '.form-page, .route-error' },
  { name: 'edit-person', hash: '#/t/1/edit/4', ready: '.form-page, .route-error' },
  { name: 'marriage', hash: '#/t/1/marriage/1', ready: '.form-page, .route-error' },
  { name: 'ancestors', hash: '#/t/1/ped/4', ready: '.chartwrap, .route-error' },
  { name: 'tidy', hash: '#/t/1/tidy', ready: '.page-header, .empty-state, .route-error' },
  { name: 'account', hash: '#/account', ready: '.account-head, .auth-card, .route-error' },
];

const BROWSER_DEFS = [
  {
    name: 'chrome',
    paths: [
      process.env.CHROME_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
  },
  {
    name: 'edge',
    paths: [
      process.env.EDGE_PATH,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  },
];

function resolveBrowsers() {
  const wanted = (process.env.BROWSERS || 'chrome,edge').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  const missing = [];
  for (const def of BROWSER_DEFS) {
    if (!wanted.includes(def.name)) continue;
    const exe = def.paths.find(p => { try { return !!p && fs.existsSync(p); } catch { return false; } });
    if (exe) out.push({ name: def.name, executablePath: exe });
    else missing.push(def.name);
  }
  return { out, missing };
}

// Runs in the browser. Returns raw measurements plus classified problems.
function measureInPage(opts) {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const drawerOpen = document.body.classList.contains('nav-open');
  const IGNORE_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'BR', 'SOURCE', 'TEMPLATE', 'NOSCRIPT']);
  const SKIP_SELECTOR = '.skip-link';

  const styleCache = new Map();
  const cs = el => {
    if (!styleCache.has(el)) styleCache.set(el, getComputedStyle(el));
    return styleCache.get(el);
  };
  const isVisible = el => {
    if (!el.isConnected) return false;
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    if (parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = el => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '')).slice(0, 70);
  };
  const overflowX = el => {
    const s = cs(el);
    const ox = s.overflowX;
    return ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip' ? ox : (s.overflow === 'auto' || s.overflow === 'scroll' ? 'auto' : null);
  };

  const componentScrolls = new Map();
  const documentOverflow = [];
  const clipping = [];
  const elements = document.body.querySelectorAll('*');

  for (const el of elements) {
    if (IGNORE_TAGS.has(el.tagName)) continue;
    if (el.matches(SKIP_SELECTOR)) continue;
    // Closed drawer: off-canvas by design. Open drawer (body.nav-open) is measured.
    if (el.closest('#sidebar') && !drawerOpen) continue;
    if (!isVisible(el)) continue;

    const r = el.getBoundingClientRect();
    const outside = r.right > vw + 1 || r.left < -1 || r.right < -1;
    if (!outside) continue;

    // Ignore descendants of a container that is itself already off-canvas because it is
    // inside the (closed) drawer; that branch was excluded above.
    let scroller = null, clipper = null;
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      // SVG defaults to overflow:hidden, but its scaled viewBox is not the real
      // scroll boundary. Keep walking to the scrollable wrapper (e.g. .chartwrap)
      // so charts are reported as reachable component scrolling, not clipping.
      if (p.tagName === 'svg') { p = p.parentElement; continue; }
      const ox = overflowX(p);
      if (ox === 'auto' || ox === 'scroll') { scroller = p; break; }
      if (ox === 'hidden' || ox === 'clip') { clipper = p; break; }
      p = p.parentElement;
    }

    if (scroller) {
      const key = label(scroller);
      if (!componentScrolls.has(key)) {
        componentScrolls.set(key, {
          container: key,
          scrollWidth: Math.round(scroller.scrollWidth),
          clientWidth: Math.round(scroller.clientWidth),
          overflowingChildren: 0,
        });
      }
      componentScrolls.get(key).overflowingChildren++;
      continue;
    }

    const entry = { el: label(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
    if (clipper) clipping.push({ ...entry, clippedBy: label(clipper) });
    else documentOverflow.push(entry);
  }

  // Deduplicate repeated rows (e.g. dozens of identical child nodes).
  const dedupe = list => {
    const seen = new Set(), out = [];
    for (const x of list) {
      const k = x.el + '|' + x.left + '|' + x.right + '|' + (x.clippedBy || '');
      if (seen.has(k)) continue;
      seen.add(k); out.push(x);
    }
    return out;
  };

  const tap = [];
  if (opts.touch) {
    const sel = 'a[href],button,select,textarea,input:not([type=checkbox]):not([type=radio]):not([type=hidden]),label.btn,[role="button"]';
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('#sidebar') && !drawerOpen) continue;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const s = cs(el);
      if (s.pointerEvents === 'none') continue;
      if (r.height < 44 - 0.5) tap.push({ el: label(el), text: (el.textContent || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 32), height: Math.round(r.height) });
    }
  }
  const dedupeTap = [];
  const seenTap = new Set();
  for (const t of tap) { const k = t.el + '|' + t.text + '|' + t.height; if (!seenTap.has(k)) { seenTap.add(k); dedupeTap.push(t); } }

  return {
    viewport: { width: vw, height: vh },
    drawerOpen,
    documentScrollWidth: Math.round(document.documentElement.scrollWidth),
    bodyScrollWidth: Math.round(document.body.scrollWidth),
    documentOverflowPx: Math.max(0, document.documentElement.scrollWidth - vw, document.body.scrollWidth - vw),
    documentOverflow: dedupe(documentOverflow).slice(0, 15),
    clipping: dedupe(clipping).slice(0, 15),
    componentScrolls: [...componentScrolls.values()].slice(0, 15),
    tapTargets: dedupeTap.slice(0, 25),
  };
}

function noProblems(m) {
  return m.documentOverflowPx === 0 && m.documentOverflow.length === 0 && m.clipping.length === 0;
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

  // Authenticate once up-front so pages render the signed-in app.
  let token;
  try {
    const res = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@family.test', password: 'demo1234' }),
    });
    const body = await res.json();
    if (!res.ok || !body.token) throw new Error(`login ${res.status}: ${body.error || JSON.stringify(body)}`);
    token = body.token;
  } catch (e) {
    console.error(`Cannot sign in to ${BASE}: ${e.message}`);
    console.error('Start the app first (npm start) and make sure the demo account exists.');
    process.exit(2);
  }

  const { out: browsers, missing } = resolveBrowsers();
  for (const name of missing) console.error(`WARN: ${name} executable not found; skipping.`);
  if (!browsers.length) {
    console.error('No requested browser matched. Set CHROME_PATH / EDGE_PATH or BROWSERS=chrome|edge.');
    process.exit(2);
  }

  const views = VIEWS.filter(v => !ONLY_VIEWS || ONLY_VIEWS.includes(v.name) || ONLY_VIEWS.includes(`${v.width}x${v.height}`));
  const pages = PAGES.filter(p => !ONLY_PAGES || ONLY_PAGES.includes(p.name));
  if (!views.length || !pages.length) {
    console.error('VIEWS/PAGES filters matched nothing.');
    process.exit(2);
  }

  const report = {
    startedAt: new Date().toISOString(),
    base: BASE,
    browsers: [],
    viewports: views.map(v => ({ name: v.name, width: v.width, height: v.height, touch: v.touch })),
    pages: pages.map(p => p.name),
    checks: [],
    failures: [],
    notes: [],
  };

  for (const browserDef of browsers) {
    const browser = await chromium.launch({ executablePath: browserDef.executablePath, headless: true, args: ['--no-sandbox'] });
    const browserVersion = browser.version();
    report.browsers.push({ name: browserDef.name, version: browserVersion, executablePath: browserDef.executablePath });
    console.log(`\n=== ${browserDef.name} ${browserVersion} ===`);

    for (const view of views) {
      // Default: sunny everywhere; run every theme on the primary phone viewport.
      const themes = EXPLICIT_THEMES
        ? EXPLICIT_THEMES
        : (view.name === 'phone-390x844' ? ALL_THEMES : ['sunny']);

      for (const theme of themes) {
        const context = await browser.newContext({
          viewport: { width: view.width, height: view.height },
          deviceScaleFactor: 1,
          isMobile: view.touch && view.width < 600,
          hasTouch: view.touch,
          colorScheme: 'light',
          reducedMotion: 'no-preference',
        });
        await context.addInitScript(([tok, th]) => {
          try { localStorage.setItem('tok', tok); localStorage.setItem('theme', th); localStorage.setItem('lang', 'en'); } catch { /* ignore */ }
        }, [token, theme]);
        // Keep the run local/hermetic: never wait on Google Fonts.
        await context.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());

        const page = await context.newPage();
        const consoleErrors = [];
        const pageErrors = [];
        const failedRequests = [];
        page.on('pageerror', e => pageErrors.push(String(e.message || e).slice(0, 200)));
        page.on('console', m => {
          if (m.type() !== 'error') return;
          const text = m.text();
          if (/fonts\.g|ERR_FAILED|Failed to load resource|net::ERR_ABORTED/i.test(text)) return;
          consoleErrors.push(text.slice(0, 200));
        });
        page.on('requestfailed', req => {
          const url = req.url();
          if (!url.startsWith(BASE)) return;
          if (/fonts\./.test(url)) return;
          failedRequests.push(`${req.method()} ${url.replace(BASE, '')} ${req.failure() ? req.failure().errorText : ''}`.slice(0, 200));
        });

        for (const p of pages) {
          const label = `${browserDef.name}/${view.name}/${theme}/${p.name}`;
          const url = `${BASE}/?v=${encodeURIComponent(view.name + theme + p.name)}${p.hash}`;
          let measure = null, error = null;
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForFunction(() => {
              const app = document.querySelector('#app');
              return !!app && app.children.length > 0;
            }, { timeout: 12000 });
            try { await page.waitForSelector(p.ready, { timeout: 5000 }); } catch { /* ready selector is advisory */ }
            await page.waitForTimeout(180);
            measure = await page.evaluate(measureInPage, { touch: view.touch });
          } catch (e) {
            error = String(e.message || e).slice(0, 300);
          }

          const check = {
            browser: browserDef.name,
            viewport: view.name,
            theme,
            page: p.name,
            url: p.hash,
            status: 'PASS',
            error,
            measurement: measure,
            consoleErrors: [...new Set(consoleErrors)].slice(0, 5),
            pageErrors: [...new Set(pageErrors)].slice(0, 5),
            failedRequests: [...new Set(failedRequests)].slice(0, 5),
          };
          const problems = [];
          if (error) problems.push(`PAGE-ERROR ${error}`);
          if (measure) {
            if (measure.documentOverflowPx > 0) problems.push(`DOCUMENT-OVERFLOW ${measure.documentOverflowPx}px`);
            for (const o of measure.documentOverflow) problems.push(`ELEMENT-OUTSIDE ${o.el} ${o.left}..${o.right}`);
            for (const c of measure.clipping) problems.push(`CLIPPING ${c.el} ${c.left}..${c.right} clipped by ${c.clippedBy}`);
            for (const t of measure.tapTargets) problems.push(`SMALL-TAP ${t.el} "${t.text}" ${t.height}px`);
            for (const s of measure.componentScrolls) report.notes.push(`${label}: component scroll ${s.container} ${s.scrollWidth}>${s.clientWidth} (${s.overflowingChildren} children outside)`);
          }
          if (check.pageErrors.length) problems.push(`JS-ERROR ${check.pageErrors.join(' | ')}`);
          if (check.consoleErrors.length) problems.push(`CONSOLE ${check.consoleErrors.join(' | ')}`);
          if (check.failedRequests.length) problems.push(`REQUEST-FAILED ${check.failedRequests.join(' | ')}`);
          if (problems.length) {
            check.status = 'FAIL';
            check.problems = problems;
            report.failures.push({ label, problems });
            console.log(`FAIL ${label}`);
            for (const x of problems.slice(0, 10)) console.log(`     - ${x}`);
          } else {
            const extra = measure && measure.componentScrolls.length ? ` (${measure.componentScrolls.length} intentional scroller${measure.componentScrolls.length === 1 ? '' : 's'})` : '';
            console.log(`PASS ${label}${extra}`);
          }
          report.checks.push(check);

          if (SHOTS && measure) {
            const file = `${SHOT_DIR}/${browserDef.name}-${view.name}-${theme}-${p.name}.png`;
            try { await page.screenshot({ path: file, fullPage: true }); } catch (e) { console.log(`  screenshot failed: ${String(e.message || e).slice(0, 100)}`); }
          }
        }

        // Drawer lifecycle: only where the off-canvas drawer is active (<=1024px CSS breakpoint).
        if (view.width <= 1024) {
          const label = `${browserDef.name}/${view.name}/${theme}/drawer`;
          const drawer = { closed: null, open: null, afterNav: null, status: 'PASS', problems: [] };
          try {
            await page.goto(`${BASE}/?v=${encodeURIComponent(view.name + theme + 'drawer')}#/t/1`, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForSelector('.tree-canvas, .empty-state', { timeout: 12000 });
            await page.waitForTimeout(150);

            // 1. Closed: the drawer must be hidden and must not create overflow.
            const closed = await page.evaluate(() => {
              const sb = document.querySelector('#sidebar');
              const menu = document.querySelector('#menu');
              const s = sb ? getComputedStyle(sb) : null;
              const r = sb ? sb.getBoundingClientRect() : null;
              return {
                bodyNavOpen: document.body.classList.contains('nav-open'),
                sidebarVisibility: s ? s.visibility : 'missing',
                sidebarLeft: r ? Math.round(r.left) : null,
                sidebarRight: r ? Math.round(r.right) : null,
                menuVisible: !!menu && menu.getBoundingClientRect().width > 0 && getComputedStyle(menu).display !== 'none',
                checkVisibility: sb && typeof sb.checkVisibility === 'function' ? sb.checkVisibility({ checkVisibilityCSS: true }) : null,
              };
            });
            drawer.closed = closed;
            const mClosed = await page.evaluate(measureInPage, { touch: view.touch });
            drawer.closed.measurement = mClosed;
            if (closed.bodyNavOpen) drawer.problems.push('drawer starts open');
            if (closed.sidebarVisibility !== 'hidden') drawer.problems.push(`closed sidebar visibility=${closed.sidebarVisibility}`);
            if (!closed.menuVisible) drawer.problems.push('menu button not visible');
            if (!noProblems(mClosed)) drawer.problems.push(...mClosed.documentOverflow.map(o => `closed overflow ${o.el} ${o.left}..${o.right}`).concat(mClosed.clipping.map(c => `closed clipping ${c.el}`)));

            // 2. Open: sidebar must be visible, on-screen, and not create document overflow.
            await page.click('#menu');
            await page.waitForFunction(() => document.body.classList.contains('nav-open'), { timeout: 5000 });
            await page.waitForTimeout(250);
            const open = await page.evaluate(() => {
              const sb = document.querySelector('#sidebar');
              const scrim = document.querySelector('#scrim');
              const close = document.querySelector('#navclose');
              const r = sb.getBoundingClientRect();
              const sr = scrim.getBoundingClientRect();
              return {
                bodyNavOpen: document.body.classList.contains('nav-open'),
                sidebarLeft: Math.round(r.left),
                sidebarRight: Math.round(r.right),
                sidebarWidth: Math.round(r.width),
                sidebarVisibility: getComputedStyle(sb).visibility,
                scrimHidden: scrim.hidden,
                scrimCoversViewport: Math.round(sr.width) >= document.documentElement.clientWidth && Math.round(sr.height) >= window.innerHeight,
                closeVisible: !!close && close.getBoundingClientRect().width > 0,
              };
            });
            drawer.open = open;
            const mOpen = await page.evaluate(measureInPage, { touch: view.touch });
            drawer.open.measurement = mOpen;
            if (!open.bodyNavOpen) drawer.problems.push('open click did not set nav-open');
            if (open.sidebarVisibility !== 'visible') drawer.problems.push(`open sidebar visibility=${open.sidebarVisibility}`);
            if (open.sidebarLeft < -1) drawer.problems.push(`open sidebar starts off-screen (${open.sidebarLeft})`);
            if (open.sidebarRight > mOpen.viewport.width + 1) drawer.problems.push(`open sidebar overflows viewport (${open.sidebarRight})`);
            if (open.scrimHidden) drawer.problems.push('scrim hidden while drawer open');
            if (!open.scrimCoversViewport) drawer.problems.push('scrim does not cover viewport');
            if (!open.closeVisible) drawer.problems.push('close button not visible');
            if (!noProblems(mOpen)) drawer.problems.push(...mOpen.documentOverflow.map(o => `open overflow ${o.el} ${o.left}..${o.right}`).concat(mOpen.clipping.map(c => `open clipping ${c.el}`)));
            if (mOpen.tapTargets.length) drawer.problems.push(`open small tap targets: ${mOpen.tapTargets.map(t => `${t.el} ${t.height}px`).join(', ')}`);

            if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${browserDef.name}-${view.name}-${theme}-drawer-open.png`, fullPage: false });

            // 3. Navigate through the drawer: it must close and the new route must render.
            const navLink = await page.evaluateHandle(() => {
              const links = [...document.querySelectorAll('#nav a.nav-item')];
              return links.find(a => !a.hasAttribute('aria-current')) || links[0] || null;
            });
            const hasLink = await navLink.evaluate(el => !!el);
            if (!hasLink) drawer.problems.push('no navigation links in drawer');
            else {
              const target = await navLink.evaluate(el => el.getAttribute('href'));
              await navLink.evaluate(el => el.click());
              await page.waitForFunction(() => !document.body.classList.contains('nav-open'), { timeout: 5000 });
              await page.waitForTimeout(400);
              const afterNav = await page.evaluate((expected) => ({
                hash: location.hash,
                target: expected,
                bodyNavOpen: document.body.classList.contains('nav-open'),
                scrimHidden: document.querySelector('#scrim').hidden,
                menuExpanded: document.querySelector('#menu').getAttribute('aria-expanded'),
                sidebarVisibility: getComputedStyle(document.querySelector('#sidebar')).visibility,
                appChildren: document.querySelector('#app').children.length,
              }), target);
              drawer.afterNav = afterNav;
              if (afterNav.bodyNavOpen) drawer.problems.push('drawer still open after navigating');
              if (!afterNav.scrimHidden) drawer.problems.push('scrim still visible after navigating');
              if (afterNav.menuExpanded !== 'false') drawer.problems.push(`menu aria-expanded=${afterNav.menuExpanded} after navigating`);
              if (afterNav.sidebarVisibility !== 'hidden') drawer.problems.push(`sidebar visibility=${afterNav.sidebarVisibility} after navigating`);
              if (!afterNav.hash || afterNav.hash === '#/t/1' && target && target !== '#/t/1') drawer.problems.push(`navigation did not change hash (${afterNav.hash})`);
              if (!afterNav.appChildren) drawer.problems.push('app empty after drawer navigation');
              const mAfter = await page.evaluate(measureInPage, { touch: view.touch });
              drawer.afterNav.measurement = mAfter;
              if (!noProblems(mAfter)) drawer.problems.push(...mAfter.documentOverflow.map(o => `after-nav overflow ${o.el} ${o.left}..${o.right}`).concat(mAfter.clipping.map(c => `after-nav clipping ${c.el}`)));
              if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${browserDef.name}-${view.name}-${theme}-drawer-after-nav.png`, fullPage: true });
            }
          } catch (e) {
            drawer.problems.push(`DRAWER-ERROR ${String(e.message || e).slice(0, 200)}`);
          }
          if (drawer.problems.length) {
            drawer.status = 'FAIL';
            report.failures.push({ label, problems: drawer.problems });
            console.log(`FAIL ${label}`);
            for (const x of drawer.problems.slice(0, 10)) console.log(`     - ${x}`);
          } else {
            console.log(`PASS ${label} (closed hidden, open on-screen, closes after navigation)`);
          }
          report.checks.push({ browser: browserDef.name, viewport: view.name, theme, page: 'drawer', status: drawer.status, drawer });
        }

        await context.close();
      }
    }
    await browser.close();
  }

  report.finishedAt = new Date().toISOString();
  report.totalChecks = report.checks.length;
  report.failedChecks = report.failures.length;
  report.status = report.failures.length ? 'FAIL' : 'PASS';
  if (SHOTS) {
    const reportFile = `${SHOT_DIR}/report.json`;
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${reportFile}`);
  }

  console.log(`\n${report.totalChecks} checks (${report.checks.filter(c => c.page === 'drawer').length} drawer lifecycle) across ${browsers.length} browser(s), ${views.length} viewport(s), ${pages.length} page(s)`);
  console.log(`${report.failedChecks} failed, ${report.notes.length} component-scroll notes`);
  if (report.failures.length) {
    console.log('\nFAILURES:');
    for (const f of report.failures) console.log(`- ${f.label}: ${f.problems.slice(0, 6).join(' | ')}`);
  }
  process.exit(report.failures.length ? 1 : 0);
})();
