/**
 * Preserve mark decorations around source ranges that are replaced by Live Preview.
 *
 * Semantic marks often include Markdown chrome (for example **, *, ~~ or link
 * delimiters). A replacement owns those source characters, but the visible text
 * on either side should keep its semantic class instead of losing the whole mark.
 */
export function splitMarksAroundExclusive(marks, exclusiveRanges) {
  const kept = [];
  for (const range of marks) {
    let segments = [{ from: range.from, to: range.to }];
    for (const exclusiveRange of exclusiveRanges) {
      if (exclusiveRange.to <= range.from) continue;
      if (exclusiveRange.from >= range.to) break;
      const next = [];
      for (const segment of segments) {
        if (exclusiveRange.to <= segment.from || exclusiveRange.from >= segment.to) {
          next.push(segment);
          continue;
        }
        if (exclusiveRange.from > segment.from) {
          next.push({ from: segment.from, to: exclusiveRange.from });
        }
        if (exclusiveRange.to < segment.to) {
          next.push({ from: exclusiveRange.to, to: segment.to });
        }
      }
      segments = next;
      if (!segments.length) break;
    }
    for (const segment of segments) {
      if (segment.to > segment.from) kept.push(range.value.range(segment.from, segment.to));
    }
  }
  return kept;
}
