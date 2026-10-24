const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const RESIZE_THRESHOLD = 4;

export function initializeResizablePanes(root = document.querySelector(".shell")) {
  const definitions = [
    { handle: "#left-pane-resizer", variable: "--left-pane-width", storage: "obsidian-web.left-pane-width", side: "left", min: 190, max: 520 },
    { handle: "#right-pane-resizer", variable: "--right-pane-width", storage: "obsidian-web.right-pane-width", side: "right", min: 190, max: 520 },
  ];
  for (const definition of definitions) {
    const handle = document.querySelector(definition.handle);
    if (!handle) continue;
    const saved = Number(localStorage.getItem(definition.storage));
    if (Number.isFinite(saved) && saved > 0) root.style.setProperty(definition.variable, `${clamp(saved, definition.min, definition.max)}px`);

    const apply = (width) => {
      const available = Math.max(definition.min, Math.min(definition.max, window.innerWidth - 420));
      const next = clamp(width, definition.min, available);
      root.style.setProperty(definition.variable, `${next}px`);
      handle.setAttribute("aria-valuenow", String(Math.round(next)));
      localStorage.setItem(definition.storage, String(Math.round(next)));
    };

    const start = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (matchMedia("(max-width:1050px)").matches) return;
      const startX = event.clientX;
      const current = parseFloat(getComputedStyle(root).getPropertyValue(definition.variable));
      let resizing = false;
      const pointerId = event.pointerId;

      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("blur", end);
        if (resizing) {
          try { handle.releasePointerCapture?.(pointerId); } catch {}
          document.body.classList.remove("is-resizing-pane");
        }
      };

      const move = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        if (!resizing) {
          if (Math.abs(delta) < RESIZE_THRESHOLD) return;
          resizing = true;
          moveEvent.preventDefault();
          handle.setPointerCapture?.(pointerId);
          document.body.classList.add("is-resizing-pane");
        }
        apply(current + delta * (definition.side === "left" ? 1 : -1));
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      window.addEventListener("blur", end);
    };

    handle.addEventListener("pointerdown", start);
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const current = parseFloat(getComputedStyle(root).getPropertyValue(definition.variable));
      const direction = event.key === "ArrowRight" ? 1 : -1;
      apply(current + direction * 12 * (definition.side === "left" ? 1 : -1));
    });
  }
}
