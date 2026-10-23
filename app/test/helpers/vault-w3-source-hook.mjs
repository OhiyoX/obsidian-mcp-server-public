// Test-only load-time mutations: no source rewrite or production fault switch.
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const control = process.env.W3_TEST_CONTROL || "clean";
const mutations = {
  "map-write": ["src/vault-runtime/composed-commit.js", "callback.call(thisArg, value, key, view)", "callback.call(thisArg, value, key, copy)"],
  "set-write": ["src/vault-runtime/composed-commit.js", "callback.call(thisArg, value, value, view)", "callback.call(thisArg, value, value, copy)"],
  "old-handle": ["src/vault-runtime/instances.js", "() => leases.isCurrent(lease)", "() => leases.isCurrent(currentInstances().get(vaultId)?.lease)"],
  "generation": ["src/vault-runtime/instance-leases.js", "if (generation !== null && generation !== lease.generation) return false;", "// injected: ignore committed generation"],
  "collision": ["src/vault-runtime/instance-leases.js", "generation === entry.lease.generation && entry.lease.revoked !== true", "generation === entry.lease.generation"],
  "identity": ["src/vault-runtime/instance-leases.js", "if (!identityIsCurrent(lease.id))", "if (false)"],
  "gate": ["src/vault-runtime/instances.js", 'typeof vaultId !== "string" || !servable(vaultId)', 'typeof vaultId !== "string"'],
};
const baselineFiles = new Set(["server.js", "src/admin/vault-git-assembly.js", "src/admin/vault-git-routes.js",
  "src/admin/vault-git-view.js", "src/app/vault-registry.js", "src/vault-runtime/vault-composition-root.js"]);
if (!["baseline", "clean"].includes(control) && !mutations[control]) throw new Error("unknown test mutation");
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!url.startsWith("file:")) return loaded;
  const relative = path.relative(app, fileURLToPath(url)).replaceAll("\\", "/");
  if (control === "baseline" && baselineFiles.has(relative)) {
    const source = execFileSync("git", ["show", `1dc52b3e82660ae5c78b3d4ae69e0cc9fd6edb00:app/${relative}`], { cwd: app, encoding: "utf8" });
    return { ...loaded, source };
  }
  const mutation = mutations[control];
  if (mutation && relative === mutation[0]) {
    const source = String(loaded.source);
    if (source.split(mutation[1]).length !== 2) throw new Error(`mutation requires exactly one anchor: ${control}`);
    console.log(`INJECTED ${control} ${relative} (one anchor)`);
    return { ...loaded, source: source.replaceAll(mutation[1], mutation[2]) };
  }
  return loaded;
} });
