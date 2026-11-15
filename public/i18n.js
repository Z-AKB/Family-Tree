// Translates the interface by matching the English text the app draws, so no templates need to change.
// Names, notes and anything people type are never in the phrase list, so they are left as written.
(function () {
  var D = window.I18N_DATA, L = D.languages, IDX = {}, W = {}, ATTR = ['placeholder', 'aria-label', 'title'];
  L.forEach(function (l, i) { IDX[l[0]] = i; });
  D.words.forEach(function (r) { W[r[0]] = r; });
  var PT = D.patterns.map(function (p) { return [new RegExp(p[0]), p]; });
  var lang = null; try { lang = localStorage.getItem('lang'); } catch (e) {}
  if (!(lang in IDX)) lang = (navigator.language || 'en').slice(0, 2);
  if (!(lang in IDX)) lang = 'en';
  var i = function () { return IDX[lang]; };
  function tr(s) {
    var t = s.trim(); if (!t || lang === 'en') return s;
    var r = W[t]; if (r && r[i()]) return s.replace(t, function () { return r[i()]; });
    for (var k = 0; k < PT.length; k++) if (PT[k][0].test(t)) { var o = PT[k][1][i()]; return o ? s.replace(t, function () { return t.replace(PT[k][0], o).trim(); }) : s; }
    return s;
  }
  var orig = new WeakMap(), oattr = new WeakMap();
  // Names, notes, titles and other things people type must never be translated, even if they happen
  // to match an interface phrase. Screens mark those areas with data-i18n-skip.
  function skip(el) { return !!(el && el.closest && el.closest('[data-i18n-skip],script,style,textarea,#lg')); }
  function apply() {
    document.documentElement.lang = lang;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) {
      var p = n.parentNode; if (!p || skip(p)) continue;
      var rec = orig.get(n), base = rec && n.data === rec.out ? rec.src : n.data, out = lang === 'en' ? base : tr(base); // new text from the app counts as English
      if (out !== n.data) { orig.set(n, { src: base, out: out }); n.data = out; } else if (rec && out === base) orig.delete(n);
    }
    document.querySelectorAll('[placeholder],[aria-label],[title]').forEach(function (el) {
      if (skip(el)) return;
      var rec = oattr.get(el) || {};
      ATTR.forEach(function (a) {
        if (!el.hasAttribute(a)) return;
        var cur = el.getAttribute(a), r = rec[a], base = r && cur === r.out ? r.src : cur, out = lang === 'en' ? base : tr(base);
        if (out !== cur) { rec[a] = { src: base, out: out }; el.setAttribute(a, out); }
      });
      oattr.set(el, rec);
    });
  }
  var sel = document.createElement('select'); sel.id = 'lg'; sel.setAttribute('aria-label', 'Language');
  sel.innerHTML = L.map(function (l) { return '<option value="' + l[0] + '"' + (l[0] === lang ? ' selected' : '') + '>' + l[1] + '</option>'; }).join('');
  document.querySelector('.tw').prepend(sel);
  sel.onchange = function () { lang = sel.value; try { localStorage.setItem('lang', lang); } catch (e) {} apply(); window.dispatchEvent(new HashChangeEvent('hashchange')); };
  var t, obs = new MutationObserver(function () { clearTimeout(t); t = setTimeout(run, 30); });
  function run() { obs.disconnect(); apply(); obs.observe(document.body, { childList: true, subtree: true, characterData: true }); }
  run();
})();
