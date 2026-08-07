/* ==========================================================================
   config/trustStatusBar.js
   ---------------------------------------------------------------------------
   Sticky Trust Status Bar — data source configuration.

   This bar shows only genuine, static trust indicators — things that are
   always true about how EazyPDF works, not numbers that pretend to be
   "live." There is no random-number generator, no counter that ticks up on
   a timer, and no fabricated "Users Online" style figure anywhere in this
   file or the two it pairs with (css/trust-status-bar.css,
   js/trust-status-bar.js).

     - "static"  Default and current mode. Renders the badges[] list below
                 and nothing else. No network calls, no fake data.
     - "backend" Reserved for the future. Only meaningful once a verified,
                 authenticated first-party API actually exists. Until
                 `backend.endpoint` is set to a real, working endpoint,
                 fetchSnapshot() below returns null and
                 js/trust-status-bar.js will not render any numeric stat —
                 it only ever adds real numbers on top of the static
                 badges, never in place of them, and never invents a
                 fallback value when the request fails.

   Public surface: window.TrustStatusBarConfig
   ========================================================================== */
(function () {

  var TrustStatusBarConfig = {

    /* "static" | "backend" */
    mode: "static",

    /* ---------------------------------------------------------------------
       Static trust badges. Every claim here must be true of the product
       as shipped — this list is the whole bar in "static" mode.
       ------------------------------------------------------------------ */
    badges: [
      {
        id: "browser",
        icon: "🟢",
        label: "Browser Processing",
        description: "All supported PDF operations run locally in your browser whenever possible."
      },
      {
        id: "device",
        icon: "🔒",
        label: "Files Never Leave Your Device",
        description: "Your files are processed locally for supported tools and are not uploaded to our servers."
      },
      {
        id: "unlimited",
        icon: "∞",
        label: "Unlimited Usage",
        description: "Use EazyPDF without mandatory registration or daily limits."
      },
      {
        id: "fast",
        icon: "⚡",
        label: "Fast Processing",
        description: "Optimized client-side processing for quick results."
      },
      {
        id: "secure",
        icon: "🛡️",
        label: "Secure & Private",
        description: "Designed with privacy-first principles."
      }
    ],

    /* ---------------------------------------------------------------------
       BACKEND MODE (future — inactive until endpoint is a real, verified
       first-party API)
       ------------------------------------------------------------------ */
    backend: {
      /* e.g. "/api/live-stats" — left null until a real, authenticated
         endpoint exists. js/trust-status-bar.js only displays a stat it
         gets back from here; it never generates one itself. */
      endpoint: null,
      pollMs: 30000,

      /* Returns a snapshot of REAL measured numbers, or null if not (yet)
         configured / the request failed. A null result means "show the
         static badges only, add no numbers" — it is never replaced with
         a simulated value. */
      fetchSnapshot: async function () {
        if (!this.endpoint) return null;
        try {
          var res = await fetch(this.endpoint, { cache: "no-store" });
          if (!res.ok) return null;
          return await res.json();
        } catch (e) {
          return null;
        }
      }
    }

    /* Snapshot shape expected from a future verified backend — every field
       optional, and only ever rendered when actually present:
       {
         usersOnline: number,        // real concurrent sessions
         filesProcessedToday: number,// real counter from server logs
         uptimePct: number,          // real measured uptime
         avgProcessingTimeSec: number
       }
    */
  };

  window.TrustStatusBarConfig = TrustStatusBarConfig;

})();
