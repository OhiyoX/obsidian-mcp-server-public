# Retrieval provenance and index freshness (issue #666)

An agent that reads a memory needs four facts before it treats the text as current: which note the
text came from, which revision of that note, when that revision was written, and whether the index
still describes the file. This document states what the server reports, and what it refuses to
report.

## How to ask

`search_notes` accepts `includeProvenance: true`. `recall` and `find_related` accept the same flag.
The flag defaults to `false`: provenance is evidence you ask for, not a tax on every search. It adds
about 120 bytes per hit on `search_notes` and about 220 bytes per hit where the hit carries more
evidence.

## What each hit gains

One object per hit, under `provenance`:

| Field | Meaning |
| --- | --- |
| `vaultId` | The Vault the path belongs to. |
| `path` | The Vault-relative path. An absolute path or one that escapes the Vault is refused, never echoed. |
| `revision` | The index side's `sha256:` revision for the text you received. |
| `modifiedAt` | The source file's modification time, as observed. Absent when it was never observed. |
| `indexGeneration` | The index generation that holds this text. Absent when the index cannot name one. |
| `freshness` | `current`, `lagging` or `unknown` (see below). |
| `reason` | A short code explaining a `lagging` or `unknown` verdict. |

The whole response also carries `index` with `files`, `lastRefresh`, `freshness` (`clean` or a
degraded word) and `coverage`, which answers "when did the index last run, and did it see
everything it was allowed to see".

## The three verdicts

- **`current`** needs all of: a source revision equal to the indexed revision, an index generation
  the index itself names as current, and no source mtime that went backwards against the mtime the
  index recorded.
- **`lagging`** means the text is behind the source, or the index cannot name a current generation.
- **`unknown`** means the evidence needed to compare is missing: a deleted or moved file, a
  permission denial, an untrusted clock, or an index that cannot name itself.

## What the server will not do

- It does not emit a date it did not observe. The process clock never stands in for a source
  modification time.
- It has no `ageDays` and no `stale` flag. A date difference is arithmetic the caller can do; calling
  something stale needs an explicit policy, and "old" is not "wrong".
- It does not change ranking. Recency weighting is not applied by this feature, so two identical
  searches return the same order.
- It does not leak across Vaults: only the index side's revision is echoed, and a revision from
  another Vault can therefore never become proof of `current`.

## Where the rules live

`app/src/search/source-provenance.js` owns the verdict and refuses to build a DTO without evidence.
`app/test/search-source-provenance.test.js` (16 tests) pins the field set, the three verdicts and
the refusals, including the negative controls (a fabricated date, a cross-Vault revision, a lagging
generation).
