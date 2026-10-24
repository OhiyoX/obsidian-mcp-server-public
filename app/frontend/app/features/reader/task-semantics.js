const TASK_CHECKBOX_CLASS = "task-list-item-checkbox";

// Desktop reads a task state with `[>\s]*...` + `(?:\[(.)\] )?` (asar app.js `dR`): the
// marker is any single character and a state is checked when it is not a space
// (`n.checked = " " !== this.content`, asar app.js `Task.initDOM`), so `[/]`, `[-]`, `[>]`
// and `[X]` are all tasks. markdown-it-task-lists only knows `[ ]`/`[x]`/`[X]`.
const TASK_MARKER = /^\[(.)\] /;
const PLUGIN_MARKERS = new Set([" ", "x", "X"]);

function findTaskCheckbox(token) {
  if (!Array.isArray(token?.children)) return null;
  return token.children.find((child) =>
    child.type === "html_inline"
    && child.content.includes(`class="${TASK_CHECKBOX_CLASS}"`));
}

function addTaskMarkerToCheckbox(checkbox, marker) {
  if (/\bdata-task=/.test(checkbox.content)) return;
  checkbox.content = checkbox.content.replace("<input ", `<input data-task="${marker}" `);
}

function isTaskItem(tokens, index) {
  return tokens[index].type === "inline"
    && tokens[index - 1].type === "paragraph_open"
    && tokens[index - 2].type === "list_item_open";
}

/**
 * markdown-it-task-lists supplies the checkbox and task-list-item class, but it
 * does not expose Obsidian's data-task/is-checked surface. Add those semantics
 * after the plugin has transformed the inline token so Vault themes can reuse
 * their normal Desktop selectors. Custom states run through this pair of rules:
 * the pre-rule remembers the authored marker and normalizes the prefix to `[x]`
 * so the plugin still builds the checked checkbox, the post-rule restores the
 * authored marker on the `<li>` and the `<input>`.
 */
export function configureTaskSemantics(parser) {
  parser.core.ruler.before("github-task-lists", "obsidian_task_marker", (state) => {
    const { tokens } = state;
    for (let index = 2; index < tokens.length; index += 1) {
      if (!isTaskItem(tokens, index)) continue;
      const inline = tokens[index];
      const match = TASK_MARKER.exec(inline.content);
      if (!match) continue;
      inline.obsidianTaskMarker = match[1];
      if (PLUGIN_MARKERS.has(match[1])) continue;
      inline.content = `[x]${inline.content.slice(3)}`;
      const first = inline.children?.[0];
      if (first?.type === "text") first.content = `[x]${first.content.slice(3)}`;
    }
  });

  parser.core.ruler.after("github-task-lists", "obsidian_task_semantics", (state) => {
    const { tokens } = state;
    for (let index = 2; index < tokens.length; index += 1) {
      const inline = tokens[index];
      const paragraph = tokens[index - 1];
      const listItem = tokens[index - 2];
      if (
        inline.type !== "inline"
        || paragraph.type !== "paragraph_open"
        || listItem.type !== "list_item_open"
      ) continue;

      const checkbox = findTaskCheckbox(inline);
      if (!checkbox) continue;

      const marker = inline.obsidianTaskMarker
        ?? (/\schecked(?:=(?:""|'')|\b)/i.test(checkbox.content) ? "x" : " ");
      listItem.attrSet("data-task", marker);
      // Desktop: `is-checked` is exactly "the marker is not a space".
      if (marker !== " ") listItem.attrJoin("class", "is-checked");
      addTaskMarkerToCheckbox(checkbox, marker);
    }
  });
}
