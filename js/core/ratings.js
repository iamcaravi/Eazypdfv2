/* ---------------- Ratings (tool + website) ----------------
   Plain classic script (same convention as every other js/core/*.js file
   here - no bundler/module system, all of them share one global scope via
   defer <script> tags, see index.html's own header comment on why).

   Two logically separate rating subjects, matching the real API in
   netlify/functions/rating.js:
     - "tool"  - answers "how useful was THIS tool" (toolId-scoped)
     - "site"  - answers "how would you rate YOYOPDF overall" (independent)
   Never mixed: a tool vote never touches the site aggregate and vice
   versa. buildRatingWidget() below still supports both, but only "tool"
   currently has a mount point in the UI (mountToolRating(), on the tool
   result screen) - the old footer "Rate YOYOPDF" mount for "site" was
   removed as redundant, see mountTrustStripRating()/mountAboutStatRating()
   below. A third read-only value, "overall" (the vote-weighted aggregate
   across every tool's votes, maintained server-side), is what the
   homepage trust strip and About stats strip show as YOYOPDF's headline
   rating - see the API's own comments for how that weighting works.

   No fake numbers, ever: every number this file renders comes from a
   `/api/rating` response. If that fetch fails (e.g. running the plain
   python dev server instead of `netlify dev` - see package.json's
   "dev:netlify" script and this repo's README for why), the widget says
   so explicitly ("Ratings unavailable right now") rather than silently
   showing "No ratings yet", which would be indistinguishable from a
   genuinely empty, working rating store.

   Privacy: no cookies. Each browser gets one random anonymous id
   (crypto.randomUUID, not derived from anything identifying) stored in
   localStorage solely so the server can recognize "you already rated
   this" and update rather than double-count your vote - the server is
   still the authority on the actual vote counts (see the API file). This
   keeps the site's existing Privacy page claim ("No analytics, cookies,
   or user profiling") true; localStorage here is a per-browser
   convenience id, not a tracker, and is never sent anywhere except this
   one same-origin rating endpoint. */

const RATING_VOTER_KEY = "yoyopdf-voter-id";
const RATING_VOTED_PREFIX = "yoyopdf-voted-"; // yoyopdf-voted-tool-<id> / yoyopdf-voted-site

function ratingVoterToken(){
  try {
    let id = localStorage.getItem(RATING_VOTER_KEY);
    if(!id){
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ("v-" + Date.now() + "-" + Math.random().toString(36).slice(2));
      localStorage.setItem(RATING_VOTER_KEY, id);
    }
    return id;
  } catch(e) {
    // Private-browsing / storage-disabled fallback: a per-page-load token
    // still lets the vote itself succeed, it just won't be remembered as
    // "already voted" locally next visit (the server-side dedupe by
    // hashed token still works for THIS submission).
    return "v-session-" + Math.random().toString(36).slice(2);
  }
}

/* Optional, no-op unless a real analytics provider is ever wired up
   (none exists in this project today - see this file's own header
   comment and the Privacy page's "no analytics" claim). Kept as a single
   guarded call site so turning on real analytics later is a one-line
   change here, not a hunt through every call site below. */
function ratingTrack(eventName, params){
  try { window.YOYO_ANALYTICS && window.YOYO_ANALYTICS.track && window.YOYO_ANALYTICS.track(eventName, params); } catch(e) {}
}

/**
 * Every rating GET/POST goes through here. Two failure UX paths (a
 * quiet "Ratings unavailable"/"Unable to submit" message, never a fake
 * number) are handled by each caller's own .catch() - this function's
 * only job on top of that is to make failures ACTUALLY DIAGNOSABLE
 * (Part "error handling" requirement: never silently swallow an API
 * error) by logging the real method/URL/status/body to the console
 * before re-throwing, instead of every call site's .catch(()=>{...})
 * discarding the underlying error entirely. Nothing here is secret -
 * this API never returns credentials, only vote counts/averages - so
 * logging the full response is safe.
 */
function ratingFetchJSON(url, options){
  return fetch(url, options)
    .catch(networkError=>{
      // fetch() itself only rejects for a genuine network-level failure
      // (DNS, connection refused, CORS block) - a plain 404/500 response
      // still resolves normally and is handled in the .then() below. Seeing
      // THIS branch fire for /api/rating locally almost always means the
      // current dev server has no such route at all (e.g. a plain static
      // file server / editor "Live Server" on a port other than the one
      // `netlify dev` uses - see README's "Ratings" section for the
      // correct local command).
      console.error("[ratings] network error calling " + (options && options.method || "GET") + " " + url + " - is this being served by `netlify dev` (see README)? ", networkError);
      throw networkError;
    })
    .then(res=>{
      if(res.ok) return res.json();
      return res.text().then(body=>{
        console.error("[ratings] " + (options && options.method || "GET") + " " + url + " -> HTTP " + res.status + (body ? (": " + body.slice(0, 500)) : ""));
        throw new Error("rating request failed: " + res.status);
      });
    });
}

/* Shared, page-lifetime cache for the one GET every read-only rating
   display on a page needs (homepage trust strip, About stats strip -
   both read the SAME authoritative aggregate, never their own separate
   copy). Without this, a page mounting more than one of these would
   fire duplicate requests for the same data - the exact "don't make
   unnecessary duplicate requests, fetch once per page and reuse"
   requirement this was built against. Not used for POSTs or for a
   single tool's own GET (those are genuinely per-tool, not shared). */
let __ratingAllFetch = null;
function ratingFetchAllShared(){
  if(!__ratingAllFetch) __ratingAllFetch = ratingFetchJSON("/api/rating?type=all");
  return __ratingAllFetch;
}

function ratingStarsGlyph(average){
  const rounded = Math.max(0, Math.min(5, Math.round(average)));
  return "★".repeat(rounded) + "☆".repeat(5 - rounded);
}

/* Local fallback strings, used only if js/core/i18n.js hasn't run yet (it
   always has by the time these widgets actually mount, but this keeps the
   module independently correct rather than assuming load order). Mirrors
   the real "rating.*" English strings added to js/core/i18n.js - same
   keys, same {{placeholder}} syntax I18N.t itself uses, so callers never
   need to know which one actually answered. */
const RATING_FALLBACK_STRINGS = {
  "rating.rateThisTool":"Rate this tool", "rating.noneYet":"No ratings yet",
  "rating.summary":"{{average}} / 5 · {{count}} votes", "rating.ratingsWord":"ratings",
  "rating.thanks":"Thanks for rating!", "rating.unavailable":"Ratings unavailable right now",
  "rating.submitError":"Unable to submit your rating right now. Please try again.",
  "rating.starLabel":"{{n}} star{{plural}}", "rating.ratedByUsers":"Rated by {{count}} users",
};
function ratingT(key, vars){
  let str = window.I18N ? I18N.t(key) : (RATING_FALLBACK_STRINGS[key] || key);
  if(vars){
    Object.keys(vars).forEach(k=>{ str = str.replace(new RegExp("\\{\\{"+k+"\\}\\}","g"), vars[k]); });
  }
  return str;
}

function ratingSummaryText(data){
  if(!data || data.voteCount === 0 || data.average == null) return ratingT("rating.noneYet");
  return ratingT("rating.summary", { average: data.average.toFixed(1), count: data.voteCount.toLocaleString() });
}

/**
 * Builds and wires one 5-star rating widget.
 * @param {object} opts
 * @param {"tool"|"site"} opts.type
 * @param {string} [opts.toolId] - required when type is "tool".
 * @param {string} opts.label - visible label, e.g. "Rate this tool".
 * @returns {HTMLElement}
 */
function buildRatingWidget(opts){
  const wrap = document.createElement("div");
  wrap.className = "rating-widget";
  wrap.dataset.ratingType = opts.type;
  if(opts.toolId) wrap.dataset.ratingTool = opts.toolId;

  const votedKey = RATING_VOTED_PREFIX + (opts.type === "tool" ? "tool-" + opts.toolId : "site");
  let myVote = 0;
  try { myVote = parseInt(localStorage.getItem(votedKey) || "0", 10) || 0; } catch(e) {}
  let submitting = false;

  const starsId = "rating-stars-" + Math.random().toString(36).slice(2, 8);
  wrap.innerHTML = `
    <div class="rating-widget-label" id="${starsId}-label">${escapeAttr(opts.label)}</div>
    <div class="rating-stars" role="radiogroup" aria-labelledby="${starsId}-label">
      ${[1,2,3,4,5].map(n=>{
        const starLabel = ratingT("rating.starLabel", { n, plural: n===1?"":"s" });
        return `<button type="button" class="rating-star" role="radio" aria-checked="false" aria-label="${escapeAttr(starLabel)}" data-value="${n}">
          <span aria-hidden="true">☆</span>
        </button>`;
      }).join("")}
    </div>
    <div class="rating-summary" aria-live="polite">…</div>
  `;

  const starButtons = [...wrap.querySelectorAll(".rating-star")];
  const summaryEl = wrap.querySelector(".rating-summary");

  function paintStars(filledCount){
    starButtons.forEach(btn=>{
      const n = parseInt(btn.dataset.value, 10);
      const filled = n <= filledCount;
      btn.classList.toggle("is-filled", filled);
      btn.setAttribute("aria-checked", String(n === filledCount));
      btn.querySelector("span").textContent = filled ? "★" : "☆";
    });
  }

  function renderSummary(data, statusOverride){
    if(statusOverride){
      summaryEl.textContent = statusOverride;
      summaryEl.classList.remove("rating-summary-error");
      return;
    }
    summaryEl.textContent = ratingSummaryText(data);
  }

  function setBusy(isBusy){
    submitting = isBusy;
    wrap.classList.toggle("is-submitting", isBusy);
    starButtons.forEach(btn=>{ btn.disabled = isBusy; });
  }

  paintStars(myVote); // "…" placeholder stays until the real GET below resolves

  const getUrl = opts.type === "tool"
    ? `/api/rating?type=tool&id=${encodeURIComponent(opts.toolId)}`
    : `/api/rating?type=site`;

  ratingFetchJSON(getUrl)
    .then(data=>{
      if(!submitting) renderSummary(data);
      if(!myVote) paintStars(0);
    })
    .catch(()=>{
      renderSummary(null, ratingT("rating.unavailable"));
    });

  function submitVote(value){
    if(submitting) return;
    setBusy(true);
    paintStars(value);
    ratingTrack(opts.type === "tool" ? "tool_rating_submitted" : "website_rating_submitted", { toolId: opts.toolId, rating: value });
    ratingFetchJSON("/api/rating", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: opts.type, id: opts.toolId, rating: value, voterToken: ratingVoterToken() }),
    })
      .then(data=>{
        myVote = value;
        try { localStorage.setItem(votedKey, String(value)); } catch(e) {}
        wrap.classList.add("rating-submitted");
        summaryEl.textContent = ratingT("rating.thanks") + " " + ratingSummaryText(data);
        summaryEl.classList.remove("rating-summary-error");
      })
      .catch(()=>{
        // Roll the stars back to whatever was last confirmed (their prior
        // vote, or unfilled) - never leave the UI claiming a submission
        // succeeded when it didn't, and never fabricate a new count.
        paintStars(myVote);
        summaryEl.textContent = ratingT("rating.submitError");
        summaryEl.classList.add("rating-summary-error");
      })
      .finally(()=>setBusy(false));
  }

  let hoverActive = false;
  starButtons.forEach(btn=>{
    const n = parseInt(btn.dataset.value, 10);
    btn.addEventListener("mouseenter", ()=>{ if(submitting) return; hoverActive = true; paintStars(n); });
    btn.addEventListener("focus", ()=>{ if(submitting) return; hoverActive = true; paintStars(n); });
    btn.addEventListener("blur", ()=>{ hoverActive = false; if(!submitting) paintStars(myVote); });
    btn.addEventListener("click", ()=>submitVote(n));
  });
  wrap.querySelector(".rating-stars").addEventListener("mouseleave", ()=>{
    hoverActive = false;
    if(!submitting) paintStars(myVote);
  });

  return wrap;
}

/**
 * Mounts a tool-rating widget into `container` for `toolId`. Safe to call
 * even if the rating API is completely unreachable - see buildRatingWidget's
 * own fetch .catch() above. Never throws, never blocks caller.
 */
function mountToolRating(container, toolId){
  if(!container || !toolId) return;
  try {
    const widget = buildRatingWidget({ type: "tool", toolId, label: ratingT("rating.rateThisTool") });
    container.appendChild(widget);
    ratingTrack("tool_rating_opened", { toolId });
  } catch(e) { /* rating UI is a non-critical add-on; never break the result screen */ }
}

/**
 * Homepage trust strip's 6th item (#trustStripRating in index.html) - a
 * read-only display of the overall (vote-weighted) tool rating, styled
 * to match the other 5 .trust-item entries exactly (same icon+text
 * structure) rather than looking like a separate banner. This is the
 * OVERALL TOOL RATING, not the independent "site" website rating (see
 * this file's header comment) - no interactive stars here, matching the
 * brief's "this strip item is read-only, like the other 5 stats" intent.
 */
function mountTrustStripRating(el){
  if(!el || el.dataset.ratingMounted) return;
  el.dataset.ratingMounted = "1";
  el.innerHTML = `<span class="trust-ico" aria-hidden="true">★</span><span class="trust-rating-text">…</span>`;
  const textEl = el.querySelector(".trust-rating-text");
  ratingFetchAllShared()
    .then(({ overallToolRating })=>{
      if(!overallToolRating || overallToolRating.voteCount === 0){
        textEl.textContent = ratingT("rating.noneYet");
        return;
      }
      textEl.textContent = overallToolRating.average.toFixed(1) + "/5 · " + overallToolRating.voteCount.toLocaleString() + " " + ratingT("rating.ratingsWord");
    })
    .catch(()=>{ textEl.textContent = ratingT("rating.unavailable"); });
}

/**
 * About panel's 5th stats-strip item (#aboutRatingStat, see TOOLS.about
 * in js/tools/misc-tools.js) - same data/source as the homepage trust
 * strip (one shared fetch), rendered in THIS strip's own a-stat
 * structure (<strong>value</strong><small>label</small>) so it reads as
 * one more stat, not an imported homepage component.
 */
function mountAboutStatRating(el){
  if(!el || el.dataset.ratingMounted) return;
  el.dataset.ratingMounted = "1";
  el.innerHTML = `<span class="a-stat-ico" aria-hidden="true">★</span><div><strong>…</strong><small>${escapeAttr(ratingT("rating.ratedByUsers"))}</small></div>`;
  const strongEl = el.querySelector("strong");
  const smallEl = el.querySelector("small");
  ratingFetchAllShared()
    .then(({ overallToolRating })=>{
      if(!overallToolRating || overallToolRating.voteCount === 0){
        strongEl.textContent = ratingT("rating.noneYet");
        smallEl.textContent = "";
        return;
      }
      strongEl.textContent = overallToolRating.average.toFixed(1) + "/5";
      smallEl.textContent = ratingT("rating.ratedByUsers", { count: overallToolRating.voteCount.toLocaleString() });
    })
    .catch(()=>{ strongEl.textContent = ratingT("rating.unavailable"); smallEl.textContent = ""; });
}

document.addEventListener("DOMContentLoaded", ()=>{
  mountTrustStripRating(document.getElementById("trustStripRating"));
});
