// D5 pin: every desktop citation this lane makes must be reproducible by BYTE offset.
//
// The review rejected the first submission because its citations were UTF-16 code-unit indices
// (`readFileSync(..., "utf8").indexOf`) quoted as if they were byte offsets in a 3.9 MB file with
// non-ASCII content: 0/7 of them matched when read with `Buffer`/`grep -ob`. This test reads the
// same archive the citations name, asserts the exact bytes at each offset, and records the needle's
// hit count — so a wrong number fails here instead of in a review.
//
// The archive lives outside the repository (it is a reverse-engineering extract), so the test
// SKIPS when it is not on this machine; a skipped run prints why rather than pretending to pass.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const ARCHIVE = process.env.OBSIDIAN_ASAR_APP ?? "/opt/obsidian-asar-1.14.4/app.js";

// offset → needle, measured on the pinned 1.14.4 extract (3,942,126 bytes).
const CITATIONS = [
  [2352086, "e.deserialize=function(t,n,i)", 1],
  [2352290, "e.prototype.serialize=function(){var e=Object.assign({},this.unrecognizedData)", 1],
  [2352459, "e.prototype.getDisplayName=function(){return this.displayName", 1],
  [2486021, "t.prototype.showEditPage=function", 1],
  [2486079, "this.host.show(new IJ(", 1],
  [
    2490421,
    'g.addEventListener("click",(function(e){e.preventDefault();var t=i.chooser.selectedItem;"property"===i.chooser.values[t].type&&i.showEditPage(l)}))',
    1,
  ],
  [2490811, "DJ.titleEditProperty({name:a})", 1],
  // The bare Escape registration exists twice (two page classes); the byte assert below is what
  // tells them apart, and the count documents that the number is not "the only one".
  [2490843, 'o.scope.register([],"Escape",(function(){o.host.back()}))', 2],
  [2491277, 'this.containerEl=createDiv("bases-toolbar-menu-form")', 1],
  [2491464, "input-row-content", 9],
  [2491417, "labelDisplayName()", 1],
  [2491484, ".setPlaceholder(c).setValue(a.getDisplayName(t)).autoSelect()", 1],
  [2492049, "i.value=c,i.blur()", 1],
  [2492636, "metadataTypeManager.setType(c,e)", 1],
  [2493031, "e.prototype.showActions=function(e,t)", 1],
  [2493381, "DJ.labelHideProperty()", 1],
];

async function archive() {
  try {
    return await fs.readFile(ARCHIVE);
  } catch {
    return null;
  }
}

test("every desktop citation in this lane is a real BYTE offset in the pinned 1.14.4 archive", async (t) => {
  const buf = await archive();
  if (!buf) {
    t.skip(`archive not on this machine (${ARCHIVE}); citations unverified here`);
    return;
  }
  assert.ok(buf.length > 3_900_000, `unexpected archive size ${buf.length}`);
  for (const [offset, needle, expectedHits] of CITATIONS) {
    const target = Buffer.from(needle, "utf8");
    const at = buf.subarray(offset, offset + target.length);
    assert.deepEqual(
      at.toString("utf8"),
      needle,
      `byte ${offset} must hold ${JSON.stringify(needle.slice(0, 40))}…, found ${JSON.stringify(at.toString("utf8").slice(0, 40))}`,
    );
    let hits = 0;
    let cursor = buf.indexOf(target);
    while (cursor !== -1) {
      hits += 1;
      cursor = buf.indexOf(target, cursor + 1);
    }
    assert.equal(hits, expectedHits, `${JSON.stringify(needle.slice(0, 30))}… occurs ${hits}x, the citation documents ${expectedHits}x`);
  }
  // Negative control: an offset shifted by one byte does NOT match, so the assertion above is not
  // passing on a coincidence.
  const [offset, needle] = CITATIONS[0];
  assert.notEqual(buf.subarray(offset + 1, offset + 1 + Buffer.byteLength(needle)).toString("utf8"), needle);
});

test("this lane's documents quote byte offsets, not code-unit indices", async () => {
  // Red on the reviewed defect: the old numbers (2483200 / 2485700 / …) were string indices.
  const stale = ["2483200", "2485700", "2485969", "2486663", "2487693", "2487960", "2347620", "2347770", "2347840"];
  const docs = await Promise.all([
    fs.readFile(new URL("../../HANDOFF-PROPERTY-SUBMENU.md", import.meta.url), "utf8").catch(() => ""),
    fs.readFile(new URL("../../docs/bases/BASES-COMPATIBILITY-MATRIX.md", import.meta.url), "utf8"),
  ]);
  for (const text of docs) {
    for (const number of stale) {
      assert.equal(text.includes(`@${number}`), false, `@${number} is a code-unit index, not a byte offset`);
    }
  }
});
