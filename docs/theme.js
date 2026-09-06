// Applique le thème mémorisé avant le rendu (évite le flash), sur toutes les pages.
(() => {
  let t = 'auto'; try { t = JSON.parse(localStorage.getItem('theme')) || 'auto'; } catch {}
  document.documentElement.dataset.theme = t === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
})();
