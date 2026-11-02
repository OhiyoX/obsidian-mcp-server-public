// Real Chromium + real application HTTP routes in an isolated temporary Vault.
// Run after build:web. Set PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE if using an external runtime.
// Issue #380: `web-regression/env.mjs` resolves and pins the full Chrome for Testing binary and
// refuses to run `chrome-headless-shell`; the resolution is printed as one startup line.
//
// This remains the single entry point spawned by scripts/run-browser-ci.mjs. The suite is
// split by domain into ./web-regression/*.mjs: env.mjs prepares the fixture Vault and app
// server, recorder.mjs collects check() results, session.mjs opens the Chromium page and
// login, and every domain module registers its checks in the original execution order.
import fs from 'node:fs/promises';
import path from 'node:path';
import { environment, cleanupEnvironment } from './web-regression/env.mjs';
import { results, check, sleep } from './web-regression/recorder.mjs';
import { openBrowserSession } from './web-regression/session.mjs';
import { registerExplorerChecks } from './web-regression/explorer.mjs';
import { registerSearchChecks } from './web-regression/search.mjs';
import { registerChromeChecks } from './web-regression/chrome.mjs';
// Issue #408 (audit Cut C): the tab-strip check. Its own module for the line budget; it
// must stay registered directly after chrome.mjs to keep the original execution order.
import { registerTabChecks } from './web-regression/tabs.mjs';
// Issue #429: the tab strip's batch-close menu (context menu / keyboard / held touch press). Its
// own module for the line budget; registered directly after the #408 strip check, whose
// inherited-strip contract it re-establishes from a hard load of its own.
import { registerTabsBulkCloseChecks } from './web-regression/tabs-bulk-close.mjs';
import { registerEditorRenderChecks } from './web-regression/editor-render.mjs';
import { registerEditorSelectionChecks } from './web-regression/editor-selection.mjs';
// Issue #484: Live Preview source fidelity — the autolink text must survive idle rendering while
// link-target chrome stays hidden. Registered with the other editor scenes on the shared page.
import { registerLiveSourceFidelityChecks } from './web-regression/live-source-fidelity.mjs';
import { registerThemeInheritanceChecks } from './web-regression/theme-inheritance.mjs';
import { registerRenderThemeParityChecks } from './web-regression/render-theme-parity.mjs';
import { registerRenderGeometryParityChecks } from './web-regression/render-geometry-parity.mjs';
import { registerTablesTokensChecks } from './web-regression/tables-tokens.mjs';
import { registerTablesScrollChecks } from './web-regression/tables-scroll.mjs';
import { registerTablesEstimateChecks } from './web-regression/tables-estimate.mjs';
import { registerTablesLayoutChecks } from './web-regression/tables-layout.mjs';
import { registerTablesInteractionChecks } from './web-regression/tables-interaction.mjs';
import { registerEditorInteractionChecks } from './web-regression/editor-interaction.mjs';
import { registerEditorRaceChecks } from './web-regression/editor-race.mjs';
import { registerBasesChecks } from './web-regression/bases.mjs';
import { registerExplorerPrefetchChecks } from './web-regression/explorer-prefetch.mjs';
import { registerExplorerRevealChecks } from './web-regression/explorer-reveal.mjs';
import { registerExplorerModeSwitchChecks } from './web-regression/explorer-mode-switch.mjs';
// Issue #427: the Explorer 新建笔记 / 新建文件夹 draft lifecycle (no write on the click,
// one POST at most on an explicit commit, cancel on blur/Escape/close). Registered right
// after the browse-mode switch: both drive the desktop Tree on the shared page.
import { registerExplorerDraftChecks } from './web-regression/explorer-draft.mjs';
// Issue #427 (U50 review HOLD): the three draft-commit interleavings (a late answer
// arriving after a repaint or after a newer draft). Its own module for the line
// budget; registered immediately after the base draft scene, which owns the same page.
import { registerExplorerDraftInterleaveChecks } from './web-regression/explorer-draft-interleave.mjs';
import { registerMobileChecks } from './web-regression/mobile.mjs';
import { registerBasesMobileChecks } from './web-regression/bases-mobile.mjs';
import { registerMobileShellChecks } from './web-regression/mobile-shell.mjs';
import { registerAssetDropChecks } from './web-regression/asset-drop.mjs';
// Issues #401-#406: the Admin plane's layout standard (own fixture Vault + server).
import { registerAdminLayoutChecks } from './web-regression/admin-layout.mjs';
// Issue #423: a `vault.resync`-driven Explorer rebuild must not lose the root listing to the anchor
// page of an in-flight document open. It does its own hard load and drives the race through the
// application's own SSE subscription, so it is registered with the other own-page scenes at the end.
import { registerExplorerResyncRaceChecks } from './web-regression/explorer-resync-race.mjs';
// Issue #410 (audit Cut D): the last-tab close is an in-app welcome transition. Registered last
// (the asset-drop scene leaves the shared page's editor dirty, so this scene starts from its own
// hard load) and it leaves the page on the welcome workspace.
import { registerWelcomeTransitionChecks } from './web-regression/welcome-transition.mjs';
// Issue #430: the body-pane word-count badge. Registered after welcome-transition because it
// starts from its own hard load and is the final owner of the shared page.
import { registerWordCountBadgeChecks } from './web-regression/word-count-badge.mjs';
// Issue #430 review follow-up: the throttled-undo race in the real browser. Kept in its own
// module (the line budget) and registered immediately after the badge scene it probes.
import { registerWordCountBadgeUndoChecks } from './web-regression/word-count-badge-undo.mjs';
// Issue #471 (P1): install metadata (manifest, icon set, Apple standalone head, CSP). Kept in
// its own module for the line budget; it opens its own 390x844 mobile context with the
// harness cookies and never touches the shared page.
import { registerPwaInstallChecks } from './web-regression/pwa-install.mjs';
// Issue #471 (I471-NAV): the internal app root is the slash-bearing `/app/` the installed app's
// manifest resolves its `scope` to. Registered last: it takes its own hard load, clears the
// shared session cookie for the login-return scene and re-authenticates through the real login
// form, so it must not run before a scene that needs the shared page state.
import { registerNavRootScopeChecks } from './web-regression/nav-root-scope.mjs';
// Issue #515: the two human-facing deploy-time surfaces (settings footer, Admin badge) must
// render Beijing time while the raw UTC ISO stays on the API face. The scene writes its own
// deploy manifest into the shared server's DATA_PATH, takes its own browser context and never
// touches the shared page, so it runs last — after every shared-page scene has finished.
import { registerDeployTimeChecks } from './web-regression/deploy-time.mjs';
// Issue #418: the mobile drawer over a Bases document (opaque surface + correct paint order).
// Own fixture Vault/server with a community theme and own 390x844 coarse-pointer context, so it
// never shares state with the scenes above. Registered after deploy-time (both own their page).
import { registerDrawerBleedChecks } from './web-regression/drawer-bleed.mjs';

const { appRoot, outputRoot, root, vault, base, child, serverErrors, fixture, expectedHeadings, propertiesFixture, chromium } = environment;
let session;
try {
  for(let n=0;n<150;n++) {try {if((await fetch(`${base}/healthz`)).ok)break;}catch{} if(child.exitCode!==null)throw Error('Test server exited');await sleep(100);}
  session = await openBrowserSession({ chromium, chromiumExecutable: environment.chromiumExecutable, base, password: environment.password, sleep });
  const { browser, page, errors, dialogs, open, mode, value, requestedAsset, assetGlobals } = session;
  const context = { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors, requestedAsset, assetGlobals, password: environment.password };
  await registerExplorerChecks(context);
  await registerSearchChecks(context);
  await registerChromeChecks(context);
  await registerTabChecks(context);
  await registerTabsBulkCloseChecks(context);
  await registerEditorRenderChecks(context);
  await registerEditorSelectionChecks(context);
  // Issue #484: read-only fidelity checks over the same A.md the editor scenes already opened.
  await registerLiveSourceFidelityChecks(context);
  await registerThemeInheritanceChecks(context);
  await registerRenderThemeParityChecks(context);
  await registerRenderGeometryParityChecks(context);
  await registerTablesTokensChecks(context);
  await registerTablesScrollChecks(context);
  await registerTablesEstimateChecks(context);
  await registerTablesLayoutChecks(context);
  await registerTablesInteractionChecks(context);
  await registerEditorInteractionChecks(context);
  await registerEditorRaceChecks(context);
  await registerBasesChecks(context);
  // Issue #284 §13: real-Chromium Explorer hover-prefetch characterisation. Registered last
  // so its fixture folders and pointer probes cannot disturb earlier scenarios.
  await registerExplorerPrefetchChecks(context);
  // Issue #336: deep-link first paint / hard refresh must materialize every ancestor
  // level. Runs after the prefetch probes so its _Workspace fixture and deep-link
  // navigations cannot disturb earlier scenarios; the browse-mode switch closes the run.
  await registerExplorerRevealChecks(context);
  // Issue #335: the browse-mode switch must repaint the files list on the same click.
  // Registered last: it leaves the panel in a query-less Tree.
  await registerExplorerModeSwitchChecks(context);
  await registerExplorerDraftChecks(context);
  await registerExplorerDraftInterleaveChecks(context);
  // Issue #337 Cut 1: the mobile scene (390x844, pointer: coarse / hover: none, touch) of the
  // Explorer touch prefetch + the mobile regression infrastructure. Registered last: it runs
  // in its own context with its own drawer/scroll state and never touches the shared page.
  await registerMobileChecks(context);
  // Issue #337 Cut 2: the Bases half of the mobile scene (360x800, `pointer: coarse`). It
  // brings its own Base fixture Vault/server and its own context, so it neither shares nor
  // disturbs the Explorer mobile scene above.
  await registerBasesMobileChecks(context);
  // Issue #371 (U29): the shell half of the mobile matrix (single topbar, conditional tab row,
  // mutually exclusive drawers on one scrim, symmetric pane headers, one safe-area owner). Kept
  // in its own module for the architecture line budget, like the Cut 3 scene before it; it
  // brings its own 390x844-coarse and 1440x1000 contexts and never touches the shared page.
  await registerMobileShellChecks(context);
  // U30: in-place image drop upload (real DataTransfer on the shared page). Registered last: it
  // overwrites A.md's editor buffer with its own drop-position fixture and never reopens another
  // scenario's note afterwards.
  await registerAssetDropChecks(context);
  // Issues #401-#406: the Admin plane's layout standard. It brings its own fixture Vault,
  // data dir and server (AUTHZ_ENABLED / GIT_ENABLED / a real MCP write), because the shared
  // harness server runs with both features off and therefore has neither Admin tab. It owns
  // its own browser context and never touches the shared page, so it runs here, before the
  // welcome-transition scene which must stay the last scene on the shared page.
  await registerAdminLayoutChecks(context);
  // Issue #423: the resync-rebuild vs anchor-locate race on the real page (own hard load).
  await registerExplorerResyncRaceChecks(context);
  // Issue #410: the in-app welcome transition behind the last-tab close.
  await registerWelcomeTransitionChecks(context);
  // Issue #430: the body-pane word-count badge. Last on the shared page: it starts from its own
  // hard load (so the welcome-transition scene's end state cannot leak in) and owns the page
  // from there; nothing else uses the shared page after it.
  await registerWordCountBadgeChecks(context);
  await registerWordCountBadgeUndoChecks(context);
  // Issue #471 (P1): the install metadata of the app shell (own mobile context, own hard load).
  await registerPwaInstallChecks(context);
  // Issue #471 (I471-NAV): registered last among the shared-page checks — it clears the shared
  // session cookie for the login-return scene and re-authenticates through the real login form.
  await registerNavRootScopeChecks(context);
  // Issue #515: registers the deploy-time browser contract. Own context + own deploy manifest
  // (written into the shared DATA_PATH, removed again by the scene), so it is safe last.
  await registerDeployTimeChecks(context);
  // Issue #418: the reported m-side bleed — the open files drawer must be an opaque, topmost
  // surface over a Base view. Own fixture Vault/server + own phone context (it never touches
  // the shared page), so it runs here after the other own-context scenes.
  await registerDrawerBleedChecks(context);
  await fs.writeFile(path.join(outputRoot,'results.json'),JSON.stringify({results,errors,serverErrors:serverErrors.filter(e=>/error|failed/i.test(e))},null,2));
} finally {
  await session?.browser?.close();
  await cleanupEnvironment();
}
if(results.some(r=>!r.pass))process.exitCode=1;
