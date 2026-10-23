// Filter popover body (desktop Bases "Filter" menu).
//
// Shape: the `当前视图` section (real count of the leaves this view carries in the
// URL) + the desktop conjunction line (`All` / `Any` / `None of the following`,
// `labelAllTheFollowing` / `labelAnyOfTheFollowing` / `labelNoneOfTheFollowing`)
// + one row per condition (`属性 select` / `运算符 select` / `值 input` / 删除)
// + a footer with `添加筛选器` / `清除筛选` and the `</>` advanced (raw expression)
// mode entry.
//
// G3 (this slice): `state.filter` is either the legacy AND list
// `[{key,op,value}]` or a desktop group `{and|or|not:[...]}` (query-state.js owns
// the codec). The conjunction select writes the group form; "All" writes the
// legacy array back so every pre-G3 URL stays byte-identical.
//
// G4: the operator list is the full desktop simple-builder table (matrix §2.3).
//
// Deliberate omissions (no fake controls):
//  - `所有视图` section: the desktop lists the Base-file-level `filters`, and the
//    frozen Web DTO does not expose them. There is no honest count, so the section
//    is not drawn at all.
//  - simple -> advanced conversion is NOT performed: the desktop serializes a
//    simple filter into an expression, this build has no such serializer, so the
//    attempt reports a visible message instead of pretending. advanced -> simple
//    reports the desktop `msgFilterSimpleUnavailable` text for the same reason.

import { buildSelect, el } from "./dom.js";
import { panelActions, panelButton, panelScroll, panelSection, panelShell, columnOptions } from "./panel-chrome.js";
import { BASE_FILTER_OPS, BASE_FILTER_OPS_NOVALUE, BASE_FILTER_CONJUNCTIONS, BASE_QUERY_MAX } from "./query-state.js";

export const BASE_FILTER_OP_LABELS = Object.freeze({
  "is": "等于",
  "is-not": "不等于",
  "contains": "包含",
  "starts-with": "开头是",
  "ends-with": "结尾是",
  "lt": "小于",
  "lte": "小于等于",
  "gt": "大于",
  "gte": "大于等于",
  "is-empty": "为空",
  "is-not-empty": "不为空",
  "contains-any": "包含任一",
  "contains-all": "包含全部",
  "matches": "匹配正则",
  "has-property": "有属性",
  "has-link": "链接到",
  "in-folder": "位于文件夹",
  "has-tag": "有标签",
});

// Desktop conjunction labels (i18n `labelAllOfTheFollowing` / `labelAnyOf…` /
// `labelNoneOf…`); the stored key is the API conjunction, not the label.
const BASE_FILTER_MATCH_OPTIONS = [
  { value: "and", label: "满足以下所有条件" },
  { value: "or", label: "满足以下任一条件" },
  { value: "not", label: "以下条件都不满足" },
];

export const BASE_FILTER_MESSAGES = Object.freeze({
  simpleUnavailable: "此筛选器无法用简单筛选器表示。",
  cannotParse: "筛选器无法解析，简单筛选器不可用。",
});

// Desktop tooltips for the `</>` toggle of the filter menu
// (`plugins.bases.tooltip-filter-advanced-mode` / `-simple-mode`). The toggle is an
// icon control: the desktop filter menu carries it in its container header next to
// the menu title, not as a worded footer button.
const BASE_FILTER_MODE_LABELS = Object.freeze({
  advanced: "高级筛选",
  simple: "简单筛选",
});

function groupKeyOf(filter) {
  if (!filter || Array.isArray(filter) || typeof filter !== "object") return null;
  return BASE_FILTER_CONJUNCTIONS.find((key) => Array.isArray(filter[key])) ?? null;
}

function leavesOf(filter) {
  const groupKey = groupKeyOf(filter);
  if (groupKey) return Array.isArray(filter[groupKey]) ? filter[groupKey] : [];
  return Array.isArray(filter) ? filter : [];
}

// Write the same leaves under a new conjunction. `and` deliberately degrades to
// the legacy array so the pre-G3 URL shape is preserved byte for byte. With no
// leaves the conjunction carries no predicate at all, so it stays the legacy
// empty array instead of fabricating `{or: []}` (which matches nothing).
export function withConjunction(filter, conjunction) {
  const leaves = leavesOf(filter);
  if (!leaves.length) return [];
  return conjunction === "and" ? leaves : { [conjunction]: leaves };
}

export function buildFilterPanel(state, context, { onFilter } = {}) {
  const doc = context.doc;
  const panel = panelShell(doc, "filter", "筛选");
  // G5: the desktop filter menu is `div.menu.bases-toolbar-menu` > `div.menu-scroll` and its
  // sections are the scroll node's own children (`r.scrollEl.createDiv("bases-toolbar-section"…)`,
  // asar app.js@2479077) — no `bases-toolbar-menu-container` in this menu.
  const scroll = panelScroll(doc);
  panel.appendChild(scroll);
  const filter = state.filter;
  const conditions = leavesOf(filter);
  const expressions = conditions.filter((item) => typeof item === "string");
  const advanced = expressions.length > 0;
  const columns = Array.isArray(context.columns) ? context.columns : [];
  const options = columnOptions(columns, conditions.map((condition) => condition?.key));

  const { section, content } = panelSection(doc, {
    label: "当前视图",
    count: conditions.length,
    attribute: "data-filter-group",
    name: "view",
  });
  scroll.appendChild(section);

  // The simple/advanced switch is the desktop's per-row `</>` icon control: the desktop
  // builds it INSIDE the filter row's action area
  // (`var h=l.createDiv("filter-row-actions"); r.toggleAdvancedModeButton=h.createEl("button",
  // {cls:"clickable-icon filer-expression-mode-toggle"})`, asar app.js@2468679/@2468775,
  // with the `code-xml` / `mouse-pointer-click` glyphs and the
  // `tooltip-filter-advanced-mode` / `-simple-mode` tooltips at @2472380/@2472400). It was on
  // the `当前视图` heading row, which is NOT where the desktop puts it — the section header
  // carries only the collapse icon, the label and the flair (@2479077).
  //
  // Placement deviation, registered: the desktop's toggle switches ONE row into the formula
  // editor, while this build's raw-expression mode is panel-wide (one expression per line,
  // `data-filter-advanced-mode`). So it cannot live in a condition row; it lives in the
  // group's action row (`div.filter-group-actions`, asar app.js@2465689, `display:flex`
  // app.css@471185) as its trailing icon control — the same row-action shape, at the level
  // this build's mode really has. See HANDOFF-MENU-CONTENT.md §G10/§`<>`.
  const mode = panelButton(doc, {
    icon: "code",
    attributes: {
      "data-filter-mode": advanced ? "advanced" : "simple",
      "aria-label": advanced ? BASE_FILTER_MODE_LABELS.simple : BASE_FILTER_MODE_LABELS.advanced,
      title: advanced ? BASE_FILTER_MODE_LABELS.simple : BASE_FILTER_MODE_LABELS.advanced,
    },
    focusKey: "filter-mode",
    className: "base-panel-button base-panel-icon-button base-panel-mode",
  });
  mode.onclick = () => {
    if (advanced) {
      // Desktop `msgFilterSimpleUnavailable`: an expression filter has no simple
      // builder representation in this build.
      say(BASE_FILTER_MESSAGES.simpleUnavailable);
      return;
    }
    if (conditions.length) {
      // The desktop serializes a simple filter into an expression; this build has
      // no such serializer, so the switch is refused with a visible message
      // instead of silently dropping the conditions.
      say(BASE_FILTER_MESSAGES.simpleUnavailable);
      return;
    }
    say("");
    onFilter?.({ [groupKeyOf(filter) ?? "and"]: ["status == \"active\""] });
  };

  const message = el(doc, "p", "base-panel-hint", "");
  message.hidden = true;
  message.setAttribute("data-filter-message", "");
  const say = (text) => {
    message.textContent = text;
    message.hidden = !text;
  };

  const matchSelect = buildSelect(doc, {
    className: "base-panel-select",
    options: BASE_FILTER_MATCH_OPTIONS,
    value: groupKeyOf(filter) ?? "and",
    attributes: { "data-filter-match": "" },
    focusKey: "filter-match",
  });
  matchSelect.onchange = () => {
    say("");
    onFilter?.(withConjunction(filter, matchSelect.value));
  };
  content.appendChild(matchSelect);

  if (advanced) {
    // The raw-expression input owns its own full-width row: sharing the line with the
    // conjunction selector shrank it to whatever the selector left over (measured
    // 144px at a 320px popover), and the conjunction line is not a value row anyway.
    const area = doc.createElement("textarea");
    area.className = "base-panel-input base-panel-textarea";
    area.setAttribute("data-filter-advanced-mode", "");
    area.setAttribute("data-focus", "filter-advanced");
    area.value = expressions.join("\n");
    area.placeholder = "高级筛选（每行一个表达式）";
    const commit = () => {
      const lines = area.value.split("\n").map((line) => line.trim().slice(0, BASE_QUERY_MAX)).filter(Boolean);
      if (!lines.length) {
        say(BASE_FILTER_MESSAGES.cannotParse);
        return;
      }
      say("");
      // Review F1: a bare string array at the top level is ambiguous (the legacy
      // AND list is condition-only). Submit the explicit group form the server
      // and the codec both know, preserving the selected conjunction.
      onFilter?.({ [groupKeyOf(filter) ?? "and"]: lines });
    };
    area.onchange = commit;
    area.onblur = commit;
    content.appendChild(area);
  } else {
    conditions.forEach((condition, index) => {
      const row = el(doc, "div", "base-panel-row");
      row.setAttribute("data-filter-row", String(index));

      const keySelect = buildSelect(doc, {
        className: "base-panel-select",
        options,
        value: condition.key,
        attributes: { "data-filter-key": "" },
        focusKey: `filter-key-${index}`,
      });
      keySelect.onchange = () => {
        onFilter?.(conditions.map((item, position) => (position === index ? { ...item, key: keySelect.value } : item)));
      };
      row.appendChild(keySelect);

      const opSelect = buildSelect(doc, {
        className: "base-panel-select",
        options: BASE_FILTER_OPS.map((op) => ({ value: op, label: BASE_FILTER_OP_LABELS[op] ?? op })),
        value: condition.op,
        attributes: { "data-filter-op": "" },
        focusKey: `filter-op-${index}`,
      });
      opSelect.onchange = () => {
        onFilter?.(conditions.map((item, position) => (
          position === index ? { key: item.key, op: opSelect.value } : item
        )));
      };
      row.appendChild(opSelect);

      if (!BASE_FILTER_OPS_NOVALUE.includes(condition.op)) {
        const input = doc.createElement("input");
        input.className = "base-panel-input";
        input.type = "text";
        input.setAttribute("data-filter-value", "");
        input.setAttribute("data-focus", `filter-value-${index}`);
        input.value = condition.value === undefined || condition.value === null ? "" : String(condition.value);
        input.placeholder = "值";
        const commit = () => {
          if (input.value === String(condition.value ?? "")) return;
          onFilter?.(conditions.map((item, position) => (
            position === index ? { ...item, value: input.value } : item
          )));
        };
        input.onchange = commit;
        input.onblur = commit;
        input.onkeydown = (event) => {
          if (event?.key === "Enter") {
            event.preventDefault?.();
            commit();
          }
        };
        row.appendChild(input);
      }

      const remove = panelButton(doc, {
        icon: "x",
        attributes: { "data-filter-remove": String(index), "aria-label": "删除筛选条件" },
        focusKey: `filter-remove-${index}`,
        // G9: a destructive action is `.mod-destructive` in the desktop menu
        // (`n.rowEl.toggleClass("mod-destructive",e.destructive)`, asar app.js@2523902;
        // declared @467177). The desktop's carrier is the action ROW; here the row's real
        // control is this button, so the class lands on the control (see HANDOFF §G9).
        className: "base-panel-button base-panel-icon-button mod-destructive",
      });
      remove.onclick = () => onFilter?.(conditions.filter((_item, position) => position !== index));
      row.appendChild(remove);

      content.appendChild(row);
    });
  }

  content.appendChild(message);

  // The action row is the desktop's `div.filter-group-actions` (asar app.js@2465689:
  // `o.containerEl.createDiv("filter-group-actions", e => { new oI(e).setIcon("lucide-plus")
  // .setText(vJ.buttonAddFilter())…; new oI(e)….setText(vJ.buttonAddFilterGroup())… })`,
  // `display:flex` at app.css@471185): the add actions share ONE row, which is the shape the
  // owner's screenshot showed. `添加筛选器组` is NOT rendered: it creates a nested
  // `.filter-group` the desktop can then edit in place, and this panel's builder is one level
  // deep (`leavesOf`/`withConjunction` in this file read a single leaf list), so the button
  // could not produce a group the user could then edit. Registered in HANDOFF §动作行.
  const actions = panelActions(doc);
  if (!advanced) {
    const add = panelButton(doc, {
      text: "添加筛选器",
      icon: "plus",
      attributes: { "data-filter-add": "" },
      focusKey: "filter-add",
    });
    add.disabled = columns.length === 0;
    if (add.disabled) add.classList.add("is-disabled");
    add.onclick = () => {
      if (add.disabled) return;
      const column = columns[0];
      onFilter?.(withConjunction([...conditions, { key: column?.key ?? "", op: "is", value: "" }], groupKeyOf(filter) ?? "and"));
    };
    actions.appendChild(add);
  }

  // `清除筛选` has no desktop counterpart in the filter menu (the desktop clears a
  // filter through the per-condition `移除筛选器` control), so it stays as the
  // surface's own affordance and is registered as a deliberate deviation in
  // docs/bases/BASES-COMPATIBILITY-MATRIX.md §14.
  if (conditions.length) {
    const clear = panelButton(doc, {
      text: "清除筛选",
      attributes: { "data-filter-clear": "" },
      focusKey: "filter-clear",
    });
    clear.onclick = () => {
      say("");
      onFilter?.([]);
    };
    actions.appendChild(clear);
  }

  actions.appendChild(mode);
  content.appendChild(actions);
  return panel;
}
