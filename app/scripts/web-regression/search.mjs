// Web search (query operators, v2 network contract).
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function registerSearchChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('Obsidian query operators and semantic fallback work in Web search',async()=>{
    const search=page.locator('#search');
    const clear=page.locator('#search-clear');
    const caseToggle=page.locator('#search-case');
    // Navigation only (U4): the search row lives in the search tab panel, which is not the
    // default view, so the panel is selected before the search input is drivable. A click
    // on the already-active tab would collapse the sidebar, hence the guard.
    if(await page.locator('[data-sidebar-tab="search"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="search"]').click();
    assert.equal(await clear.isVisible(),false);
    assert.equal(await caseToggle.textContent(),'Aa');
    assert.equal(await caseToggle.getAttribute('aria-pressed'),'false');
    const chrome=await page.evaluate(()=>{
      const input=document.querySelector('#search').getBoundingClientRect();
      const aa=document.querySelector('#search-case').getBoundingClientRect();
      return{input:{left:input.left,right:input.right,top:input.top,bottom:input.bottom},aa:{left:aa.left,right:aa.right,top:aa.top,bottom:aa.bottom}};
    });
    assert.ok(chrome.aa.left>=chrome.input.left&&chrome.aa.right<=chrome.input.right,JSON.stringify(chrome));
    assert.ok(chrome.aa.top>=chrome.input.top&&chrome.aa.bottom<=chrome.input.bottom,JSON.stringify(chrome));

    const looseCase=page.waitForResponse(r=>{
      if(!r.url().includes('/api/web/v2/search?'))return false;
      const u=new URL(r.url());
      return u.searchParams.get('q')==='file:b.md'&&u.searchParams.get('caseSensitive')==='false';
    });
    await search.fill('file:b.md');await looseCase;
    // Scope (U4-EXT2): this asserts the *search result* rendered, so the selector must be
    // scoped to the search panel -- the file tree keeps its own hidden B.md node and an
    // unscoped selector resolves to that one first (it can never become visible).
    await page.waitForSelector('#search-list .note[title="B.md"]');
    assert.equal(await clear.isVisible(),true);

    const strictCase=page.waitForResponse(r=>{
      if(!r.url().includes('/api/web/v2/search?'))return false;
      const u=new URL(r.url());
      return u.searchParams.get('q')==='file:b.md'&&u.searchParams.get('caseSensitive')==='true';
    });
    await caseToggle.click();await strictCase;
    assert.equal(await caseToggle.getAttribute('aria-pressed'),'true');
    await page.waitForFunction(()=>!document.querySelector('#search-list .note[title="B.md"]'));
    assert.equal(await page.locator('#semantic-search').getAttribute('aria-pressed'),'false');

    const relaxedAgain=page.waitForResponse(r=>{
      if(!r.url().includes('/api/web/v2/search?'))return false;
      const u=new URL(r.url());
      return u.searchParams.get('q')==='file:b.md'&&u.searchParams.get('caseSensitive')==='false';
    });
    await caseToggle.click();await relaxedAgain;
    await page.waitForSelector('#search-list .note[title="B.md"]');

    const cleared=page.waitForResponse(r=>{
      if(!r.url().includes('/api/web/v2/tree'))return false;
      return new URL(r.url()).searchParams.get('parent')==='';
    });
    await clear.click();await cleared;
    assert.equal(await search.inputValue(),'');
    assert.equal(await clear.isVisible(),false);
    assert.equal(await search.evaluate(el=>document.activeElement===el),true);
    for(const query of ['file:A.md','tag:fixture','line:"intro selection text"','section:"hard break"','[status:test]']){
      // Navigation only (U4): kept as a guard. Since C3 the clear above no longer returns to
      // the file panel, so this normally does not fire; it stays for a panel left elsewhere.
      if(await page.locator('[data-sidebar-tab="search"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="search"]').click();
      const response=page.waitForResponse(r=>r.url().includes('/api/web/v2/search?')&&new URL(r.url()).searchParams.get('q')===query);
      await search.fill(query);assert.equal((await response).status(),200);
      // Scope (U4-EXT2): assert the search result, not the file tree's hidden node.
      await page.waitForSelector('#search-list .note[title="A.md"]');
    }
    await page.locator('.search-help > summary').click();
    await page.waitForSelector('.search-help-card');
    assert.match(await page.locator('.search-help-card').innerText(),/line:.*section:.*\[status\]/s);
    assert.equal(await page.locator('#semantic-search').innerText(),'使用语义');
    assert.match(await page.locator('#semantic-search').getAttribute('title'),/普通搜索之外/);
    const helpFont=await page.locator('.search-help-card').evaluate(el=>getComputedStyle(el).fontFamily);
    const appFont=await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).fontFamily);
    assert.equal(helpFont,appFont);
    await page.locator('.search-help > summary').click();
    // Search results are a flat, server-ordered list (no client re-sort, no tree).
    const folderSearch=page.waitForResponse(r=>r.url().includes('/api/web/v2/search?')&&new URL(r.url()).searchParams.get('q')==='server');
    await search.fill('server');await folderSearch;
    await page.waitForSelector('.search-results .note[data-path]');
    assert.equal(await page.locator('.search-results .tree-folder').count(),0,'search results are flat');
    const ordered=await page.locator('.search-results .note[data-path]').evaluateAll(els=>els.map(el=>el.dataset.path));
    assert.equal(new Set(ordered).size,ordered.length,'no duplicate rows');
    const invalid=page.waitForResponse(r=>r.url().includes('/api/web/v2/search?')&&new URL(r.url()).searchParams.get('q')==='file:');
    await search.fill('file:');assert.equal((await invalid).status(),400);
    await page.waitForFunction(()=>document.querySelector('#search-status').textContent.includes('搜索语法不完整'));
    assert.equal(await page.locator('.toast.error').count(),0);
    const exact=page.waitForResponse(r=>r.url().includes('/api/web/v2/search?')&&new URL(r.url()).searchParams.get('q')==='tag:fixture "intro selection"');
    await search.fill('tag:fixture "intro selection"');await exact;
    // Phase 3B-2: semantic is a real path. With embeddings disabled in this harness it
    // must degrade explicitly (requested=true, used=false, a visible reason) and never
    // fall back to the v1 notes endpoint.
    const semantic=page.waitForResponse(r=>r.url().includes('/api/web/v2/search?')&&new URL(r.url()).searchParams.get('semantic')==='true');
    await page.locator('#semantic-search').click();
    const semanticResponse=await semantic;
    assert.equal(semanticResponse.status(),200);
    const semanticBody=await semanticResponse.json();
    assert.equal(semanticBody.semantic.requested,true);
    assert.equal(semanticBody.semantic.used,false);
    assert.ok(semanticBody.semantic.error,'the semantic degradation reason must be explicit');
    assert.match(await page.locator('#search-status').innerText(),/语义不可用/);
    assert.equal(await page.locator('#semantic-search').getAttribute('aria-pressed'),'true');
    await page.locator('#semantic-search').click();
    const reset=page.waitForResponse(r=>r.url().includes('/api/web/v2/tree')&&new URL(r.url()).searchParams.get('parent')==='');
    await search.fill('');await reset;
    // C3 migration (was: "clearing returns to the file panel"): clearing no longer returns
    // to the file panel -- the reader stays on the search panel with its empty state, and the
    // tree is re-materialized behind it, so that node is asserted as attached, not visible.
    assert.equal(await page.locator('#panel-search').isVisible(),true);
    assert.equal(await search.inputValue(),'');
    await page.waitForFunction(()=>document.querySelector('#search-list .empty')?.textContent.trim()==='输入关键词开始搜索');
    await page.waitForSelector('#note-list .note[title="B.md"]',{state:'attached'});
  });
  await check('v2 search network contract: v2 endpoint only, complete cursor paging, no v1 fallback',async()=>{
    const search=page.locator('#search');
    const v1=[],searchUrls=[];
    // Navigation only (U4): kept as a guard. Since C3 the previous check ends on the search
    // panel (clearing no longer returns to files), so this normally does not fire.
    if(await page.locator('[data-sidebar-tab="search"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="search"]').click();
    const onRequest=request=>{const url=request.url();if(url.includes('/api/web/v1/notes'))v1.push(url);else if(url.includes('/api/web/v2/search'))searchUrls.push(new URL(url));};
    page.on('request',onRequest);
    try{
      // 1. a lexical query goes to v2 -- never to the v1 notes endpoint.
      const first=page.waitForResponse(r=>r.url().includes('/api/web/v2/search?')&&new URL(r.url()).searchParams.get('q')==='file:note-');
      await search.fill('file:note-');
      const firstResponse=await first;
      assert.equal(firstResponse.status(),200);
      const firstBody=await firstResponse.json();
      assert.equal(firstBody.items.length,50,'the first page is the frozen page size');
      assert.ok(firstBody.nextCursor,'a full page offers an opaque cursor');
      assert.deepEqual(firstBody.semantic,{requested:false,used:false,error:null});
      assert.equal(v1.length,0,`search must never use v1 notes: ${v1.join(',')}`);
      const paths=await page.locator('.search-results .note[data-path]').evaluateAll(els=>els.map(el=>el.dataset.path));
      assert.equal(paths.length,50);

      // 2. continuation passes the opaque cursor back verbatim until it is null.
      let cursor=firstBody.nextCursor,guard=0;
      while(cursor&&guard<10){
        guard+=1;
        const expected=cursor;
        const next=page.waitForResponse(r=>{if(!r.url().includes('/api/web/v2/search?'))return false;return new URL(r.url()).searchParams.get('cursor')===expected;});
        await page.locator('.search-load-more').click();
        const body=await (await next).json();
        paths.push(...body.items.map(item=>item.path));
        cursor=body.nextCursor;
      }
      assert.equal(paths.length,260,`every match stays reachable through the cursor: ${paths.length}`);
      assert.equal(new Set(paths).size,260,'no duplicates across pages');
      assert.equal(v1.length,0,'paging must not use v1 notes');

      // 3. a new query replaces the results and drops the previous cursor.
      const replaced=page.waitForResponse(r=>r.url().includes('/api/web/v2/search?')&&new URL(r.url()).searchParams.get('q')==='zz-no-such-note');
      await search.fill('zz-no-such-note');
      assert.equal((await replaced).status(),200);
      await page.waitForFunction(()=>document.querySelectorAll('.search-results .note[data-path]').length===0);
      assert.equal(await page.locator('.search-load-more').count(),0,'a fresh query drops the old cursor');

      // 4. semantic is a real path: explicit requested/used/error, still no v1.
      const semantic=page.waitForResponse(r=>r.url().includes('/api/web/v2/search?')&&new URL(r.url()).searchParams.get('semantic')==='true');
      await search.fill('file:A.md');
      await page.locator('#semantic-search').click();
      const semanticResponse=await semantic;
      assert.equal(semanticResponse.status(),200);
      const semanticBody=await semanticResponse.json();
      assert.equal(semanticBody.semantic.requested,true);
      assert.equal(semanticBody.semantic.used,false);
      assert.ok(semanticBody.semantic.error,'the semantic degradation reason must be explicit');
      assert.match(await page.locator('#search-status').innerText(),/语义不可用/);
      await page.locator('#semantic-search').click();
      await sleep(150);

      // 5. clearing ends the query and re-materializes the v2 lazy tree; the whole flow stays
      //    v1-free. C3 migration: the reader stays on the search panel (empty state), so the
      //    tree node is asserted as attached in the file panel behind it.
      const cleared=page.waitForResponse(r=>r.url().includes('/api/web/v2/tree')&&new URL(r.url()).searchParams.get('parent')==='');
      await search.fill('');await cleared;
      assert.equal(await search.inputValue(),'');
      assert.equal(await page.locator('#panel-search').isVisible(),true);
      await page.waitForSelector('#note-list .note[title="A.md"]',{state:'attached'});
      assert.equal(v1.length,0,`the whole search flow must stay v1-free: ${v1.join(',')}`);
      assert.ok(searchUrls.length>=4,searchUrls.length);

      // 6. a superseded response can never repaint a newer query. The barrier only
      //    delays query A; B completes first and A is released afterwards.
      let releaseA=()=>{};
      const gateA=new Promise(resolve=>{releaseA=resolve;});
      const barrier=async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/api/web/v2/search'&&url.searchParams.get('q')==='file:note-099')await gateA;
        await route.continue();
      };
      await page.route('**/api/web/v2/search**',barrier);
      try{
        // Navigation only (U4): kept as a guard. Since C3, step 5's clear leaves the search
        // panel in front, so this normally does not fire.
        if(await page.locator('[data-sidebar-tab="search"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="search"]').click();
        const requestA=page.waitForRequest(r=>{const u=new URL(r.url());return u.pathname==='/api/web/v2/search'&&u.searchParams.get('q')==='file:note-099';});
        await search.fill('file:note-099');
        await requestA; // A is now held at the barrier
        const responseB=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/web/v2/search'&&u.searchParams.get('q')==='file:A.md';});
        await search.fill('file:A.md');
        await responseB;
        await page.waitForSelector('.search-results .note[data-path="A.md"]');
        releaseA();
        await sleep(300);
        const afterRace=await page.locator('.search-results .note[data-path]').evaluateAll(els=>els.map(el=>el.dataset.path));
        assert.deepEqual(afterRace,['A.md'],`the late response must not repaint the newer query: ${afterRace}`);
        assert.equal(await search.inputValue(),'file:A.md');
        assert.equal(v1.length,0,`the race must not use v1 notes: ${v1.join(',')}`);
      }finally{
        releaseA();
        await page.unroute('**/api/web/v2/search**',barrier);
      }

      // 7. an injected 409 cursor-stale restarts only this search: the frontend
      //    refetches page 1 without a cursor, never reloads the tree root, and never
      //    touches v1 notes.
      const treeRoots=[];
      const onTree=r=>{const u=new URL(r.url());if(u.pathname==='/api/web/v2/tree'&&u.searchParams.get('parent')==='')treeRoots.push(r.url());};
      page.on('request',onTree);
      let staleInjected=0;
      const staleRoute=async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/api/web/v2/search'&&url.searchParams.get('cursor')&&staleInjected===0){
          staleInjected+=1;
          return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'cursor-stale'})});
        }
        return route.continue();
      };
      await page.route('**/api/web/v2/search**',staleRoute);
      try{
        const pageOne=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/web/v2/search'&&u.searchParams.get('q')==='file:note-'&&!u.searchParams.get('cursor');});
        await search.fill('file:note-');
        assert.equal((await pageOne).status(),200);
        await page.waitForSelector('.search-load-more');
        const treeBefore=treeRoots.length;
        const restart=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/web/v2/search'&&u.searchParams.get('q')==='file:note-'&&!u.searchParams.get('cursor');});
        await page.locator('.search-load-more').click();
        const restartBody=await (await restart).json();
        assert.equal(staleInjected,1,'the injected 409 cursor-stale was exercised');
        assert.equal(restartBody.items.length,50,'the restart is a fresh page 1');
        await sleep(300);
        assert.equal(treeRoots.length,treeBefore,'cursor-stale must not reload the tree root');
        assert.equal(v1.length,0,`cursor-stale recovery must not use v1 notes: ${v1.join(',')}`);
        const afterRestart=await page.locator('.search-results .note[data-path]').evaluateAll(els=>els.map(el=>el.dataset.path));
        assert.equal(afterRestart.length,50,'only page 1 is shown after the restart');
        assert.equal(new Set(afterRestart).size,50);
      }finally{
        await page.unroute('**/api/web/v2/search**',staleRoute);
        page.off('request',onTree);
      }
    }finally{
      page.off('request',onRequest);
      // Leave a clean tree state: this check ends in search mode, and a later check
      // opening a note from the tree must not inherit a filtered result list.
      await page.locator('#search').fill('').catch(()=>{});
      // C3 migration: clearing no longer returns to the file panel, so the file tab is
      // restored here to keep the pre-C3 starting condition of the later frozen checks.
      if(await page.locator('[data-sidebar-tab="files"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="files"]').click();
      await sleep(200);
    }
  });
}
