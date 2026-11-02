// Focused tests for the generated-artifact text comparison used by the P2-C verifiers.
//
// The real failure this guards: `cost-gate.md` / `runtime-matrix.md` are committed with
// LF, but a Windows `core.autocrlf=true` checkout materializes them as CRLF, which made
// `--verify` / `npm test` fail even though no content changed. The comparison must accept
// CRLF-equivalent text and reject every other edit (including a BOM or a changed final newline).
import assert from "node:assert/strict";
import test from "node:test";
import { generatedArtifactMismatch, normalizeArtifactEol } from "../scripts/artifact-text.mjs";

const LF = "line one\nline two\n";
const CRLF = "line one\r\nline two\r\n";

test("normalizeArtifactEol folds CRLF to LF and leaves everything else", () => {
  assert.equal(normalizeArtifactEol(CRLF), LF);
  assert.equal(normalizeArtifactEol(LF), LF);
  assert.equal(normalizeArtifactEol("a\r\nb\nc"), "a\nb\nc");
  // A lone CR is not a supported checkout transformation and is left intact.
  assert.equal(normalizeArtifactEol("a\rb"), "a\rb");
});

test("identical LF text matches with no reason", () => {
  assert.equal(generatedArtifactMismatch(LF, LF), null);
});

test("CRLF checkout text matches the freshly generated LF text", () => {
  assert.equal(generatedArtifactMismatch(CRLF, LF), null);
});

test("mixed CRLF/LF checkout text matches when the content is otherwise identical", () => {
  assert.equal(generatedArtifactMismatch("line one\r\nline two\n", LF), null);
});

test("intentional final newline is required and not trimmed", () => {
  assert.notEqual(generatedArtifactMismatch("line one\nline two", LF), null);
  assert.notEqual(generatedArtifactMismatch("line one\nline two\n\n", LF), null);
  // A CRLF final newline is still the same as the committed LF final newline.
  assert.equal(generatedArtifactMismatch("line one\r\nline two\r\n", LF), null);
});

test("trailing whitespace and appended text are real differences", () => {
  assert.notEqual(generatedArtifactMismatch("line one \nline two\n", LF), null);
  assert.notEqual(generatedArtifactMismatch(`${LF}line three\n`, LF), null);
  assert.notEqual(generatedArtifactMismatch("line one\nfine two\n", LF), null);
});

test("a leading BOM is reported explicitly, never silently ignored", () => {
  const reason = generatedArtifactMismatch(`\uFEFF${LF}`, LF);
  assert.match(reason, /BOM/);
  assert.match(generatedArtifactMismatch(`\uFEFF${CRLF}`, LF), /BOM/);
});

test("a stray carriage return inside a line is not hidden as a line ending", () => {
  assert.notEqual(generatedArtifactMismatch("line one\rline two\n", LF), null);
});
