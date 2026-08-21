/* Open-Shannon — theme bootstrap: system resolution, no FOUC, cross-page sync.
   Must load in <head> before paint. Sets data-theme on <html> and dispatches
   a "themechange" event when the theme flips (system pref change or cross-tab sync). */
(function () {
  'use strict';

  var STORAGE_KEY = 'shannon-theme';
  var mql = window.matchMedia('(prefers-color-scheme: light)');

  function resolveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return mql.matches ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: theme } }));
  }

  function getStoredPref() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function setStoredPref(pref) {
    try { localStorage.setItem(STORAGE_KEY, pref); } catch (e) {}
  }

  // Apply before first paint
  var pref = getStoredPref();
  applyTheme(resolveTheme(pref));

  // System preference changed (only matters if user selected "system")
  mql.addEventListener('change', function (e) {
    if (!getStoredPref() || getStoredPref() === 'system') {
      applyTheme(e.matches ? 'light' : 'dark');
    }
  });

  // Cross-tab sync
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) {
      applyTheme(resolveTheme(e.newValue));
    }
  });

  // Public API for settings modal
  window.ShannonTheme = {
    get: function () { return getStoredPref() || 'system'; },
    set: function (pref) {
      setStoredPref(pref);
      applyTheme(resolveTheme(pref));
    },
    resolved: function () {
      return document.documentElement.getAttribute('data-theme');
    }
  };
})();
