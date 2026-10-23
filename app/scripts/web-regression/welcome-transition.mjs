// Issue #410 (audit Cut D): closing the last document tab is an in-app welcome transition.
//
// The pre-#410 strip called `location.replace("/app")` on the last close, so the same "close
// this tab" gesture had two semantics: a tab with a neighbour went through the ordinary in-app
// `openNote()` flow (session guard, in-app render, session-only UI state kept), while the last
// tab reloaded the whole page (fresh bootstrap, every session-only state lost). The checks
// below pin the in-app transition on the real application:
//
//   `welcome-transition.mjs` is registered last, after the asset-drop scene. It owns its own
//   page state (a hard load first) and leaves the shared page on the welcome workspace, so no
//   later check inherits a half-closed document.
//
// Witness choice for "no full page navigation": a document load is the only way to drop a
// `window` marker AND the only thing that issues a `resourceType: "document"` request, so both
// witnesses are taken at the Playwright level (a same-document `history.replaceState` satisfies
// neither) and are asserted together instead of relying on a soft signal.
//
// The Explorer witness is a real DOM read, so it is taken on a settled listing
// (`settledFolderState()`): every `vault.resync` frame retires the tree pages and repaints before
// the root page is re-materialized, and a read taken on a row that only *appeared* can observe the
// cleared listing (`{"folderCount":0,"expanded":null}`, tag CI run 37935136769 attempt 1, job
// 113835185089). The same window is pinned deterministically by re-dispatching one structured
// frame on the page's own `EventSource` (welcome-transition's third check).
import assert from 'node:assert/strict';

const WELCOME_ROUTE='/app/';
const SETTLE_MS=150;
const UNSAVED_PREFIX='当前修改尚未保存，仍要';
// The Explorer's own startup phase: the first SSE subscription makes the server publish
// `vault.resync` frames (coverage-gap -> watcher-ready -> catalog-ready) and every frame makes the
// Explorer rebuild its root page. That rebuild is unrelated background work, so the transition
// measured below must not race it: the scene waits for the listing to stop rebuilding first, and
// re-runs itself if a resync frame still lands inside the measured window.
const EXPLORER_SETTLE_MS=400;
const SCENE_ATTEMPTS=3;

export async function registerWelcomeTransitionChecks({ check, sleep, page, dialogs, base, open, mode }) {
  // Count the app's `vault.resync` frames and keep the live sources. `features/sync/live-events.js`
  // opens the only SSE stream and subscribes by event name, so mirror that subscription without
  // touching the page's own; the source list is only used to re-dispatch one structured frame
  // deterministically (the same injection technique `explorer-resync-race.mjs` documents).
  await page.addInitScript(()=>{
    window.__u45ResyncFrames=0;
    window.__u45Sources=[];
    const Native=window.EventSource;
    window.EventSource=class extends Native {
      constructor(...args){
        super(...args);
        window.__u45Sources.push(this);
        this.addEventListener('vault.resync',()=>{window.__u45ResyncFrames+=1;});
      }
    };
  });
  const resyncFrames=()=>page.evaluate(()=>window.__u45ResyncFrames??0);
  // Wait until the root listing has stopped mutating and the tree is really painted. `explorer.mjs`
  // uses the same observation for the startup full reload; here it also keeps the measured window
  // free of a resync-driven rebuild.
  const settleExplorer=async()=>{
    await page.waitForFunction(()=>document.querySelector('#live-status')?.dataset?.state==='live',null,{timeout:15000});
    await page.evaluate(()=>{
      window.__u45SettleAt=performance.now();
      window.__u45SettleObserver=new MutationObserver(()=>{window.__u45SettleAt=performance.now();});
      window.__u45SettleObserver.observe(document.querySelector('#note-list'),{childList:true,subtree:true});
    });
    try {
      await page.waitForFunction(quiet=>performance.now()-window.__u45SettleAt>quiet,EXPLORER_SETTLE_MS,{timeout:15000});
    } finally {
      await page.evaluate(()=>{window.__u45SettleObserver?.disconnect();window.__u45SettleObserver=null;});
    }
  };
  // The session-only UI state this check witnesses: Explorer folder expansion is page state
  // (`features/explorer` keeps it in the tree model and never persists it), so a document load
  // collapses it and the in-app transition must keep it.
  const folderState=()=>page.evaluate(()=>{
    const row=document.querySelector('.tree-folder-row[data-folder-path="Expand"]');
    return { folderCount:document.querySelectorAll('.tree-folder-row[data-folder-path="Expand"]').length, expanded:row?.querySelector('.tree-folder')?.getAttribute('aria-expanded')??null };
  });
  // The same read, but only on a settled listing, with a bounded timeout. Every `vault.resync` frame
  // runs `features/explorer/lazy-events.js` -> `controller.invalidateEverything()`, which retires every
  // page and repaints (`invalidateAll` + `onChange`) before the root page is re-materialized, so the
  // witness row is *removed* for one round trip after each frame. A read that only waited for the row
  // to be visible therefore observes the cleared listing when a frame lands between the wait and the
  // read -- CI run 37935136769 attempt 1 (job 113835185089) read `{"folderCount":0,"expanded":null}`
  // exactly there. Arming the quiet observer before the row wait and testing it inside the same page
  // function as the read leaves no window in which a rebuild could go unobserved.
  const settledFolderState=async()=>{
    await page.waitForSelector('#note-list');
    await page.evaluate(quiet=>{
      window.__u45ReadQuiet=quiet;
      window.__u45ReadAt=performance.now();
      window.__u45ReadObserver?.disconnect();
      window.__u45ReadObserver=new MutationObserver(()=>{window.__u45ReadAt=performance.now();});
      window.__u45ReadObserver.observe(document.querySelector('#note-list'),{childList:true,subtree:true});
    },EXPLORER_SETTLE_MS);
    let handle=null;
    try {
      handle=await page.waitForFunction(()=>{
        const row=document.querySelector('.tree-folder-row[data-folder-path="Expand"]');
        if(!row||row.getBoundingClientRect().height<=0)return null;
        if(performance.now()-window.__u45ReadAt<window.__u45ReadQuiet)return null;
        return { folderCount:document.querySelectorAll('.tree-folder-row[data-folder-path="Expand"]').length, expanded:row.querySelector('.tree-folder')?.getAttribute('aria-expanded')??null };
      },null,{timeout:15000});
    } catch (error) {
      throw new Error(`the witness folder never settled into the listing (${JSON.stringify(await folderState())}): ${error.message}`);
    } finally {
      await page.evaluate(()=>{window.__u45ReadObserver?.disconnect();window.__u45ReadObserver=null;});
    }
    return handle.jsonValue();
  };
  const welcomeState=()=>page.evaluate(()=>{
    const preview=document.querySelector('#preview');
    const row=document.querySelector('.document-tab-row');
    return {
      marker:window.__u45WelcomeMarker??null,
      pathname:location.pathname,
      hash:location.hash,
      welcomeVisible:Boolean(document.querySelector('.welcome')),
      welcomeVisibleByLayout:(document.querySelector('.welcome')?.getBoundingClientRect().height??0)>0,
      previewHidden:preview.hidden,
      previewDisplay:preview.isConnected?getComputedStyle(preview).display:'none',
      editorHidden:document.querySelector('#editor').hidden,
      documentClasses:[...document.querySelector('.document').classList].filter(name=>name.startsWith('mode-')),
      path:document.querySelector('#current-path').textContent.trim(),
      tabCount:document.querySelectorAll('#document-tabs .document-tab').length,
      hasDocumentTabs:document.querySelector('.workspace').classList.contains('has-document-tabs'),
      rowDisplay:getComputedStyle(row).display,
      rowHeight:row.getBoundingClientRect().height,
    };
  });
  const tabPaths=()=>page.evaluate(()=>[...document.querySelectorAll('#document-tabs .document-tab')].map(row=>row.getAttribute('data-tab-path')));
  const closeTab=(path)=>page.locator(`#document-tabs .document-tab[data-tab-path=${JSON.stringify(path)}] .document-tab-close`).click();

  await check('closing the last document tab builds the welcome workspace in place, without a document load',async()=>{
    // The scene re-runs while a `vault.resync` frame lands inside it: such a frame rebuilds the
    // root page, and a rebuild interleaved with the document's own locate can replace the listing
    // with an anchor slice. Both gates below redo the scene on a settled page instead of reading a
    // list that background work is rewriting; the assertions are evaluated once, on a clean window.
    let measured=false;
    for(let attempt=1;attempt<=SCENE_ATTEMPTS&&!measured;attempt+=1){
      await page.goto(`${base}${WELCOME_ROUTE}`);
      await page.waitForSelector('.welcome',{state:'visible'});
      // Let the page's own startup re-materialisation finish before the scene touches the tree.
      await settleExplorer();

      const documentRequests=[];
      const onRequest=request=>{if(request.resourceType()==='document')documentRequests.push(request.url());};
      page.on('request',onRequest);
      await page.evaluate(()=>{window.__u45WelcomeMarker='same-document';});
      const framesBeforeOpen=await resyncFrames();
      await open('A.md');
      await settleExplorer();
      // Gate 1: a resync that landed while the note opened may already have replaced the root
      // listing, so the witness expansion below could not even be created on a healthy tree.
      if(await resyncFrames()!==framesBeforeOpen&&attempt<SCENE_ATTEMPTS){page.off('request',onRequest);continue;}
      // Expand a folder that no other scene uses, so the witness is this check's own.
      await page.locator('.tree-folder-row[data-folder-path="Expand"] .tree-folder').click();
      await page.waitForSelector('.note[title="Expand/Child.md"]');
      const before=await settledFolderState();
      assert.deepEqual(before,{folderCount:1,expanded:'true'},`the witness folder must be really expanded: ${JSON.stringify(before)}`);
      const framesAtStart=await resyncFrames();

      const openState=await welcomeState();
      assert.equal(openState.tabCount,1,'one note is open before the close');
      await closeTab('A.md');
      await page.waitForSelector('.welcome',{state:'visible'});
      await sleep(SETTLE_MS);
      page.off('request',onRequest);

      // Gate 2: the measured window itself (witness expansion -> in-app transition) must be free
      // of background rebuilds, otherwise the witness read describes the rebuild, not the close.
      if(await resyncFrames()!==framesAtStart&&attempt<SCENE_ATTEMPTS)continue;
      measured=true;

      const state=await welcomeState();
      const folder=await settledFolderState();
      assert.deepEqual(documentRequests,[],`the welcome workspace must be built in place, not loaded: ${JSON.stringify(documentRequests)}`);
      assert.equal(state.marker,'same-document','a document load would have dropped the window marker');
      assert.equal(state.pathname,WELCOME_ROUTE,`the address is the welcome route: ${JSON.stringify(state)}`);
      assert.equal(state.hash,'');
      assert.equal(state.welcomeVisible,true,'the welcome workspace is rendered');
      assert.equal(state.welcomeVisibleByLayout,true,`and it is really on screen, not a hidden node: ${JSON.stringify(state)}`);
      assert.equal(state.previewDisplay,'block',`the reading pane is the visible surface: ${JSON.stringify(state)}`);
      assert.equal(state.previewHidden,false);
      assert.equal(state.editorHidden,true,'no editor surface is left over the welcome workspace');
      assert.equal(state.path,'尚未打开笔记','the header breadcrumb returns to its empty label');
      assert.equal(state.tabCount,0,`the strip is empty after the last close: ${JSON.stringify(state)}`);
      assert.equal(state.hasDocumentTabs,false,'the tab row leaves the layout through the existing mirror');
      assert.equal(state.rowDisplay,'none');
      assert.equal(state.rowHeight,0);
      assert.deepEqual(folder,before,'session-only Explorer expansion survives the in-app transition');
    }

    // Witness control: the same state read after a real document load must differ, otherwise the
    // assertion above would not discriminate an in-app transition from a reload. The read goes
    // through `settledFolderState()`: the root listing is painted after the shell and then rebuilt
    // by the startup `vault.resync` frames, so waiting for the row alone is what CI attempt 1 hit.
    await page.goto(`${base}${WELCOME_ROUTE}`);
    await page.waitForSelector('.welcome',{state:'visible'});
    await page.waitForSelector('.tree-folder-row[data-folder-path="Expand"]');
    const afterReload=await settledFolderState();
    assert.equal(afterReload.expanded,'false',`witness control: a document load collapses the folder (${JSON.stringify(afterReload)})`);
  });

  await check('closing the last document tab: the witness read stays on a settled Explorer when a vault.resync rebuild lands in its window',async()=>{
    // The interleaving CI attempt 1/2 charged to the witness control above: the root listing paints
    // (so `waitForSelector` is satisfied), then a `vault.resync` frame clears it before the root page
    // is re-materialized, and a read taken in that window reports `folderCount: 0`. The frame is
    // re-dispatched on the page's own `EventSource` -- the structurally identical injection
    // `explorer-resync-race.mjs` uses -- so this pins the wait deterministically instead of waiting
    // for a loaded runner to hit the race, and the settled read is what must carry the witness.
    await page.goto(`${base}${WELCOME_ROUTE}`);
    await page.waitForSelector('.welcome',{state:'visible'});
    await page.waitForSelector('.tree-folder-row[data-folder-path="Expand"]');
    const dispatched=await page.evaluate(()=>{
      let count=0;
      for(const source of window.__u45Sources??[]){
        source.dispatchEvent(new MessageEvent('vault.resync',{data:JSON.stringify({type:'vault.resync',origin:'u45-witness-rebuild'})}));
        count+=1;
      }
      return count;
    });
    assert.ok(dispatched>0,'the page owns a live EventSource to re-dispatch the rebuild on');
    const afterRebuild=await settledFolderState();
    assert.deepEqual(afterRebuild,{folderCount:1,expanded:'false'},`a document load collapses the folder (${JSON.stringify(afterRebuild)})`);
  });

  await check('closing the last document tab asks the same unsaved-changes guard as every other tab close',async()=>{
    // The shared page auto-accepts dialogs (session.mjs). This check has to observe a refused
    // dialog, so it takes the handler over after the initial hard load and restores the suite's
    // accept-and-record handler in the finally block. It is the last scene of the run.
    page.removeAllListeners('dialog');
    const observed=[];
    let answer='dismiss';
    page.on('dialog',async dialog=>{observed.push({type:dialog.type(),message:dialog.message(),answer});if(answer==='accept')await dialog.accept();else await dialog.dismiss();});
    try {
      await page.goto(`${base}${WELCOME_ROUTE}`);
      await page.waitForSelector('.welcome',{state:'visible'});
      // Same startup contract as the check above: a `vault.resync` landing here would reload the
      // open note under the dirty document this check is measuring.
      await settleExplorer();
      await open('A.md');
      await open('B.md');
      await page.locator('#document-tabs .document-tab[data-tab-path="A.md"] .document-tab-main').click();
      await page.waitForFunction(()=>document.querySelector('#current-path').textContent==='A.md');
      // A real edit through the captured editor: the same dirty path a user typing in Live mode takes.
      await mode('live');
      const dispatched=await page.evaluate(()=>{
        const view=window.__testEditor?._view;
        if(!view)return false;
        view.dispatch({changes:{from:0,insert:'U45 dirty edit\n'}});
        return true;
      });
      assert.equal(dispatched,true,'the dirty edit was dispatched into the real editor');
      await page.waitForFunction(()=>document.querySelector('#status').textContent.trim()==='尚未保存');

      // (1) a close that still has a neighbour: the ordinary tab-close path.
      await closeTab('A.md');
      await sleep(SETTLE_MS);
      const neighbour=observed.at(-1);
      assert.ok(neighbour,`the neighbour close must ask before giving up the note: ${JSON.stringify(observed)}`);
      assert.equal(neighbour.type,'confirm',`both closes use the native confirm: ${JSON.stringify(neighbour)}`);
      assert.match(neighbour.message,new RegExp(`^${UNSAVED_PREFIX}`),`the shared guard prefix: ${JSON.stringify(neighbour)}`);
      const refusedNeighbour=await page.evaluate(()=>({path:document.querySelector('#current-path').textContent,status:document.querySelector('#status').textContent.trim()}));
      assert.equal(refusedNeighbour.path,'A.md',`a declined dialog aborts the close: ${JSON.stringify(refusedNeighbour)}`);
      assert.deepEqual(await tabPaths(),['A.md','B.md'],'and the strip is untouched');
      assert.equal(refusedNeighbour.status,'尚未保存','the document is still dirty after the refusal');

      // (2) the same guard on the last close: drop the background tab first, then close it again.
      await closeTab('B.md');
      await sleep(SETTLE_MS);
      assert.deepEqual(await tabPaths(),['A.md'],'the background close needs no dialog and no navigation');
      assert.equal(observed.length,1,`a background close must not ask: ${JSON.stringify(observed)}`);
      await closeTab('A.md');
      await sleep(SETTLE_MS);
      const last=observed.at(-1);
      assert.equal(observed.length,2,`the last close asked once: ${JSON.stringify(observed)}`);
      assert.equal(last.type,neighbour.type,'one guard implementation, one dialog shape');
      assert.match(last.message,new RegExp(`^${UNSAVED_PREFIX}`),`the last close reuses the shared guard message: ${JSON.stringify(last)}`);
      const refusedLast=await welcomeState();
      assert.equal(refusedLast.path,'A.md',`the refused last close keeps the document: ${JSON.stringify(refusedLast)}`);
      assert.equal(refusedLast.tabCount,1,'and keeps its tab');
      assert.equal(refusedLast.welcomeVisible,false,'no welcome workspace without the guard accepting');
      assert.ok(refusedLast.pathname.startsWith('/app/note'),`and the address stays on the note: ${JSON.stringify(refusedLast)}`);

      // (3) the accepted close commits the in-app transition, from a Live surface that must not
      //     stay painted over the welcome workspace.
      answer='accept';
      await closeTab('A.md');
      await page.waitForSelector('.welcome',{state:'visible'});
      await sleep(SETTLE_MS);
      const committed=await welcomeState();
      assert.equal(committed.pathname,WELCOME_ROUTE,`the accepted close lands on /app: ${JSON.stringify(committed)}`);
      assert.equal(committed.tabCount,0);
      assert.equal(committed.hasDocumentTabs,false);
      assert.equal(committed.editorHidden,true,'the Live editor is hidden, not left over the welcome pane');
      assert.equal(committed.previewDisplay,'block',`the welcome pane is visible after a Live-mode close: ${JSON.stringify(committed)}`);
      assert.deepEqual(committed.documentClasses,['mode-preview'],`the document returns to the reading surface: ${JSON.stringify(committed.documentClasses)}`);
      assert.equal(committed.path,'尚未打开笔记');
    } finally {
      page.removeAllListeners('dialog');
      page.on('dialog',dialog=>{dialogs.push({type:dialog.type(),message:dialog.message()});void dialog.accept();});
    }
  });
}
