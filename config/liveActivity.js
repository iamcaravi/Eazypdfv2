/* ==========================================================================
   config/liveActivity.js
   ---------------------------------------------------------------------------
   Sticky Live Activity Bar — data source configuration.

   This file is the single place that decides WHERE the bar's numbers come
   from. It ships three modes:

     - "demo"      Fully self-contained, realistic-looking counters. This is
                    the default and needs no setup — it's what powers the
                    bar today.
     - "analytics" Stubbed for a future Google Analytics (GA4 Realtime) or
                    Cloudflare Analytics integration. fetchSnapshot() below
                    returns null until a provider + credentials are wired
                    in, at which point js/live-activity-bar.js will use
                    whatever it returns instead of demo data.
     - "backend"   Stubbed for a future first-party API. Point `endpoint`
                    at a JSON endpoint that returns a snapshot shaped like
                    DEMO_SNAPSHOT_SHAPE (see bottom of this file) and it
                    will be polled automatically.

   Switching modes is a one-line change (LiveActivityConfig.mode) — no other
   file needs to know which mode is active. js/live-activity-bar.js falls
   back to demo data whenever the active mode's fetchSnapshot() returns
   null/undefined, so the bar never ends up empty just because a future
   integration isn't configured yet.

   Public surface: window.LiveActivityConfig
   ========================================================================== */
(function () {

  var LiveActivityConfig = {

    /* "demo" | "analytics" | "backend" */
    mode: "demo",

    /* ---------------------------------------------------------------------
       DEMO MODE
       Realistic, slowly-drifting numbers. Each metric below defines its own
       starting point and how it's allowed to move on every tick — see
       js/live-activity-bar.js's DemoProvider for how these are applied.
       - "walk" metrics (usersOnline) nudge up or down within [min,max].
       - "counter" metrics (filesProcessedToday, pdfsConvertedToday) only
         ever increase, like a real running total would.
       - "jitter" metrics (avgProcessingTimeSec, successRatePct) hover
         close to a fixed baseline.
       ------------------------------------------------------------------ */
    demo: {
      usersOnline: {
        start: 1248, min: 1050, max: 2400,
        stepMin: -3, stepMax: 4
      },
      filesProcessedToday: {
        start: 89593,
        stepMin: 1, stepMax: 6
      },
      pdfsConvertedToday: {
        start: 12483,
        stepMin: 1, stepMax: 3
      },
      avgProcessingTimeSec: {
        base: 2.8, min: 1.6, max: 4.2, jitter: 0.3
      },
      successRatePct: {
        base: 99.98, min: 99.90, max: 100, jitter: 0.02
      },
      browserProcessingOperational: true,

      /* How often the bar nudges its numbers. A single shared tick (not one
         timer per metric) keeps this lightweight — see "Performance" in
         the feature spec. Randomized within this range so it doesn't feel
         mechanical. */
      tickMinMs: 2800,
      tickMaxMs: 5200
    },

    /* ---------------------------------------------------------------------
       ANALYTICS MODE (future)
       ------------------------------------------------------------------ */
    analytics: {
      /* "google" | "cloudflare" | null */
      provider: null,

      /* TODO(analytics): fill in once a provider is chosen, e.g.
         google:     { propertyId: "" }
         cloudflare: { zoneTag: "", apiToken: "" }
      */
      google: { propertyId: "" },
      cloudflare: { zoneTag: "", apiToken: "" },

      /* Returns a snapshot (see shape at the bottom of this file) or null
         if not yet configured. js/live-activity-bar.js treats null as
         "fall back to demo data for this tick". */
      fetchSnapshot: async function () {
        // TODO(analytics): call GA4 Realtime API or the Cloudflare
        // Analytics GraphQL API here, map the response onto the snapshot
        // shape, and return it.
        return null;
      }
    },

    /* ---------------------------------------------------------------------
       BACKEND MODE (future)
       ------------------------------------------------------------------ */
    backend: {
      /* e.g. "/api/live-activity" — left null until a real endpoint exists */
      endpoint: null,
      pollMs: 30000,

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

    /* Snapshot shape every mode is expected to (eventually) produce:
       {
         usersOnline: number,
         filesProcessedToday: number,
         pdfsConvertedToday: number,
         avgProcessingTimeSec: number,
         successRatePct: number,
         browserProcessingOperational: boolean
       }
    */
  };

  window.LiveActivityConfig = LiveActivityConfig;

})();
