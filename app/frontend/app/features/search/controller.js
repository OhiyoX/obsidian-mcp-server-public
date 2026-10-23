// Search panel controls: the query input, its two real toggles (`#search-case`,
// `#semantic-search`, which latch while their state stays on the same surface) and the
// file panel's one-shot Publishes shortcut (`#publishes-open`, #421).
export function initializeSearchControls({
  state,
  input,
  clearButton,
  caseButton,
  semanticButton,
  publishesButton,
  revealButton,
  loadNotes,
  revealCurrent,
  // #421: the Publishes entry is a shortcut, so it owns the "which panel is in front"
  // half of its own action (a repeat click must land on the results even when the
  // explorer sees no new query identity to react to).
  showSearchView,
  debounceMs = 180,
}) {
  let timer;

  function syncChrome() {
    clearButton.hidden = !input.value;
  } // Keep native-looking clear affordance in sync with programmatic changes.

  function setSemantic(enabled) {
    state.semantic = Boolean(enabled);
    semanticButton.classList.toggle("active", state.semantic);
    semanticButton.setAttribute("aria-pressed", String(state.semantic));
  }

  function setCaseSensitive(enabled) {
    state.caseSensitive = Boolean(enabled);
    caseButton.classList.toggle("active", state.caseSensitive);
    caseButton.setAttribute("aria-pressed", String(state.caseSensitive));
  }

  function cancelPending() {
    clearTimeout(timer);
  }

  input.addEventListener("input", (event) => {
    cancelPending();
    syncChrome();
    timer = setTimeout(() => loadNotes(event.target.value), debounceMs);
  });

  clearButton.onclick = async () => {
    cancelPending();
    input.value = "";
    syncChrome();
    input.focus();
    await loadNotes("");
  };

  caseButton.onclick = async () => {
    const next = !state.caseSensitive;
    setCaseSensitive(next);
    if (next && state.semantic) setSemantic(false);
    await loadNotes(input.value);
  };

  semanticButton.onclick = async () => {
    const next = !state.semantic;
    setSemantic(next);
    if (next && state.caseSensitive) setCaseSensitive(false);
    await loadNotes(input.value);
  };

  // #421: `#publishes-open` is a one-shot shortcut, not a toggle. Every click runs the
  // same preset query and lands on the Search panel; it never flips the query back off,
  // and it keeps no pressed state of its own (`aria-pressed`/`active`) because the panel
  // that would show it is not the one the reader ends up looking at.
  publishesButton.onclick = async () => {
    input.value = "published:true";
    syncChrome();
    // Forced here rather than left to the explorer: a repeat click is the *same* query
    // identity, and the explorer deliberately does not yank a reader who switched back
    // to the file panel for a query it is only re-running.
    showSearchView?.();
    await loadNotes(input.value);
  };

  revealButton.onclick = () => {
    input.value = "";
    setSemantic(false);
    syncChrome();
    revealCurrent();
  };

  syncChrome();

  return {
    cancelPending,
    syncChrome,
    getValue: () => input.value,
  };
}
