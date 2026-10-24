# Obsidian Web operations

## Service and protected state

- Compose project: operator-configured project path (protected environment/CLI config; never stored in the repository)
- Vault: configured by `VAULT_PATH`; do not expose it through Nginx static serving.
- OAuth/API-key state: `/data/oauth/state.json` in the container data volume.
- Durable human Web sessions: `/data/web/sessions.json` in the same data volume (schema v1, SHA-256 token-hash keys, mode 0600). It holds only `userId`, `userUpdatedAt`, `csrf`, `vaultId`, `createdAt`, `expiresAt`, `lastSeenAt`; never a raw cookie, bearer token, password, scope or allowedVaults list.
- Secrets: protected project `.env`; never copy values into notes or logs.
- Canonical Web and Admin entry points: `/app` and `/admin/auth`.

## Web catalog directory (issue #428)

The Web Explorer's catalog is a derived SQLite index, one file per vault id. Its location is:

1. `WEB_CATALOG_DIR`, when set (a relative value resolves against the process cwd — unchanged), else
2. `<DATA_PATH>/web-catalog/<vaultId>.sqlite` (`/data/web-catalog/<vaultId>.sqlite` in the Docker topology; `DATA_PATH` keeps its existing `/data` default when unset).

Every store that is actually opened logs one line — `Web Catalog (<vaultId>): store <absolute file>
(source: WEB_CATALOG_DIR|DATA_PATH)`. It is never repeated per request and never returned in an HTTP response.

**Changed by #428.** The retired default was `process.cwd()/data/web-catalog`, so any two servers started
with the same cwd and the same vault id (both `default` unless renamed) opened one file. Only instances
that never set `WEB_CATALOG_DIR` are affected: their catalog location moves under `DATA_PATH` on the first
start after the upgrade, and that first reconcile rebuilds the index from the Vault. The cold/warm,
`stale` and cursor-invalid contracts are unchanged. Production Compose already sets
`WEB_CATALOG_DIR=/data/web-catalog` (`docker-compose.yaml`), so its path is unchanged.

**No automatic migration.** The upgrade never moves, deletes, or falls back to reading a pre-#428
SQLite/WAL/SHM file; an old index may already be polluted, so it is rebuilt from the Vault instead. Delete
the old file manually only after the new index is verified.

**Keep the old location explicitly** (no rebuild, no path change):

```sh
WEB_CATALOG_DIR=<old directory>   # for example the deployment's former cwd/data/web-catalog
```

Pinning a directory only chooses where the derived SQLite lives — it does not validate the index inside
it. Pinning the pre-#428 directory therefore keeps whatever was there, including an index polluted by the
shared-file collision above.

**Rollback — first choice: stay on the directory you already verified.** Point `WEB_CATALOG_DIR` at the
post-#428 directory you verified and restart; leave the retired index untouched. No file is moved, deleted
or re-read:

```sh
WEB_CATALOG_DIR=<verified directory>   # the post-#428 <DATA_PATH>/web-catalog, for example
```

**Returning to the retired location** (only when that is genuinely what you want):

1. back up the retired directory first;
2. point `WEB_CATALOG_DIR` at it and restart, so the first reconcile rebuilds the index from the Vault;
3. verify the Explorer tree, search and note reads before relying on it.

“The files were never modified” is **not** a safety proof. This upgrade did not corrupt them, and the risk
is a *polluted* index, not a damaged file — which is exactly why a pre-#428 index must be rebuilt, not
merely re-opened. Delete a superseded directory only after the directory in use has been verified.
`WEB_CATALOG_ENABLED=false` (v2 returns `503 catalog-unavailable`) is the larger off-switch.

**Shared-directory boundary.** An effective directory plus a vault id identifies exactly one file. This
slice adds no lock, so independent instances must be given different `WEB_CATALOG_DIR` values.

## Backup

Before application changes, copy the affected source, Compose file and protected configuration to a dated directory inside the project. Back up the data volume separately before authorization-state migrations. Vault content uses its existing Git and version-history policy.

## Session revocation and password recovery

- Web sessions are invalidated by account password, scope, enabled-state or deletion changes. A restart no longer revokes them: still-valid, unrevoked sessions resume from `/data/web/sessions.json`. An explicit logout removes the durable record (a failed delete returns an error and leaves a documented crash-resurrection residual until the next successful checkpoint).
- Admin sessions are in memory; restart the container to revoke all of them. Rotate `OAUTH_ADMIN_PASSWORD` in the protected `.env` and recreate the container for administrator-password recovery.
- Reset an OAuth/Web account password from `/admin/auth`; this also revokes that account's OAuth grants and invalidates Web sessions.
- Revoke individual OAuth tokens or the entire client grant from the Admin OAuth tabs. API keys can be deleted independently.

## Theme recovery

Web discovers standard themes from `.obsidian/themes/<Theme>/manifest.json` plus `theme.css`. Standalone `.obsidian/themes/<Theme>.css` files are not loaded. A broken theme can be bypassed by choosing “默认主题” in the Web toolbar or removing its saved `obsidian-web.theme` browser preference. Theme CSS and local theme assets are served only after Web login.

## Vault and Git recovery

- A Web save uses revision checks, atomic replacement and the configured version snapshots.
- On a revision conflict, reload the note and reconcile; do not force overwrite.
- Use the MCP version-history tools for a single-note recovery.
- Use `git_status`, `git_diff` and `git_log` before Git recovery. Prefer restoring a selected path or commit through normal Git history; do not reset the whole Vault.

## Web asset caching and the first-load budget

Web assets live under `/app/assets/` and are referenced by the pages as
`/app/assets/<name>?v=<16-hex content hash>` (`src/app/pages.js`). Because the URL changes whenever
the bytes change, assets are served with `Cache-Control: public, max-age=31536000, immutable` and
gzip-negotiated (`Vary: Accept-Encoding`) by `src/app/asset-encoding.js`; already-compressed
formats (woff/woff2, images) are served uncompressed. Session, HTML, API and publish responses stay
`no-store`. Do not register a cache-setting middleware ahead of the asset branch: Express `send`
only applies the static mount's immutable policy while `Cache-Control` is still unset, which is how
issue #414 silently turned every asset into `no-store`.

- `app/test/web-firstload-budget.test.js` is the blocking gate. It spawns the real server and asserts
  the header policy (assets cacheable >= 1 day, `/app` and `/api/web/v1/*` still `no-store`), gzip
  negotiation (byte-identical after `gunzip`, identity when the client did not ask, raw woff2), the
  versioned `/app/assets/...` URLs in the served shell, the shell's on-demand loader contract, and a
  byte ratchet against `app/scripts/web-firstload-baseline.json`.
- The shell loads only `theme-boot.js` and `app-loader.js`. `app-loader.js` fetches `app.js` first and
  publishes `window.__obsidianWebAssets.ensureEditor/ensureReader`; `editor.js` and `reader.js` are
  fetched on demand — the first reading render and any document open (the reading surface consumes
  the editor's heading model and asset-revision context), plus every Live/RAW surface. Keep
  `core/app.js` free of direct `window.createObsidianEditor` / `window.renderObsidianMarkdown` use:
  the gate asserts that, and it is what keeps the first list from waiting for 1.6 MB.
- Baseline keys: `firstScreenAssets` + `firstScreenAssetsGzipBytes` (what the browser really requests
  before the first list paints), `deferredAssets` + `deferredAssetsGzipBytes` (`editor.js`,
  `reader.js`), `issue414ComparisonSet` + `issue414ComparisonGzipBytes` (the original five-asset total,
  kept so bytes cannot be "moved out" of the budget instead of off the critical path), and
  `shellEagerScripts` + `shellEagerRawBytes`.
- The baseline is `<=` only: lower it in the same commit when a payload shrinks; raising it needs a
  fresh measurement plus a written reason.
- **What counts as first-screen bytes** (so a change can be judged instead of guessed): the measured
set is exactly `app/scripts/web-firstload-baseline.json` → `firstScreenAssets` — `theme-boot.js`,
`reader.css`, `app.css`, `icons.svg`, `app-loader.js` and `app.js` — measured as the gzip the server
returns for those URLs. It **may** move when any of these changes:
  1. **a direct edit to one of those six assets**, including the hand-maintained static ones
     (`theme-boot.js`, the two CSS files, `icons.svg`, `app-loader.js`) — they are not bundled, but they
     are measured;
  2. **the bundle's dependency chain, dependency versions or build configuration** — `app.js` is the only
     member of the measured set that is bundled, and its entry is `frontend/app/core/app.js`; the other
     three esbuild entries (`frontend/app/features/editor/editor.js`,
     `frontend/app/features/reader/reader.js`, `frontend/app/publish.js`) produce separate bundles
     (`editor.js`, `reader.js`, `publish.js`) that are **deferred** assets outside the measured set;
  3. **the measured set or the compression口径 itself** — the baseline file and
     `app/src/app/asset-encoding.js` decide what is measured and how it is encoded.
- Server-rendered modules under `app/src/**` (`pages.js`, `auth-center.js`, …) are rendered into the
  **HTML response** and never enter `app.js`. That only means they add **no bytes to the measured set**;
  it does **not** exempt the static assets or the server-side measurement implementation from the rule
  above.
- “Zero growth” is only ever a statement about **this six-asset gzip metric** — it says nothing about the
  HTML response, the install manifest/icons, or total transfer.
- `app/scripts/web-firstload-metric.mjs` is a **record-only** companion (real Chromium, cold load and
  warm reload: time-to-first-list, DCL, load, encoded transfer bytes) writing JSON to `--out` /
  `$WEB_FIRSTLOAD_OUT`. It intentionally has no wall-clock threshold, for the reason recorded in
  `app/test/bases-perf-baseline.test.js` (§6.6/§14.8).

## Supported browser floor

The floor is a **chosen support policy** (issue #473, route A: publish the minimum instead of adding
per-engine fallbacks). It is set so that the shells we ship — and the relative-colour drawer fix on the
#468 candidate — sit inside it; it is **not** a claim about every engine the code happens to tolerate.

- **Chrome / Edge 119+, Safari 16.4+, Firefox 128+.** Two things set it:
  - `:has()` appears inside a **plain comma-separated selector list** (`app.css`, the completed-task
    strikethrough keyed on the checkbox widget). One unsupported selector invalidates the **whole**
    list, so on older engines the strikethrough silently disappears — a functional difference, not a
    cosmetic one. Firefox only supports `:has()` from **121**.
  - relative colour syntax `rgb(from …)` (Chrome 119 / Safari 16.4 / Firefox 128), which the #418
    drawer fix uses on its branch.
- **Below that floor the app is not supported**: those declarations become invalid, so the affected
  surfaces fall back to inherited/initial values. That is a **policy boundary, not a bug** — do not
  file it as one, and do not add per-engine fallbacks for it without reopening #473.
- **`color-mix(in srgb, var(--x) 100%, transparent)` does not force opacity** — with an input alpha of
  0.8 the result is still 0.8. To make a possibly translucent token opaque, use
  `rgb(from var(--x) r g b / 1)` (that is the form on #468's branch, and it is why the floor above
  covers 119 / 16.4 / 128).
- Features that do **not** raise the floor: `dvh` (Chrome 108 / Safari 15.4 / Firefox 101 — below the
  floor; only `html, body` carries a `vh` fallback, `.shell` and `.settings-dialog` do not),
  `scrollbar-width` / `scrollbar-color` (native scrollbar appearance; the `::-webkit-scrollbar` rules
  cover WebKit) — note `scrollbar-gutter` is **not** purely cosmetic, it reserves layout width, so
  gutter-sensitive geometry must be measured with it in mind — and `:focus-visible` (Chrome 86 /
  Safari 15.4 / Firefox 85). On the JS side `build:web` downlevels **syntax** with
  `esbuild … --target=es2020`, and the **API** surface (`Object.groupBy`, `Promise.withResolvers`,
  `toSorted`, `findLast`, `Array.fromAsync`, `Set.union`, `showPopover`, `URL.parse`, `Promise.try`,
  `Float16Array`, …) has no usage above the floor — the only hit, `structuredClone` (Chrome 98), is
  server-side. `--target` alone is **not** evidence of an API floor.
- **This is a support policy, not a compatibility proof**: no engine at or above the floor has been
  verified on a real device here, and a selector/API name scan is not a substitute for that.
- Real-device expectations per platform live in `docs/manual-mobile-verification.md`; this section
  only fixes **which engines are in scope**.

## Browser regression CI gate

The `browser` job in `.github/workflows/ci.yml` runs the real-Chromium Web regression
(`app/scripts/web-regression.mjs`) on every pull request and on `main`/tag pushes. It is blocking: a
non-zero harness exit, any `FAIL` check, any uncaught page error, a missing/empty `results.json`, or
a missing Playwright runtime fails the run.

- `app/scripts/run-browser-ci.mjs` is the CI adapter. It resolves the Playwright runtime
  (`PLAYWRIGHT_MODULE` or the app-local `playwright` package), runs the harness with
  `WEB_TEST_OUTPUT` pointed at the artifact directory, and always writes `browser-regression.log`
  and `ci-summary.json` — including when the harness crashes before writing `results.json`.
- Playwright is pinned in the workflow (`PLAYWRIGHT_VERSION`, currently `1.63.0` -> Chromium 1243)
  and installed with `npm install --no-save`. It is deliberately not a `package.json` dependency, so
  the lockfile and the production image stay unchanged. `~/.cache/ms-playwright` is cached under
  that version, so the browser revision and its download stay fixed across runs.
- The job uploads the `browser-regression` artifact with `if: always()`: `browser-regression.log`,
  `results.json`, `ci-summary.json`, `performance.json`, and screenshots (`upload-artifact@v4`,
  14 days).
- The fixture `app/test/fixtures/comprehensive-markdown.md` is CRLF in Windows checkouts while the
  editor always returns LF, so the harness normalizes CRLF at runtime. `app/test/browser-ci.test.js`
  guards that normalization (and the adapter's gate decisions); Linux CI checks out LF.
- The job also runs the standalone **Web Publish surface checks**
  (`app/scripts/run-web-publish-checks.mjs`, issues #277/#278): Admin Publish tab lifecycles, the
  Web `published:` filter, the anonymous `/publish/<id>` surface, and — since #447 — a phone-viewport
  reading of the served page proving a long inline `code` token (Vault path, SHA-256, URL) never makes
  the document scroll sideways while block-level `pre` keeps its own horizontal scroll. That last check
  is the behavioural gate for the #447 fix; both sample sets are *named* in
  `app/scripts/web-publish-fixtures.mjs` (`WEB_PUBLISH_INLINE_SAMPLES` / `WEB_PUBLISH_BLOCK_SAMPLES`) and
  the check asserts each one exists on the served page before measuring it, so a vanished sample fails the
  gate instead of leaving an empty measurement loop passing. Since FIX3 it also asserts the two mechanisms
  those samples depend on, at all three viewports and through the same helper:
  `inlineCodeBoxProblems` rejects a named inline sample that is in the DOM but not rendered
  (`display:none` / `visibility:hidden` / zero box / no client rect), and `blockScrollProblems` requires the
  block's computed `overflow-x` to still be a user scroll mechanism (`auto`|`scroll`) with a real
  `scrollWidth > clientWidth` range — an `overflow: hidden` block has the size but lost the way to reach the
  line, so size alone is never accepted. `app/test/publish-inline-code-wrap.test.js`
  is its fast stylesheet-level sibling: it pins the wrapping rule to the Publish surface and asserts the
  fixture body still carries every named sample; `app/test/publish-surfaces-browser-contract.test.js`
  pins the two criteria above so their regression fails without a browser. All checks run against
  a synthetic tmp Vault and a real server, and the runner is a sibling step with its own
  `timeout … 180s` hang detector, so it does not
  consume the `run-browser-ci.mjs` budget above; its `PASS <check>` lines and `summary: n/n passed`
  land in the job log, and `if: always()` uploads the `web-publish-checks` artifact (`results.json`
  plus `run.log`, 14 days).
- The v1 → v2 Publish state migration is verified by an executable fixture —
  `app/scripts/run-publish-migration-checks.mjs` (9 cases over the checked-in samples in
  `app/test/fixtures/publish-state/`), wired into the `app` job through
  `app/test/publish-migration-fixture.test.js`. Its env-gated negative control
  (`P278_D_MIGRATION_NEGATIVE=all`) is red by design and proves each fail-closed guard detects its
  regression.
- The `browser` job requires the custom runner label `browser` on top of `[self-hosted, linux, x64,
  obsidian-ci]`: `nas-obsidian-ci` and `wsl-obsidian-ci` carry it, `tx-obsidian-ci` does not. It is a
  throughput/robustness rule, not a product rule: on `main` `8ab945ee` (run `37914910852`) all six
  harness attempts of the three GitHub attempts landed on tx, every one was killed by the harness
  deadline, and the furthest attempt also read `typing p95 63.3 ms`; the same suite finished green in
  339.6 s (213/213) on wsl in run `37907247393`. Any runner that can hold the gate can join by taking
  the label (`gh api -X POST repos/<owner>/<repo>/actions/runners/<id>/labels -f 'labels[]=browser'`),
  so the gate is not pinned to one host. The `app` and `Dependency audit` jobs stay on the whole pool.
- `WEB_BROWSER_TIMEOUT_MS` overrides that adapter's wall-clock budget for the harness process tree
  (default `600000` ms; anything above the documented `600000` ms maximum is clamped with a warning).
  The budget is a hang detector, not a check: it never relaxes an assertion, and hitting it still fails
  the job as `harness timed out after <budget>ms` with no `results.json`. The default is the maximum on
  purpose — the CI job allows 25 minutes, and two attempts at 600 s plus this job's setup stay inside
  it, so the harness always fails first with its artifacts instead of being killed by `timeout-minutes`
  without them. A suite that cannot finish in 600 s on a `browser` runner must be split.
- LP-12 (`editor-race.mjs`) lost its absolute wall-clock budgets in U54 (`initialLoadMs < 500`,
  `typingP95 < 50`, `selectionP95 < 16`) because they measured the runner: an **equivalent git tree
  at two different SHAs** (`1c7a657e` for the wsl reference run `37907247393`, `8ab945ee` for the tx
  run `37914910852`; `git diff 1c7a657e 8ab945ee --stat` is empty) read `typing p95` 5.5 ms on wsl
  and 48.8 / 63.3 ms on tx. It now measures a 51-line
  control document next to the 10k-line document in the same page and judges, via
  `app/scripts/web-regression/editing-envelope.mjs`: measurement preconditions (both documents are the
  51 / 10011-line fixture with their 4 / 834 table and 8 / 1668 code fences, 30 finite non-negative
  typing **and** selection samples per side, the 30 dispatched insertions really landed, and something
  rendered), count invariants (rendered lines, materialized widgets, per-keystroke DOM mutations) and
  same-run ratios. The same-run control removes the first-order effect of machine speed; it is **not**
  load-free — time-varying load on a shared runner can still move the two halves of a ratio by
  different amounts. Every reading, criterion and negative control lands in `performance.json`
  (uploaded).
- LP-12's negative controls run inside the same check (no new check, the suite count stays 213): the
  harness drives the real browser through four wrong workloads — the 51-line control loaded into the
  "large" slot, a single-sample run, 4x the fixture (40035 lines) in the "large" slot, and a taller
  window that makes CodeMirror really paint a document-sized one — and requires the fixed judgement to
  reject each. Both verdict sets (the frozen pre-fix judgement of
  `app/scripts/web-regression/editing-envelope-prefix.mjs` and the judgement under test) are recorded,
  so the "pre-fix accepted it / the fix rejects it" pair is evidence rather than a claim. The same pair
  for the judged readings is pinned by `app/test/editing-envelope.test.js`.
- LP-12's calibration limits (keep them in mind before trusting a pass): the count caps were set from
  the two branch runs above, so a medium widget amplification (order 100 widgets, not 1000) can still
  pass; `initialLoadMs` has no absolute gate any more (only the 600 s hang detector backs a
  "both machines got slower but the counts are normal" regression); `tx-obsidian-ci` no longer
  participates in the browser gate, so a defect that only reproduces on a 2 vCPU container is rejected
  later or not at all (slow-machine coverage may become a non-blocking diagnostic, and this gate does
  not claim to cover every hardware profile); and an artifact-upload failure can still turn a green
  Chromium run into a red job (`Upload progress stalled.`), so `2x600 s + setup` inside
  `timeout-minutes: 25` does not guarantee that a long run's artifacts are never truncated.

Local reproduction from `app/`:

```sh
npm ci
npm install --no-save playwright@1.63.0
npx playwright install --with-deps chromium
npm run build:web
node scripts/run-browser-ci.mjs
node scripts/run-web-publish-checks.mjs   # standalone: tmp Vault + real server + real Chromium
```

Use `WEB_TEST_ONLY='<regex>'` to run a subset, and `CHROMIUM_EXECUTABLE` / `PLAYWRIGHT_MODULE` to
reuse an existing browser or external Playwright runtime. Artifacts default to `app/.browser-ci/`
(gitignored).

### Pinned Chromium binary (issue #380)

`chromium.launch({ headless: true })` without an `executablePath` resolves to
`chromium_headless_shell-<revision>` on Playwright >= 1.49. That build has a different
gesture/compositor pipeline — after a pan its fling stop can keep swallowing the first synthesized
tap past the 3 s budget the Bases table-touch check allows — so the *same tree* produced
`clicks: []` (deterministic FAIL) or PASS depending on which binary a machine or CI image happened
to pick. Verdicts were therefore machine-dependent.

`app/scripts/web-regression/env.mjs` now resolves the binary once, through
`app/scripts/web-regression/chromium-binary.mjs`, before anything can launch it, and launches that
exact path. The first usable candidate wins:

1. `CHROMIUM_EXECUTABLE` — explicit operator override. A `chrome-headless-shell` path is **rejected**;
   that build is the root cause of #380, not a valid choice.
2. the pinned Playwright runtime's own `chromium.executablePath()` — the full Chrome for Testing
   build at the revision that runtime speaks to (it honors `PLAYWRIGHT_BROWSERS_PATH` itself);
3. a scan of `PLAYWRIGHT_BROWSERS_PATH` for `chromium-<revision>/` full builds, newest revision
   first (the pattern cannot match `chromium_headless_shell-<revision>/`).

When none of the three yields a file the harness exits **fail-closed** with exit code 2, printing the
candidates it tried and the fix (`npx playwright install chromium`, point
`PLAYWRIGHT_BROWSERS_PATH` at a directory holding a `chromium-<revision>/` build, or set
`CHROMIUM_EXECUTABLE` explicitly). It never silently falls back to the headless shell.

The resolution is printed as one `[web-regression] chromium=<path> source=<source>` line, and the
CI `browser` job asserts the *launched* binary independently in the step
`Assert the harness launches the full Chromium build (#380)`
(`app/scripts/verify-chromium-binary.mjs`): it resolves through the same module, launches the
browser, and requires Chromium's `Browser.getVersion` product to be `Chrome/<version>` — the
headless shell reports `HeadlessChrome/<version>`, so a path that merely looks right cannot pass.
That step also writes `chromium-binary.json` into the uploaded regression artifact.

## Deployment verification

Publish lifecycle semantics (record states, error codes, what the Admin tab must show, and the single
source of the `published:` candidate set) are documented in [ADMIN_PUBLISH.md](ADMIN_PUBLISH.md);
verify a release against that page before touching production.

1. Run `npm run build:web`, `npm run check` and `npm test`.
2. Recreate or reload the Compose service and confirm it is healthy with zero unexpected restarts.
3. Verify OAuth discovery advertises `/oauth/*`, removed root OAuth and `/admin` routes return 404, `/app` requires login, and unknown/public health routes remain blocked at the edge.
4. In a real browser, verify Things in light/dark modes, readable left-sidebar chrome in light mode, authenticated local images, reading/editing, independent scroll areas and logout. In Live properties, row-level remove actions should stay hidden until row hover/focus on desktop; at <=600px they must remain directly touchable with a 44px target without taking a separate grid row. Open an anonymous Publish link and verify its theme button switches both directions; light mode offers the moon/“深色模式” action and dark mode offers the sun/“浅色模式” action, with no blank icon frame or icon-slot layout shift during either switch. Click the Explorer `Publishes` shortcut (`#publishes-open` in the Files panel head; one-shot since #421: it always runs `published:true` and opens the Search panel, and it carries no pressed state), open one of the listed notes and confirm the toolbar agrees with the filter: it offers the public link (`复制公开链接`, `取消 Publish`, active Publish icon). A note whose frontmatter only says `published: true`/`published:true` without being published must not appear behind that filter.

## Rollback

Restore the dated application backup, rebuild Web assets when frontend sources changed, and recreate the Compose service. Restoring application code does not require deleting Vault content. Authorization-state files should only be restored from a matching backup when the data format changed.
