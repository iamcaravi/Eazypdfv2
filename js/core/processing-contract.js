/* YoyoPDF processing contract.
 * Shared, dependency-free primitives for long-running document tools.
 * Keep this file browser/worker safe: no DOM, no bundler, no external deps.
 */
(function (root) {
  "use strict";

  const LIMITS = Object.freeze({
    maxFileBytes: 200 * 1024 * 1024,
    maxPages: 1500,
    warningFileBytes: 50 * 1024 * 1024,
  });

  class ProcessingError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "ProcessingError";
      this.code = code;
      this.details = details;
    }
  }

  function validateInputFile(file, options = {}) {
    const maxFileBytes = options.maxFileBytes ?? LIMITS.maxFileBytes;
    if (!file) throw new ProcessingError("NO_FILE", "Choose a file to continue.");

    const size = Number(file.size ?? file.byteLength ?? file.length ?? 0);
    if (!Number.isFinite(size) || size < 0) {
      throw new ProcessingError("INVALID_FILE", "The selected file could not be read.");
    }
    if (size > maxFileBytes) {
      throw new ProcessingError(
        "FILE_TOO_LARGE",
        `This file exceeds YoyoPDF's ${Math.round(maxFileBytes / 1024 / 1024)} MB in-browser limit.`,
        { size, maxFileBytes }
      );
    }
    return {
      size,
      warning: size > LIMITS.warningFileBytes,
    };
  }

  function validatePageCount(pageCount, maxPages = LIMITS.maxPages) {
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new ProcessingError("INVALID_PAGE_COUNT", "This document has no readable pages.");
    }
    if (pageCount > maxPages) {
      throw new ProcessingError(
        "TOO_MANY_PAGES",
        `This document exceeds YoyoPDF's ${maxPages}-page in-browser limit.`,
        { pageCount, maxPages }
      );
    }
    return pageCount;
  }

  function createCancellationToken() {
    let cancelled = false;
    const listeners = new Set();
    return {
      get cancelled() { return cancelled; },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        for (const listener of listeners) {
          try { listener(); } catch (_) { /* cancellation must not throw */ }
        }
        listeners.clear();
      },
      onCancel(listener) {
        if (typeof listener !== "function") return () => {};
        if (cancelled) listener();
        else listeners.add(listener);
        return () => listeners.delete(listener);
      },
      throwIfCancelled() {
        if (cancelled) throw new ProcessingError("CANCELLED", "Processing was cancelled.");
      },
    };
  }

  function createProgressReporter(onProgress) {
    let last = -1;
    return function report(value, message = "") {
      const percent = Math.max(0, Math.min(100, Number(value) || 0));
      if (percent === last && !message) return;
      last = percent;
      if (typeof onProgress === "function") onProgress({ percent, message });
    };
  }

  function makeSuccess(bytes, meta = {}) {
    return Object.freeze({
      ok: true,
      bytes,
      ...meta,
    });
  }

  root.YoyoPDFProcessing = Object.freeze({
    LIMITS,
    ProcessingError,
    validateInputFile,
    validatePageCount,
    createCancellationToken,
    createProgressReporter,
    makeSuccess,
  });
})(typeof self !== "undefined" ? self : window);
