import { icon } from "../../ui/icons.js";
import {
  coercePropertyInput,
  displayPropertyValue,
  isListPropertyKey,
  propertyIconName,
} from "../editor/frontmatter.js";
import { formatDateValue, isoDateParts } from "./property-value.js";

function stop(event) {
  event.preventDefault();
  event.stopPropagation();
}

/** `tags` is the only list property whose pills are tag searches (`aliases` opens notes). */
function isTagPropertyKey(key) {
  return /^tags?$/i.test(key);
}

/**
 * Obsidian-like properties panel used by Live (editable) and Reading (read-only).
 * Returns a DOM root; callers own mounting and document writes.
 */
export function createPropertiesPanel(options = {}) {
  const editable = options.editable !== false;
  const data = { ...(options.data || {}) };
  const parseError = Boolean(options.parseError);
  const onChange = typeof options.onChange === "function" ? options.onChange : null;
  const onSearchTag = typeof options.onSearchTag === "function" ? options.onSearchTag : null;

  const root = document.createElement("div");
  root.className = `metadata-container properties document-properties${editable ? " is-editable" : " is-readonly"}`;
  root.dataset.editable = editable ? "true" : "false";
  root.setAttribute("aria-label", "笔记属性");

  const heading = document.createElement("button");
  heading.type = "button";
  heading.className = "metadata-properties-heading document-properties-toggle cm-live-properties-toggle";
  heading.append(icon("chevron-right", "svg-icon properties-chevron"));
  heading.append(icon("list-tree", "svg-icon properties-icon"));
  const title = document.createElement("span");
  title.textContent = "笔记属性";
  heading.append(title);

  const content = document.createElement("div");
  content.className = "metadata-content";
  const list = document.createElement("div");
  list.className = "metadata-properties";

  let open = options.open !== false;
  const syncOpen = () => {
    content.hidden = !open;
    root.classList.toggle("is-collapsed", !open);
    if (heading.tagName === "BUTTON") heading.setAttribute("aria-expanded", String(open));
  };
  syncOpen();
  heading.addEventListener("click", (event) => {
    stop(event);
    open = !open;
    syncOpen();
  });

  const commit = () => {
    onChange?.({ ...data });
  };

  const buildRow = (key, value) => {
    const row = document.createElement("div");
    row.className = "property metadata-property document-property-row";

    const keyCell = document.createElement("div");
    keyCell.className = "metadata-property-key";
    keyCell.append(icon(propertyIconName(key), "svg-icon metadata-property-icon"));
    const keyLabel = document.createElement("span");
    keyLabel.textContent = key;
    keyCell.append(keyLabel);

    const valueCell = document.createElement("div");
    valueCell.className = "metadata-property-value";

    if (isListPropertyKey(key) || Array.isArray(value)) {
      const values = Array.isArray(value) ? value : [];
      const pills = document.createElement("div");
      pills.className = "document-property-pills cm-live-property-pills";
      const taggable = Boolean(onSearchTag) && isTagPropertyKey(key);
      for (const item of values) {
        const pill = document.createElement("span");
        pill.className = "property-pill multi-select-pill cm-live-tag-pill";
        const label = document.createElement("span");
        // Desktop parity: the pill's label is the `.multi-select-pill-content` box (asar
        // app.js@1845965), which is what the pill's `max-width` clamp sizes (see app.css).
        label.className = "multi-select-pill-content";
        // Desktop strips one leading `#` from a tag value before showing/searching it.
        const text = taggable ? String(item).replace(/^#/, "") : String(item);
        label.textContent = text;
        if (taggable) {
          // Desktop parity: the pill label itself searches `tag:<value>`; the × beside it
          // stays the removal target, so the two affordances never overlap.
          label.dataset.tag = text;
          label.title = `在标签里搜索 ${text}`;
          label.addEventListener("click", (event) => {
            stop(event);
            onSearchTag(text);
          });
        }
        pill.append(label);
        if (editable) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "cm-live-property-pill-remove";
          remove.setAttribute("aria-label", `移除 ${item}`);
          remove.addEventListener("click", (event) => {
            stop(event);
            data[key] = values.filter((entry) => entry !== item);
            commit();
          });
          pill.append(remove);
        }
        pills.append(pill);
      }
      valueCell.append(pills);
      if (editable) {
        const add = document.createElement("input");
        add.className = "cm-live-property-input cm-live-property-pill-input";
        add.type = "text";
        add.placeholder = "添加…";
        add.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          stop(event);
          const next = add.value.trim();
          if (!next) return;
          data[key] = [...values, next];
          commit();
        });
        valueCell.append(add);
      }
    } else if (typeof value === "boolean") {
      if (editable) {
        const select = document.createElement("select");
        select.className = "cm-live-property-input";
        for (const optionValue of ["true", "false"]) {
          const option = document.createElement("option");
          option.value = optionValue;
          option.textContent = optionValue;
          if ((value && optionValue === "true") || (!value && optionValue === "false")) option.selected = true;
          select.append(option);
        }
        select.addEventListener("change", () => {
          data[key] = select.value === "true";
          commit();
        });
        valueCell.append(select);
      } else {
        const pill = document.createElement("span");
        pill.className = "property-pill property-boolean";
        pill.textContent = value ? "true" : "false";
        valueCell.append(pill);
      }
    } else if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      if (editable) {
        const input = document.createElement("textarea");
        input.className = "cm-live-property-input cm-live-property-object";
        input.rows = 2;
        input.value = displayPropertyValue(value);
        input.addEventListener("blur", () => {
          data[key] = coercePropertyInput(key, input.value, value);
          commit();
        });
        valueCell.append(input);
      } else {
        const code = document.createElement("code");
        code.className = "cm-live-property-object-code";
        code.textContent = displayPropertyValue(value);
        valueCell.append(code);
      }
    } else if (value instanceof Date && editable) {
      // A read-only Date falls through to the ISO-date chip below, so the panel shares the
      // one date renderer (authored day, instant only where a time is present) the reading
      // view uses; `toLocaleDateString()` on the instant shifted the day in UTC-x zones.
      const input = document.createElement("input");
      input.className = "cm-live-property-input";
      input.type = "text";
      input.value = displayPropertyValue(value);
      input.addEventListener("blur", () => {
        data[key] = coercePropertyInput(key, input.value, value);
        commit();
      });
      valueCell.append(input);
    } else if (value == null || value === "") {
      const empty = document.createElement("span");
      empty.className = "metadata-empty";
      empty.textContent = "—";
      if (editable) {
        const input = document.createElement("input");
        input.className = "cm-live-property-input";
        input.type = "text";
        input.value = "";
        input.addEventListener("blur", () => {
          data[key] = coercePropertyInput(key, input.value, value);
          commit();
        });
        valueCell.append(input);
      } else {
        valueCell.append(empty);
      }
    } else if (editable) {
      const buildInput = () => {
        const input = document.createElement("input");
        input.className = "cm-live-property-input";
        input.type = "text";
        input.value = displayPropertyValue(value);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            stop(event);
            input.blur();
          }
        });
        input.addEventListener("blur", () => {
          data[key] = coercePropertyInput(key, input.value, value);
          commit();
        });
        return input;
      };
      const editableDate = formatDateValue(value);
      const editableParts = isoDateParts(value);
      if (editableDate && editableParts) {
        // Desktop parity in the editable surface too: the date shows as glyph + locale
        // short form and only becomes a text field once it is clicked.
        const dateButton = document.createElement("button");
        dateButton.type = "button";
        dateButton.className = "metadata-property-date metadata-property-date-editor";
        dateButton.title = editableParts.iso;
        dateButton.setAttribute("aria-label", `${key}: ${editableDate}（点击编辑，源值 ${editableParts.iso}）`);
        dateButton.append(icon("calendar", "svg-icon metadata-property-date-icon"), document.createTextNode(editableDate));
        dateButton.addEventListener("click", (event) => {
          stop(event);
          const input = buildInput();
          dateButton.replaceWith(input);
          input.focus();
          input.select?.();
        });
        valueCell.append(dateButton);
      } else {
        valueCell.append(buildInput());
      }
    } else {
      // Desktop parity: a date value (a Date from YAML, or a string that is exactly an ISO date)
      // renders as a date (calendar glyph + locale short form) with the source value kept for
      // tooltips/copying, exactly like the reading-view chip; a value carrying a time keeps its
      // full instant in `datetime` (the Publish contract #546).
      const dateText = formatDateValue(value);
      const parsed = isoDateParts(value);
      if (dateText && parsed) {
        const time = document.createElement("time");
        time.className = "metadata-property-date";
        time.dateTime = parsed.datetime ?? parsed.iso;
        time.title = parsed.iso;
        time.append(icon("calendar", "svg-icon metadata-property-date-icon"), document.createTextNode(dateText));
        valueCell.append(time);
      } else {
        valueCell.append(document.createTextNode(displayPropertyValue(value)));
      }
    }

    row.append(keyCell, valueCell);
    if (editable) {
      const removeRow = document.createElement("button");
      removeRow.type = "button";
      removeRow.className = "cm-live-property-remove";
      removeRow.title = "移除属性";
      removeRow.setAttribute("aria-label", `移除属性 ${key}`);
      removeRow.textContent = "×";
      removeRow.addEventListener("click", (event) => {
        stop(event);
        delete data[key];
        commit();
      });
      row.append(removeRow);
    }
    return row;
  };

  if (parseError) {
    const note = document.createElement("p");
    note.className = "cm-live-property-error";
    note.textContent = "无法解析属性。";
    content.append(note);
  } else {
    const keys = Object.keys(data);
    if (!keys.length) {
      const empty = document.createElement("p");
      empty.className = "cm-live-property-empty";
      empty.textContent = "尚未添加属性";
      list.append(empty);
    } else {
      for (const key of keys) list.append(buildRow(key, data[key]));
    }
    content.append(list);
  }

  if (editable) {
    const actions = document.createElement("div");
    actions.className = "cm-live-property-actions";
    const addRow = document.createElement("button");
    addRow.type = "button";
    addRow.className = "cm-live-property-add";
    addRow.append(icon("plus", "svg-icon"));
    const addLabel = document.createElement("span");
    addLabel.textContent = "添加笔记属性";
    addRow.append(addLabel);
    addRow.addEventListener("click", (event) => {
      stop(event);
      let index = 1;
      let key = "new-property";
      while (Object.prototype.hasOwnProperty.call(data, key)) {
        index += 1;
        key = `new-property-${index}`;
      }
      data[key] = "";
      commit();
    });
    actions.append(addRow);
    content.append(actions);
  }

  root.append(heading, content);
  return root;
}
