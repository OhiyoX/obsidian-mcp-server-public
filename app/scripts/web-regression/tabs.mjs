// Issue #408 (audit Cut C): the document tab strip as a roving tabindex tablist.
// Extracted verbatim from chrome.mjs for the architecture line budget; registered by
// scripts/web-regression.mjs immediately after registerChromeChecks so the global check
// order is unchanged. Only the module wrapper is new: the check body, its local helpers
// (readState/tabMain/waitSettled/roving) and the settle timeout below are byte-identical.

import assert from 'node:assert/strict';

// The #408 tab-strip check below waits for a settled (document, focus) pair; the bound is explicit
// and mirrors the shared page's Playwright default timeout, not a fresh budget of its own.
const TAB_FOCUS_SETTLE_TIMEOUT_MS=7000;

export async function registerTabChecks({ check, page, open }) {
  // Issue #408 (audit Cut C): the document tab strip is a roving tabindex tablist. Arrow/Home
  // navigation must leave the active document, the single `aria-selected=true` tab and the real DOM
  // focus on one and the same tab, and `Delete` must close the focused tab from inside the tablist.
  // The pre-#408 view restored focus by numeric index, so it is red on every focus assertion here.
  //
  // This is the module's last check and it shares the page with every scenario before it, so the
  // strip it inherits is NOT clean: `open()` only re-activates a tab that already exists, and the
  // earlier checks leave their own notes open. Every element is therefore addressed by tab path
  // and every expectation (neighbour, whole `aria-selected`/`tabindex` arrays, Delete's result) is
  // derived from the strip that really exists, never from an assumed `A-B-Target` layout.
  //
  // Finally, every keyboard step waits through `waitSettled` below for the settled (document, focus)
  // pair instead of asserting the instant `#current-path` flips, so a slow render is waited for.
  await check('the document tab strip keeps focus, aria-selected and the active document on one tab',async()=>{
    const readState=()=>page.evaluate(()=>{
      const mains=[...document.querySelectorAll('#document-tabs .document-tab-main')];
      const focused=document.activeElement;
      return {
        paths:mains.map(main=>main.getAttribute('data-tab-path')),
        selected:mains.map(main=>main.getAttribute('aria-selected')),
        tabindex:mains.map(main=>main.getAttribute('tabindex')),
        current:document.querySelector('#current-path').textContent,
        focusPath:focused?.closest?.('#document-tabs')?focused.getAttribute('data-tab-path'):null,
      };
    });
    const tabMain=path=>page.locator(`#document-tabs .document-tab-main[data-tab-path=${JSON.stringify(path)}]`);
    // Activation commits `#current-path` one render before the strip moves focus to the activated
    // tab, so wait for the settled pair (expected path AND real focus on that tab's
    // `.document-tab-main`, never a `:focus` guess) instead of the instant the path flips. The wait
    // is bounded, and its timeout is swallowed on purpose: the assertions below still read and print
    // the whole strip, so a negative control reports its JSON and not a bare Playwright timeout.
    const waitSettled=async path=>{
      await page.waitForFunction(expected=>{
        if(document.querySelector('#current-path')?.textContent!==expected)return false;
        const main=document.activeElement?.closest?.('.document-tab-main')??null;
        return main?.closest?.('#document-tabs')===document.querySelector('#document-tabs')&&main.getAttribute('data-tab-path')===expected;
      },path,{timeout:TAB_FOCUS_SETTLE_TIMEOUT_MS}).catch(()=>{});
    };
    // The invariant under test, written against the strip instead of one fixed layout: exactly one
    // tab owns `aria-selected` and the roving `tabindex=0`, and it is the tab the document shows.
    const roving=(paths,owner)=>({
      selected:paths.map(path=>String(path===owner)),
      tabindex:paths.map(path=>path===owner?'0':'-1'),
    });
    const pathsBeforeCheck=(await readState()).paths;
    await open('A.md');
    await open('B.md');
    await open('Target.md');
    const paths=(await readState()).paths;
    const scenarioTabs=['A.md','B.md','Target.md'];
    assert.ok(paths.length>=3&&scenarioTabs.every(path=>paths.includes(path)),`the scenario tabs must join the inherited strip: ${JSON.stringify(paths)}`);
    // Enter the strip on A.md's real left neighbour so the ArrowRight below lands on A.md itself: a
    // tab the document is not showing, i.e. the arrow has to re-target the open document instead of
    // being a same-note no-op.
    const aIndex=paths.indexOf('A.md');
    const anchor=paths[(aIndex-1+paths.length)%paths.length];
    await tabMain(anchor).focus();
    let state=await readState();
    assert.equal(state.current,'Target.md',`the scenario leaves Target.md as the active document: ${JSON.stringify(state)}`);
    assert.equal(state.focusPath,anchor,`focus starts on the tab this scenario picked: ${JSON.stringify(state)}`);
    // Focus a background tab and walk right: the activated document must carry focus with it.
    await page.keyboard.press('ArrowRight');
    await waitSettled('A.md');
    state=await readState();
    assert.deepEqual(state.paths,paths,`arrow navigation must not change the strip: ${JSON.stringify(state)}`);
    assert.deepEqual(state.selected,roving(paths,'A.md').selected,`aria-selected must stay unique: ${JSON.stringify(state)}`);
    assert.deepEqual(state.tabindex,roving(paths,'A.md').tabindex,`roving tabindex must not loosen: ${JSON.stringify(state)}`);
    assert.equal(state.focusPath,'A.md',`focus must follow the activated tab: ${JSON.stringify(state)}`);
    // Arrow on the active tab advances to A.md's real right neighbour; Home lands on the first tab
    // of the real strip, focus included.
    const rightOfA=paths[(aIndex+1)%paths.length];
    await page.keyboard.press('ArrowRight');
    await waitSettled(rightOfA);
    state=await readState();
    assert.equal(state.focusPath,rightOfA,`focus follows the advance: ${JSON.stringify(state)}`);
    assert.deepEqual(state.selected,roving(paths,rightOfA).selected,`aria-selected must stay unique after the advance: ${JSON.stringify(state)}`);
    assert.deepEqual(state.tabindex,roving(paths,rightOfA).tabindex,`roving tabindex must not loosen after the advance: ${JSON.stringify(state)}`);
    await page.keyboard.press('Home');
    await waitSettled(paths[0]);
    state=await readState();
    assert.equal(state.focusPath,paths[0],`Home keeps focus and the active document together: ${JSON.stringify(state)}`);
    assert.deepEqual(state.tabindex,roving(paths,paths[0]).tabindex,`Home must leave a single tab stop: ${JSON.stringify(state)}`);
    // Delete from inside the tablist closes the focused background tab and never navigates. The
    // victim is one of this scenario's own tabs, so restoring it below is a plain `open()` and never
    // depends on an unrelated note being reachable in the explorer (the inherited tabs are not).
    const victim=scenarioTabs.find(path=>path!==paths[0]);
    await tabMain(victim).focus();
    await page.keyboard.press('Delete');
    await page.waitForFunction(count=>document.querySelectorAll('#document-tabs .document-tab').length===count,paths.length-1);
    state=await readState();
    assert.deepEqual(state.paths,paths.filter(path=>path!==victim),`Delete closes the focused tab: ${JSON.stringify(state)}`);
    assert.equal(state.current,paths[0],'closing a background tab never navigates');
    assert.ok(state.focusPath!==null,`focus stays inside the tablist: ${JSON.stringify(state)}`);
    // Put the strip back the way this check found it: re-open the scenario tab Delete closed when it
    // already existed, drop the tabs this scenario added (never the last one), then leave A.md
    // showing for the checks that follow.
    const inherited=new Set(pathsBeforeCheck);
    for(const path of scenarioTabs){ if(inherited.has(path)&&!state.paths.includes(path)) await open(path); }
    for(const path of state.paths){
      if(inherited.has(path)||(await readState()).paths.length===1) continue;
      await page.locator(`#document-tabs .document-tab[data-tab-path=${JSON.stringify(path)}] .document-tab-close`).click();
    }
    await open('A.md');
  });
}
