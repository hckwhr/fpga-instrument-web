// Apply the saved palette before CSS paints; storage may be unavailable in a WebView.
(() => {
  let theme = 'light';
  try {
    if (localStorage.getItem('instrument-theme') === 'dark') theme = 'dark';
  } catch { /* Keep the warm daytime default. */ }
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#211e1b' : '#f5f1e9';
})();
