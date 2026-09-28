(function () {
  try {
    var stored = localStorage.getItem('lx_theme_mode');
    var mode = stored === 'light' || stored === 'dark' ? stored : 'system';
    var eff = mode === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode;
    document.documentElement.setAttribute('data-theme', eff);
    document.documentElement.setAttribute('data-theme-mode', mode);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-theme-mode', 'system');
  }
})();
