/**
 * Regent shared marquee engine.
 *
 * Attaches drag/swipe + auto-resume behavior to any element marked with
 * data-marquee="<speed>" (px per frame; sign = direction: positive scrolls
 * left, negative scrolls right).
 *
 * The markup supplies ONE loop unit's worth of content — however many items
 * that is. The engine then clones that unit until the track is at least one
 * full unit wider than its container, and loops on the unit's width, so the
 * strip is continuous at any viewport size with no blank stretch. It used to
 * assume the caller had hand-duplicated the content and looped on
 * scrollWidth/2, which only held while the content happened to be wider than
 * the container: on a 1920px page the glance ticker's half-width was 495px,
 * leaving 1426px of empty track on every pass. Callers that still ship two
 * copies are fine — that pair simply becomes the unit.
 *
 * Behaviors:
 *  - auto-scrolls via rAF; hover pauses (desktop)
 *  - mouse drag / touch swipe moves the track; release resumes auto-scroll
 *    after 1.6s FROM THE DROP POSITION, in the track's original direction
 *  - touch only engages once the gesture is clearly horizontal (6px intent,
 *    |dx| > |dy|) so vertical page scrolling is never hijacked
 *  - position normalized into (-unitWidth, 0] with a modulo wrap valid for
 *    any fling distance in either direction
 *  - the unit is re-measured and the fill rebuilt after webfonts land, on
 *    resize, and whenever the caller replaces the track's children (dynamic
 *    tickers); the observer is detached while the engine rewrites the track
 *    so its own clones never retrigger it
 *  - prefers-reduced-motion: no auto-scroll, manual drag still works
 */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function attach(track, speed) {
    if (!track || track.dataset.marqueeAttached) return;
    track.dataset.marqueeAttached = '1';

    var pos = 0;
    var unitW = 0;
    var baseHTML = null;
    var observer = null;
    var dragging = false, startX = 0, startY = 0, startPos = 0;
    var touchDecided = false;
    var resumeTimer = null;
    var paused = reduceMotion;

    // Render one unit, measure it, then clone until the track is at least a
    // full unit wider than the container. Translating by up to unitW can then
    // never expose the end of the strip.
    function rebuild() {
      if (observer) observer.disconnect();
      if (baseHTML === null) baseHTML = track.innerHTML;

      track.innerHTML = baseHTML;
      unitW = track.scrollWidth;

      if (unitW > 0) {
        var container = track.parentElement;
        var containerW = (container && container.clientWidth) || window.innerWidth || 0;
        var copies = Math.ceil((containerW + unitW) / unitW) + 1;
        if (copies < 2) copies = 2;
        var html = '';
        for (var i = 0; i < copies; i++) html += baseHTML;
        track.innerHTML = html;
      }

      wrap();
      if (observer) observer.observe(track, { childList: true, subtree: true });
    }

    function wrap() {
      if (!unitW) return;
      pos = -((((-pos) % unitW) + unitW) % unitW);
    }

    function tick() {
      if (!paused && !dragging && unitW) {
        pos -= speed;
        wrap();
      }
      track.style.transform = 'translateX(' + pos + 'px)';
      requestAnimationFrame(tick);
    }

    function endDrag() {
      if (!dragging && !touchDecided) return;
      dragging = false;
      touchDecided = false;
      track.classList.remove('dragging');
      clearTimeout(resumeTimer);
      paused = true;
      if (!reduceMotion) {
        resumeTimer = setTimeout(function () { paused = false; }, 1600);
      }
    }

    // Mouse drag
    track.addEventListener('mousedown', function (e) {
      dragging = true; startX = e.clientX; startPos = pos;
      track.classList.add('dragging');
      clearTimeout(resumeTimer);
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      pos = startPos + (e.clientX - startX);
      wrap();
    });
    window.addEventListener('mouseup', function () {
      if (dragging) endDrag();
    });

    // Touch drag with horizontal-intent detection
    track.addEventListener('touchstart', function (e) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startPos = pos;
      touchDecided = false;
      clearTimeout(resumeTimer);
    }, { passive: true });
    track.addEventListener('touchmove', function (e) {
      var dx = e.touches[0].clientX - startX;
      var dy = e.touches[0].clientY - startY;
      if (!touchDecided) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        touchDecided = true;
        dragging = Math.abs(dx) > Math.abs(dy);
        if (dragging) track.classList.add('dragging');
      }
      if (!dragging) return;
      pos = startPos + dx;
      wrap();
    }, { passive: true });
    track.addEventListener('touchend', endDrag);
    track.addEventListener('touchcancel', endDrag);

    // Hover pause (desktop)
    track.addEventListener('mouseenter', function () {
      if (!dragging) { paused = true; clearTimeout(resumeTimer); }
    });
    track.addEventListener('mouseleave', function () {
      if (!dragging && !reduceMotion) {
        resumeTimer = setTimeout(function () { paused = false; }, 800);
      }
    });

    // Keep the loop period and the fill honest: fonts, resize, and content
    // changes. A caller replacing the track's children invalidates the cached
    // unit, so drop it and re-derive from the new markup.
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(function () {
        baseHTML = null;
        rebuild();
      });
    }
    rebuild();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(rebuild);
    }
    var resizeT = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeT);
      resizeT = setTimeout(rebuild, 150);
    });

    tick();
  }

  function auto(root) {
    var nodes = (root || document).querySelectorAll('[data-marquee]');
    for (var i = 0; i < nodes.length; i++) {
      var s = parseFloat(nodes[i].getAttribute('data-marquee'));
      attach(nodes[i], (isNaN(s) || !s) ? 0.6 : s);
    }
  }

  window.RegentMarquee = { attach: attach, auto: auto };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { auto(); });
  } else {
    auto();
  }
})();
