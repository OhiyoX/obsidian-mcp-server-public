// W2 (#437) — filesystem-independent replacement simulation for integration tests.
//
// Real filesystem behavior varies: some (tmpfs, drvfs) return fresh inodes after delete+recreate;
// others (ext4, Linux CI runner) may reuse the same inode. Managed v2 also binds an incarnation proof.
// This helper preserves the controlled different-inode branch by provisioning a new test proof and
// injecting a different fileId when flagged. It cannot prove the real same-tuple replacement boundary;
// scripts/verify-w2-ext4-incarnation.mjs exercises that boundary without identity injection.
//
// Usage in integration tests:
//   const replacement = createControlledReplacement();
//   const world = await makeWorld({ ..., resolveIdentity: replacement.resolve });
//   // Later, after delete+recreate:
//   replacement.markReplaced(path);

import { computeIdentityDigest, resolveVaultIdentity } from "../../src/vault-runtime/identity.js";
import { initializeIncarnation } from "../../src/vault-runtime/incarnation.js";

/**
 * Create a controlled replacement tracker for integration tests.
 *
 * Returns { resolve, markReplaced, reset }:
 * - resolve(options): async function compatible with vault-runtime resolveIdentity parameter
 * - markReplaced(root): mark a directory as replaced; next resolve() returns a different identity
 * - reset(): clear all replacement tracking
 */
export function createControlledReplacement() {
  const originalIdentities = new Map(); // root -> identity
  const replacedPaths = new Set(); // roots marked as replaced
  async function resolve(options) {
    // Test-only setup of a NEW proof after replacement, then inject a different inode.
    // Production scans never create a marker. Real same-tuple evidence has a separate no-injection probe.
    if (replacedPaths.has(options.root)) await initializeIncarnation(options.root);
    const real = await resolveVaultIdentity(options); // preserve real missing/unreadable failures
    if (!originalIdentities.has(options.root)) originalIdentities.set(options.root, real);
    if (!replacedPaths.has(options.root)) return real;
    const original = originalIdentities.get(options.root);
    const parts = { ...original, fileId: (BigInt(original.fileId) + 1n).toString() };
    return Object.freeze({ ...parts, digest: computeIdentityDigest(parts) });
  }

  function markReplaced(root) {
    if (!originalIdentities.has(root)) {
      throw new Error(`Cannot mark ${root} as replaced: it was never resolved. Call resolve() first.`);
    }
    replacedPaths.add(root);
  }

  function reset() {
    originalIdentities.clear();
    replacedPaths.clear();
  }

  return { resolve, markReplaced, reset };
}
