# Identity filesystem boundary (R-B candidate)

Directory deletion/recreation can reuse realpath, dev and ino on real ext4. A persisted copy of
that tuple cannot distinguish lifecycle. Managed identity v2 hashes the JSON array
`[2, canonicalRoot, volumeId, fileId, incarnation]`, with persistent per-directory proof created
only by explicit administrator enrollment. See [the plan locked before code](W2-incarnation-repair.md).
The new revision awaits independent approval; W1 refusal invariants remain binding.

`incarnation.js` reads `.obsidian-mcp-incarnation.json` with a byte cap, regular-file/symlink checks
and a file handle; explicit creation is exclusive and never repairs corrupt proof. Missing/changed
proof under an existing binding refuses the old ID. Startup/scanning never creates a proof or
transfers approval to a replacement. Lease currency checks tuple/proof before each new consumer/background
operation and latches failure. This is bounded local I/O, not scanning; validity is not cached.

Record/sentinel outer schemas remain v1, while identities have their own version. Old v1 parsing
preserves history but the production managed gate refuses it. Explicit v1 migration uses a NEW
configured ID and approval, preserving old bindings/data; no automatic upgrade, allowlist transfer
or data-key reuse. Old binaries reject v2 identities and must not run against unisolated
pending/revoked/old IDs. Record loss requires surviving v2 proof and revision floor recovery;
proof/sentinel alone never grant permission.

Evidence is split by what it proves:

- The controlled replacement helper retains the different-inode fault matrix. Its marked branch
  explicitly provisions NEW proof as test setup, then returns original fileId+1 with recomputed
  digest. This proves rejection/failure handling given distinct identity, not real same-tuple safety.
- `scripts/verify-w2-ext4-incarnation.mjs` requires Linux and statfs 0xef53 at `/var/tmp`, DEFAULT
  resolver and actual record/sentinel/registry/map/service. It physically deletes/recreates until
  actual dev/ino reuse; nonmatching empty allocations stay alive in its temp root so the allocator
  can reach the original inode. No stat/fs/helper injection. No reuse is a failed probe, never skip.
- The probe checks healthy independent-process restart, replacement restart and old-ID refusal,
  zero old-handle replacement reads, and real GitRuntime timer/direct sweep against a valid
  replacement Git repo whose HEAD must stay unchanged. Baseline 6e8eb21c fails the same probe;
  the repair passes. Raw local logs are linked from HANDOFF.
- `vault-w2-primary-bootstrap.test.js` checks actual process-shared Git/retrieval wiring on physical
  replacement, before scanning, with a real startup-probe barrier.
- `vault-incarnation-lifecycle.test.js` checks explicit enrollment/migration, record loss, malformed
  proof, sentinel floor and partial-write recovery. Identity tests retain Windows/Linux cross-process
  stability and controlled changed-inode coverage.

Proof belongs to the trusted backup/operator boundary. Restoring the complete original directory
with proof restores that identity. Arbitrary filesystem writers able to copy/forge original proof
are outside this claim. Checks are not an atomic cross-process filesystem transaction and do not
remove all adversarial TOCTOU. Entered operations follow existing in-flight rules. No production,
NAS/container or W3 transport acceptance is implied.

Authority: Vault contract §2.3/§3.1/§3.2/§4/§5/§10 and RULING-437-W2-REPAIR.md.
