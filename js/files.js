// File open/save. Uses the File System Access API (Chrome/Edge) so Save writes
// back to the opened file; falls back to <input type=file> + download elsewhere.
(function () {
  'use strict';
  const A = (window.AIDE = window.AIDE || {});
  const TYPES = [{ description: 'Story card JSON', accept: { 'application/json': ['.json'] } }];
  const fsOK = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;

  const isAbort = e => e && e.name === 'AbortError';

  function pickViaInput() {
    return new Promise(resolve => {
      const input = document.getElementById('fileInput');
      input.value = '';
      input.onchange = async () => {
        const f = input.files[0];
        resolve(f ? { name: f.name, text: await f.text(), handle: null } : null);
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  }

  A.files = {
    fsOK,

    async open() {
      if (!fsOK) return pickViaInput();
      try {
        const [handle] = await window.showOpenFilePicker({ types: TYPES, multiple: false });
        const f = await handle.getFile();
        return { name: f.name, text: await f.text(), handle };
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
    },

    // Reads a file dropped onto the page, keeping a writable handle when possible.
    // Both getters must be called synchronously inside the drop event.
    fromDrop(dataTransfer) {
      const item = [...dataTransfer.items].find(i => i.kind === 'file');
      if (!item) return null;
      const handlePromise = item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
      const file = item.getAsFile();
      return (async () => {
        let handle = null;
        try { handle = handlePromise ? await handlePromise : null; } catch { handle = null; }
        if (handle && handle.kind !== 'file') handle = null;
        const f = handle ? await handle.getFile() : file;
        return { name: f.name, text: await f.text(), handle };
      })();
    },

    async write(handle, text) {
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
    },

    // Returns a handle, 'download' when falling back, or null if cancelled.
    async saveAs(suggestedName, text) {
      if (!fsOK) {
        this.download(suggestedName, text);
        return 'download';
      }
      try {
        const handle = await window.showSaveFilePicker({ suggestedName, types: TYPES });
        await this.write(handle, text);
        return handle;
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
    },

    download(name, text) {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
})();
