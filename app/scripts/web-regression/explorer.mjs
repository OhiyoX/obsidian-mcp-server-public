// Explorer (tree, navigation, lazy loading).
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
// Issue #411: the collision below is a *failure*, and a failure toast is now the alert
// channel with its own lifetime. The wait is derived from that constant so the gate cannot
// silently pin the old 2.6 s success window again.
import { TOAST_ERROR_MS } from '../../frontend/app/ui/feedback.js';

export async function registerExplorerChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors, requestedAsset, assetGlobals } = ctx;
  await check('sidebar and Ribbon keep desktop-like hierarchy and shared chrome',async()=>{
    const layout=await page.evaluate(()=>{
      const ribbon=document.querySelector('.ribbon');
      const sidebar=document.querySelector('.sidebar');
      const fileActions=document.querySelector('.sidebar-actions');
      const footer=document.querySelector('.sidebar-footer');
      const settings=document.querySelector('#settings-open');
      const help=document.querySelector('.search-row .search-help');
      const active=document.querySelector('#files-toggle');
      return {
        ribbonBg:getComputedStyle(ribbon).backgroundColor,
        sidebarBg:getComputedStyle(sidebar).backgroundColor,
        activeBg:getComputedStyle(active).backgroundColor,
        accent:getComputedStyle(document.documentElement).getPropertyValue('--interactive-accent').trim(),
        hasMark:Boolean(ribbon.querySelector('.mark')),
        settingsInFooter:footer.contains(settings),
        helpInSearch:document.querySelector('.search-row').contains(help),
        helpInFooter:footer.contains(help),
        settingsInToolbar:fileActions.contains(settings),
        toolbarIds:[...fileActions.querySelectorAll('button')].map(el=>el.id),
      };
    });
    assert.equal(layout.ribbonBg,layout.sidebarBg,JSON.stringify(layout));
    assert.equal(layout.hasMark,false,JSON.stringify(layout));
    assert.equal(layout.settingsInFooter,true,JSON.stringify(layout));
    assert.equal(layout.helpInSearch,true,JSON.stringify(layout));
    assert.equal(layout.helpInFooter,false,JSON.stringify(layout));
    assert.equal(layout.settingsInToolbar,false,JSON.stringify(layout));
    assert.deepEqual(layout.toolbarIds,['explorer-sort-toggle','reveal-active','publishes-open'],JSON.stringify(layout));
    assert.notEqual(layout.activeBg,layout.accent,JSON.stringify(layout));
    // Issue #414 (C): the shell must paint before the two bundles exist. `session.mjs` starts
    // the asset request log before the first navigation, so "a note row is on screen" plus
    // "neither bundle was requested" plus "neither global exists" is the proof that `app.js`
    // boots without `createObsidianEditor` / `renderObsidianMarkdown`.
    const globals=await assetGlobals();
    assert.equal(globals.loader,true,'app-loader.js must publish window.__obsidianWebAssets');
    assert.equal(globals.editor,false,'window.createObsidianEditor must not exist when the shell lists notes');
    assert.equal(globals.reader,false,'window.renderObsidianMarkdown must not exist when the shell lists notes');
    assert.equal(requestedAsset('editor.js'),false,'editor.js must not be requested before a note/editable surface exists');
    assert.equal(requestedAsset('reader.js'),false,'reader.js must not be requested before a note is rendered');
  });
  await check('opening another note keeps explorer DOM nodes stable across background refresh',async()=>{
    await page.waitForFunction(()=>document.querySelector('#live-status')?.dataset.state==='live');
    // Let the startup settle before marking nodes, so this check measures the note-event
    // refresh and not a one-off startup resync. The resync is a server event that can land
    // after the SSE connection flips `live-status` to live; the shell now paints before it
    // (issue #414 C), so the fixed delay that used to cover it started racing. Observe the
    // list instead and wait until it stops mutating: that startup full reload legitimately
    // rebuilds rows, the note-event refresh below must not.
    await page.evaluate(()=>{
      window.__listMutationAt=performance.now();
      window.__listObserver=new MutationObserver(()=>{window.__listMutationAt=performance.now();});
      window.__listObserver.observe(document.querySelector('#note-list'),{childList:true,subtree:true});
    });
    await page.waitForFunction(()=>performance.now()-window.__listMutationAt>400,null,{timeout:7000});
    await page.evaluate(()=>window.__listObserver.disconnect());
    const marker='keep-'+Date.now();
    await page.locator('.note[title="A.md"]').evaluate((el,value)=>{el.dataset.performanceMarker=value;},marker);

    const refreshPath=path.join(vault,'Refresh.md');
    const refreshText=await fs.readFile(refreshPath,'utf8');
    const treeRefresh=page.waitForResponse(response=>{
      if(!response.url().includes('/api/web/v2/tree'))return false;
      return new URL(response.url()).searchParams.get('parent')==='';
    });
    // A same-path-set filesystem event exercises the SSE -> loadNotes() path that
    // raced the original DOM-stability check in the v2026.09.25.16 tag run.
    await fs.writeFile(refreshPath,refreshText);
    await open('B.md');
    assert.equal((await treeRefresh).status(),200);
    await sleep(80);
    assert.equal(await page.locator('.note[title="A.md"]').getAttribute('data-performance-marker'),marker);
    assert.equal(await page.locator('.note[title="B.md"]').getAttribute('aria-current'),'page');
    // Issue #414 (C): the first reading render is what fetches reader.js. Opening a document
    // also carries the pending document into the editor bundle (the outline's heading model
    // lives there), so this asserts the reader contract the brief requires without claiming
    // the editor bundle is absent.
    await page.waitForFunction(()=>typeof window.renderObsidianMarkdown==='function',null,{timeout:10000});
    assert.equal(requestedAsset('reader.js'),true,'opening a note must request reader.js for the reading surface');
    assert.equal((await assetGlobals()).reader,true,'window.renderObsidianMarkdown must be available after opening a note');
  });
  await check('internal note links update canonical URL and browser back/forward restores notes',async()=>{
    await open('A.md');
    await mode('raw');
    // Issue #414 (C): entering an editable surface is what fetches and defines the editor
    // bundle (`mode()` already waited for the captured instance).
    assert.equal(requestedAsset('editor.js'),true,'switching to an editable surface must request editor.js');
    assert.equal((await assetGlobals()).editor,true,'window.createObsidianEditor must be available on the editable surface');
    await page.evaluate(()=>window.__testEditor.setValue('[[B]]',{resetHistory:true,silent:true}));
    await mode('preview');
    const aUrl=page.url();
    assert.match(new URL(aUrl).pathname,/^\/app\/note\//);
    const link=page.locator('#preview [data-note]').filter({hasText:'B'}).first();
    await link.waitFor();
    await link.click();
    await page.waitForFunction(()=>document.querySelector('#current-path')?.textContent==='B.md');
    const bUrl=page.url();
    assert.match(new URL(bUrl).pathname,/^\/app\/note\//);
    assert.notEqual(bUrl,aUrl);

    await page.evaluate(()=>history.back());
    await page.waitForFunction(()=>document.querySelector('#current-path')?.textContent==='A.md');
    assert.equal(page.url(),aUrl);
    assert.match(await value(),/Actual heading/);

    await page.evaluate(()=>history.forward());
    await page.waitForFunction(()=>document.querySelector('#current-path')?.textContent==='B.md');
    assert.equal(page.url(),bUrl);
    assert.match(await value(),/B unique content/);
  });
  await check('canonical resolver opens aliases and preserves heading fragments in URL/history',async()=>{
    await open('A.md');await mode('raw');
    await page.evaluate(()=>window.__testEditor.setValue('[[Shortcut#Deep Heading]]',{resetHistory:true,silent:true}));
    await mode('preview');
    const aUrl=page.url();
    await page.locator('#preview [data-note]').click();
    await page.waitForFunction(()=>document.querySelector('#current-path')?.textContent==='Alias Target.md');
    assert.equal(decodeURIComponent(new URL(page.url()).hash),'#Deep Heading');
    assert.match(await value(),/Alias target content/);
    await page.waitForFunction(()=>document.querySelector('#outline-list .outline-item.is-active')?.textContent==='Deep Heading');
    await page.evaluate(()=>history.back());
    await page.waitForFunction(()=>document.querySelector('#current-path')?.textContent==='A.md');
    assert.equal(page.url(),aUrl);
  });
  await check('same-note heading links push a fragment without reopening or losing the document',async()=>{
    await open('A.md');await mode('raw');
    await page.evaluate(source=>window.__testEditor.setValue('[[#Actual heading]]\\n\\n'+source,{resetHistory:true,silent:true}),fixture);
    await mode('preview');
    const before=page.url();
    await page.locator('#preview [data-note]').first().click();
    await page.waitForFunction(()=>decodeURIComponent(location.hash)==='#Actual heading');
    assert.equal(await page.locator('#current-path').textContent(),'A.md');
    assert.notEqual(page.url(),before);
    assert.match(await value(),/Actual heading/);
  });
  await check('ordinary note navigation preserves Live and RAW editing surfaces',async()=>{
    await open('A.md');await mode('live');
    await open('B.md');
    assert.equal(await page.locator('.document').evaluate(el=>el.classList.contains('mode-live')),true);
    assert.equal(await page.locator('#editor').isVisible(),true);
    await mode('raw');
    await open('A.md');
    assert.equal(await page.locator('.document').evaluate(el=>el.classList.contains('mode-raw')),true);
    assert.equal(await page.locator('#editor').isVisible(),true);
  });
  await check('unresolved internal navigation keeps search clear control synchronized',async()=>{
    await open('A.md');
    await mode('raw');
    await page.evaluate(()=>window.__testEditor.setValue('[[Definitely Missing Note]]',{resetHistory:true,silent:true}));
    await mode('preview');
    await page.locator('#preview [data-note]').click();
    await page.waitForFunction(()=>document.querySelector('#search')?.value==='Definitely Missing Note');
    assert.equal(await page.locator('#search-clear').isVisible(),true);
    await page.locator('#search-clear').click();
    assert.equal(await page.locator('#search').inputValue(),'');
    assert.equal(await page.locator('#search-clear').isVisible(),false);
  });
  await check('folder plus creates a note inline without a browser prompt',async()=>{
    // Navigation only (U4/C3): the previous check cleared the query via #search-clear, which
    // since C3 leaves the search panel in front, so the file tab is selected before driving
    // the tree (the switch alone keeps the empty query).
    if(await page.locator('[data-sidebar-tab="files"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="files"]').click();
    const folder=page.locator('.tree-folder-row[data-folder-path="Folder"]');
    await folder.hover();
    const add=folder.locator('.tree-folder-add');
    await add.waitFor();
    const beforeDialogs=dialogs.length;
    await add.click();
    const input=page.locator('.tree-folder-row[data-folder-path="Folder"] + .tree-children > .note-create-row .note-create-input');
    await input.waitFor();
    assert.equal(await input.inputValue(),'未命名笔记');
    await input.fill('Inline created');
    const created=page.waitForResponse(async response=>{
      if(!response.url().endsWith('/api/web/v1/note')||response.request().method()!=='POST')return false;
      try{return (await response.request().postDataJSON()).path==='Folder/Inline created.md';}catch{return false;}
    });
    await input.press('Enter');
    assert.equal((await created).status(),200);
    await page.waitForFunction(()=>document.querySelector('#current-path')?.textContent==='Folder/Inline created.md');
    assert.equal(dialogs.length,beforeDialogs,JSON.stringify(dialogs.slice(beforeDialogs)));
    assert.equal(await page.locator('.sidebar-actions #new-note').count(),0);
    // U38 (#571): every sprite reference carries the published content hash, so the expected
    // href is whatever the shell published on <html> — not a hand-written URL.
    const spriteUrl=await page.evaluate(()=>document.documentElement.getAttribute('data-icon-sprite'));
    assert.match(String(spriteUrl),/^\/app\/assets\/icons\.svg\?v=[0-9a-f]{16}$/,'the shell publishes the versioned sprite URL');
    assert.equal(await page.locator('#vault-create use').getAttribute('href'),`${spriteUrl}#database`);
    await fs.rm(path.join(vault,'Folder','Inline created.md'),{force:true});
    // Leave a different current note so the next check's open('A.md') cannot
    // satisfy its path wait before the async open request has committed.
    await open('B.md');
  });
  await check('folder plus rejects a name collision and lets the user rename inline',async()=>{
    const folder=page.locator('.tree-folder-row[data-folder-path="Folder"]');
    await folder.hover();
    const add=folder.locator('.tree-folder-add');
    await add.waitFor();
    await add.click();
    const input=page.locator('.tree-folder-row[data-folder-path="Folder"] + .tree-children > .note-create-row .note-create-input');
    await input.waitFor();
    const existing=await fs.readFile(path.join(vault,'Folder','Nested.md'),'utf8');
    await input.fill('Nested');
    await input.press('Enter');
    // A collision must surface a rename hint and keep the row editable instead of
    // silently overwriting the existing note or closing the inline editor.
    await page.waitForFunction(()=>[...document.querySelectorAll('.toast')].some(t=>/同名/.test(t.textContent||'')));
    assert.equal(await page.locator('.note-create-row').count(),1);
    assert.equal(await input.inputValue(),'Nested');
    assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('note-create-input')),true);
    assert.equal(await fs.readFile(path.join(vault,'Folder','Nested.md'),'utf8'),existing);
    // Let the collision toast auto-dismiss so it cannot leak into later checks. An error
    // toast lives for TOAST_ERROR_MS (#411), which is longer than the old success-only
    // 2600 ms, so the bound is the error window plus a margin instead of a fixed 5 s.
    await page.waitForFunction(()=>document.querySelectorAll('.toast').length===0,undefined,{timeout:TOAST_ERROR_MS+4000});
    // Renaming in place must create the note and open it.
    await input.fill('Nested renamed');
    const created=page.waitForResponse(async response=>{
      if(!response.url().endsWith('/api/web/v1/note')||response.request().method()!=='POST')return false;
      try{return (await response.request().postDataJSON()).path==='Folder/Nested renamed.md';}catch{return false;}
    });
    await input.press('Enter');
    assert.equal((await created).status(),200);
    await page.waitForFunction(()=>document.querySelector('#current-path')?.textContent==='Folder/Nested renamed.md');
    assert.equal(await page.locator('.note-create-row').count(),0);
    await fs.rm(path.join(vault,'Folder','Nested renamed.md'),{force:true});
    await open('B.md');
  });
  await check('explorer folder expansion stays in place and reveal-current is cached + smooth',async()=>{
    await open('B.md');
    const list=page.locator('#note-list');
    const folder=page.locator('.tree-folder-row[data-folder-path="Folder"] .tree-folder');
    if(await folder.getAttribute('aria-expanded')==='true')await folder.click();
    await page.evaluate(()=>{
      const list=document.querySelector('#note-list');
      list.style.setProperty('height','52px','important');
      list.style.setProperty('max-height','52px','important');
      list.style.setProperty('overflow-y','auto','important');
      list.scrollTop=0;
    });
    // A Playwright click auto-scrolls the target into view; do that BEFORE recording
    // the baseline so it is not counted as "expansion changed the scroll".
    await folder.scrollIntoViewIfNeeded();
    await sleep(50);
    const beforeExpand=await list.evaluate(el=>el.scrollTop);
    await folder.click();
    await sleep(80);
    assert.equal(await folder.getAttribute('aria-expanded'),'true');
    assert.equal(await list.evaluate(el=>el.scrollTop),beforeExpand);

    const search=page.locator('#search');
    // Navigation only (U4): the search input lives in the search tab panel, so the query
    // flow selects that tab first (the file panel is in front while using the tree). A
    // click on the already-active tab collapses the sidebar, so it is only clicked when
    // another panel is in front.
    if(await page.locator('[data-sidebar-tab="search"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="search"]').click();
    const searchResponse=page.waitForResponse(r=>r.url().includes('/api/web/v2/search?')&&new URL(r.url()).searchParams.get('q')==='file:A.md');
    await search.fill('file:A.md');
    assert.equal((await searchResponse).status(),200);
    // Scope (U4-EXT2): the wait asserts the *search result* rendered (its pre-U4 position and
    // semantics), so it is scoped to the search panel and stays before the file-tab switch;
    // an unscoped selector now matches the file tree's hidden node first.
    await page.waitForSelector('#search-list .note[title="A.md"]');
    // Navigation only (U4): #reveal-active belongs to the file panel head, so a real user
    // path returns to the file tab before locating (the switch alone keeps the query).
    if(await page.locator('[data-sidebar-tab="files"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="files"]').click();

    const noteRequests=[];
    const onRequest=request=>{if(request.url().includes('/api/web/v1/notes?'))noteRequests.push(request.url());};
    page.on('request',onRequest);
    await page.evaluate(()=>{
      window.__explorerRevealScrollCalls=[];
      window.__explorerOriginalScrollIntoView=Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView=function(options){
        window.__explorerRevealScrollCalls.push(options||null);
        return window.__explorerOriginalScrollIntoView.call(this,options);
      };
    });
    try{
      await page.locator('#reveal-active').click();
      await page.waitForSelector('.note[title="B.md"][aria-current="page"]');
      await sleep(120);
      const calls=await page.evaluate(()=>window.__explorerRevealScrollCalls);
      assert.equal(noteRequests.length,0,JSON.stringify(noteRequests));
      assert.ok(calls.length>=1,JSON.stringify(calls));
      assert.equal(calls.at(-1)?.behavior,'smooth',JSON.stringify(calls));
      assert.equal(calls.at(-1)?.block,'center',JSON.stringify(calls));
      assert.equal(await search.inputValue(),'');
    }finally{
      page.off('request',onRequest);
      await page.evaluate(()=>{
        if(window.__explorerOriginalScrollIntoView)Element.prototype.scrollIntoView=window.__explorerOriginalScrollIntoView;
        delete window.__explorerOriginalScrollIntoView;
        delete window.__explorerRevealScrollCalls;
        const list=document.querySelector('#note-list');
        list.style.removeProperty('height');
        list.style.removeProperty('max-height');
        list.style.removeProperty('overflow-y');
      });
    }
  });
  await check('lazy explorer network contract: one root page, per-parent expand, cursor load-more, anchor open, SSE invalidation',async()=>{
    const tree=[];const v1=[];
    const onRequest=request=>{const url=request.url();if(url.includes('/api/web/v2/tree'))tree.push(new URL(url));else if(url.includes('/api/web/v1/notes'))v1.push(url);};
    const params=()=>tree.map(u=>u.search);
    const treeResponses=(parent)=>page.waitForResponse(r=>{const u=r.url();return u.includes('/api/web/v2/tree')&&new URL(u).searchParams.get('parent')===parent;});
    // Wait for the first reconcile to publish before measuring the first paint.
    const warm=await page.request.get(`${base}/api/web/v2/tree?parent=`);
    assert.equal(warm.status(),200,'catalog must be ready before the network-contract check');
    page.on('request',onRequest);
    try{
      // First paint is measured on a FRESH page in the same authenticated context,
      // while the original page keeps the watcher/SSE coverage alive. Reloading the
      // live page can legitimately re-request root via coverage-gap/watcher-ready
      // resync, so it cannot prove "bootstrap exactly once".
      const probeTree=[];const probeV1=[];
      const probeContext=await browser.newContext({viewport:{width:1440,height:1000}});
      await probeContext.addCookies(await page.context().cookies());
      const probe=await probeContext.newPage();
      probe.on('request',r=>{const u=r.url();if(u.includes('/api/web/v2/tree'))probeTree.push(new URL(u));else if(u.includes('/api/web/v1/notes'))probeV1.push(u);});
      await probe.goto(`${base}/app`);
      await probe.waitForSelector('.note[title="A.md"]');
      await sleep(250);
      assert.equal(probeTree.filter(u=>u.searchParams.get('parent')==='').length,1,`bootstrap must request exactly one root page: ${probeTree.map(u=>u.search)}`);
      assert.equal(probeV1.length,0,`the tree must not use v1 notes: ${probeV1}`);
      await probeContext.close();

      // Expanding one folder requests only that parent.
      tree.length=0;
      await page.locator('.tree-folder-row[data-folder-path="Expand"] .tree-folder').click();
      await page.waitForSelector('.note[title="Expand/Child.md"]');
      await sleep(150);
      assert.deepEqual([...new Set(tree.map(u=>u.searchParams.get('parent')))],['Expand'],params());
      assert.equal(v1.length,0,JSON.stringify(v1));

      // A >page directory pages with the RETURNED cursor verbatim, and one load-more
      // must yield every item exactly once.
      tree.length=0;
      const firstBulk=treeResponses('Bulk');
      await page.locator('.tree-folder-row[data-folder-path="Bulk"] .tree-folder').click();
      const firstBody=await (await firstBulk).json();
      assert.equal(firstBody.items.length,100,'a full page is returned');
      assert.ok(firstBody.nextCursor,'a >page directory must return a nextCursor');
      await page.waitForSelector('.note[title="Bulk/note-000.md"]');
      const more=page.locator('.tree-load-more').first();
      await more.waitFor();
      tree.length=0;
      const nextBulk=treeResponses('Bulk');
      await more.click();
      const nextResponse=await nextBulk;
      assert.equal(new URL(nextResponse.request().url()).searchParams.get('cursor'),firstBody.nextCursor,'load-more must pass the returned cursor verbatim');
      await page.waitForFunction(()=>document.querySelectorAll('.note[title^="Bulk/note-"]').length>=130,undefined,{timeout:5000});
      await sleep(150);
      const bulkPaths=await page.locator('.note[title^="Bulk/note-"]').evaluateAll(nodes=>nodes.map(n=>n.dataset.path));
      assert.equal(bulkPaths.length,130,'one load-more must load the whole directory (no missing items)');
      assert.equal(new Set(bulkPaths).size,130,'load-more must not duplicate items');
      assert.ok(tree.every(u=>u.searchParams.get('parent')==='Bulk'&&u.searchParams.get('cursor')),`load-more must stay on Bulk with a cursor: ${params()}`);
      assert.equal(v1.length,0,JSON.stringify(v1));

      // A far-page target in a NEVER-expanded directory: opening it must locate via
      // layer-by-layer anchorPath and must NOT walk cursor pages sequentially.
      const search=page.locator('#search');
      // Navigation only (U4): select the search tab before driving the search input (the
      // file panel is in front while the tree is being expanded).
      if(await page.locator('[data-sidebar-tab="search"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="search"]').click();
      await search.fill('file:note-125');
      await page.waitForSelector('.note[title="Far/note-125.md"]');
      tree.length=0;v1.length=0;
      await page.locator('.note[title="Far/note-125.md"]').click();
      await page.waitForFunction(()=>document.querySelector('#current-path')?.textContent==='Far/note-125.md');
      await sleep(250);
      const anchors=tree.map(u=>u.searchParams.get('anchorPath')).filter(Boolean);
      assert.ok(anchors.includes('Far/note-125.md'),`far-page open must anchor the target: ${params()}`);
      assert.equal(tree.filter(u=>u.searchParams.get('cursor')).length,0,`far-page open must not walk cursor pages: ${params()}`);
      assert.equal(tree.filter(u=>u.searchParams.get('parent')==='').length,0,'far-page open must not reload root');

      // Real filesystem mutation -> SSE -> only the affected parent is invalidated.
      // Clearing the query re-materializes the root, so that response is awaited first:
      // the baseline below must only contain SSE-driven invalidation.
      const clearedRoot=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/web/v2/tree'&&new URL(r.url()).searchParams.get('parent')==='');
      await search.fill('');
      // Navigation only (U4/C3): clearing no longer returns to the file panel, so the file
      // tab is selected before the tree work below (the switch alone keeps the empty query).
      if(await page.locator('[data-sidebar-tab="files"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="files"]').click();
      await clearedRoot;
      await page.waitForSelector('.note[title="A.md"]');
      const folderRow=page.locator('.tree-folder-row[data-folder-path="Folder"] .tree-folder');
      if(await folderRow.getAttribute('aria-expanded')!=='true')await folderRow.click();
      await page.waitForSelector('.note[title="Folder/Nested.md"]');
      tree.length=0;v1.length=0;
      await fs.writeFile(path.join(vault,'Folder','Live.md'),'# live\n');
      await page.waitForSelector('.note[title="Folder/Live.md"]',{timeout:8000});
      await sleep(250);
      assert.deepEqual([...new Set(tree.map(u=>u.searchParams.get('parent')))],['Folder'],`SSE must invalidate only the affected parent: ${params()}`);
      assert.equal(tree.filter(u=>u.searchParams.get('parent')==='').length,0,'root must not be reloaded');
      assert.equal(v1.length,0,`query inactive => no v1 notes request: ${v1}`);
      await fs.rm(path.join(vault,'Folder','Live.md'),{force:true});

      // Mobile uses the same lazy network model (fresh probe at a mobile viewport).
      const mobileTree=[];const mobileV1=[];
      const mobileContext=await browser.newContext({viewport:{width:390,height:844}});
      await mobileContext.addCookies(await page.context().cookies());
      const mobileProbe=await mobileContext.newPage();
      mobileProbe.on('request',r=>{const u=r.url();if(u.includes('/api/web/v2/tree'))mobileTree.push(new URL(u));else if(u.includes('/api/web/v1/notes'))mobileV1.push(u);});
      await mobileProbe.goto(`${base}/app`);
      await mobileProbe.waitForSelector('.note[title="A.md"]');
      await sleep(250);
      assert.equal(mobileTree.filter(u=>u.searchParams.get('parent')==='').length,1,mobileTree.map(u=>u.search));
      assert.equal(mobileV1.length,0,JSON.stringify(mobileV1));
      // Mobile search uses the same v2 request model (no viewport-specific path).
      const mobileSearch=mobileProbe.waitForResponse(r=>r.url().includes('/api/web/v2/search?')&&new URL(r.url()).searchParams.get('q')==='file:A.md');
      // Navigation only (U4): on a narrow viewport the sidebar is a closed drawer and the
      // search input sits in the search tab panel, so the real drawer toggle + tab click
      // come first (neither issues a search request).
      await mobileProbe.locator('#menu').click();
      if(await mobileProbe.locator('[data-sidebar-tab="search"]').getAttribute('aria-selected')!=='true')await mobileProbe.locator('[data-sidebar-tab="search"]').click();
      await mobileProbe.locator('#search').fill('file:A.md');
      assert.equal((await mobileSearch).status(),200);
      await mobileProbe.waitForSelector('.search-results .note[data-path]');
      assert.equal(mobileV1.length,0,'mobile search must not use v1 notes');
      await mobileContext.close();
    }finally{
      page.off('request',onRequest);
      await page.setViewportSize({width:1440,height:1000});
      // Leave a clean tree state so a failure here cannot cascade into later checks.
      await page.locator('#search').fill('').catch(()=>{});
      await sleep(150);
    }
  });
}
