// Snapshot-based undo/redo. Snapshots are opaque strings produced by the owner.
(function () {
  'use strict';
  const A = (window.AIDE = window.AIDE || {});

  A.History = class {
    constructor({ take, restore, limit = 80, onChange = () => {} }) {
      this.take = take;
      this.restore = restore;
      this.limit = limit;
      this.onChange = onChange;
      this.clear();
    }
    clear() {
      this.undoStack = [];
      this.redoStack = [];
      this.onChange();
    }
    // Call before a mutation.
    push() {
      this.undoStack.push(this.take());
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack = [];
      this.onChange();
    }
    undo() {
      if (!this.undoStack.length) return false;
      this.redoStack.push(this.take());
      this.restore(this.undoStack.pop());
      this.onChange();
      return true;
    }
    redo() {
      if (!this.redoStack.length) return false;
      this.undoStack.push(this.take());
      this.restore(this.redoStack.pop());
      this.onChange();
      return true;
    }
    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }
  };
})();
