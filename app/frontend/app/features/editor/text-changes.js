// WEB-ED-03: pure oldText/newText -> CodeMirror ChangeSpec[] mapping.
//
// A clean remote refresh must be expressed as real, ordered, non-overlapping
// changes so CodeMirror can map selection, history and decorations through the
// unchanged islands. A "common prefix + common suffix -> one big replace" is
// explicitly not enough: a multi-hunk remote edit would swallow untouched text
// between the edits and destroy precise mapping.
//
// The implementation is a deterministic Myers-style bisect diff over lines,
// followed by a bounded per-hunk character refinement. It has no DOM or module
// dependency beyond plain strings, and it operates on UTF-16 code units so the
// produced offsets match CodeMirror's own position model.

const CHAR_REFINE_LIMIT = 4096;

function splitLines(text) {
  if (text === "") return [];
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function lineOffsets(lines) {
  const offsets = [0];
  let total = 0;
  for (const line of lines) {
    total += line.length;
    offsets.push(total);
  }
  return offsets;
}

// Myers' O(ND) middle-snake search (linear space). Returns an absolute split
// point { a, b } inside [a0, a1) x [b0, b1), or null when the ranges share no
// element. Deterministic for a given input.
function bisect(a, b, a0, a1, b0, b1, equals) {
  const n = a1 - a0;
  const m = b1 - b0;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  const length = 2 * maxD + 1;
  const forward = new Int32Array(length).fill(-1);
  const backward = new Int32Array(length).fill(-1);
  forward[offset + 1] = 0;
  backward[offset + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;

  for (let d = 0; d < maxD; d += 1) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = offset + k1;
      let x1 = (k1 === -d || (k1 !== d && forward[k1Offset - 1] < forward[k1Offset + 1]))
        ? forward[k1Offset + 1]
        : forward[k1Offset - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && equals(a[a0 + x1], b[b0 + y1])) {
        x1 += 1;
        y1 += 1;
      }
      forward[k1Offset] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2Offset = offset + delta - k1;
        if (k2Offset >= 0 && k2Offset < length && backward[k2Offset] !== -1) {
          const x2 = n - backward[k2Offset];
          if (x1 >= x2) return { a: a0 + x1, b: b0 + y1 };
        }
      }
    }

    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = offset + k2;
      let x2 = (k2 === -d || (k2 !== d && backward[k2Offset - 1] < backward[k2Offset + 1]))
        ? backward[k2Offset + 1]
        : backward[k2Offset - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && equals(a[a1 - x2 - 1], b[b1 - y2 - 1])) {
        x2 += 1;
        y2 += 1;
      }
      backward[k2Offset] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1Offset = offset + delta - k2;
        if (k1Offset >= 0 && k1Offset < length && forward[k1Offset] !== -1) {
          const x1 = forward[k1Offset];
          const y1 = offset + x1 - k1Offset;
          const x2b = n - x2;
          if (x1 >= x2b) return { a: a0 + x1, b: b0 + y1 };
        }
      }
    }
  }
  return null;
}

// Cheap O(n + m) pre-check: when two ranges share no token the Myers search
// would still run its full worst case only to return null. Detecting that here
// keeps a full-document rewrite from becoming quadratic. Uses a Set so it is
// only used with primitive tokens (lines are strings, char refinement uses
// single UTF-16 code units).
function sharesAny(a, a0, a1, b, b0, b1) {
  const seen = new Set();
  for (let index = b0; index < b1; index += 1) seen.add(b[index]);
  for (let index = a0; index < a1; index += 1) {
    if (seen.has(a[index])) return true;
  }
  return false;
}

// Diff two token arrays into ordered components:
//   { op: 0, a0, b0, len } equal
//   { op: -1, a0, len }    removed from a
//   { op: 1, b0, len }     added from b
// An explicit stack keeps recursion depth independent of input size.
function diffArrays(a, b, equals) {
  const components = [];
  const stack = [{ kind: "range", a0: 0, a1: a.length, b0: 0, b1: b.length }];
  while (stack.length) {
    const item = stack.pop();
    if (item.kind === "emit") {
      components.push(item.component);
      continue;
    }
    const { a0, a1, b0, b1 } = item;

    let prefix = 0;
    while (a0 + prefix < a1 && b0 + prefix < b1 && equals(a[a0 + prefix], b[b0 + prefix])) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      a1 - suffix > a0 + prefix
      && b1 - suffix > b0 + prefix
      && equals(a[a1 - 1 - suffix], b[b1 - 1 - suffix])
    ) {
      suffix += 1;
    }

    const la0 = a0 + prefix;
    const la1 = a1 - suffix;
    const lb0 = b0 + prefix;
    const lb1 = b1 - suffix;
    const removed = la1 - la0;
    const added = lb1 - lb0;

    const ordered = [];
    const emit = (component) => ordered.push({ kind: "emit", component });
    if (prefix > 0) emit({ op: 0, a0, b0, len: prefix });
    if (removed > 0 && added > 0) {
      const split = sharesAny(a, la0, la1, b, lb0, lb1)
        ? bisect(a, b, la0, la1, lb0, lb1, equals)
        : null;
      if (split) {
        ordered.push({ kind: "range", a0: la0, a1: split.a, b0: lb0, b1: split.b });
        ordered.push({ kind: "range", a0: split.a, a1: la1, b0: split.b, b1: lb1 });
      } else {
        emit({ op: -1, a0: la0, len: removed });
        emit({ op: 1, b0: lb0, len: added });
      }
    } else if (removed > 0) {
      emit({ op: -1, a0: la0, len: removed });
    } else if (added > 0) {
      emit({ op: 1, b0: lb0, len: added });
    }
    if (suffix > 0) emit({ op: 0, a0: a1 - suffix, b0: b1 - suffix, len: suffix });

    // Push in reverse so the stack yields left-to-right output order.
    for (let index = ordered.length - 1; index >= 0; index -= 1) stack.push(ordered[index]);
  }
  return components;
}

export function computeTextChanges(oldText, newText) {
  const previous = String(oldText ?? "");
  const next = String(newText ?? "");
  if (previous === next) return [];

  const oldLines = splitLines(previous);
  const newLines = splitLines(next);
  const components = diffArrays(oldLines, newLines, (left, right) => left === right);
  const oldOffsets = lineOffsets(oldLines);

  const changes = [];
  let aIndex = 0;
  let bIndex = 0;
  let index = 0;

  while (index < components.length) {
    const component = components[index];
    if (component.op === 0) {
      aIndex += component.len;
      bIndex += component.len;
      index += 1;
      continue;
    }

    const aStart = aIndex;
    const bStart = bIndex;
    let aEnd = aIndex;
    let bEnd = bIndex;
    while (index < components.length && components[index].op !== 0) {
      if (components[index].op === -1) aEnd += components[index].len;
      else bEnd += components[index].len;
      index += 1;
    }
    aIndex = aEnd;
    bIndex = bEnd;

    const from = oldOffsets[aStart];
    const to = oldOffsets[aEnd];
    const insert = newLines.slice(bStart, bEnd).join("");
    appendRegion(changes, previous, from, to, insert);
  }

  return changes;
}

function appendRegion(changes, previous, from, to, insert) {
  if (from === to && insert === "") return;
  if (from === to || insert === "") {
    changes.push({ from, to, insert });
    return;
  }
  if (to - from + insert.length > CHAR_REFINE_LIMIT) {
    changes.push({ from, to, insert });
    return;
  }

  const oldRegion = previous.slice(from, to);
  const oldChars = oldRegion.split("");
  const newChars = insert.split("");
  const components = diffArrays(oldChars, newChars, (left, right) => left === right);

  let aIndex = 0;
  let bIndex = 0;
  let index = 0;
  while (index < components.length) {
    const component = components[index];
    if (component.op === 0) {
      aIndex += component.len;
      bIndex += component.len;
      index += 1;
      continue;
    }
    let aEnd = aIndex;
    let bEnd = bIndex;
    while (index < components.length && components[index].op !== 0) {
      if (components[index].op === -1) aEnd += components[index].len;
      else bEnd += components[index].len;
      index += 1;
    }
    const changeFrom = from + aIndex;
    const changeTo = from + aEnd;
    const changeInsert = insert.slice(bIndex, bEnd);
    if (changeFrom === changeTo && changeInsert === "") {
      // Skip a no-op refinement step.
    } else {
      changes.push({ from: changeFrom, to: changeTo, insert: changeInsert });
    }
    aIndex = aEnd;
    bIndex = bEnd;
  }
}

// Test/support helper: replay the changes against the old text.
export function applyTextChanges(text, changes) {
  const source = String(text ?? "");
  let result = "";
  let cursor = 0;
  for (const change of changes) {
    result += source.slice(cursor, change.from);
    result += change.insert ?? "";
    cursor = change.to;
  }
  result += source.slice(cursor);
  return result;
}
