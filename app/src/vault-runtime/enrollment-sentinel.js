// W2FIX2 (#437 RETURN item 1) — the MANAGED-MODE ENROLLMENT sentinel file I/O.
//
// Split out of `admission-store.js` (line budget) as one cohesive unit: read/write the sentinel
// atomically. It holds no state and makes no policy decision — the store owns the in-memory
// `enrollment` snapshot and the composition root decides WHEN to enroll.

import path from "node:path";
import { randomUUID } from "node:crypto";
import { ADMISSIONS_CORRUPT, cloneEnrollmentState, validateEnrollmentState } from "./admission-document.js";

export const ADMISSIONS_READ_FAILED = "VAULT_ADMISSIONS_READ_FAILED";
/** The managed-mode sentinel could not be persisted (item 1) — the operation fails closed. */
export const ADMISSIONS_ENROLLMENT_FAILED = "VAULT_ADMISSIONS_ENROLLMENT_FAILED";

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

/** The default sentinel path is a sibling of the record, so a record-only delete cannot remove it. */
export function defaultEnrollmentFile(file) {
  return path.join(path.dirname(file), "vault-admission-enrollment.json");
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return typeof value;
}

/** Read + parse + validate the sentinel. ENOENT (never managed) returns null; corruption throws. */
export async function readEnrollmentFile({ fsApi, enrollmentFile }) {
  let raw;
  try {
    raw = await fsApi.readFile(enrollmentFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail(ADMISSIONS_READ_FAILED, `cannot read the managed-mode sentinel ${describe(enrollmentFile)}: ${error?.code || error?.message || error}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(ADMISSIONS_CORRUPT, `the managed-mode sentinel ${describe(enrollmentFile)} is not valid JSON (${error?.message || error}); refusing to start with unenforceable bindings`);
  }
  return cloneEnrollmentState(validateEnrollmentState(parsed));
}

/** Atomic `temp + rename` write of the sentinel (mode 0600, same discipline as the record). */
export async function writeEnrollmentFile({ fsApi, enrollmentFile, document }) {
  const validated = validateEnrollmentState(document);
  const temporary = path.join(path.dirname(enrollmentFile), `.${path.basename(enrollmentFile)}.${randomUUID()}.tmp`);
  try {
    await fsApi.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsApi.rename(temporary, enrollmentFile);
  } catch (error) {
    if (typeof fsApi.rm === "function") await fsApi.rm(temporary, { force: true }).catch(() => {});
    fail(
      ADMISSIONS_ENROLLMENT_FAILED,
      `cannot atomically write the managed-mode sentinel ${describe(enrollmentFile)}: ${error?.code || error?.message || error}. ` +
        "Refusing the operation rather than running without durable managed-mode evidence (item 1)",
    );
  }
  return cloneEnrollmentState(validated);
}
