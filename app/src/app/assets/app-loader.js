(() => {
  const source = document.currentScript;
  // Issue #414 (C): the shell must start without the two large bundles. `app.js` paints the
  // Explorer and the note list first; `editor.js`/`reader.js` stay off the critical path and
  // load through `window.__obsidianWebAssets.ensure*` on the surface that needs them
  // (reader render / editable surface), so the first list never waits for 1.6 MB of scripts.
  const bundles = {
    editor: { expected: "createObsidianEditor", url: source.dataset.editorSrc },
    reader: { expected: "renderObsidianMarkdown", url: source.dataset.readerSrc },
  };
  const pending = new Map();

  function loadScript(url, expected) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = () => !expected || typeof window[expected] === "function"
        ? resolve()
        : reject(new Error(`${expected} was not initialized`));
      script.onerror = () => reject(new Error(`${url} could not be loaded`));
      document.head.append(script);
    });
  }

  function ensure(name) {
    if (!pending.has(name)) {
      const bundle = bundles[name];
      pending.set(name, loadScript(`${bundle.url}&retry=${Date.now()}`, bundle.expected));
    }
    return pending.get(name);
  }

  // The editor bundle consumes the reader bundle's globals (`renderObsidianMarkdown`,
  // `prepareObsidianDocumentContext`) for its Live fragments, so an editable surface waits
  // for both. A reader-only failure must not block the editor: Live degrades to source text
  // (the extensions already fall back when the renderer is missing) and the reader surface
  // reports its own failure.
  function ensureEditor() {
    return Promise.all([
      ensure("reader").catch((error) => {
        console.error("Obsidian Web reader bundle failed to load", error);
        return null;
      }),
      ensure("editor"),
    ]);
  }

  window.__obsidianWebAssets = {
    ensureEditor,
    ensureReader: () => ensure("reader"),
    editorLoaded: () => typeof window.createObsidianEditor === "function",
    readerLoaded: () => typeof window.renderObsidianMarkdown === "function",
  };

  // Shell first. Only a failure of `app.js` itself leaves the workspace unusable, so only
  // that case keeps the blocking error panel in the note list.
  loadScript(source.dataset.appSrc).catch((error) => {
    console.error("Obsidian Web failed to initialize", error);
    const status = document.querySelector("#note-list");
    if (!status) return;
    status.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "前端资源加载失败，请刷新页面重试。";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新加载";
    retry.addEventListener("click", () => location.reload());
    status.append(message, retry);
  });
})();
