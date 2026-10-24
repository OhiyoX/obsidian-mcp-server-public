import { Decoration, WidgetType } from "@codemirror/view";

export class TaskCheckboxWidget extends WidgetType {
  constructor(from, to, checked) {
    super();
    this.from = from;
    this.to = to;
    this.checked = checked;
  }

  eq(other) {
    return other.from === this.from && other.to === this.to && other.checked === this.checked;
  }

  toDOM(view) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "task-list-item-checkbox cm-live-task-checkbox";
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "标记任务为未完成" : "标记任务为完成");
    input.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const head = view.state.selection.main.head;
      view.dispatch({
        changes: { from: this.from + 1, to: this.from + 2, insert: this.checked ? " " : "x" },
        selection: { anchor: taskCaretAfterToggle(head, this.from, this.to) },
      });
      view.focus();
    });
    return input;
  }

  ignoreEvent() { return true; }
}

export function taskAtomicRangesFromDecorations(decorations, docLength) {
  const ranges = [];
  decorations.between(0, docLength, (from, to, value) => {
    if (from < to && value.spec?.widget instanceof TaskCheckboxWidget) {
      ranges.push(Decoration.mark({}).range(from, to));
    }
  });
  return Decoration.set(ranges, true);
}

export function taskCaretAfterToggle(head, from, to) {
  return head > from && head < to ? to : head;
}
