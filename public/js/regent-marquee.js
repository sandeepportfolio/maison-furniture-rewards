/**
 * Regent shared marquee engine.
 *
 * Attaches drag/swipe + auto-resume behavior to any element marked with
 * data-marquee="<speed>" (px per frame; sign = direction: positive scrolls
 * left, negative scrolls right). The element must contain two identical
 * copies of its content so translating by half its scrollWidth loops
 * seamlessly.
 *
 * Behaviors:
 *  - auto-scrolls via rAF; hover pauses (desktop)
 *  - mouse drag / touch swipe moves the track; release resumes auto-scroll
 *    after 1.6s FROM THE DROP POSITION, in the track's original direction
 *  - touch only engages once the gesture is clearly horizontal (6px intent,
 *    |dx| > |dy|) so vertical page scrolling is never hijacked
 *  - position normalized into (-width/2, 0] with a modulo wrap valid for
 *    any fling distance in either direction
 *  - loop width re-measures after webfonts land, on resize, and whenever
 *    the track's children change (dynamic tickers)
 *  - prefers-reduced-motion: no auto-scroll, manual drag still works
 */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function attach(track, speed) {
    if (!track || track.dataset.marqueeAttached) return;
    track.dataset.marqueeAttached = '1';

    var pos = 0;
    var halfW = 0;
    var dragging = false, startX = 0, startY = 0, startPos = 0;
    var touchDecided = false;
    var resumeTimer = null;
    var paused = reduceMotion;

    function measure() {
      halfW = track.scrollWidth / 2;
      wrap();
    }

    function wrap() {
      if (!halfW) return;
      pos = -((((-pos) % halfW) + halfW) % halfW);
    }

    function tick() {
      if (!paused && !dragging && halfW) {
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

    // Keep the loop period honest: fonts, resize, and content changes.
    measure();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(measure);
    }
    var resizeT = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeT);
      resizeT = setTimeout(measure, 150);
    });
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(measure).observe(track, { childList: true, subtree: true });
    }

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
