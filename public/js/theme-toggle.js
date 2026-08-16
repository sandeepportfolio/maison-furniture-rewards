/* ── Regent Theme Toggle ──
   Shared across all BookWithRegent.com pages.
   Reads/writes localStorage('regent-theme'). Sets data-theme on <html>.
   Call regentThemeInit() immediately in a blocking <script> in <head> to avoid FOUC. */

(function(){
  'use strict';
  var KEY = 'regent-theme';

  // Apply saved theme ASAP (call from <head> to prevent flash)
  function applyStored(){
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch(e){}
    if(saved === 'light' || saved === 'dark'){
      document.documentElement.setAttribute('data-theme', saved);
    }
    // If nothing stored, leave default (each page decides its own default)
  }

  // Toggle between light/dark
  function toggle(){
    var current = document.documentElement.getAttribute('data-theme') || 'dark';
    var next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch(e){}
    updateIcons();
  }

  // Update all toggle button icons on the page
  function updateIcons(){
    var theme = document.documentElement.getAttribute('data-theme') || 'dark';
    var btns = document.querySelectorAll('.theme-toggle-btn');
    for(var i=0;i<btns.length;i++){
      var sun = btns[i].querySelector('.theme-icon-sun');
      var moon = btns[i].querySelector('.theme-icon-moon');
      if(sun && moon){
        // Sun = currently light (tap to go dark). Moon = currently dark (tap to go light).
        sun.style.display = theme === 'dark' ? 'none' : 'block';
        moon.style.display = theme === 'dark' ? 'block' : 'none';
      }
      btns[i].setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    }
  }

  // Public API
  window.regentThemeInit = applyStored;
  window.regentThemeToggle = toggle;
  window.regentThemeUpdateIcons = updateIcons;

  // Auto-apply on load
  applyStored();

  // Update icons once DOM is ready
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', updateIcons);
  } else {
    updateIcons();
  }
})();
