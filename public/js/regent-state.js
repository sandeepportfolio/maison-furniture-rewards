/**
 * Regent session-state persistence.
 *
 * Restores the page exactly as the guest left it across refreshes:
 * scroll position, carousel slides, minimized cards, active filter,
 * show-more expansion (homepage); scroll, hero photo, open gallery
 * (glance pages).
 *
 * - sessionStorage (per-tab, clears on browser close), keyed by pathname
 *   so different glance pages never collide
 * - loaded with `defer` AFTER the page's inline script: globals exist,
 *   but DOMContentLoaded has not fired yet — so homepage state is seeded
 *   into carouselState/collapsedCards/currentCategoryFilter BEFORE
 *   renderProperties() builds the DOM (no flash of wrong state)
 * - the map overlay + detail modal already persist via the URL hash
 *   (#map/slug, #property/slug) — this module deliberately leaves them
 *   to the existing hash restore and only skips scroll restore when an
 *   overlay owns the viewport
 * - writes are wrap-around hooks on the page's own interaction functions
 *   plus a debounced scroll listener and a pagehide flush
 */
(function () {
  'use strict';

  var KEY = 'regent_state:' + location.pathname;
  var state = {};
  try { state = JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch (e) { state = {}; }

  var writeT = null;
  function save(patch) {
    if (patch) for (var k in patch) state[k] = patch[k];
    clearTimeout(writeT);
    writeT = setTimeout(flush, 120);
  }
  function flush() {
    clearTimeout(writeT);
    try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* quota/private mode */ }
  }

  // Wrap a global function so `after(args)` runs post-invocation.
  function hook(name, after) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      var out = orig.apply(this, arguments);
      try { after.apply(this, arguments); } catch (e) { /* never break the page */ }
      return out;
    };
  }

  // Debounced scroll capture (200ms) — never store while a fullscreen
  // overlay owns the viewport (body scroll is locked at 0 then).
  var scrollT = null;
  window.addEventListener('scroll', function () {
    clearTimeout(scrollT);
    scrollT = setTimeout(function () {
      if (document.body.style.overflow === 'hidden') return;
      save({ y: window.scrollY });
    }, 200);
  }, { passive: true });
  window.addEventListener('pagehide', function () {
    if (document.body.style.overflow !== 'hidden') state.y = window.scrollY;
    flush();
  });

  // Restore scroll once the document is tall enough to hold the target —
  // dynamic content (property grid, photo strip) hasn't rendered when the
  // page loads, so a naive scrollTo would land short.
  function restoreScroll() {
    var y = state.y;
    if (!y || y < 1) return;
    if (location.hash.indexOf('#map') === 0 || location.hash.indexOf('#property/') === 0) return;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    var tries = 0;
    (function attempt() {
      var ready = document.documentElement.scrollHeight >= y + window.innerHeight;
      if (ready || tries > 60) {
        window.scrollTo(0, y);
        if (Math.abs(window.scrollY - y) > 2 && tries <= 60) { tries++; requestAnimationFrame(attempt); }
      } else {
        tries++;
        requestAnimationFrame(attempt);
      }
    })();
  }

  // ── Homepage wiring ────────────────────────────────────────────────
  // NOTE: carouselState / collapsedCards / currentCategoryFilter are
  // top-level const/let in the page script — shared via the global lexical
  // environment but NOT window properties. They must be referenced as bare
  // identifiers, only inside this gated branch (elsewhere they'd throw).
  if (typeof window.renderProperties === 'function') {
    // Seed BEFORE DOMContentLoaded's renderProperties() so cards build in
    // their restored state — no post-render correction, no flash.
    if (state.carousel) {
      for (var slug in state.carousel) carouselState[slug] = state.carousel[slug];
    }
    if (Array.isArray(state.collapsed)) {
      state.collapsed.forEach(function (s) { collapsedCards.add(s); });
    }
    if (state.filter) {
      currentCategoryFilter = state.filter;
      document.querySelectorAll('.coll-filter-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.filter === state.filter);
      });
    }

    // Writes
    hook('carouselMove', function () { save({ carousel: carouselState }); });
    hook('goToSlide', function () { save({ carousel: carouselState }); });
    hook('togglePropInfo', function () { save({ collapsed: Array.from(collapsedCards) }); });
    hook('setPropertyFilter', function (f) { save({ filter: f }); });
    hook('toggleExploreExpand', function (section) {
      var grid = document.getElementById(section === 'events' ? 'exploreEventsGrid' : 'exploreGrid');
      var patch = {};
      patch[section + 'Expanded'] = !!(grid && grid.classList.contains('expanded'));
      save(patch);
    });

    window.addEventListener('DOMContentLoaded', function () {
      // Re-expand show-more sections (idempotent: only toggle when needed).
      ['events', 'attractions'].forEach(function (section) {
        if (!state[section + 'Expanded']) return;
        var grid = document.getElementById(section === 'events' ? 'exploreEventsGrid' : 'exploreGrid');
        if (grid && !grid.classList.contains('expanded') && typeof window.toggleExploreExpand === 'function') {
          window.toggleExploreExpand(section);
        }
      });
      requestAnimationFrame(restoreScroll);
    });
  }

  // ── Glance wiring ──────────────────────────────────────────────────
  if (typeof window.setHeroPhoto === 'function' && typeof window.openGallery === 'function') {
    // Writes
    hook('setHeroPhoto', function () { save({ hero: window.currentHeroIdx }); });
    hook('openGallery', function () { save({ galleryOpen: true, galleryIdx: window.galleryIdx }); });
    hook('galleryNav', function () { save({ galleryIdx: window.galleryIdx }); });
    hook('closeGallery', function () { save({ galleryOpen: false }); });

    // Restore. init() already ran inline; an explicit ?photo= deep link
    // outranks the stored hero.
    var urlPhoto = new URLSearchParams(location.search).get('photo');
    if (urlPhoto === null && typeof state.hero === 'number' && state.hero !== window.currentHeroIdx) {
      window.setHeroPhoto(state.hero);
    }
    if (state.galleryOpen && typeof state.galleryIdx === 'number') {
      window.openGallery(state.galleryIdx);
    }
    restoreScroll();
  }
})();
