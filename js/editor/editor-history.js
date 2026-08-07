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
   ---------------------------------------------------------------------------
   Public surface: window.EditorHistory.init()
                   window.EditorHistory.undo() / redo()
   Events emitted: editor:historyChange { canUndo, canRedo }
   ========================================================================== */
(function () {
  let undoStack = [];
  let redoStack = [];
  let applying = false; // true while undo()/redo() itself is calling restoreState() — its own resulting objectsCommitted (there isn't one; restoreState doesn't fire it) is not a concern, but guards against any future re-entrancy

  function init() {
    undoStack = [];
    redoStack = [];

    window.addEventListener('editor:objectsCommitted', (e) => {
      if (applying) return;
      undoStack.push(e.detail.before);
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
    redoStack.push(window.EditorObjects.getState());
    applying = true;
    window.EditorObjects.restoreState(prev);
    applying = false;
    emitChange();
  }

  function redo() {
    if (!redoStack.length || !window.EditorObjects) return;
    const next = redoStack.pop();
    undoStack.push(window.EditorObjects.getState());
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
