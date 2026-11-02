// Document state races, frontmatter and end-to-end latency.
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
// U54: LP-12's same-run normalized judgement (measurement preconditions + count invariants +
// same-run ratios) lives in its own module so `app/test/editing-envelope.test.js` can pin it
// without a browser.
import { evaluateEditingEnvelope, EDITING_ENVELOPE } from './editing-envelope.mjs';
// U54-FIX: the frozen PRE-FIX judgement. It is never consulted by the gate; the negative controls
// below use it only to record the "head red / fixed green" pair on the real browser readings
// (`performance.json`), so the seat's false greens are shown as a runnable pair, not a claim.
import { evaluatePrefixEnvelope } from './editing-envelope-prefix.mjs';

// U54-FIX: the browser-side negative controls drive a real, deliberately wrong workload through
// the same measurement chain and require the judgement to reject it.
//
// `NEGATIVE_CONTROL_WINDOW_HEIGHTS` makes the window tall enough that CodeMirror really renders a
// document-sized window instead of a viewport-sized one. The ladder is a guard against an
// unknown editor-height/window-height relation (the two recorded branch readings render 24 and 50
// `.cm-line` nodes in the same 1000px window, so the relation is not exactly linear): the first
// height that pushes the reading past `renderedLineCap` ends the probe, and every attempt is
// recorded. 1x the control document is ~51 lines at ~20px per line, so 12000px is well past the
// 400-line cap unless the editor pane is clipped far below the window.
const NEGATIVE_CONTROL_WINDOW_HEIGHTS = [12000, 20000, 32000];
const BASE_VIEWPORT = { width: 1440, height: 1000 };

export async function registerEditorRaceChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('LP-03 editing while POST in flight remains dirty',async()=>{
    await open('B.md');await mode('raw');
    await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\nsave snapshot');
    let release,hit; const gate=new Promise(r=>release=r); const started=new Promise(r=>hit=r);
    const handler=async route=>{if(route.request().method()!=='POST')return route.continue();hit();await gate;await route.continue();};
    await page.route('**/api/web/v1/note',handler);
    await page.locator('#save').click();await started;
    await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\nnew unsaved typing');
    const response=page.waitForResponse(r=>r.url().endsWith('/api/web/v1/note')&&r.request().method()==='POST');
    release();await response;await sleep(250);await page.unroute('**/api/web/v1/note',handler);
    assert.match(await value(),/new unsaved typing/);assert.equal(await page.locator('#save').isEnabled(),true);
    assert.doesNotMatch(await fs.readFile(path.join(vault,'B.md'),'utf8'),/new unsaved typing/);
  });
  await check('LP-02 external refresh never overwrites typing while GET is in flight',async()=>{
    await open('A.md');await mode('raw');
    let release,hit;const gate=new Promise(r=>release=r);const started=new Promise(r=>hit=r);
    const handler=async route=>{hit();await gate;await route.continue();};
    await page.route('**/api/web/v1/note?path=A.md',handler);
    await fs.writeFile(path.join(vault,'A.md'),fixture+'\nexternal version\n');
    await Promise.race([started,sleep(5000).then(()=>{throw Error('watcher did not start refresh GET');})]);
    await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\nlocal after GET');
    release();await sleep(400);await page.unroute('**/api/web/v1/note?path=A.md',handler);
    assert.match(await value(),/local after GET/);assert.doesNotMatch(await value(),/external version/);
    assert.equal(await page.locator('#save').isEnabled(),true);
  });
  await check('LP-02 late A response cannot replace opened B',async()=>{
    await open('B.md');
    let release,hit;const gate=new Promise(r=>release=r);const started=new Promise(r=>hit=r);
    const handler=async route=>{hit();await gate;try{await route.continue();}catch{}};
    await page.route('**/api/web/v1/note?path=A.md',handler);
    await page.locator('.note[title="A.md"]').click();await started;
    await open('B.md');release();await sleep(350);await page.unroute('**/api/web/v1/note?path=A.md',handler);
    assert.equal(await page.locator('#current-path').textContent(),'B.md');assert.match(await value(),/B unique content/);
  });
  await check('LP-02 pending B open preserves newly typed A and confirmed reload works',async()=>{
    await open('A.md');await mode('raw');
    const marker='A typed while B loading';
    const aPath=path.join(vault,'A.md');
    const exactNoteGet=(response,note)=>response.request().method()==='GET'
      && response.url().includes('/api/web/v1/note?')
      && new URL(response.url()).searchParams.get('path')===note;

    let releaseB,hitB;
    const bGate=new Promise(resolve=>{releaseB=resolve;});
    const bStarted=new Promise(resolve=>{hitB=resolve;});
    const bHandler=async route=>{
      const request=route.request();
      if(request.method()!=='GET'||new URL(request.url()).searchParams.get('path')!=='B.md')return route.continue();
      hitB();
      await bGate;
      await route.continue();
    };
    await page.route('**/api/web/v1/note?path=B.md',bHandler);
    const bResponse=page.waitForResponse(response=>exactNoteGet(response,'B.md'));
    try {
      await page.locator('.note[title="B.md"]').click();
      await Promise.race([bStarted,sleep(5000).then(()=>{throw Error('B note GET did not reach controlled barrier');})]);

      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(`\n${marker}`);

      assert.equal(await page.locator('#current-path').textContent(),'A.md');
      assert.match(await value(),new RegExp(marker));
      assert.doesNotMatch(await fs.readFile(aPath,'utf8'),new RegExp(marker));

      releaseB();
      assert.equal((await bResponse).status(),200);
      await page.waitForFunction(expected=>(
        document.querySelector('#current-path')?.textContent==='A.md'
        && window.__testEditor.getValue().includes(expected)
      ),marker);

      assert.match(await value(),new RegExp(marker));
      assert.doesNotMatch(await fs.readFile(aPath,'utf8'),new RegExp(marker));
    } finally {
      releaseB?.();
      await page.unroute('**/api/web/v1/note?path=B.md',bHandler);
    }

    const diskBeforeReload=await fs.readFile(aPath,'utf8');
    assert.doesNotMatch(diskBeforeReload,new RegExp(marker));

    let releaseA,hitA;
    const aGate=new Promise(resolve=>{releaseA=resolve;});
    const aStarted=new Promise(resolve=>{hitA=resolve;});
    const aHandler=async route=>{
      const request=route.request();
      if(request.method()!=='GET'||new URL(request.url()).searchParams.get('path')!=='A.md')return route.continue();
      hitA();
      await aGate;
      await route.continue();
    };
    await page.route('**/api/web/v1/note?path=A.md',aHandler);
    const aResponse=page.waitForResponse(response=>exactNoteGet(response,'A.md'));
    const dialogsBefore=dialogs.length;
    try {
      await page.locator('.note[title="A.md"]').click();
      await Promise.race([aStarted,sleep(5000).then(()=>{throw Error('confirmed A reload GET did not reach controlled barrier');})]);

      assert.ok(dialogs.length>dialogsBefore,JSON.stringify({dialogsBefore,dialogs}));
      assert.equal(await page.locator('#current-path').textContent(),'A.md');
      assert.match(await value(),new RegExp(marker));
      assert.doesNotMatch(await fs.readFile(aPath,'utf8'),new RegExp(marker));

      releaseA();
      assert.equal((await aResponse).status(),200);

      await page.waitForFunction(expected=>window.__testEditor.getValue()===expected,diskBeforeReload);
      assert.equal(await page.locator('#current-path').textContent(),'A.md');
      assert.equal(await value(),diskBeforeReload);
      assert.doesNotMatch(await value(),new RegExp(marker));
      assert.equal(await fs.readFile(aPath,'utf8'),diskBeforeReload);
      assert.doesNotMatch(await fs.readFile(aPath,'utf8'),new RegExp(marker));
    } finally {
      releaseA?.();
      await page.unroute('**/api/web/v1/note?path=A.md',aHandler);
    }
  });
  await check('properties panel edits Live frontmatter and round-trips through save/reading',async()=>{
    await open('Properties.md');await mode('live');
    await page.evaluate(()=>window.__testEditor.scrollToPosition(0));await sleep(150);
    assert.equal(await page.locator('.cm-live-properties').count(),1);
    assert.equal(await page.locator('.cm-live-inline-title').count(),1);
    assert.equal(await page.locator('.cm-live-inline-title').textContent(),'Properties');
    const liveDocumentHead=await page.evaluate(()=>{
      const title=document.querySelector('.cm-live-inline-title');
      const properties=document.querySelector('.cm-live-properties');
      const titleRect=title?.getBoundingClientRect(),propertiesRect=properties?.getBoundingClientRect();
      return{
        titleBeforeProperties:Boolean(title&&properties&&(title.compareDocumentPosition(properties)&Node.DOCUMENT_POSITION_FOLLOWING)),
        titleTop:titleRect?.top??null,
        propertiesTop:propertiesRect?.top??null,
      };
    });
    assert.equal(liveDocumentHead.titleBeforeProperties,true,JSON.stringify(liveDocumentHead));
    assert.ok(liveDocumentHead.titleTop<liveDocumentHead.propertiesTop,JSON.stringify(liveDocumentHead));
    assert.equal(await page.locator('.cm-line').filter({hasText:/^title:/}).count(),0);
    const titleRow=page.locator('.document-property-row',{hasText:'title'});
    const titleRemove=titleRow.locator('.cm-live-property-remove');
    const hiddenRemove=await titleRemove.evaluate(el=>({opacity:getComputedStyle(el).opacity,pointerEvents:getComputedStyle(el).pointerEvents}));
    assert.equal(hiddenRemove.opacity,'0');
    assert.equal(hiddenRemove.pointerEvents,'none');
    await titleRow.hover();await sleep(140);
    const hoveredRemove=await titleRemove.evaluate(el=>({opacity:getComputedStyle(el).opacity,pointerEvents:getComputedStyle(el).pointerEvents}));
    assert.equal(hoveredRemove.opacity,'1');
    assert.equal(hoveredRemove.pointerEvents,'auto');
    await page.locator('.cm-live-properties-toggle').hover();await sleep(140);
    assert.equal(await titleRemove.evaluate(el=>getComputedStyle(el).opacity),'0');

    const titleInput=titleRow.locator('input.cm-live-property-input');
    await titleInput.fill('Edited property');
    assert.equal(await titleRemove.evaluate(el=>getComputedStyle(el).opacity),'1');
    await titleInput.blur();await sleep(120);
    assert.match(await value(),/title: Edited property/);
    await mode('preview');
    assert.equal(await page.locator('#preview .inline-title').textContent(),'Properties');
    const readerDocumentHead=await page.evaluate(()=>{
      const title=document.querySelector('#preview .inline-title');
      const properties=document.querySelector('#preview .properties');
      const titleRect=title?.getBoundingClientRect(),propertiesRect=properties?.getBoundingClientRect();
      return{
        titleBeforeProperties:Boolean(title&&properties&&(title.compareDocumentPosition(properties)&Node.DOCUMENT_POSITION_FOLLOWING)),
        titleTop:titleRect?.top??null,
        propertiesTop:propertiesRect?.top??null,
      };
    });
    assert.equal(readerDocumentHead.titleBeforeProperties,true,JSON.stringify(readerDocumentHead));
    assert.ok(readerDocumentHead.titleTop<readerDocumentHead.propertiesTop,JSON.stringify(readerDocumentHead));
    assert.match(await page.locator('#preview .properties').innerText(),/Edited property/);
    assert.match(await page.locator('#preview .properties').innerText(),/false/);
    assert.match(await page.locator('#preview .properties').innerText(),/中文/);
    await mode('live');await sleep(120);
    assert.equal(await page.locator('.cm-live-property-source, .cm-live-yaml-source-bar').count(),0);
    assert.equal(await page.locator('.cm-live-properties').count(),1);
    assert.equal(await page.locator('.cm-line').filter({hasText:/^title:/}).count(),0);
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/web/v1/note')&&r.request().method()==='POST');
    await page.locator('#save').click();assert.equal((await saved).status(),200);
    assert.match(await fs.readFile(path.join(vault,'Properties.md'),'utf8'),/title: Edited property/);

    await page.setViewportSize({width:390,height:844});await sleep(100);
    const mobileTitleRow=page.locator('.document-property-row',{hasText:'title'});
    const mobileTitleRemove=mobileTitleRow.locator('.cm-live-property-remove');
    const mobileLayout=await mobileTitleRemove.evaluate(el=>{
      const style=getComputedStyle(el);
      return {position:style.position,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,opacity:Number(style.opacity),pointerEvents:style.pointerEvents};
    });
    assert.equal(mobileLayout.position,'absolute');
    assert.ok(mobileLayout.width>=44&&mobileLayout.height>=44,JSON.stringify(mobileLayout));
    assert.ok(mobileLayout.opacity>0&&mobileLayout.opacity<0.6,JSON.stringify(mobileLayout));
    assert.equal(mobileLayout.pointerEvents,'auto');
    const mobileValueWidth=await mobileTitleRow.locator('.metadata-property-value').evaluate(el=>({
      value:el.getBoundingClientRect().width,
      row:el.closest('.document-property-row').getBoundingClientRect().width,
    }));
    assert.ok(mobileValueWidth.value>=mobileValueWidth.row-32,JSON.stringify(mobileValueWidth));
    await page.setViewportSize({width:1440,height:1000});await sleep(80);

    await page.screenshot({path:path.join(outputRoot,'properties-live.png'),fullPage:true});
  });
  await check('empty, malformed and unclosed YAML never drops source or creates markdown block widgets',async()=>{
    const cases=['---\n---\n\nbody','---\ntitle: [broken\n---\n\nbody','---\ntags:\n  - open item'];
    for(const source of cases){
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);await sleep(80);
      assert.equal(await value(),source);assert.equal(await page.locator('.cm-live-rendered-block').count(),0);
    }
    const malformed=await page.evaluate(()=>window.renderObsidianMarkdown('---\ntitle: [broken\n---\n\nbody'));
    assert.match(malformed,/broken/);assert.match(malformed,/body/);
    await open('A.md');
  });
  await check('WEB-ED-R3 clean external refresh maps caret and keeps the remote patch out of local undo',async()=>{
    const initial='# Refresh heading\n\nalpha line\nbravo line\ncharlie anchor\n';
    try {
      await open('Refresh.md');await mode('raw');
      // A real local history entry: type, then save so the document is clean again.
      // A dirty document would make the session gate reject the external refresh (LP-02).
      await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\nlocal-edit');
      const saved=page.waitForResponse(r=>r.url().endsWith('/api/web/v1/note')&&r.request().method()==='POST');
      await page.locator('#save').click();assert.equal((await saved).status(),200);await sleep(150);
      const before=await value();
      assert.ok(before.includes('local-edit'),JSON.stringify({before}));
      // Logical caret sits on unchanged text between the two remote hunks.
      const anchor=before.indexOf('charlie anchor');
      await page.evaluate(pos=>window.__testEditor._view.dispatch({selection:{anchor:pos}}),anchor);
      const remote=before.replace('alpha line\n','alpha line\nINSERTED\n')+'REMOTE-TAIL\n';
      await fs.writeFile(path.join(vault,'Refresh.md'),remote);
      await page.waitForFunction(text=>window.__testEditor.getValue()===text,remote,{timeout:7000});
      const mapped=await page.evaluate(()=>window.__testEditor._view.state.selection.main.head);
      assert.equal(mapped,remote.indexOf('charlie anchor'),'caret must map with the unchanged suffix');
      await page.evaluate(()=>window.__testEditor._view.focus());await page.keyboard.press('Control+z');await sleep(120);
      const undone=await value();
      // The remote patch is a history boundary: one undo reverts the local edit and leaves
      // the externally applied text in place instead of treating the patch as a local step.
      assert.ok(undone.includes('INSERTED'),JSON.stringify({undone}));
      assert.ok(undone.includes('REMOTE-TAIL'),JSON.stringify({undone}));
      assert.ok(!undone.includes('local-edit'),JSON.stringify({undone}));
    } finally {
      await fs.writeFile(path.join(vault,'Refresh.md'),initial).catch(()=>{});
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),initial).catch(()=>{});
    }
  });
  await check('all scenarios leave no editor exceptions and server remains healthy',async()=>{
    assert.deepEqual(errors,[]);assert.equal((await fetch(`${base}/healthz`)).status,200);
    assert.ok(!serverErrors.some(e=>/circular structure|uncaught|RangeError/i.test(e)));
  });
  await check('LP-12 10k-line editing stays viewport-bounded, not document-bounded',async()=>{
    await mode('live');
    // U54: the absolute wall-clock budgets (initial load < 500 ms, typing p95 < 50 ms,
    // selection p95 < 16 ms) were removed because they measured the runner, not the product: the
    // same tree read typing p95 5.5 ms on wsl and 48.8 / 63.3 ms (two attempts of one job) on tx,
    // and 420 s was not enough for the tx attempt to finish the suite at all. The protocol below
    // therefore measures two document sizes in the same page and the same run -- a 51-line
    // control (fully inside the viewport) and the 10k fixture (10011 lines, 834 table fences +
    // 1668 code-fence lines) -- and `editing-envelope.mjs` judges fixture identity, sample shape,
    // "the keystrokes landed" and "the viewport painted" first, then count invariants and
    // same-run ratios. The same-run control removes the FIRST-ORDER effect of machine speed; it
    // does not make the ratio load-independent, because time-varying load can still move the two
    // halves of a ratio by different amounts. See that module for the readings behind every
    // constant, `app/test/editing-envelope.test.js` for the counterexamples it still catches, and
    // the negative controls at the end of this check for real-Chromium proof that the chain
    // rejects wrong workloads instead of only preset numbers.
    const measure=async(repeat,options={})=>page.evaluate(async({chunkRepeat,iterations,settle})=>{
      const chunk='# heading\n\nplain paragraph with **bold** and words\n\n| a | b |\n| --- | --- |\n| c | d |\n\n```js\nconst x = 1;\n```\n\n';
      const source='editable intro\n\n'+chunk.repeat(chunkRepeat);
      const loadedAt=performance.now();
      window.__testEditor.setValue(source,{resetHistory:true,silent:true});
      const loadMs=performance.now()-loadedAt;
      window.__testEditor.scrollToPosition(0);
      const surface=document.querySelector('.cm-content');
      if(settle){
        // Negative-control path: wait for the (much larger) window to settle instead of trusting a
        // fixed delay, so the reading is the rendered window and not an intermediate frame.
        let previous=-1,stable=0;
        const deadline=performance.now()+10000;
        while(performance.now()<deadline){
          await new Promise(resolve=>setTimeout(resolve,250));
          const now=surface.querySelectorAll('.cm-line').length;
          // Three identical polls (~1s of no change) before trusting the count: CodeMirror can
          // render a restricted window while it measures, and this probe must read the settled one.
          if(now===previous){stable+=1;if(stable>=3)break;}else{stable=0;previous=now;}
        }
      }else{
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
      const view=window.__testEditor._view;
      const renderedLines=surface.querySelectorAll('.cm-line').length;
      const widgets=surface.querySelectorAll('.cm-table-widget, .cm-live-rendered-code').length;
      let mutations=0;
      const observer=new MutationObserver(records=>{mutations+=records.length;});
      observer.observe(surface,{childList:true,subtree:true,characterData:true});
      const lengthBefore=view.state.doc.length;
      const typing=[],selection=[];
      for(let i=0;i<iterations;i++){
        let start=performance.now();view.dispatch({changes:{from:0,insert:'x'},selection:{anchor:1}});typing.push(performance.now()-start);
        start=performance.now();view.dispatch({selection:{anchor:i%2}});selection.push(performance.now()-start);
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      mutations+=observer.takeRecords().length;
      observer.disconnect();
      const doc=view.state.doc;
      // `view.state.doc` is a CodeMirror `Text`, not a string: `doc.toString()` is the only way to
      // count fixture lines/fences. (The first CI run on this fix failed here with
      // `TypeError: doc.split is not a function`, which is exactly what a real-browser run buys.)
      const lines=doc.toString().split('\n');
      const countLines=test=>lines.filter(test).length;
      return {lines:doc.lines,samples:typing.length,selectionSamples:selection.length,
        // U54-FIX: what the pre-fix judgement never checked -- the 30 dispatches must really be in
        // the document, the fixture must really be the fixture, and something must have painted.
        editApplied:doc.length-lengthBefore===iterations&&doc.sliceString(0,iterations)==='x'.repeat(iterations),
        tableFences:countLines(line=>line==='| --- | --- |'),
        codeFenceLines:countLines(line=>line.startsWith('```')),
        renderedLines,widgets,mutations,loadMs,typing,selection,
        measurement:'synchronous transaction duration, excludes next-paint and hardware IME'};
    },{chunkRepeat:repeat,iterations:options.iterations??30,settle:options.settle??false});
    const control=await measure(4);
    const large=await measure(834);
    const verdicts=evaluateEditingEnvelope({control,large});

    // ---------------------------------------------------------------------------------------
    // Negative controls (U54-FIX). Every one of them is a real Chromium reading taken with the
    // protocol above and then judged twice: by the fixed judgement (must reject) and by the
    // frozen pre-fix judgement (which accepted the two false greens the seat found). Both verdict
    // sets are recorded, so the "head red / fixed green" pair is evidence in the artifact.
    const negativeControls=[];
    const judge=(label,reading)=>{const fixedVerdicts=evaluateEditingEnvelope({control,large:reading});
      const prefixVerdicts=evaluatePrefixEnvelope({control,large:reading});
      const record={label,reading,
        fixed:{passes:fixedVerdicts.every(v=>v.ok),failed:fixedVerdicts.filter(v=>!v.ok).map(v=>v.name)},
        prefix:{passes:prefixVerdicts.every(v=>v.ok),failed:prefixVerdicts.filter(v=>!v.ok).map(v=>v.name)}};
      negativeControls.push(record);
      return record;};
    const rejectedOn=(record,fragment)=>record.fixed.failed.some(name=>name.includes(fragment));

    // (1) The seat's counterexample: the "large" slot really loads the 51-line control document.
    //     The pre-fix judgement passes it (it never looked at the document size); the fixed one
    //     must reject it on the large-fixture precondition.
    const mislabeled=judge('the "large" slot really loads the 51-line control document',await measure(4));
    // (2) A partial run: a single typing/selection sample instead of the 30-transaction protocol.
    const singleSample=judge('the 10k document measured with a single typing/selection sample',await measure(834,{iterations:1}));
    // (3) The browser genuinely enlarges the workload: the "large" slot loads 4x the fixture
    //     (40035 lines) instead of the fixture. Counts stay viewport-bounded, so only the fixture
    //     precondition can catch it -- and it must.
    const oversized=judge('the "large" slot really loads 4x the fixture instead of the fixture',await measure(3336));
    // (4) The browser genuinely renders a document-sized window: a taller viewport makes
    //     CodeMirror really paint more than the cap. One keystroke is enough for this probe (only
    //     the count criterion is asserted; the sample-shape precondition is allowed to fail too).
    //     This one is rejected by the pre-fix judgement as well (same cap); its purpose is to
    //     prove the count criterion is a live reading of real DOM work, not a constant.
    let enlarged=null;
    const attempts=[];
    try{
      for(const height of NEGATIVE_CONTROL_WINDOW_HEIGHTS){
        try{
          await page.setViewportSize({width:BASE_VIEWPORT.width,height});
          const reading=await measure(834,{iterations:1,settle:true});
          enlarged=judge(`the 10k document rendered in a ${height}px-tall window instead of a viewport-sized one`,reading);
          attempts.push({height,renderedLines:reading.renderedLines});
          if(reading.renderedLines>EDITING_ENVELOPE.renderedLineCap)break;
        }catch(error){
          attempts.push({height,error:String(error&&error.message||error)});
        }
      }
    } finally {
      await page.setViewportSize(BASE_VIEWPORT);
      await sleep(200);
    }

    await fs.writeFile(path.join(outputRoot,'performance.json'),`${JSON.stringify({
      note:'RECORD ONLY -- the gate is scripts/web-regression/editing-envelope.mjs (measurement preconditions + count invariants + same-run ratios + hang caps); these raw readings exist so a reviewer can re-derive them. The negativeControls block is the real-Chromium counterexample set: `prefix` is the frozen pre-fix judgement of `editing-envelope-prefix.mjs`, `fixed` is the judgement under test.',
      control,large,verdicts,negativeControls,windowsProbe:attempts,
    },null,2)}\n`);

    for(const verdict of verdicts)assert.ok(verdict.ok,`${verdict.name}: ${verdict.detail}`);

    // The two false greens the seat found must be REJECTED by the fixed judgement and ACCEPTED by
    // the pre-fix one, on real browser readings -- that is the pair, not a claim.
    assert.equal(mislabeled.prefix.passes,true,`the pre-fix judgement must accept the 51-line "large" document: ${JSON.stringify(mislabeled.prefix)}`);
    assert.ok(rejectedOn(mislabeled,'10k fixture really holds'),`a 51-line "large" document must be rejected: ${JSON.stringify(mislabeled)}`);
    assert.equal(singleSample.prefix.passes,true,`the pre-fix judgement must accept a single-sample run: ${JSON.stringify(singleSample.prefix)}`);
    assert.ok(rejectedOn(singleSample,'30 finite, non-negative typing samples'),`a single-sample run must be rejected: ${JSON.stringify(singleSample)}`);
    // The enlarged browser workload: the same wrong-workload classes, driven by real DOM work.
    assert.ok(oversized.reading.lines>EDITING_ENVELOPE.largeLines,`the oversized fixture must really load more lines than the fixture: ${oversized.reading.lines}`);
    // (`oversized.prefix` is recorded but not asserted: at 4x the fixture a hidden O(document) cost
    // could legitimately trip a ratio instead of the fixture precondition. Either rejection is a
    // rejection; what must hold is that the fixed judgement rejects it.)
    assert.ok(rejectedOn(oversized,'10k fixture really holds'),`4x the fixture must be rejected: ${JSON.stringify(oversized)}`);
    assert.ok(enlarged,'the enlarged-window negative control must run');
    assert.ok(enlarged.reading.renderedLines>EDITING_ENVELOPE.renderedLineCap,`the taller window must really render more than ${EDITING_ENVELOPE.renderedLineCap} .cm-line node(s): rendered ${enlarged.reading.renderedLines} (attempts ${JSON.stringify(attempts)})`);
    assert.ok(rejectedOn(enlarged,'renders a viewport'),`a document-sized rendered window must be rejected: ${JSON.stringify(enlarged)}`);

    // Leave the shared page on a small buffer: the controls above end on a 10x fixture.
    await page.evaluate(()=>window.__testEditor.setValue('# LP-12 fixtures measured; page left clean.\n',{resetHistory:true,silent:true}));
  });
}
