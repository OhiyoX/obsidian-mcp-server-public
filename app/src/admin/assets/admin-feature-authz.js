import { registerFeature } from "./admin-feature-registry.js";

const isTime = (value) => /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
const isInterval = (from, to) => isTime(from) && (isTime(to) || to === "24:00") && from < to;
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clock = (value) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

function timeBar(from, to, drawing = false, name = "") {
  const bar = document.createElement("span");
  bar.className = drawing ? "w drawing" : "w";
  bar.style.left = `${from / 14.4}%`;
  bar.style.width = `${(to - from) / 14.4}%`;
  if (drawing) {
    bar.textContent = `${clock(from)}–${clock(to)}`;
  } else if (name) {
    // Each end is a grab handle; `name` is the row's start field, so a drag knows what it moves.
    bar.dataset.name = name;
    for (const edge of ["from", "to"]) {
      const handle = document.createElement("span");
      handle.className = "h";
      handle.dataset.edge = edge;
      bar.append(handle);
    }
  }
  return bar;
}

/** The day's other intervals, as [from, to] in minutes. */
function othersOf(rows, name) {
  const other = [...rows.children]
    .map((row) => [...row.querySelectorAll("input")])
    .filter(([start]) => start && start.name !== name)
    .map(([start, end]) => [start.value, end.value])
    .filter(([from, to]) => isInterval(from, to))
    .map(([from, to]) => [minutes(from), to === "24:00" ? 1440 : minutes(to)]);
  return { other };
}

/** Drag one end of an existing interval: 15 minute steps, never past a neighbour, never shorter than 15. */
function resizeEdge(rows, edge, name, value) {
  const start = rows.querySelector(`input[name="${name}"]`);
  const end = rows.querySelector(`input[name="${(name || "").replace(/from_(\d+)$/, "to_$1")}"]`);
  if (!start || !end) return false;
  const { other } = othersOf(rows, name);
  if (edge === "from") {
    const to = end.value === "24:00" ? 1440 : minutes(end.value);
    const floor = Math.max(0, ...other.filter(([, b]) => b <= to).map(([, b]) => b));
    start.value = clock(Math.min(Math.max(value, floor), to - 15));
  } else {
    const from = minutes(start.value);
    const ceiling = Math.min(1440, ...other.filter(([a]) => a >= from).map(([a]) => a));
    const to = Math.max(Math.min(value, ceiling), from + 15);
    end.value = to === 1440 ? "24:00" : clock(to);
  }
  return true;
}

function drawSlot(link, addSlot, ctx) {
  const track = link.lastElementChild;
  let drag = null;
  let resize = null;
  const timeIn = (event, box) => Math.min(1440, Math.max(0, Math.round((event.clientX - box.left) / box.width * 96) * 15));
  const timeAt = (event) => timeIn(event, drag);
  const bounds = (event) => {
    const end = timeAt(event);
    return [Math.min(drag.start, end), Math.max(drag.start, end)];
  };
  // The click that ends a drag must not also open a row.
  const swallowClick = () => {
    const suppressClick = (click) => {
      click.preventDefault();
      click.stopImmediatePropagation();
    };
    link.addEventListener("click", suppressClick, { capture: true, once: true });
    setTimeout(() => link.removeEventListener("click", suppressClick, true), 0);
  };
  track.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    const handle = event.target.closest(".h");
    if (handle) {
      event.preventDefault();
      resize = { id: event.pointerId, edge: handle.dataset.edge, name: handle.closest(".w").dataset.name, box: track.getBoundingClientRect() };
      try {
        track.setPointerCapture(event.pointerId);
      } catch {
        // a synthetic pointer keeps working through the track listeners
      }
      return;
    }
    if (event.target.closest(".w")) return; // the bar body is a click: it opens that bar's row
    const { left, width } = track.getBoundingClientRect();
    drag = { id: event.pointerId, left, width };
    drag.start = timeAt(event);
    track.setPointerCapture(event.pointerId);
  });
  track.addEventListener("pointermove", (event) => {
    if (resize?.id === event.pointerId) {
      if (resizeEdge(ctx.rows, resize.edge, resize.name, timeIn(event, resize.box))) ctx.repaint();
      return;
    }
    if (drag?.id !== event.pointerId) return;
    drag.bar?.remove();
    const [from, to] = bounds(event);
    if (from < to) {
      drag.bar = timeBar(from, to, true);
      track.append(drag.bar);
    }
  });
  track.addEventListener("pointercancel", () => {
    drag?.bar?.remove();
    drag = null;
    resize = null;
  });
  track.addEventListener("pointerup", (event) => {
    if (resize?.id === event.pointerId) {
      if (resizeEdge(ctx.rows, resize.edge, resize.name, timeIn(event, resize.box))) ctx.repaint();
      resize = null;
      swallowClick();
      return;
    }
    if (drag?.id !== event.pointerId) return;
    const [from, to] = bounds(event);
    drag.bar?.remove();
    drag = null;
    if (from === to) return;
    swallowClick();
    addSlot(clock(from), clock(to));
  });
}

function enhanceTimeline(form, groups) {
  const timeline = form.querySelector("[data-draft-timeline]");
  timeline.hidden = false;
  let sync = () => {};
  const days = groups.filter(({ day }) => day).map(({ day, rows, button, addInterval }) => {
    const link = timeline.querySelector(`[data-timeline-day="${day}"]`);
    const name = link.firstElementChild.textContent;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const bar = event.target.closest(".w[data-name]");
      const target = (bar && rows.querySelector(`input[name="${bar.dataset.name}"]`)) ?? rows.querySelector("input") ?? button;
      target.focus();
    });
    drawSlot(link, (from, to) => {
      const added = addInterval(from, to);
      if (added) added.dispatchEvent(new Event("input", { bubbles: true }));
    }, { rows, repaint: () => sync() });
    return { link, name, rows };
  });
  sync = () => {
    const slots = days.map(({ rows }) => [...rows.children].map((row) => {
      const [start, end] = row.querySelectorAll("input");
      return { start, from: start.value, to: end.value };
    }));
    const emptyWeek = slots.every((day) => day.every(({ from, to }) => !from && !to));
    days.forEach(({ link, name }, index) => {
      const intervals = emptyWeek ? [{ from: "00:00", to: "24:00" }] : slots[index].filter(({ from, to }) => isInterval(from, to));
      const hint = emptyWeek ? timeline.dataset.allDay : intervals.map(({ from, to }) => `${from}–${to}`).join(", ") || timeline.dataset.noSlots;
      link.setAttribute("aria-label", `${name} · ${hint}`);
      link.title = hint;
      const bars = intervals.map(({ from, to, start }) => timeBar(minutes(from), minutes(to), false, start?.name));
      link.lastElementChild.replaceChildren(...bars);
    });
  };
  return sync;
}

function enhanceSchedule(form) {
  const groups = [...form.querySelectorAll("[data-schedule-group]")].map((group) => {
    const rows = group.querySelector("[data-schedule-rows]");
    const spare = rows.querySelector("[data-spare]");
    const button = group.querySelector("[data-add-row]");
    const prefix = spare.querySelector("input").name.replace(/from_\d+$/, "");
    let nextIndex = rows.children.length - 1;
    spare.remove();
    button.hidden = false;
    for (const remove of rows.querySelectorAll("[data-remove-row]")) remove.hidden = false;
    function addRow(from = "", to = "") {
      const row = spare.cloneNode(true);
      row.removeAttribute("data-spare");
      const [start, end] = row.querySelectorAll("input");
      start.name = `${prefix}from_${nextIndex}`;
      end.name = `${prefix}to_${nextIndex++}`;
      start.value = from;
      end.value = to;
      row.querySelector("[data-remove-row]").hidden = false;
      rows.append(row);
      return start;
    }
    function addInterval(from, to) {
      let empty = null;
      for (const row of rows.children) {
        const [start, end] = row.querySelectorAll("input");
        if (start.value === from && end.value === to) return null;
        // Ranges never overlap: a drawn range that would cross a neighbour is refused, not trimmed.
        if (isInterval(start.value, end.value) && from < end.value && to > start.value) return null;
        if (!empty && !start.value && !end.value) empty = [start, end];
      }
      if (!empty) return addRow(from, to);
      const [start, end] = empty;
      start.value = from;
      end.value = to;
      return start;
    }
    button.addEventListener("click", () => addRow().focus());
    rows.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-row]");
      if (!remove) return;
      const row = remove.closest("[data-schedule-row]");
      const next = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      syncTimeline();
      (next?.querySelector("[data-remove-row]") ?? button).focus();
    });
    return { day: group.dataset.day, rows, addInterval, button };
  });
  const syncTimeline = enhanceTimeline(form, groups);
  syncTimeline();
  form.querySelector(".weekly-schedule").addEventListener("input", syncTimeline);
  form.querySelector(".weekly-schedule").addEventListener("change", ({ target }) => {
    if (!target.matches("input[type=text]")) return;
    const value = target.value.trim();
    const match = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(value);
    const digits = /^(\d{1,2})(\d{2})$/.exec(value);
    const parts = match ?? digits;
    if (!parts) return;
    const fixed = `${parts[1].padStart(2, "0")}:${(parts[2] ?? "00").padStart(2, "0")}`;
    if (!isTime(fixed) && !(fixed === "24:00" && /_to_\d+$/.test(target.name))) return;
    target.value = fixed;
    syncTimeline();
  });

  const shortcuts = form.querySelector("[data-schedule-shortcuts]");
  const feedback = shortcuts.querySelector("[data-schedule-feedback]");
  shortcuts.hidden = false;
  shortcuts.addEventListener("change", () => { feedback.hidden = true; });
  shortcuts.addEventListener("click", (event) => {
    const action = event.target.closest("[data-add-days]")?.dataset.addDays;
    if (!action) return;
    const [start, end] = shortcuts.querySelectorAll("select");
    const from = start.value;
    const to = end.value;
    if (!isInterval(from, to)) {
      feedback.textContent = shortcuts.dataset.invalidTime;
      feedback.hidden = false;
      (start._selProxy ?? start).focus();
      return;
    }
    feedback.hidden = true;
    const weekends = new Set(["sat", "sun"]);
    let firstAdded;
    for (const group of groups.filter(({ day }) => day && (action === "everyDay" || weekends.has(day) === (action === "weekend")))) {
      const added = group.addInterval(from, to);
      firstAdded ??= added;
    }
    syncTimeline();
    firstAdded?.focus();
  });
}

function enhanceOperations(form) {
  const root = form.querySelector("[data-operation-groups]");
  const search = root.querySelector("[data-operation-search]");
  const count = root.querySelector("[data-operation-count]");
  const groups = [...root.querySelectorAll("[data-operation-group]")];
  const all = form.querySelector("[data-every-operation]");
  const empty = form.querySelector("[data-no-operations]");
  const allMarker = Boolean(form.elements.capabilitiesAll);
  const sync = () => {
    const selected = form.querySelectorAll('input[name="capabilities"]:checked').length;
    all.hidden = !allMarker || selected > 0;
    empty.hidden = allMarker || selected > 0;
    count.textContent = count.dataset.countTemplate.replace("%s", selected);
    const query = search.value.trim().toLocaleLowerCase();
    for (const group of groups) {
      const rows = [...group.querySelectorAll('.operation-grid .chk')];
      const checked = rows.filter((row) => row.querySelector("input").checked).length;
      const toggle = group.querySelector("[data-operation-select-all]");
      toggle.checked = checked === rows.length;
      toggle.indeterminate = checked > 0 && checked < rows.length;
      for (const row of rows) row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
      group.hidden = rows.every((row) => row.hidden);
      if (query && !group.hidden) group.open = true;
    }
  };
  search.hidden = false;
  count.hidden = false;
  for (const group of groups) group.querySelector("[data-operation-toggle]").hidden = false;
  search.addEventListener("input", sync);
  root.addEventListener("change", ({ target }) => {
    if (target.matches("[data-operation-select-all]")) {
      for (const input of target.closest("[data-operation-group]").querySelectorAll('input[name="capabilities"]')) input.checked = target.checked;
    }
    sync();
  });
  form.querySelector("[data-chosen-operations]").addEventListener("change", sync);
  sync();
}

registerFeature("authz-editor", () => {
  const form = document.getElementById("authz-constraint");
  if (!form) return;
  const schedule = form.querySelector("#constraint-schedule");
  document.querySelector('[href="#constraint-schedule"]')?.addEventListener("click", (event) => {
    event.preventDefault();
    schedule.scrollIntoView({ block: "start" });
    schedule.focus({ preventScroll: true });
  });
  const mode = form.elements.mode;
  const vaultChoices = form.querySelector("[data-vault-choices]");
  const count = form.querySelector("[data-subject-count]");
  const search = form.querySelector("[data-subject-search]");
  const subjects = form.querySelector("[data-subject-picker]");
  const tabs = form.querySelector("[data-subject-tabs]");
  let activeKind = "";
  const previewDirty = document.querySelector("[data-preview-dirty]");
  const syncScope = () => {
    const revoke = mode.value === "revoke";
    for (const section of form.querySelectorAll("[data-suspend-only]")) {
      section.hidden = revoke;
      section.disabled = revoke;
    }
    form.querySelector("[data-suspend-help]").hidden = revoke;
    form.querySelector("[data-revoke-help]").hidden = !revoke;
    vaultChoices.hidden = form.elements.vaultScope.value !== "selected";
  };
  const syncSubjects = () => {
    if (!subjects) return;
    const query = search.value.trim().toLocaleLowerCase();
    const rows = [...subjects.querySelectorAll(".chk")];
    for (const row of rows) {
      const subject = row.querySelector("input");
      const kind = row.querySelector(".tag.danger") ? "missing" : subject.value.split(":")[0];
      row.hidden = Boolean(activeKind && activeKind !== kind) ||
        !`${row.textContent} ${subject.value}`.toLocaleLowerCase().includes(query);
    }
    form.querySelector("[data-no-matches]").hidden = rows.some((row) => !row.hidden);
    count.textContent = count.dataset.subjectCount.replace("%s", subjects.querySelectorAll(":checked").length);
  };
  if (search) search.hidden = false;
  if (tabs) {
    tabs.hidden = false;
    tabs.addEventListener("click", (event) => {
      const selected = event.target.closest("[data-subject-kind]");
      if (!selected) return;
      activeKind = selected.dataset.subjectKind;
      for (const tab of tabs.children) tab.setAttribute("aria-pressed", String(tab === selected));
      subjects.scrollTop = 0;
      syncSubjects();
    });
  }
  enhanceSchedule(form);
  enhanceOperations(form);
  syncScope();
  syncSubjects();
  search?.addEventListener("input", syncSubjects);
  form.addEventListener("change", ({ target }) => {
    if (target === mode || target.name === "vaultScope") syncScope();
    if (target.name === "subjects") syncSubjects();
  });
  if (!previewDirty) return;
  const readDraft = () => JSON.stringify([...new FormData(form)].filter(([, value]) => value !== ""));
  const initialDraft = readDraft();
  const syncPreview = () => { previewDirty.hidden = !form.dataset.draftRefused && readDraft() === initialDraft; };
  form.addEventListener("input", syncPreview);
  form.addEventListener("change", syncPreview);
  form.addEventListener("click", ({ target }) => {
    if (target.closest("[data-remove-row], [data-add-days]")) syncPreview();
  });
  syncPreview();
});
