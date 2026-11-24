// Where the compact descriptor bytes actually go: prose vs structure.
//
// Every MCP session pays for `tools/list` before it does any work, so this is the one cost that is
// always paid. Measure the split before choosing what to cut. Run from `app/`:
//   DATA_PATH=/tmp/desc-split node scripts/descriptor-byte-split.mjs [compact|full]
import { createHash } from "node:crypto";
import { captureToolsList } from "./mcp-descriptor-cost-report.mjs";

const profile = process.argv[2] === "full" ? "full" : "compact";
const list = await captureToolsList(profile);

const collect = (node, key, sink) => {
  if (typeof node === "string" && key === "description") sink.prose += Buffer.byteLength(node, "utf8");
  else if ((key === "enum" || key === "const") && node !== undefined) sink.enum += Buffer.byteLength(JSON.stringify(node), "utf8");
  if (node && typeof node === "object") {
    for (const [childKey, child] of Object.entries(node)) collect(child, childKey, sink);
  }
};

const payload = Buffer.byteLength(JSON.stringify({ tools: list.tools }), "utf8");
const rows = list.tools.map((descriptor) => {
  const sink = { prose: 0, enum: 0 };
  collect(descriptor, "", sink);
  return { name: descriptor.name, bytes: Buffer.byteLength(JSON.stringify(descriptor), "utf8"), ...sink };
});
const sum = (field) => rows.reduce((total, row) => total + row[field], 0);
const sha = createHash("sha256").update(JSON.stringify({ tools: list.tools })).digest("hex");

console.log(`profile ${profile}: ${rows.length} descriptors, payload ${payload} B, sha ${sha.slice(0, 16)}`);
console.log(`  prose (description strings) ${sum("prose")} B  ${((sum("prose") / payload) * 100).toFixed(1)}%`);
console.log(`  enum/const values           ${sum("enum")} B  ${((sum("enum") / payload) * 100).toFixed(1)}%`);
console.log(`  structure (everything else) ${payload - sum("prose") - sum("enum")} B`);
rows.sort((a, b) => b.prose - a.prose);
for (const row of rows.slice(0, 8)) {
  console.log(`  ${row.name.padEnd(46)} ${String(row.bytes).padStart(6)} B  prose ${String(row.prose).padStart(6)} B`);
}
