(function () { // runs before the page paints so there is no flash of the wrong design
  var t = null; try { t = localStorage.getItem('theme'); } catch (e) {}
  if (['sunny', 'heritage', 'midnight', 'blossom', 'clean'].indexOf(t) < 0)
    t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'midnight' : 'sunny';
  document.documentElement.setAttribute('data-theme', t);
})();
