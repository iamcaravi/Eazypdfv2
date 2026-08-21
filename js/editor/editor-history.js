/* ==========================================================================
   js/editor/editor-history.js
   ---------------------------------------------------------------------------
   Undo/redo for Edit PDF. editor-toolbar.js already wires Undo/Redo buttons
   to window.EditorHistory.undo()/redo() and listens for editor:historyChange
   to enable/disable them — this implements exactly that contract.

   Snapshot-based (whole-object-list, not per-field commands): editor-
   objects.js's getState()/restoreState() already give a cheap, JSON-safe
   full snapshot, and a real editing session has at most a few dozen
   objects, so the simplicity of "push/pop the whole list" comfortably
   outweighs building a command-pattern undo stack for this scope.

   Only reacts to editor:objectsCommitted (add/delete/move-end/resize-end/
   property edit/restore) — never editor:objectsChanged, which also fires
   on pure selection changes. That distinction lives in editor-objects.js
   (see its file header); this file only needs to trust it.

   Phase 12: bounded to MAX_HISTORY_ENTRIES snapshots. Each snapshot is a
   full deep clone of every object (editor-objects.js's getState()),
   including any placed image's full base64 data: URL — an unbounded stack
   in an image-heavy session could retain dozens of full-size image copies
   simultaneously with no ceiling. Bounding by entry count (not estimating
   snapshot byte size, which would need to inspect every object's data
   payload on every commit) keeps the fix as simple as the rest of this
   file's own "push/pop the whole list" design: a plain FIFO eviction, one
   `.shift()` when the cap is hit, same pattern page-cache.js already uses
   for its own bounded LRU. The oldest step becomes unrecoverable once
   evicted — an intentional, disclosed tradeoff (see MAX_HISTORY_ENTRIES's
   own comment), not a silent one; the alternative (no bound at all) is
   the actual bug this closes.
   ---------------------------------------------------------------------------
   Public surface: window.EditorHistory.init()
                   window.EditorHistory.undo() / redo()
   Events emitted: editor:historyChange { canUndo, canRedo }
   ========================================================================== */
(function () {
  // 50 steps comfortably covers realistic editing sessions (this file's
  // own header already reasons a session has "at most a few dozen
  // objects" — 50 undo steps is generous headroom beyond that) while
  // still capping worst-case retained memory to a fixed, known multiple
  // of one snapshot's size instead of growing for the life of the tab.
  const MAX_HISTORY_ENTRIES = 50;
  let undoStack = [];
  let redoStack = [];
  let applying = false; // true while undo()/redo() itself is calling restoreState() — its own resulting objectsCommitted (there isn't one; restoreState doesn't fire it) is not a concern, but guards against any future re-entrancy

  function pushBounded(stack, snapshot) {
    stack.push(snapshot);
    if (stack.length > MAX_HISTORY_ENTRIES) stack.shift();
  }

  function init() {
    undoStack = [];
    redoStack = [];

    window.addEventListener('editor:objectsCommitted', (e) => {
      if (applying) return;
      pushBounded(undoStack, e.detail.before);
      redoStack = [];
      emitChange();
    });

    // A newly-loaded document starts a fresh editing session — the old
    // stacks refer to objects/pages that no longer correspond to anything.
    window.addEventListener('editor:documentLoaded', () => {
      undoStack = [];
      redoStack = [];
      emitChange();
    });

    emitChange(); // establishes the initial disabled/disabled state
  }

  function undo() {
    if (!undoStack.length || !window.EditorObjects) return;
    const prev = undoStack.pop();
    pushBounded(redoStack, window.EditorObjects.getState());
    applying = true;
    window.EditorObjects.restoreState(prev);
    applying = false;
    emitChange();
  }

  function redo() {
    if (!redoStack.length || !window.EditorObjects) return;
    const next = redoStack.pop();
    pushBounded(undoStack, window.EditorObjects.getState());
    applying = true;
    window.EditorObjects.restoreState(next);
    applying = false;
    emitChange();
  }

  function emitChange() {
    window.dispatchEvent(new CustomEvent('editor:historyChange', { detail: { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 } }));
  }

  window.EditorHistory = { init, undo, redo };
})();
