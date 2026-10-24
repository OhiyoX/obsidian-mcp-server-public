import fs from "node:fs/promises";
import path from "node:path";

const data = path.resolve(process.env.DATA_PATH || "/data");
const backup = process.argv[2];
if (!backup) throw new Error("Pass the pre-migration Publish state backup path");
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
if (!publicBaseUrl) throw new Error("Set PUBLIC_BASE_URL to the deployment origin to verify");
const before = JSON.parse(await fs.readFile(backup, "utf8"));
const after = JSON.parse(await fs.readFile(path.join(data, "publish", "state.json"), "utf8"));
if (before.records.length !== after.records.length) throw new Error("Publish record count changed");
const current = new Map(after.records.map((record) => [record.id, record]));
const results = [];
for (const record of before.records) {
  const next = current.get(record.id);
  if (!next || next.vaultId !== record.vaultId) throw new Error("Publish ID or Vault changed");
  const response = await fetch(new URL(`/publish/${encodeURIComponent(record.id)}`, publicBaseUrl));
  results.push({ path: next.path, status: response.status });
  if (response.status !== 200) throw new Error(`Publish route returned ${response.status}`);
}
console.log(JSON.stringify({ preservedIds: results.length, results }, null, 2));
