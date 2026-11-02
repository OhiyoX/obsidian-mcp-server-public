export function bindDocumentNavigation({
  preview,
  editorHost,
  outline,
  editor,
  getMode,
  getPath,
  getDocumentKind = () => "note",
  getVaultId,
  openNote,
  openBase = async () => false,
  resolveNote,
  searchInput,
  loadNotes,
  syncSearchChrome = () => {},
  historyObject = window.history,
  locationObject = window.location,
  windowObject = window,
}) {
  // Canonical note resolution lives on the server; this layer owns interaction + history only.
  const HISTORY_MARKER = "obsidianWebNavigation";
  let historyIndex = Number.isInteger(historyObject.state?.index) ? historyObject.state.index : 0;
  let seeded = historyObject.state?.kind === HISTORY_MARKER;
  let restoring = false;

  if (!seeded && /^\/app\/?$/.test(locationObject.pathname || "")) {
    historyObject.replaceState(
      { kind: HISTORY_MARKER, index: historyIndex, vaultId: getVaultId() || null, path: null, fragment: "" },
      "",
      locationObject.pathname,
    );
    seeded = true;
  }

  function splitTarget(raw) {
    const value = String(raw || "");
    const hash = value.indexOf("#");
    return hash < 0
      ? { target: value.trim(), fragment: "" }
      : { target: value.slice(0, hash).trim(), fragment: value.slice(hash + 1).trim() };
  }

  function cleanFragment(value) {
    try {
      return decodeURIComponent(String(value || "").replace(/^#/, "")).trim();
    } catch {
      return String(value || "").replace(/^#/, "").trim();
    }
  }

  function routeWithFragment(route, fragment) {
    const clean = cleanFragment(fragment);
    return clean ? `${route}#${encodeURIComponent(clean)}` : route;
  }

  function headingForFragment(fragment) {
    const clean = cleanFragment(fragment);
    if (!clean) return null;
    const folded = clean.normalize("NFKC").toLocaleLowerCase();
    return outline.getHeadings().find((heading) => (
      String(heading.id || "").normalize("NFKC").toLocaleLowerCase() === folded
      || String(heading.title || "").trim().normalize("NFKC").toLocaleLowerCase() === folded
    )) || null;
  }

  function navigateFragment(fragment) {
    const heading = headingForFragment(fragment);
    if (!heading) return false;
    if (getMode() === "preview") return outline.scrollTo(heading) !== false;
    return editor.scrollToPosition?.(heading.from) === true;
  }

  function search(target, prefix = "") {
    searchInput.value = `${prefix}${target}`;
    syncSearchChrome();
    loadNotes(searchInput.value);
  }

  function routeState({ vaultId, path, route = null, documentKind = "note", fragment = "" }, index = historyIndex) {
    return { kind: HISTORY_MARKER, index, vaultId, path, route, documentKind, fragment: cleanFragment(fragment) };
  }

  function commit(data, mode = "push") {
    const route = String(data?.route || "");
    const path = String(data?.path || "");
    const vaultId = String(data?.vaultId ?? getVaultId() ?? "");
    // Base and note entries share one history stack; documentKind decides which
    // loader replays an entry on Back/Forward.
    const documentKind = data?.documentKind || getDocumentKind() || "note";
    const fragment = cleanFragment(data?.fragment);
    if (!route || !path || !vaultId || mode === "none") return false;
    const href = routeWithFragment(route, fragment);
    const nextState = () => routeState({ vaultId, path, route, documentKind, fragment });

    if (mode === "replace" || !seeded) {
      historyObject.replaceState(nextState(), "", href);
      seeded = true;
      return true;
    }

    const current = historyObject.state;
    if (current?.kind === HISTORY_MARKER
      && current.vaultId === vaultId
      && current.path === path
      && (current.documentKind || "note") === documentKind
      && cleanFragment(current.fragment) === fragment) {
      historyObject.replaceState(nextState(), "", href);
      return true;
    }

    historyIndex += 1;
    historyObject.pushState(nextState(), "", href);
    return true;
  }

  /**
   * Issue #410 (audit Cut D): the in-app welcome transition replaces the current history
   * entry with the document-less one, addressed as `/app/` (the installed app's `scope`, #471).
   * Back therefore cannot return to the document the user just closed (an earlier note entry
   * still replays through `openNote`), and Forward onto this entry reloads the welcome page
   * exactly like a first load of `/app/`, which is what `handlePopState` already does for a
   * path-less entry.
   */
  function commitWelcome({ vaultId, route = "/app/", mode = "replace" } = {}) {
    const nextVaultId = String(vaultId ?? getVaultId() ?? "");
    const nextRoute = String(route || "");
    if (!nextVaultId || !nextRoute || mode === "none") return false;
    const entryAt = (index) => routeState({ vaultId: nextVaultId, path: null, route: nextRoute, documentKind: "note", fragment: "" }, index);
    if (mode === "replace") historyObject.replaceState(entryAt(historyIndex), "", nextRoute);
    else {
      historyIndex += 1;
      historyObject.pushState(entryAt(historyIndex), "", nextRoute);
    }
    seeded = true;
    return true;
  }

  async function handlePopState(event) {
    if (restoring) {
      restoring = false;
      return;
    }
    const target = event.state;
    if (target?.kind !== HISTORY_MARKER) {
      locationObject.reload();
      return;
    }

    const targetIndex = Number.isInteger(target.index) ? target.index : historyIndex;
    const delta = historyIndex - targetIndex;
    if (!target.path) {
      locationObject.reload();
      return;
    }

    if (target.vaultId && target.vaultId !== getVaultId()) {
      locationObject.reload();
      return;
    }

    const targetKind = target.documentKind === "base" ? "base" : "note";
    if (target.path === getPath() && targetKind === (getDocumentKind() || "note")) {
      historyIndex = targetIndex;
      seeded = true;
      navigateFragment(target.fragment);
      return;
    }

    const opened = targetKind === "base"
      ? await openBase({ path: target.path, vaultId: target.vaultId, route: target.route ?? null, historyMode: "none", fragment: target.fragment })
      : await openNote(target.path, { historyMode: "none", fragment: target.fragment });
    if (opened) {
      historyIndex = targetIndex;
      seeded = true;
      navigateFragment(target.fragment);
      return;
    }

    // popstate changes the address bar before application code runs. If the
    // document transition is rejected, restore the entry for the visible note.
    if (delta) {
      restoring = true;
      historyObject.go(delta);
    }
  }

  async function navigateInternal(rawTarget) {
    const { target, fragment } = splitTarget(rawTarget);
    const sourcePath = getPath();
    if (!sourcePath) return false;

    let resolved;
    try {
      resolved = await resolveNote(sourcePath, target);
    } catch {
      if (target) search(target);
      return false;
    }

    if (!resolved?.path || !resolved?.route) {
      if (target) search(target);
      return false;
    }

    if (resolved.path === sourcePath) {
      commit({ ...resolved, fragment });
      return fragment ? navigateFragment(fragment) : true;
    }

    const opened = await openNote(resolved.path, { fragment });
    if (!opened) return false;
    if (fragment) navigateFragment(fragment);
    return true;
  }

  windowObject.addEventListener("popstate", handlePopState);

  preview.addEventListener("click", async (event) => {
    if (event.button !== 0) return;
    const selection = windowObject.getSelection?.();
    if (selection && !selection.isCollapsed) return;
    const tag = event.target.closest("[data-tag]");
    if (tag) {
      event.preventDefault();
      search(tag.dataset.tag, "tag:");
      return;
    }
    const link = event.target.closest("[data-note]");
    if (!link) return;
    event.preventDefault();
    let target = link.dataset.note;
    try { target = decodeURIComponent(target); } catch {}
    await navigateInternal(target);
  });

  editorHost.addEventListener("obsidian-navigate", async (event) => {
    const detail = event.detail || {};
    if (detail.vaultId !== getVaultId() || detail.sourcePath !== getPath()) return;
    if (detail.tag) {
      search(detail.tag, "tag:");
    } else if (detail.note) {
      await navigateInternal(detail.note);
    } else if (/^https?:\/\//i.test(detail.href || "")) {
      windowObject.open(detail.href, "_blank", "noopener,noreferrer");
    }
  });

  return {
    commit,
    commitWelcome,
    navigateInternal,
    navigateFragment,
    destroy() {
      windowObject.removeEventListener("popstate", handlePopState);
    },
  };
}
