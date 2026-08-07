/* ==========================================================================
   js/trust-status-bar.js
   ---------------------------------------------------------------------------
   Sticky Trust Status Bar — replaces the old "Live Activity Bar" that
   simulated Users Online / Files Processed Today / Success Rate etc.

   This file renders ONLY the static badges from
   config/trustStatusBar.js. There is no timer that fabricates numbers, no
   Math.random() anywhere below, and no "demo mode." If a real backend is
   ever wired up via TrustStatusBarConfig.backend.endpoint, this file will
   layer verified numbers on top of the static badges — never invent one
   itself, and never show a number while that number is unverified.

   Depends on: config/trustStatusBar.js having already run (must be
   included first) so window.TrustStatusBarConfig exists.

   Public surface: window.TrustStatusBar.init()  (auto-called at the
   bottom of this file, same pattern as the other bottom-of-body scripts
   in index.html).
   ========================================================================== */
(function () {

  function buildBadgeButton(badge) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trust-bar-badge';
    btn.id = 'trustBadge-' + badge.id;
    btn.setAttribute('data-badge-id', badge.id);
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'trustStatusPopover');
    btn.setAttribute('aria-label', badge.label + ' — activate for details');

    var icon = document.createElement('span');
    icon.className = 'trust-bar-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = badge.icon;

    var label = document.createElement('span');
    label.className = 'trust-bar-label';
    label.textContent = badge.label;

    btn.appendChild(icon);
    btn.appendChild(label);
    return btn;
  }

  function renderBar(bar, badges) {
    bar.innerHTML = '';
    badges.forEach(function (badge) {
      bar.appendChild(buildBadgeButton(badge));
    });
  }

  function init() {
    var bar = document.getElementById('trustStatusBar');
    var popover = document.getElementById('trustStatusPopover');
    var popoverTitle = document.getElementById('trustStatusPopoverTitle');
    var popoverDesc = document.getElementById('trustStatusPopoverDesc');
    var popoverExtra = document.getElementById('trustStatusPopoverExtra');
    if (!bar || !popover || !popoverTitle || !popoverDesc) return;

    var body = document.body;
    var overlayEl = document.getElementById('overlay');
    var config = window.TrustStatusBarConfig || { badges: [] };
    var badges = config.badges || [];
    var badgesById = {};
    badges.forEach(function (b) { badgesById[b.id] = b; });

    renderBar(bar, badges);

    var canHover = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

    /* Real, verified data only — populated (if ever) from a real backend.
       Never seeded with a placeholder/demo value. */
    var realExtras = null; // e.g. { browser: "Uptime: 99.98% (last 30 days)" }

    function fetchRealDataIfConfigured() {
      if (config.mode !== 'backend' || !config.backend || typeof config.backend.fetchSnapshot !== 'function') return;
      Promise.resolve(config.backend.fetchSnapshot()).then(function (snap) {
        if (snap && snap.badgeExtras) realExtras = snap.badgeExtras;
      }).catch(function () { /* stay silent — badges remain static-only */ });
    }
    fetchRealDataIfConfigured();

    /* ---- Popover open/close, content driven by whichever badge is active ---- */
    var activeTrigger = null;
    var closeTimer = null;

    function clearCloseTimer() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    }

    function positionPopover(trigger) {
      var barRect = bar.getBoundingClientRect();
      var triggerRect = trigger.getBoundingClientRect();
      var center = triggerRect.left + triggerRect.width / 2;
      var half = popover.offsetWidth / 2 || 150;
      var margin = 12;
      var min = half + margin;
      var max = window.innerWidth - half - margin;
      var clamped = Math.max(min, Math.min(max, center));
      popover.style.left = clamped + 'px';
      popover.style.setProperty('--trust-arrow-offset', (center - clamped) + 'px');
    }

    function openPopoverFor(trigger) {
      var badge = badgesById[trigger.getAttribute('data-badge-id')];
      if (!badge) return;
      clearCloseTimer();
      if (activeTrigger && activeTrigger !== trigger) {
        activeTrigger.setAttribute('aria-expanded', 'false');
      }
      activeTrigger = trigger;
      popoverTitle.textContent = badge.label;
      popoverDesc.textContent = badge.description;
      if (popoverExtra) {
        var extra = realExtras && realExtras[badge.id];
        popoverExtra.textContent = extra || '';
        popoverExtra.style.display = extra ? '' : 'none';
      }
      trigger.setAttribute('aria-expanded', 'true');
      popover.classList.add('open');
      positionPopover(trigger);
    }

    function closePopover() {
      clearCloseTimer();
      popover.classList.remove('open');
      if (activeTrigger) activeTrigger.setAttribute('aria-expanded', 'false');
      activeTrigger = null;
    }

    function closePopoverSoon() {
      clearCloseTimer();
      closeTimer = setTimeout(closePopover, 160);
    }

    bar.addEventListener('click', function (e) {
      var trigger = e.target.closest('.trust-bar-badge');
      if (!trigger) return;
      if (activeTrigger === trigger && popover.classList.contains('open')) {
        closePopover();
      } else {
        openPopoverFor(trigger);
      }
    });

    if (canHover) {
      bar.addEventListener('mouseover', function (e) {
        var trigger = e.target.closest('.trust-bar-badge');
        if (!trigger) return;
        openPopoverFor(trigger);
      });
      bar.addEventListener('mouseleave', closePopoverSoon);
      popover.addEventListener('mouseenter', clearCloseTimer);
      popover.addEventListener('mouseleave', closePopoverSoon);
    }

    bar.addEventListener('focusin', function (e) {
      var trigger = e.target.closest('.trust-bar-badge');
      if (trigger) openPopoverFor(trigger);
    });
    bar.addEventListener('focusout', function (e) {
      if (!bar.contains(e.relatedTarget) && !popover.contains(e.relatedTarget)) closePopoverSoon();
    });

    document.addEventListener('click', function (e) {
      if (!popover.classList.contains('open')) return;
      if (bar.contains(e.target) || popover.contains(e.target)) return;
      closePopover();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && popover.classList.contains('open')) {
        var toFocus = activeTrigger;
        closePopover();
        if (toFocus) toFocus.focus();
      }
    });
    window.addEventListener('resize', function () {
      if (activeTrigger) positionPopover(activeTrigger);
    }, { passive: true });

    /* ---- Visibility: hidden inside the fullscreen Edit PDF workspace ---- */
    function syncBarHeight() {
      if (bar.classList.contains('trust-bar-hidden')) {
        document.documentElement.style.setProperty('--trust-bar-height', '0px');
        return;
      }
      var h = bar.getBoundingClientRect().height;
      if (h > 0) document.documentElement.style.setProperty('--trust-bar-height', h + 'px');
    }
    function setBarVisible(visible) {
      bar.classList.toggle('trust-bar-hidden', !visible);
      body.classList.toggle('has-trust-bar', visible);
      if (!visible) closePopover();
      syncBarHeight();
    }
    setBarVisible(true);
    window.addEventListener('resize', syncBarHeight, { passive: true });

    if (overlayEl) {
      /* Hide for ANY open tool panel, not just the special Edit PDF
         fullscreen mode - every tool now opens as a full-page overlay
         (added after this bar was first built), and with a higher
         z-index than the overlay, the bar was sitting on top of the
         bottom ~48px of every regular tool's content/sidebar. */
      var fullscreenObserver = new MutationObserver(function () {
        setBarVisible(!overlayEl.classList.contains('open'));
      });
      fullscreenObserver.observe(overlayEl, { attributes: true, attributeFilter: ['class'] });
      setBarVisible(!overlayEl.classList.contains('open'));
    }
  }

  window.TrustStatusBar = { init: init };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
