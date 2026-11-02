// Reported from production 2026-10-21: a fresh deployment (no `vault-admissions.json`, discovery off)
// could not be switched to multi-vault at all. The Admin page rendered no admission form, and a
// hand-made POST to `/admission/initialize` answered `vault_git_admission_invalid` — because the route
// required `status().enabled`, while `enabled` only becomes true once an admissions record exists or
// discovery is on. The documented enable path ("initialise from Admin") was therefore unreachable in
// exactly the configuration every new deployment starts in.
//
// This pins both halves of the fix: the form is reachable while the store is un-initialised, and the
// gate applies IMMEDIATELY after initialising (no restart, no window where approvals exist but every
// vault is still ungated).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { managedAdmin, TAB } from "./helpers/vault-w3-admin-harness.js";
import { Cdp, Page, launchBrowser, resolveBrowser, sleep } from "./admin-redo/browser-harness.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAYS_ASSET = path.join(APP_ROOT, "src", "admin", "assets", "admin-feature-overlays.js");
// The browser half is opt-in exactly like the rest of the client evidence (see `client-lists.test.js`);
// with the variable set, a missing Chromium is a hard failure instead of a skip.
const REQUIRE_BROWSER = process.env.ADMIN_CLIENT_BROWSER_EVIDENCE === "1";

test("a fresh deployment can be initialised from the Admin surface, and the gate applies at once", async (t) => {
  // The production shape: no admissions file, discovery OFF ⇒ the controller is not enforced.
  const world = await managedAdmin(t, { initialized: false, automaticDiscovery: false });
  assert.equal(world.controller.status().enabled, false, "precondition: a fresh deployment is not enforced yet");

  // The form must exist, otherwise the only way in is a hand-written POST nobody documents. A fresh
  // deployment offers ONE real entry control on the list page — the prototype has no admission section
  // at all, so that single control is the smallest honest divergence — and the form itself lives in the
  // confirm state, the same `?confirm=` idiom as the Git repair dialog.
  // 2026-10-22: the list section used to be hidden *and* the drawer only said「等待显式初始化」, so a
  // fresh deployment had no way in at all.
  const entry = await world.request();
  assert.match(entry.body, /href="\/admin\/auth\/vault-git\?confirm=admission"/, "a fresh deployment offers the bootstrap entry on the list page");
  const confirm = await world.request(`${TAB}?confirm=admission`);
  assert.match(confirm.body, /action="\/admin\/auth\/vault-git\/admission\/initialize"/, "the initialise form renders in the confirm state");
  // The same `?confirm=` idiom as the Git repair dialog means the same cancel affordance; a reviewer
  // asked for exactly this ("the same interaction must not behave differently in two entries").
  assert.match(confirm.body, /<a class="btn ghost" href="\/admin\/auth\/vault-git">取消<\/a>/, "the confirm state carries the same 取消 link as the repair dialog");

  // Initialising is the documented enable path: the primary is confirmed, `alpha` is not.
  const { response, body } = await world.request(`${TAB}/admission/initialize`, { confirm: ["vault"] });
  assert.equal(response.status, 200, `initialise must succeed from this state, got ${response.status}`);
  assert.match(body, /准入操作已完成|准入决定已保存/, "the operator sees a completion notice");

  // Enforcement must be live right away, not after a restart.
  const status = world.controller.status();
  assert.equal(status.enabled, true, "the gate is enforced immediately after initialising");
  assert.equal(status.initialized, true);
  assert.equal(world.registry.servable("vault"), true, "the confirmed primary stays servable");
  assert.equal(world.registry.servable("alpha"), false, "an unconfirmed vault is not servable the moment the gate arms");

  // Bootstrap is scoped: a second initialise is refused, so this is not a general door-opener.
  const again = await world.request(`${TAB}/admission/initialize`, { confirm: ["vault"] });
  assert.notEqual(again.response.status, 200, "re-running initialise must be refused");
});

test("approve is still gated on an enforced controller (bootstrap does not widen the surface)", async (t) => {
  const world = await managedAdmin(t, { initialized: false, automaticDiscovery: false });
  const { response } = await world.request(`${TAB}/admission/approve`, { vaultId: "alpha" });
  assert.notEqual(response.status, 200, "approve before initialise stays refused");
});

test("with an admissions record present the surface behaves exactly as before (no regression)", async (t) => {
  const world = await managedAdmin(t, { initialized: true });
  assert.equal(world.controller.status().enabled, true, "a managed store is enforced from load()");
  const page = await world.request();
  assert.match(page.body, /admission\/(approve|revoke)/, "the decision forms render as before");
  const entry = world.controller.store.entryFor("alpha");
  assert.ok(entry, "the fixture's vault has an admission record");
  await fs.access(path.join(world.base, "data", "vault-admissions.json"));
});

/* ------------------------------------------------------------------ the browser half (opt-in) */

/**
 * Review v31-r1 found the blocker only a browser can see: with the enhancement script served (the
 * router reads `admin-feature-overlays.js` from disk per request), the dialog's per-Vault `confirm`
 * CHECKBOXES were adopted by the generic typed gate — a checkbox's `value` is the Vault id, the target
 * string is empty — so the primary action was disabled forever and a fresh deployment still could not
 * be switched to multi-vault from the UI. Every HTTP assertion above passes in that state, so this is
 * the half that actually fails without the fix.
 */
const DIALOG_PROBE = `(() => {
  const modal = document.querySelector('.modal.show');
  if (!modal) return { modal: false };
  const submit = modal.querySelector('button[type="submit"]');
  const boxes = [...modal.querySelectorAll('input[type=checkbox][name=confirm]')];
  const form = modal.querySelector('form');
  return {
    modal: true,
    disabled: submit ? submit.disabled : null,
    choices: boxes.length,
    outsideForm: boxes.filter((box) => !form || box.form !== form).length,
    gated: modal.dataset.typedGate === '1',
    degraded: modal.dataset.typedGateDegraded === '1',
  };
})()`;

/** Open `/admin/auth/vault-git` in a real Chromium page with the harness session cookie installed. */
async function openAdmissionDialog(cdp, world) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, targetId, sessionId, world.origin);
  await page.send("Page.enable");
  await page.send("DOM.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  const [name, value] = world.sessionCookie.split(";")[0].split("=");
  await page.send("Network.setCookie", { name, value, url: `${world.origin}/`, path: "/" });
  await page.goto(TAB);
  await sleep(150);
  await page.click('a[href$="?confirm=admission"]');
  await sleep(500); // the client fetches the fragment and mounts the modal in place
  return page;
}

async function withBrowser(t, scenario) {
  if (!REQUIRE_BROWSER) {
    t.skip("browser evidence is opt-in: re-run with ADMIN_CLIENT_BROWSER_EVIDENCE=1 (CHECKPOINT.md §2)");
    return;
  }
  const resolution = resolveBrowser();
  assert.ok(!resolution.error, `ADMIN_CLIENT_BROWSER_EVIDENCE=1 but no full Chromium build: ${resolution.error}`);
  const launched = await launchBrowser(resolution.executablePath);
  const cdp = await Cdp.connect(launched.endpoint);
  t.after(async () => {
    cdp.close();
    launched.child.kill("SIGKILL");
    await fs.rm(launched.profile, { recursive: true, force: true }).catch(() => {});
  });
  return scenario(cdp);
}

test("a fresh deployment can really be initialised in a browser (script on), and the check can go red", async (t) => {
  await withBrowser(t, async (cdp) => {
    // 1. Negative control FIRST (a fresh fixture, mutated asset): undoing ALL THREE hardenings on disk
    //    must reproduce the review's blocker, otherwise the positive half below proves nothing. The
    //    selector alone is not enough — the text-entry guard and the empty-target guard also skip the
    //    checkbox, so the mutation has to remove exactly what the fix added.
    const original = await fs.readFile(OVERLAYS_ASSET, "utf8");
    t.after(() => fs.writeFile(OVERLAYS_ASSET, original).catch(() => {}));
    const PREFIX_MUTATIONS = [
      ['input.inp[name=confirm]");', '[data-typeconf], input[name=confirm]");'],
      ['if (!isTextEntry(typed) || !target || !submit) {', 'if (false) {'],
    ];
    let mutated = original;
    for (const [find, replace] of PREFIX_MUTATIONS) {
      const next = mutated.replace(find, replace);
      assert.notEqual(next, mutated, `negative control: the mutation must actually apply (${find.slice(0, 48)}…)`);
      mutated = next;
    }
    await fs.writeFile(OVERLAYS_ASSET, mutated);
    const controlWorld = await managedAdmin(t, { initialized: false, automaticDiscovery: false });
    const controlPage = await openAdmissionDialog(cdp, controlWorld);
    const control = await controlPage.evaluate(DIALOG_PROBE);
    assert.equal(control.modal, true, "negative control: the dialog must mount");
    assert.equal(control.disabled, true, "negative control: the pre-fix gate must disable the primary action (else this observation cannot fail)");
    await fs.writeFile(OVERLAYS_ASSET, original);

    // 2. The real thing: fresh deployment, real click, real submit, then the gate must be armed and the
    //    admission record written.
    const world = await managedAdmin(t, { initialized: false, automaticDiscovery: false });
    const page = await openAdmissionDialog(cdp, world);
    const dialog = await page.evaluate(DIALOG_PROBE);
    assert.equal(dialog.modal, true, "clicking the entry must mount the confirm dialog");
    assert.equal(dialog.disabled, false, `the primary action must stay clickable with the script loaded (gated=${dialog.gated})`);
    assert.equal(dialog.choices > 0, true, "the dialog carries the per-Vault confirm choices");
    assert.equal(dialog.outsideForm, 0, "every confirm checkbox must belong to the POST form");
    assert.equal(dialog.gated, false, "the dialog is not a type-to-confirm gate; the server stays the authority");
    assert.equal(dialog.degraded, false, "the dialog must not be marked as a degraded typed gate");
    await page.click('.modal.show button[type="submit"]');
    await sleep(600);
    assert.equal(world.controller.status().enabled, true, "the browser submission must arm the gate immediately");
    await fs.access(path.join(world.base, "data", "vault-admissions.json"));
  });
});
