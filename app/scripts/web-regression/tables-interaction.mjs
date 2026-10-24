// Table Surface v2 widget columns, cell editing and wheel/mobile interaction.
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function registerTablesInteractionChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('Table Surface v2 renders one real table widget with stable shared columns',async()=>{
    const source=[
      '# Table V2',
      '',
      '| A | B | C | D | E |',
      '| --- | --- | --- | --- | --- |',
      ...Array.from({length:10},(_,row)=>`| r${row}a | r${row}b | r${row}c | r${row}d | r${row}e |`),
      '',
    ].join('\n');
    try {
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(180);
      const initial=await page.evaluate(()=>{
        const widget=document.querySelector('.cm-table-widget');
        const table=widget?.querySelector('table');
        const cells=[...widget?.querySelectorAll('.cm-table-cell')||[]];
        const rows=[...table?.rows||[]].map(row=>[...row.cells].map(cell=>{
          const r=cell.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width};
        }));
        return{
          widgetCount:document.querySelectorAll('.cm-table-widget').length,
          v2:document.querySelector('[data-obsidian-table-surface="v2"]')!=null,
          rows,
          paneScrollLeft:document.querySelector('.cm-scroller')?.scrollLeft||0,
          legacyRows:document.querySelectorAll('.cm-live-table-row,.cm-live-table-header').length,
          cellCount:cells.length,
        };
      });
      assert.equal(initial.widgetCount,1,JSON.stringify(initial));
      assert.equal(initial.v2,true,JSON.stringify(initial));
      assert.equal(initial.legacyRows,0,JSON.stringify(initial));
      assert.ok(initial.rows.length>=11&&initial.cellCount>=55,JSON.stringify(initial));
      const columnCount=initial.rows[0].length;
      for(let col=0;col<columnCount;col++){
        const left=initial.rows[0][col].left,right=initial.rows[0][col].right;
        for(const row of initial.rows){
          assert.ok(Math.abs(row[col].left-left)<=1&&Math.abs(row[col].right-right)<=1,JSON.stringify({col,left,right,row}));
        }
      }
      const editors=page.locator('.cm-table-cell-editor');
      const editorCount=await editors.count();
      assert.equal(editorCount,initial.cellCount,JSON.stringify({editorCount,initial}));
      const baselineWidget=await page.locator('.cm-table-widget').boundingBox();
      // Design hard gate: focus every cell. Focus/source-chrome state alone
      // must never move any shared column track or the table shell.
      for(let index=0;index<editorCount;index++){
        await editors.nth(index).click();
        await sleep(12);
        const focused=await page.evaluate(()=>({
          paneScrollLeft:document.querySelector('.cm-scroller')?.scrollLeft||0,
          legacyPipes:document.querySelectorAll('.cm-live-table-pipe,.cm-live-table-pipe-active').length,
          widget:(()=>{const r=document.querySelector('.cm-table-widget').getBoundingClientRect();return{left:r.left,right:r.right,width:r.width};})(),
          rows:[...document.querySelector('.cm-table-widget table').rows].map(row=>[...row.cells].map(cell=>{
            const r=cell.getBoundingClientRect();return{left:r.left,right:r.right};
          })),
        }));
        assert.equal(focused.paneScrollLeft,0,JSON.stringify({index,focused}));
        assert.equal(focused.legacyPipes,0,JSON.stringify({index,focused}));
        assert.ok(Math.abs(focused.widget.left-baselineWidget.x)<=1&&Math.abs(focused.widget.width-baselineWidget.width)<=1,JSON.stringify({index,focused,baselineWidget}));
        for(let col=0;col<columnCount;col++){
          const left=focused.rows[0][col].left,right=focused.rows[0][col].right;
          for(const row of focused.rows){
            assert.ok(Math.abs(row[col].left-left)<=1&&Math.abs(row[col].right-right)<=1,JSON.stringify({index,col,left,right,row}));
          }
        }
      }
      // Keyboard traversal is part of the same table interaction contract.
      // Start at the first cell and Tab through every remaining cell.
      await editors.first().click();
      for(let index=1;index<editorCount;index++){
        await page.keyboard.press('Tab');
        await sleep(18);
        const active=await page.evaluate(()=>{
          const editor=document.activeElement?.closest?.('.cm-table-cell-editor');
          const cell=editor?.closest?.('.cm-table-cell');
          return{
            row:Number(cell?.dataset.tableRow),
            col:Number(cell?.dataset.tableCol),
            isEditor:Boolean(editor),
          };
        });
        const expected={row:Math.floor(index/columnCount),col:index%columnCount};
        assert.equal(active.isEditor,true,JSON.stringify({index,active,expected}));
        assert.equal(active.row,expected.row,JSON.stringify({index,active,expected}));
        assert.equal(active.col,expected.col,JSON.stringify({index,active,expected}));
      }
    } finally {
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });
  await check('Table Surface v2 escapes typed pipes so cell edits cannot split the table',async()=>{
    const source='| Name | Status |\n| --- | --- |\n| Alpha | open |\n';
    try {
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(140);
      const cell=page.locator('.cm-table-cell-editor').filter({hasText:'Alpha'}).first();
      await cell.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.insertText('A|B');
      await sleep(120);
      // While active the cell intentionally shows Markdown source (A\|B).
      // Blur back to rendered mode before asserting the visual label.
      await page.locator('.cm-table-cell-editor').filter({hasText:'open'}).first().click();
      await sleep(80);
      const result=await page.evaluate(()=>({
        source:window.__testEditor.getValue(),
        widgetCount:document.querySelectorAll('.cm-table-widget').length,
        columns:[...document.querySelector('.cm-table-widget table').rows].map(row=>row.cells.length),
        rendered:[...document.querySelectorAll('.cm-table-cell-editor')].map(el=>(el.textContent||'').trim()),
      }));
      assert.match(result.source,/\| A\\\|B \| open \|/,JSON.stringify(result));
      assert.equal(result.widgetCount,1,JSON.stringify(result));
      assert.ok(result.columns.every(count=>count===2),JSON.stringify(result));
      assert.ok(result.rendered.includes('A|B'),JSON.stringify(result));
    } finally {
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });

  await check('Table Surface v2 cell editing writes through root document history',async()=>{
    const source='# Edit table\n\n| Name | Status |\n| --- | --- |\n| Alpha | open |\n| Beta | done |\n';
    try {
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(180);
      const before=await value();
      const cell=page.locator('.cm-table-cell-editor').filter({hasText:'Alpha'}).first();
      await cell.click();
      await sleep(60);
      await page.keyboard.press('End');
      await page.keyboard.type('X');
      await sleep(120);
      const after=await value();
      assert.notEqual(after,before,JSON.stringify({before,after}));
      assert.match(after,/AlphaX/);
      await page.keyboard.press('Control+z');await sleep(100);
      assert.equal(await value(),before);
      assert.equal(await page.locator('.cm-live-table-row,.cm-live-table-header,.cm-live-table-pipe').count(),0);
    } finally {
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });

  await check('Table Surface v2 preserves source through IME copy-paste readonly and external refresh',async()=>{
    const source='# Table interactions\n\n| Name | Status |\n| --- | --- |\n| Alpha | open |\n| Beta | done |\n';
    try {
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(180);

      // Cell IME commits exactly once through the root document transaction.
      const alpha=page.locator('.cm-table-cell-editor').filter({hasText:'Alpha'}).first();
      await alpha.click();await page.keyboard.press('End');
      const cdp=await page.context().newCDPSession(page);
      try {
        await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
        await cdp.send('Input.insertText',{text:'中文'});
        await sleep(140);
      } finally {await cdp.detach();}
      const imeValue=await value();
      assert.equal((imeValue.match(/中文/g)||[]).length,1,JSON.stringify({imeValue}));
      assert.match(imeValue,/Alpha中文/);
      await page.keyboard.press('Control+z');await sleep(100);
      assert.equal(await value(),source);

      // Native cell copy/paste must still result in root Markdown changes.
      await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
      await alpha.click();await page.keyboard.press('Control+a');await page.keyboard.press('Control+c');
      const copied=await page.evaluate(()=>navigator.clipboard.readText());
      assert.equal(copied,'Alpha',JSON.stringify({copied}));
      const beta=page.locator('.cm-table-cell-editor').filter({hasText:'Beta'}).first();
      await beta.click();await page.keyboard.press('Control+a');await page.keyboard.press('Control+v');await sleep(140);
      const pasted=await value();
      assert.match(pasted,/\| Alpha \| done \|/,JSON.stringify({pasted}));
      await page.keyboard.press('Control+z');await sleep(100);
      assert.equal(await value(),source);

      // Clean external refresh rebuilds the widget from the root document, not
      // from stale cell DOM state.
      const remote=source.replace('Beta','Remote');
      const applied=await page.evaluate(text=>window.__testEditor.applyExternalText(text),remote);
      assert.equal(applied,true);
      await sleep(120);
      assert.equal(await value(),remote);
      assert.ok(await page.locator('.cm-table-cell-editor').filter({hasText:'Remote'}).count());

      // Preview/read-only mode must never turn a cell editor contenteditable.
      await page.evaluate(()=>window.__testEditor.setMode('preview'));
      await sleep(100);
      const readOnly=await page.evaluate(()=>{
        const view=window.__testEditor._view;
        const editor=document.querySelector('.cm-table-cell-editor');
        if(editor){
          const r=editor.getBoundingClientRect();
          editor.dispatchEvent(new PointerEvent('pointerdown',{
            bubbles:true,cancelable:true,clientX:r.left+4,clientY:(r.top+r.bottom)/2,
          }));
        }
        return{
          state:view.state.readOnly,
          editable:editor?.contentEditable||'missing',
          text:view.state.doc.toString(),
        };
      });
      assert.equal(readOnly.state,true,JSON.stringify(readOnly));
      if(readOnly.editable!=='missing')assert.notEqual(readOnly.editable,'true',JSON.stringify(readOnly));
      assert.equal(readOnly.text,remote);
      await page.evaluate(()=>window.__testEditor.setMode('live'));await sleep(80);
    } finally {
      await page.evaluate(text=>{window.__testEditor.setMode('live');window.__testEditor.setValue(text,{resetHistory:true,silent:true});},fixture);
    }
  });

  await check('Table Surface v2 hides the Live horizontal scrollbar when the table fits',async()=>{
    const source=[
      '# Fitting table',
      '',
      '| File | Limit | Goal |',
      '| --- | ---: | --- |',
      '| frontend/app/core/app.js | 619 | bootstrap wiring |',
      '| src/app/live-events.js | 600 | transport lifecycle |',
      '',
      'paragraph after table',
      '',
    ].join('\n');
    try{
      await page.setViewportSize({width:1440,height:1000});await sleep(80);
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(180);
      const state=await page.evaluate(()=>{
        const viewport=document.querySelector('.cm-table-viewport');
        if(!viewport)throw Error('table viewport missing');
        const style=getComputedStyle(viewport);
        return{
          overflow:viewport.dataset.tableOverflow||'',
          overflowX:style.overflowX,
          scrollWidth:viewport.scrollWidth,
          clientWidth:viewport.clientWidth,
          scrollLeft:viewport.scrollLeft,
        };
      });
      assert.equal(state.overflow,'false',JSON.stringify(state));
      assert.equal(state.overflowX,'hidden',JSON.stringify(state));
      assert.equal(state.scrollLeft,0,JSON.stringify(state));
      const point=await page.evaluate(()=>{
        const viewport=document.querySelector('.cm-table-viewport');
        const rect=viewport.getBoundingClientRect();
        return{x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2};
      });
      await page.mouse.move(point.x,point.y);
      await page.mouse.wheel(220,0);
      await sleep(80);
      const afterWheel=await page.evaluate(()=>({
        tableScroll:document.querySelector('.cm-table-viewport')?.scrollLeft||0,
        rootScroll:document.querySelector('.cm-scroller')?.scrollLeft||0,
      }));
      assert.equal(afterWheel.tableScroll,0,JSON.stringify({state,afterWheel}));
      assert.equal(afterWheel.rootScroll,0,JSON.stringify({state,afterWheel}));
    }finally{
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });


  await check('Table Surface v2 horizontal wheel scrolls the whole table without moving prose',async()=>{
    const source=[
      '# Overflow table',
      '',
      '| '+Array.from({length:12},(_,i)=>`Column ${i+1}`).join(' | ')+' |',
      '| '+Array(12).fill('---').join(' | ')+' |',
      '| '+Array.from({length:12},(_,i)=>`frontend/features/very-long-path-${i+1}.js`).join(' | ')+' |',
      '| '+Array.from({length:12},(_,i)=>`another-long-value-${i+1}`).join(' | ')+' |',
      '',
      'paragraph after table',
      '',
    ].join('\n');
    try {
      await page.setViewportSize({width:1100,height:900});await sleep(80);
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(220);
      const before=await page.evaluate(()=>{
        const widget=document.querySelector('.cm-table-widget');
        const viewport=widget?.querySelector('.cm-table-viewport');
        const first=widget?.querySelector('.cm-table-cell');
        const r=first?.getBoundingClientRect();
        return{
          overflow:viewport?.dataset.tableOverflow||'',
          overflowX:viewport?getComputedStyle(viewport).overflowX:'',
          scrollLeft:viewport?.scrollLeft||0,
          scrollWidth:viewport?.scrollWidth||0,
          clientWidth:viewport?.clientWidth||0,
          firstLeft:r?.left||0,
          pane:document.querySelector('.cm-scroller')?.scrollLeft||0,
          pageWidth:document.documentElement.scrollWidth,
          viewport:window.innerWidth,
        };
      });
      assert.equal(before.overflow,'true',JSON.stringify(before));
      assert.equal(before.overflowX,'auto',JSON.stringify(before));
      assert.ok(before.scrollWidth>before.clientWidth+20,JSON.stringify(before));
      // Target a pixel that is actually visible inside the table viewport.
      // Later columns can be geometrically under the right context sidebar
      // before the table has scrolled, which would test the sidebar instead.
      const wheelPoint=await page.evaluate(()=>{
        const viewport=document.querySelector('.cm-table-viewport');
        const cell=viewport?.querySelector('.cm-table-cell-editor');
        if(!viewport||!cell)throw Error('table wheel target missing');
        const v=viewport.getBoundingClientRect(),c=cell.getBoundingClientRect();
        return{
          x:Math.max(v.left+8,Math.min(v.right-8,(c.left+c.right)/2)),
          y:Math.max(v.top+8,Math.min(v.bottom-8,(c.top+c.bottom)/2)),
        };
      });
      await page.mouse.move(wheelPoint.x,wheelPoint.y);
      const wheelHit=await page.evaluate(({x,y})=>{
        const el=document.elementFromPoint(x,y);
        return{tag:el?.tagName||'',className:el?.className||'',insideViewport:Boolean(el?.closest?.('.cm-table-viewport'))};
      },wheelPoint);
      assert.equal(wheelHit.insideViewport,true,JSON.stringify({before,wheelPoint,wheelHit}));
      await page.mouse.wheel(180,0);
      await sleep(120);
      const after=await page.evaluate(()=>{
        const widget=document.querySelector('.cm-table-widget');
        const viewport=widget?.querySelector('.cm-table-viewport');
        const first=widget?.querySelector('.cm-table-cell');
        const r=first?.getBoundingClientRect();
        return{
          scrollLeft:viewport?.scrollLeft||0,
          firstLeft:r?.left||0,
          pane:document.querySelector('.cm-scroller')?.scrollLeft||0,
          pageWidth:document.documentElement.scrollWidth,
          viewport:window.innerWidth,
        };
      });
      assert.ok(after.scrollLeft>0,JSON.stringify({before,after,wheelHit}));
      assert.ok(after.firstLeft<before.firstLeft-20,JSON.stringify({before,after}));
      assert.equal(after.pane,0,JSON.stringify(after));
      assert.ok(after.pageWidth<=after.viewport,JSON.stringify(after));
    } finally {
      await page.setViewportSize({width:1440,height:1000});await sleep(80);
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });

  await check('Table Surface v2 stays contained on mobile and sidebar resize',async()=>{
    const source='| Path | Status | Notes | Owner | More |\n| --- | --- | --- | --- | --- |\n| frontend/features/a-very-long-file-name.js | Implemented | long readable note text | owner-a | another long value |\n| frontend/features/another-long-file-name.js | Partial | more readable note text | owner-b | another long value |\n';
    try {
      await page.setViewportSize({width:1320,height:900});await sleep(80);
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await page.setViewportSize({width:390,height:844});await sleep(120);
      await sleep(180);
      const mobile=await page.evaluate(()=>{
        const widget=document.querySelector('.cm-table-widget');
        const viewport=widget.querySelector('.cm-table-viewport');
        const pane=document.querySelector('.cm-scroller');
        const W=viewport.getBoundingClientRect(),P=pane.getBoundingClientRect();
        return{
          widgetLeft:W.left,widgetRight:W.right,
          paneLeft:P.left,paneRight:P.right,
          widgetScrollWidth:viewport.scrollWidth,widgetClientWidth:viewport.clientWidth,
          paneScrollLeft:pane.scrollLeft,
          pageWidth:document.documentElement.scrollWidth,
          viewport:window.innerWidth,
        };
      });
      assert.ok(mobile.widgetLeft>=mobile.paneLeft-1&&mobile.widgetRight<=mobile.paneRight+1,JSON.stringify(mobile));
      assert.equal(mobile.paneScrollLeft,0,JSON.stringify(mobile));
      assert.ok(mobile.pageWidth<=mobile.viewport,JSON.stringify(mobile));
      await page.setViewportSize({width:1320,height:900});await sleep(100);
      await page.locator('#sidebar-toggle').click().catch(()=>{});
      await sleep(120);
      const resized=await page.evaluate(()=>({
        count:document.querySelectorAll('.cm-table-widget').length,
        pane:document.querySelector('.cm-scroller')?.scrollLeft||0,
        legacy:document.querySelectorAll('.cm-live-table-row,.cm-live-table-header').length,
        rows:[...document.querySelector('.cm-table-widget table').rows].map(row=>[...row.cells].map(cell=>{
          const r=cell.getBoundingClientRect();return{left:r.left,right:r.right};
        })),
      }));
      assert.equal(resized.count,1,JSON.stringify(resized));
      assert.equal(resized.pane,0,JSON.stringify(resized));
      assert.equal(resized.legacy,0,JSON.stringify(resized));
      for(let col=0;col<resized.rows[0].length;col++){
        const left=resized.rows[0][col].left,right=resized.rows[0][col].right;
        for(const row of resized.rows){
          assert.ok(Math.abs(row[col].left-left)<=1&&Math.abs(row[col].right-right)<=1,JSON.stringify({col,left,right,row,resized}));
        }
      }
    } finally {
      await page.setViewportSize({width:1440,height:1000});await sleep(80);
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });
}
