// Editor interaction (atomic task markers, mouse selection, composition, undo, embeds).
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function registerEditorInteractionChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('WEB-ED-04 task marker is atomic for arrows, selection, copy, undo and adjacent IME',async()=>{
    const source='- [ ] task one\n- [x] task two\n\nparagraph after\n';
    const select=anchor=>page.evaluate(pos=>{const view=window.__testEditor._view;view.dispatch({selection:{anchor:pos}});view.focus();},anchor);
    const head=()=>page.evaluate(()=>window.__testEditor._view.state.selection.main.head);
    try {
      await open('A.md');await mode('live');
      await page.evaluate(text=>{window.__testEditor.setValue(text,{resetHistory:true,silent:true});window.__testEditor.scrollToPosition(0);},source);
      await sleep(120);
      assert.equal(await page.locator('.cm-live-task-checkbox').count(),2);
      const positions=await page.evaluate(()=>{
        const text=window.__testEditor.getValue();
        const first=text.indexOf('[ ]'),second=text.indexOf('[x]');
        return{first,firstEnd:first+3,second,secondEnd:second+3};
      });
      // One arrow press crosses the whole hidden `[ ]` / `[x]` source range.
      for(const [from,to] of [[positions.first,positions.firstEnd],[positions.second,positions.secondEnd]]){
        await select(from);await sleep(30);
        await page.keyboard.press('ArrowRight');await sleep(30);
        assert.equal(await head(),to,JSON.stringify({case:'right',from,to}));
        await page.keyboard.press('ArrowLeft');await sleep(30);
        assert.equal(await head(),from,JSON.stringify({case:'left',from,to}));
      }
      // A selection spanning the marker keeps the Markdown source slice and the
      // real Ctrl+C payload is source, not the checkbox DOM/label.
      await page.evaluate(({to})=>{const view=window.__testEditor._view;view.dispatch({selection:{anchor:0,head:to+1}});view.focus();},{to:positions.firstEnd});
      await page.evaluate(()=>{window.__copied=null;document.addEventListener('copy',event=>{window.__copied=event.clipboardData.getData('text/plain');},{once:true});});
      await page.keyboard.press('Control+c');await sleep(60);
      const copied=await page.evaluate(()=>{const view=window.__testEditor._view,sel=view.state.selection.main;return{payload:window.__copied,slice:view.state.sliceDoc(sel.from,sel.to)};});
      assert.equal(copied.slice,'- [ ] ',JSON.stringify(copied));
      assert.equal(copied.payload,'- [ ] ',JSON.stringify(copied));
      // A checkbox click is one document transaction and a single undo restores it.
      await page.evaluate(()=>{const view=window.__testEditor._view;view.dispatch({selection:{anchor:view.state.doc.length}});view.focus();});
      const caretBefore=await head();
      const before=await value();
      await page.locator('.cm-live-task-checkbox').first().click();
      await sleep(80);
      assert.equal(await value(),source.replace('- [ ] ','- [x] '));
      const caretAfter=await head();
      assert.equal(caretAfter,caretBefore,JSON.stringify({caretBefore,caretAfter}));
      assert.ok(caretAfter<=positions.first||caretAfter>=positions.firstEnd,JSON.stringify({caretAfter,positions}));
      await page.evaluate(()=>window.__testEditor._view.focus());
      await page.keyboard.press('Control+z');await sleep(80);
      assert.equal(await value(),before,JSON.stringify({result:'single undo did not restore source'}));
      // Composition adjacent to the widget commits once and keeps the checkbox.
      const imeBefore=await value();
      const imePos=await page.evaluate(()=>{const view=window.__testEditor._view;const pos=view.state.doc.toString().indexOf('[ ]')+4;view.dispatch({selection:{anchor:pos}});view.focus();return pos;});
      const cdp=await page.context().newCDPSession(page);
      try {
        await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
        await cdp.send('Input.insertText',{text:'中文'});await sleep(120);
      } finally {await cdp.detach();}
      const imeAfter=await page.evaluate(()=>({text:window.__testEditor.getValue(),boxes:document.querySelectorAll('.cm-live-task-checkbox').length}));
      assert.equal(imeAfter.text,imeBefore.slice(0,imePos)+'中文'+imeBefore.slice(imePos),JSON.stringify(imeAfter));
      assert.equal(imeAfter.boxes,2,JSON.stringify(imeAfter));
    } finally {await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);}
  });
  await check('LP-06 forward and backward mouse selection across rendered blocks',async()=>{
    const source='# Selection fixture\n\nintro selection text\n\n| Name | Value |\n| --- | ---: |\n| first | 1 |\n\n```js\n# fake heading\nconst value = 1;\n```\n\nSetext title\n------------\n\n- one\n- two\n\nbefore %% private %% after\n\nend paragraph\n';
    const expected=source.slice(source.indexOf('intro selection text'),source.indexOf('end paragraph')+'end paragraph'.length);
    try {
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      for(const reverse of [false,true]){
        await page.evaluate(()=>window.__testEditor.scrollToPosition(0));await sleep(120);
        const points=await page.evaluate(()=>{
          const view=window.__testEditor._view;
          const text=view.state.doc.toString();
          function point(pos){
            const r=view.coordsAtPos(pos);if(!r)throw Error('Position not rendered');
            // Browser glyph boundary rounding may resolve the exact caret edge to the newline.
            // Pick an actual pointer pixel mapping to the asserted source position before dragging.
            for(const dy of [0,-2,2,-4,4,-8,8,-12,12])for(const dx of [0,-.25,.25,-.5,.5,-1,1,-2,2]){
              const p={x:r.left+dx,y:(r.top+r.bottom)/2+dy};if(view.posAtCoords(p)===pos)return p;
            }
            const dom=view.domAtPos(pos);const el=dom.node.nodeType===3?dom.node.parentElement:dom.node;
            throw Error(`No pointer pixel maps to source position ${pos}: ${JSON.stringify({r,dom:el.outerHTML,rect:el.getBoundingClientRect().toJSON(),samples:[-12,-8,-4,0,4,8,12].map(dy=>[dy,view.posAtCoords({x:r.left,y:(r.top+r.bottom)/2+dy})])})}`);
          }
          const from=text.indexOf('intro selection text'),to=text.indexOf('end paragraph')+'end paragraph'.length;
          const a=point(from),b=point(to);
          return {a,b,from,to,roundtripA:view.posAtCoords(a),roundtripB:view.posAtCoords(b)};
        });
        const [start,end]=reverse?[points.b,points.a]:[points.a,points.b];
        await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:20});await page.mouse.up();
        const selected=await page.evaluate(()=>({text:window.__testEditor.getSelection(),range:window.__testEditor._view.state.selection.main.toJSON()}));
        assert.equal(selected.text,expected,JSON.stringify({reverse,points,selectedRange:selected.range}));
      }
    } finally {await page.mouse.up().catch(()=>{});await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);}
  });
  await check('same-document mode changes preserve text undo and selection',async()=>{
    await mode('raw');await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('UNDO-MARK');
    await mode('live');await mode('raw');await page.keyboard.press('Control+z');assert.equal(await value(),fixture);
  });
  await check('LP-06 Chromium composition commits Chinese exactly once',async()=>{
    await mode('live');await page.locator('.cm-content').click();await page.keyboard.press('Control+End');
    const before=await value();const cdp=await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
      await cdp.send('Input.insertText',{text:'中文'});await sleep(100);
      assert.equal(await value(),before+'中文');
    } finally {await cdp.detach();}
  });
  await check('LP-05 opening B isolates undo from A',async()=>{
    await open('B.md');await mode('raw');await page.locator('.cm-content').click();await page.keyboard.press('Control+z');
    assert.equal(await value(),'# B heading\n\nB unique content\n');
  });
  // Owner ruling 2026-10-10 (option B) landed in #506/#507: the Web **Reading** surface now
  // shows `%%…%%` faintly with both delimiters kept, instead of omitting the whole comment.
  // LP-11 therefore asserts the new contract: the comment stays between its neighbours, it is
  // painted as exactly one faint span, and the rule does not reach into literal inline code.
  await check('LP-11 comments keep adjacent reading text visible around a faint inline comment',async()=>{
    await open('A.md');await mode('preview');await sleep(120);
    const pane=page.locator('#preview');
    const text=await pane.innerText();
    assert.match(text,/before\s+%%\s*private\s*%%\s+after/,`the comment must stay in place between its neighbours; visible text was ${JSON.stringify(text.slice(0,300))}`);
    const comments=pane.locator('.obsidian-comment');
    assert.equal(await comments.count(),1,`exactly one faint comment span; visible text was ${JSON.stringify(text.slice(0,300))}`);
    assert.equal((await comments.innerText()).trim(),'%% private %%',`the faint span keeps both delimiters and its text verbatim; got ${JSON.stringify(await comments.innerText())}`);
    // Negative control: `%%` inside an inline code span is literal text, not a comment opener.
    try {
      await mode('live');
      await page.evaluate(()=>window.__testEditor.setValue('literal `a %% b %% c` code and %% real %% here\n',{resetHistory:true,silent:true}));
      await mode('preview');await sleep(120);
      const injected=await pane.innerText();
      assert.match(injected,/a %% b %% c/,`inline code must keep its literal %% characters; visible text was ${JSON.stringify(injected.slice(0,300))}`);
      assert.equal(await pane.locator('.obsidian-comment').count(),1,`only the real comment may become a faint span; visible text was ${JSON.stringify(injected.slice(0,300))}`);
      assert.equal((await pane.locator('.obsidian-comment').innerText()).trim(),'%% real %%',`got ${JSON.stringify(await pane.locator('.obsidian-comment').innerText())}`);
      assert.equal(await pane.locator('code').first().innerText(),'a %% b %% c');
    } finally {
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await mode('preview');
    }
  });
  await check('LP-08 external asset change invalidates reading and live resource URLs',async()=>{
    await mode('preview');await sleep(120);
    const before=await page.locator('#preview img').first().getAttribute('src');
    await fs.writeFile(path.join(vault,'pixel.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>');
    await page.waitForFunction(src=>document.querySelector('#preview img')?.getAttribute('src')!==src,before);
    await mode('live');
    assert.ok(await page.locator('.cm-live-wiki-link').count());
    assert.equal(await page.locator('.cm-live-rendered-block').count(),0);
    assert.equal(await value(),fixture);
  });
  await check('LP-08 live embeds stay in-place wiki chrome instead of atomic image widgets',async()=>{
    await mode('live');
    try {
      await page.evaluate(text=>{window.__testEditor.setValue(text.replace('![[pixel.svg]]','![[missing/pixel.svg]]'),{resetHistory:true,silent:true});window.__testEditor.scrollToPosition(0);},fixture);
      await sleep(80);
      assert.match(await page.locator('.cm-live-wiki-link').filter({hasText:'pixel.svg'}).first().innerText(),/pixel\.svg/);
      assert.equal(await page.locator('.cm-live-rendered-block').count(),0);
    } finally {await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);}
  });
}
