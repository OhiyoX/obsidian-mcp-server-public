// Explorer "new note / new folder" drafts (issue #427).
//
// Frozen contract: clicking a 新建 entry only opens a LOCAL draft. Nothing is
// written to the Vault until an explicit commit (Enter) of a name that really
// differs from the draft's initial value. Escape, a blur without a commit, closing
// the sidebar/drawer, switching the browse mode/search stream and abandoning the
// draft all cancel it: no POST, no new file/folder, no success toast. A commit that
// the server confirmed is a real resource and is never auto-deleted afterwards.
//
// One draft exists at a time (single owner). `beginDraft` settles whatever draft was
// open before it renders the new row, and every row callback carries the draft's
// token, so a late blur / timeout / promise from a replaced draft can neither revive
// it nor commit it. The commit POST itself is single-flight: `beginSubmit` refuses a
// second Enter / a second click while the first request is in flight. That isolation
// also covers the `await` of the commit itself: a request whose draft was replaced in
// the meantime may neither settle/remove the new owner's row on success nor re-render
// on failure, and failure recovery re-resolves the scope's live container.
//
// The module has two halves:
//  - a DOM-free state machine (`draftCommitDecision`, `createDraftRegistry`) that the
//    Node tests drive directly;
//  - one inline row renderer shared by all three entries (panel-head new note,
//    folder-row `+`, panel-head new folder).
export const DEFAULT_NOTE_NAME = "未命名笔记";
export const DEFAULT_FOLDER_NAME = "新建文件夹";

export function normalizeDraftName(value) {
  return String(value ?? "").trim();
}

// The single Enter decision. `unchanged-default` is the frozen "no creation intent"
// rule: a default name alone (including a name typed back to the default) is never a
// commit. `empty` keeps the editable row focused, exactly as before this fix.
export function draftCommitDecision({ value, initialValue }) {
  const name = normalizeDraftName(value);
  if (!name) return { action: "reject", reason: "empty" };
  if (name === normalizeDraftName(initialValue)) return { action: "reject", reason: "unchanged-default" };
  return { action: "submit", name };
}

// Token-scoped single-owner registry. Every method is intentionally side-effect free
// with respect to the DOM so the state machine stays unit-testable.
export function createDraftRegistry() {
  let current = null;
  return {
    begin(spec) {
      current = {
        token: {},
        kind: spec.kind,
        scope: spec.scope ?? "",
        scopeLabel: spec.scopeLabel ?? "",
        initialValue: spec.initialValue ?? "",
        value: spec.initialValue ?? "",
        onCommit: spec.onCommit ?? null,
        // Optional: a repaint can replace the scope's container (a folder's children are
        // rebuilt from scratch), so the scope resolver lets failure recovery re-target a
        // container that is really in the document instead of a detached pre-await node.
        resolveContainer: typeof spec.resolveContainer === "function" ? spec.resolveContainer : null,
        submitting: false,
      };
      return current;
    },
    current: () => current,
    isCurrent(draft) {
      return Boolean(draft) && current !== null && current.token === draft.token;
    },
    // First caller wins; a repeated Enter and a click that lands while the request is
    // in flight are both refused here, so at most one create POST leaves the client.
    beginSubmit(draft) {
      if (!this.isCurrent(draft) || draft.submitting) return false;
      draft.submitting = true;
      return true;
    },
    failSubmit(draft) {
      if (this.isCurrent(draft)) draft.submitting = false;
    },
    settle(draft) {
      if (!this.isCurrent(draft)) return false;
      current = null;
      return true;
    },
  };
}

const registry = createDraftRegistry();
let settledHandler = null;

export function setDraftSettledHandler(handler) {
  settledHandler = typeof handler === "function" ? handler : null;
}

export function activeDraft() {
  const draft = registry.current();
  return draft ? { ...draft } : null;
}

export function hasActiveDraft() {
  return registry.current() !== null;
}

function settleDraft(draft) {
  if (!registry.settle(draft)) return false;
  settledHandler?.();
  return true;
}

// Cancel: clear the draft state *and* take its row off screen. Every cancel path (Escape,
// blur, the pane close, a mode/search switch) goes through here, so a cancelled draft can
// never leave a stale editable row behind.
function cancelDraft(draft) {
  const row = draft.row;
  if (!registry.settle(draft)) return false;
  settledHandler?.();
  row?.remove?.();
  return true;
}

// Cancel the open draft (if any). Used by the panel's close handler, the browse-mode
// switch and the search path: an uncommitted draft never survives its scope.
export function settleActiveDraft() {
  const draft = registry.current();
  return draft ? cancelDraft(draft) : false;
}

export function isDraftInput(element) {
  return Boolean(element?.classList?.contains?.("note-create-input"));
}

// The renderers call this just before they clear their host. A focused draft keeps its
// value + focus across the repaint; an unfocused draft was already cancelled by its own
// blur, so it is dropped instead of being resurrected from stale module state.
export function preserveActiveDraft() {
  const draft = registry.current();
  if (!draft) return null;
  if (isDraftInput(globalThis.document?.activeElement)) return { ...draft };
  if (!draft.submitting) settleActiveDraft();
  return null;
}

// Failure recovery must render into the container that is really in the document NOW.
// A draft with a scope resolver (the in-folder entries) re-resolves it; a draft without
// one (the panel-head root entries) targets the stable host it was opened against.
function retryContainer(draft, fallback) {
  if (typeof draft.resolveContainer !== "function") return fallback;
  return draft.resolveContainer() ?? null;
}

function focusDraftInput(container) {
  const input = container?.querySelector?.(".note-create-input");
  input?.focus?.();
  input?.select?.();
}

// Build (and insert) the editable row for the active draft. `preserved` restores focus +
// selection after a repaint, so a background refresh cannot drop the user's typing.
export function renderActiveDraft({ host, container, preserved = null } = {}) {
  const draft = registry.current();
  if (!draft || !host) return false;
  // An in-flight commit has no interactive row (and a repaint must not rebuild one): the
  // request decides the outcome, and a failure re-renders the row for the retry.
  if (draft.submitting) return false;
  const target = container ?? host;
  if (!target) {
    settleActiveDraft();
    return false;
  }

  const isFolder = draft.kind === "folder";
  // Every paint of the draft row owns a fresh row token. A background repaint detaches the
  // focused row (the browser then fires `focusout`), and the replaced row's deferred blur
  // must not cancel the draft that very repaint restored. The draft's own token (registry)
  // is unchanged, so the single-owner and commit-once rules still hold.
  const rowToken = {};
  draft.rowToken = rowToken;
  const row = document.createElement("div");  row.className = isFolder ? "note-create-row folder-create-row" : "note-create-row";
  const input = document.createElement("input");
  input.className = isFolder ? "note-create-input folder-create-input" : "note-create-input";
  input.type = "text";
  input.value = draft.value;
  input.placeholder = isFolder ? "文件夹名称" : "笔记名称";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", isFolder
    ? "新建文件夹"
    : draft.scope ? `在 ${draft.scopeLabel} 中新建笔记` : "新建笔记");
  row.append(input);

  const cancel = () => {
    if (draft.rowToken !== rowToken) return;
    if (draft.submitting) return;
    if (!registry.isCurrent(draft)) return;
    cancelDraft(draft);
  };

  const submit = async () => {
    if (draft.rowToken !== rowToken) return;
    const decision = draftCommitDecision({ value: input.value, initialValue: draft.initialValue });
    if (decision.action === "reject") {
      // An empty name is not a commit either; keep the row editable (unchanged U6 path).
      if (decision.reason === "empty") {
        input.focus();
        return;
      }
      // Default name unchanged: abandon the draft without any write. Never a hidden create.
      cancel();
      return;
    }
    if (!registry.beginSubmit(draft)) return;
    input.disabled = true;
    // The row is not interactive while the request is in flight; the outcome decides
    // whether it comes back (failure) or the committed resource takes over (success).
    row.remove();
    const created = await draft.onCommit?.(decision.name, { kind: draft.kind, scope: draft.scope });
    // The `await` above is a yield point: the user can open a NEW draft while this request
    // is in flight, and `beginDraft` then settles this one and renders its own row. A late
    // answer from a replaced draft must stay inert — an old success may not settle (or
    // remove the row of) the new owner, and an old failure may not re-render at all.
    if (!registry.isCurrent(draft)) return;
    if (created) {
      // Our own draft, confirmed by the server: the created resource stays, the draft ends.
      settleDraft(draft);
      draft.row?.remove?.();
      return;
    }
    // The server rejected the write (or the network failed): bring the row back with the
    // typed value and the focus so the user can fix the name and retry — never a silent
    // loss. A repaint during the request may have replaced the host AND the scope's
    // container, so re-resolve it now: rendering into the pre-await node would leave the
    // row detached from the document (invisible, unable to take the focus).
    registry.failSubmit(draft);
    const retryTarget = retryContainer(draft, target);
    if (!retryTarget) return;
    renderActiveDraft({ host, container: retryTarget, preserved: draft });
  };

  input.addEventListener("input", () => {
    if (registry.isCurrent(draft)) draft.value = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  // Deferred so an Enter in the same tick still wins: the blur of a committed row finds
  // `submitting` set and does nothing.
  input.addEventListener("blur", () => setTimeout(cancel, 0));

  // The row is always the first child of its container: the list itself for a root-scope
  // draft, the folder's live children for an in-folder one.
  draft.row = row;
  target.prepend(row);
  if (preserved) {
    input.focus();
    input.select?.();
  }
  return true;
}

// The three Explorer create entries (panel-head new note, folder-row `+`, panel-head new
// folder) share this one draft lifecycle: each entry only opens a draft, and the write
// happens in the commit seam the caller supplies. It lives here so the controller — whose
// file budget is tight — only wires the seam.
export function createExplorerCreateEntries({ host, createNote, createFolder } = {}) {
  return {
    beginNewNote: () => beginDraft({
      host,
      kind: "note",
      scopeLabel: "根目录",
      initialValue: DEFAULT_NOTE_NAME,
      onCommit: (name) => createNote?.(name),
    }),
    beginNewFolder: () => beginDraft({
      host,
      kind: "folder",
      scopeLabel: "根目录",
      initialValue: DEFAULT_FOLDER_NAME,
      onCommit: (name) => createFolder?.(name),
    }),
    cancelDraft: () => settleActiveDraft(),
  };
}

// Open a draft: settle the previous owner, clear any row it left behind, then render.
export function beginDraft({
  host,
  container,
  resolveContainer = null,
  kind = "note",
  scope = "",
  scopeLabel = "",
  initialValue = "",
  onCommit = null,
} = {}) {
  if (!host) return false;
  settleActiveDraft();
  host.querySelectorAll(".note-create-row").forEach((node) => node.remove());
  registry.begin({ kind, scope, scopeLabel, initialValue, onCommit, resolveContainer });
  const target = container ?? resolveContainer?.() ?? host;
  if (!renderActiveDraft({ host, container: target })) return false;
  focusDraftInput(target);
  return true;
}
