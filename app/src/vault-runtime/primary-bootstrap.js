// Root-free read-only bootstrap. Composition facades inject protected paths and the switch.
// Any I/O error other than ENOENT refuses initialization; no record is created or migrated here.
import fs from "node:fs/promises";
import { initializePrimaryAuthorization } from "./primary-authorization.js";
let bootstrap = null;
export function bootstrapPrimaryAuthorization({ automaticDiscovery, file, enrollmentFile }) {
  return bootstrap ??= (async () => {
    const exists = async target => {
      try { await fs.stat(target); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    };
    const [record, enrollment] = await Promise.all([exists(file), exists(enrollmentFile)]);
    const managed = automaticDiscovery === true || record || enrollment;
    initializePrimaryAuthorization({ managed });
    return Object.freeze({ managed });
  })();
}
