// Opens the app in headless Chromium at phone, tablet and desktop sizes and reports sideways overflow, JavaScript errors and touch targets under 44px.
// Options: THEMES=sunny,clean LANGS=en,fr,ha VIEWS=phone-360,laptop. Pages use the demo tree (person 4 = Rosalind, 10 = Daniel, 11 = Nora).
// Uses the installed playwright-core and a local Chrome/Edge; set CHROME_PATH to choose a browser. Start the app first (npm start), then: npm run check:responsive
const fs = require('fs');
const { chromium } = require('playwright-core');
const chromePaths = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = chromePaths.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!executablePath) {
  console.error('No Chrome or Edge found. Install Chrome/Edge, or set CHROME_PATH to its executable.');
  process.exit(1);
}
const base = process.env.BASE || 'http://localhost:3000';
fs.mkdirSync('responsive-shots', { recursive: true });
(async () => {
  const tok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@family.test', password: 'demo1234' }) })).json()).token;
  const themes = (process.env.THEMES || 'sunny,heritage,midnight,blossom,clean').split(','), langs = (process.env.LANGS || 'en').split(','), only = process.env.VIEWS ? process.env.VIEWS.split(',') : null;
  const views = [['phone-360', 360, 740, true], ['phone-390', 390, 844, true], ['tablet', 768, 1024, true], ['laptop', 1280, 800, false], ['wide', 1920, 1080, false]];
  const pages = [['home', '#/'], ['tree', '#/t/1'], ['tree-open', '#/t/1', true], ['person', '#/t/1/p/4'], ['grand', '#/t/1/gc'], ['form', '#/t/1/new?m=1'], ['share', '#/t/1/share'], ['history', '#/t/1/history'], ['chart', '#/t/1/chart'], ['chart5', '#/t/1/chart?g=5'], ['ped', '#/t/1/ped/11'], ['insights', '#/t/1/insights'], ['parents', '#/t/1/new?parents=10'], ['tidy', '#/t/1/tidy'], ['account', '#/account'], ['forgot', '#/forgot'], ['marriage', '#/t/1/marriage/1'], ['person-nora', '#/t/1/p/11']];
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const issues = []; let checks = 0;
  for (const [vn, w, h, touch] of views.filter(v => !only || only.includes(v[0]))) for (const theme of themes) for (const lang of langs) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: touch && w < 700, hasTouch: touch });
    await ctx.addInitScript(([t, th, lg]) => { localStorage.setItem('tok', t); localStorage.setItem('theme', th); localStorage.setItem('lang', lg); }, [tok, theme, lang]);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    const page = await ctx.newPage(); page.on('pageerror', e => issues.push('JS ERROR ' + vn + ' ' + theme + '/' + lang + ': ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_FAILED|Failed to load resource/.test(m.text())) issues.push('CONSOLE ' + vn + ' ' + theme + '/' + lang + ': ' + m.text().slice(0, 120)); });
    for (const [pn, hash, open] of pages) {
      await page.goto(base + '/' + hash); await page.reload();
      await page.waitForFunction(() => document.querySelector('#app') && document.querySelector('#app').children.length > 0);
      if (open) { for (let i = 0; i < 6 && await page.$('.more[aria-expanded="false"]'); i++) await page.click('.more[aria-expanded="false"]'); }
      await page.waitForTimeout(120);
      const r = await page.evaluate(() => {
        const W = innerWidth, bad = [], vis = e => { const r = e.getBoundingClientRect(); return r.width && r.height && !e.closest('[hidden]'); };
        document.querySelectorAll('body *').forEach(e => { if (!vis(e) || e.closest('nav,.chartwrap')) return; const r = e.getBoundingClientRect(); if (r.right > W + 1 || r.left < -1) bad.push(((e.id || e.className || e.tagName) + '').slice(0, 30) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); });
        const small = [...document.querySelectorAll('a[href],button,select,input:not([type=checkbox]):not([type=file]),label.btn')].filter(e => vis(e) && (e.getBoundingClientRect().height < 44)).map(e => ((e.textContent || e.name || e.id || e.tagName).trim().slice(0, 18)) + ' h' + Math.round(e.getBoundingClientRect().height));
        return { over: document.documentElement.scrollWidth - W, bad: [...new Set(bad)].slice(0, 4), small: [...new Set(small)].slice(0, 8) };
      });
      checks++;
      if (r.over > 0 || r.bad.length) issues.push(`OVERFLOW ${vn} ${theme}/${lang} ${pn}: page ${r.over}px wider; ${r.bad.join(' | ')}`);
      if (touch && r.small.length) issues.push(`SMALL-TAP ${vn} ${theme}/${lang} ${pn}: ${r.small.join(', ')}`);
      if (false) await page.screenshot({ path: `responsive-shots/${vn}-${theme}-tree.png`, fullPage: true });
      if ((pn === 'chart' || pn === 'ped' || pn === 'insights') && theme === 'sunny' && (vn === 'phone-390' || vn === 'laptop')) await page.screenshot({ path: `responsive-shots/${vn}-${pn}.png` });
      if (pn === 'person' && theme === 'sunny' && vn === 'phone-390') await page.screenshot({ path: `responsive-shots/${vn}-person.png`, fullPage: true });
    }
    if (vn === 'phone-390') {
      try {
        await page.goto(base + '/#/t/1');
        await page.click('#tb');
        await page.screenshot({ path: `responsive-shots/phone-picker-${theme}.png` });
      } catch (e) {
        const msg = String(e.message || e);
        if (/not visible|not attached|Element is not|Target closed|navigation/.test(msg)) {
          console.log(`SKIPPED phone-picker screenshot ${theme}: ${msg.slice(0, 80)}`);
        } else {
          issues.push(`SCREENSHOT-ERROR ${theme}: ${msg.slice(0, 120)}`);
        }
      }
    }
    await ctx.close();
  }
  await browser.close();
  console.log(checks + ' page checks across ' + views.length + ' screen sizes x ' + themes.length + ' designs');
  const g = {}; issues.forEach(i => { const k = i.split(':')[0].split(' ')[0] + ' ' + i.split(':').slice(1).join(':').trim().slice(0, 70); (g[k] = g[k] || []).push(i.split(':')[0]); });
  console.log(issues.length + ' issues'); console.log(issues.slice(0, 40).join('\n'));
})();
