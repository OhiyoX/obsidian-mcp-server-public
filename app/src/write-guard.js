// Destructive-write guard for overwrite-style note mutations (issue #251).
//
// This module is deliberately pure: no filesystem access, no server state, and
// no mutation. Callers measure the bytes they are about to write and pass both
// sides of the change in; every decision here is derived only from those inputs
// plus the exported thresholds.

import { parseBlocks, parseHeadings } from "./obsidian.js";

// A write is treated as destructive when the whole file shrinks by more than
// this ratio AND the pre-write file was at least WRITE_SHRINK_MIN_BYTES. Small
// notes are exempt so routine edits to a handful of lines never prompt.
export const WRITE_SHRINK_RATIO = 0.2;
export const WRITE_SHRINK_MIN_BYTES = 2048;

const MAX_LISTED_TITLES = 10;

export function noteOutline(content) {
  const text = typeof content === "string" ? content : "";
  return {
    headings: [...new Set(parseHeadings(text).map((heading) => heading.title))].sort(),
    blocks: [...new Set(parseBlocks(text).map((block) => block.id))].sort(),
  };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

export function assessWriteImpact({ previousBytes = 0, nextBytes = 0, previousContent = "", nextContent = "" } = {}) {
  // The gate decision must use the unrounded ratio: a real shrink of 20.0008%
  // rounds to a displayed 0.2 and must still be refused. Only the reported
  // `shrinkRatio` is rounded for display.
  const rawShrinkRatio = previousBytes > 0 ? Math.max(0, (previousBytes - nextBytes) / previousBytes) : 0;
  const shrinkRatio = round4(rawShrinkRatio);
  const before = noteOutline(previousContent);
  const after = noteOutline(nextContent);
  const afterHeadings = new Set(after.headings);
  const afterBlocks = new Set(after.blocks);
  return {
    previousBytes,
    nextBytes,
    shrinkRatio,
    rawShrinkRatio,
    shrunk: previousBytes >= WRITE_SHRINK_MIN_BYTES && rawShrinkRatio > WRITE_SHRINK_RATIO,
    removedHeadings: before.headings.filter((heading) => !afterHeadings.has(heading)),
    removedBlocks: before.blocks.filter((block) => !afterBlocks.has(block)),
  };
}

function formatTitles(values) {
  if (values.length === 0) return "(none)";
  const listed = values.slice(0, MAX_LISTED_TITLES).map((value) => `"${value}"`).join(", ");
  return values.length > MAX_LISTED_TITLES ? `${listed} (+${values.length - MAX_LISTED_TITLES} more)` : listed;
}

export function assertShrinkConfirmed(impact, { confirmShrink, toolName, path } = {}) {
  if (!impact?.shrunk || confirmShrink === true) return impact;
  const percent = (impact.shrinkRatio * 100).toFixed(1);
  throw new Error(
    `${toolName} would shrink ${path} from ${impact.previousBytes} bytes to ${impact.nextBytes} bytes (-${percent}%), ` +
    `removing ${impact.removedHeadings.length} heading(s) [${formatTitles(impact.removedHeadings)}] and ` +
    `${impact.removedBlocks.length} block(s) [${formatTitles(impact.removedBlocks)}]. ` +
    "This is an overwrite that deletes note content. Re-run with confirmShrink: true to proceed, or call " +
    `plan_note_changes first to review the diff. list_versions plus restore_version can roll back a completed write.`,
  );
}
