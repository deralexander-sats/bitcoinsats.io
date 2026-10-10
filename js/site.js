/* Hell-/Dunkel-Umschalter und Menü. Das Start-Theme setzt ein kleiner Inline-Code im <head>. */
(function () {
  var root = document.documentElement;
  var themeBtn = document.getElementById('theme');
  var menuBtn = document.getElementById('menubtn');
  var menu = document.getElementById('menu');

  function themeLabel() {
    var dark = root.dataset.theme === 'dark';
    themeBtn.textContent = dark ? '☀' : '☾';
    themeBtn.setAttribute('aria-label', dark ? 'Zum hellen Design wechseln' : 'Zum dunklen Design wechseln');
  }
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var t = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = t;
      try { localStorage.setItem('theme', t); } catch (e) {}
      themeLabel();
    });
    themeLabel();
  }

  function setMenu(open) {
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (menuBtn && menu) {
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setMenu(menu.hidden);
    });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !menu.contains(e.target)) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) { setMenu(false); menuBtn.focus(); }
    });
    var here = location.pathname.replace(/index\.html$/, '');
    menu.querySelectorAll('a').forEach(function (a) {
      if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page');
    });
  }
})();
