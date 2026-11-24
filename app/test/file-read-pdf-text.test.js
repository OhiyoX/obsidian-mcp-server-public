import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { zlibSync } from "fflate";

// `src/config.js` resolves the Vault at module evaluation, so the environment comes first.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-pdf-read-"));
const vault = path.join(root, "vault");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
process.env.GIT_ENABLED = "false";
await fs.mkdir(vault, { recursive: true });
after(() => fs.rm(root, { recursive: true, force: true }));

const { registerFileTools } = await import("../src/tools/files.js");

// A fake MCP server that keeps the handlers, so the test calls the real registration.
function register() {
  const handlers = new Map();
  registerFileTools({
    registerTool(name, _spec, handler) {
      handlers.set(name, handler);
    },
  });
  return handlers;
}

function onePagePdf(lines) {
  const content = `BT /F1 12 Tf 1 0 0 1 50 700 Tm ${lines.map((line) => `(${line}) Tj 0 -16 Td`).join(" ")} ET`;
  const stream = Buffer.from(zlibSync(Buffer.from(content, "latin1")));
  const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n5 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1");
  const tail = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n0\n%%EOF\n", "latin1");
  return Buffer.concat([head, stream, tail]);
}

function imageOnlyPdf() {
  const stream = Buffer.from(zlibSync(Buffer.from("0 0 100 100 re f\n", "latin1")));
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n", "latin1"),
    Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), stream,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 5 >>\n%%EOF\n", "latin1"),
  ]);
}

await fs.writeFile(path.join(vault, "Doc.pdf"), onePagePdf(["Quarterly numbers", "second line"]));
await fs.writeFile(path.join(vault, "Scan.pdf"), imageOnlyPdf());

test("auto still returns base64 for a PDF, so existing callers do not change", async () => {
  const result = await register().get("get_file")({ path: "Doc.pdf", encoding: "auto", acceptedOnly: true, offset: 0 });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.encoding, "base64");
  assert.equal(result.structuredContent.pages, undefined);
});

test("pdf-text returns the real text with page numbers and the file revision", async () => {
  const result = await register().get("get_file")({ path: "Doc.pdf", pdfText: true, encoding: "auto", acceptedOnly: true, offset: 0, maxChars: 20000 });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  const body = result.structuredContent;
  assert.equal(body.encoding, "pdf-text");
  assert.equal(body.pageCount, 1);
  assert.deepEqual(body.pages.map((page) => page.page), [1]);
  assert.match(body.pages[0].text, /Quarterly numbers/);
  assert.match(body.pages[0].text, /second line/);
  assert.match(body.revision, /^sha256:/);
  assert.equal(body.truncated, false);
});

test("the excerpt budget truncates instead of returning the whole document", async () => {
  const result = await register().get("get_file")({ path: "Doc.pdf", pdfText: true, encoding: "auto", acceptedOnly: true, offset: 0, maxChars: 5 });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.pages[0].text.length, 5);
  assert.equal(result.structuredContent.pages[0].truncated, true);
  assert.equal(result.structuredContent.truncated, true);
});

test("a document without extractable text is refused, never guessed", async () => {
  const result = await register().get("get_file")({ path: "Scan.pdf", pdfText: true, encoding: "auto", acceptedOnly: true, offset: 0, maxChars: 20000 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "no-extractable-text");
});
