/* ==========================================================================
   js/editor/render-queue.js
   ---------------------------------------------------------------------------
   A small priority queue in front of RenderEngine.renderPage(). Exists so
   that scrolling fast through a 300-page document, or changing zoom while
   10 renders are in flight, doesn't pile up wasted work:
     - only MAX_CONCURRENT renders run at once
     - requesting the same page again (e.g. re-entering the viewport)
       cancels the previous in-flight render for that page first
     - changing zoom calls cancelAll(), so every stale render at the old
       scale is aborted immediately rather than finishing and being thrown
       away
   This is the module that makes "cancel render tasks when changing zoom"
   and "no memory leaks" true — every RenderTask this queue starts is
   tracked and guaranteed either to finish or to be .cancel()'d, never
   both left dangling.
   ---------------------------------------------------------------------------
   Public surface:
     RenderQueue.request(pageNumber, canvas, scale, priority) -> Promise<void>
     RenderQueue.cancel(pageNumber)
     RenderQueue.cancelAll()
   Events emitted:
     editor:renderProgress { rendered, total, pending }
   ========================================================================== */
(function () {
  const MAX_CONCURRENT = 3;
  const active = new Map();   // pageNumber -> { task, canvas }
  const pending = [];         // [{pageNumber, canvas, scale, priority, resolve, reject}]
  let renderedCount = 0;
  let totalRequested = 0;

  function request(pageNumber, canvas, scale, priority = 0) {
    return new Promise((resolve, reject) => {
      // A newer request for the same page supersedes any queued/active one.
      cancel(pageNumber);
      pending.push({ pageNumber, canvas, scale, priority, resolve, reject });
      pending.sort((a, b) => b.priority - a.priority);
      totalRequested++;
      emitProgress();
      pump();
    });
  }

  function pump() {
    while (active.size < MAX_CONCURRENT && pending.length) {
      const job = pending.shift();
      startJob(job);
    }
  }

  async function startJob(job) {
    const { pageNumber, canvas, scale, resolve, reject } = job;
    // Reserve the slot immediately (task: null means "starting, not cancellable
    // yet by handle — but we can still remember the cancel request"). This
    // closes the race where cancel(pageNumber) arrives while RenderEngine's
    // getPage() is still resolving, before renderPage() has returned an
    // actual RenderTask to call .cancel() on.
    const slot = { task: null, canvas, cancelledEarly: false };
    active.set(pageNumber, slot);
    try {
      const task = await window.RenderEngine.renderPage(pageNumber, canvas, scale);
      if (slot.cancelledEarly) {
        task.cancel();
        // Priority 3G: this never touched task.promise at all — cancel()
        // makes it reject (RenderingCancelledException, expected), but with
        // no .catch anywhere it was a genuine unhandled promise rejection,
        // silenced only by luck via render-engine.js's global
        // 'unhandledrejection' listener (which only knows to suppress that
        // one exception name — anything else from this path would have
        // gone completely unlogged). Handled locally and precisely instead.
        task.promise.catch(() => {});
        active.delete(pageNumber); resolve(); return;
      }
      slot.task = task;
      await task.promise;
      active.delete(pageNumber);
      renderedCount++;
      emitProgress();
      resolve();
    } catch (err) {
      active.delete(pageNumber);
      // A cancelled render rejects with a RenderingCancelledException — that's
      // expected/normal, not a real error; anything else gets reported.
      if (err && err.name !== 'RenderingCancelledException') reject(err);
      else resolve();
    } finally {
      pump();
    }
  }

  function cancel(pageNumber) {
    const running = active.get(pageNumber);
    if (running) {
      if (running.task) running.task.cancel();
      else running.cancelledEarly = true; // task not created yet — mark for startJob to catch
      active.delete(pageNumber);
    }
    const idx = pending.findIndex((j) => j.pageNumber === pageNumber);
    if (idx !== -1) pending.splice(idx, 1);
  }

  function cancelAll() {
    // Priority 3G fix: a slot's `task` can legitimately still be `null` here
    // — startJob() reserves the slot synchronously before RenderEngine's
    // getPage()/renderPage() has resolved into an actual cancellable
    // RenderTask (see the `cancelledEarly` comment above). cancel(pageNumber)
    // already accounts for this; cancelAll() didn't, so calling it while any
    // render was still in that reserved-but-not-yet-started window (e.g. a
    // rapid zoom change right after scrolling to a new page) threw
    // `TypeError: Cannot read properties of null (reading 'cancel')` — an
    // uncaught, user-visible console error with no functional impact
    // reported, since the render loop still ran, but a real regression
    // against "no console errors."
    active.forEach((v) => { if (v.task) v.task.cancel(); else v.cancelledEarly = true; });
    active.clear();
    pending.length = 0;
    renderedCount = 0;
    totalRequested = 0;
    emitProgress();
  }

  function emitProgress() {
    window.dispatchEvent(new CustomEvent('editor:renderProgress', {
      detail: { rendered: renderedCount, total: totalRequested, pending: pending.length + active.size }
    }));
  }

  window.RenderQueue = { request, cancel, cancelAll };
})();
