// Table Surface v2 geometry, caret and selection at table boundaries.
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function registerTablesLayoutChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('Table Surface v2 reuses the balanced column allocator instead of intrinsic max-content widths',async()=>{
    const source=[
      '| 能力 | 状态 | 主要实现/运行证据 | 测试/发布证据 | 当前边界 |',
      '| --- | --- | --- | --- | --- |',
      '| Markdown 笔记读写 | Implemented | app/src/tools/notes.js, app/src/obsidian.js, app/src/vault.js | tool-contract tests | Core 仍以 Vault 为核 |',
      '| 文件/附件/Canvas/ZIP/断点上传 | Implemented | app/src/tools/files.js, file-transfer.js | file-transfer tests | 本地 Vault |',
      '| 搜索与 Obsidian 查询语法 | Implemented | tools/search.js, search/*, vault-index.js | search tests | path-based |',
      '| Recall / embedding hybrid retrieval | Implemented | retrieval.js, embeddings.js, tools/intelligence.js | retrieval tests | service-backed |',
      '',
    ].join('\n');
    try{
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(220);
      const geometry=await page.evaluate(()=>{
        const table=document.querySelector('.cm-live-table-element');
        const viewport=document.querySelector('.cm-table-viewport');
        const cols=[...table.querySelectorAll('colgroup[data-table-layout="balanced"] col')].map(col=>parseFloat(col.style.width)||0);
        const first=[...table.rows[0].cells].map(cell=>cell.getBoundingClientRect().width);
        return{
          columnLayout:table.dataset.columnLayout,
          cols,first,
          tableWidth:table.getBoundingClientRect().width,
          viewportWidth:viewport.clientWidth,
          overflow:viewport.dataset.tableOverflow,
          borderOwnership:(()=>{
            const thead=table.tHead;
            const row=thead?.rows?.[0];
            const header=row?.cells?.[0];
            const ts=thead?getComputedStyle(thead):null;
            const rs=row?getComputedStyle(row):null;
            const hs=header?getComputedStyle(header):null;
            return{
              theadBottom:parseFloat(ts?.borderBottomWidth)||0,
              rowBottom:parseFloat(rs?.borderBottomWidth)||0,
              headerBottom:parseFloat(hs?.borderBottomWidth)||0,
            };
          })(),
        };
      });
      assert.equal(geometry.columnLayout,'balanced',JSON.stringify(geometry));
      assert.equal(geometry.cols.length,5,JSON.stringify(geometry));
      assert.ok(geometry.cols.every(width=>width>40),JSON.stringify(geometry));
      assert.ok(Math.max(...geometry.cols)-Math.min(...geometry.cols)>40,JSON.stringify(geometry));
      assert.ok(geometry.cols[1]<geometry.cols[2],JSON.stringify(geometry));
      assert.ok(geometry.first[1]<geometry.first[2],JSON.stringify(geometry));
      assert.ok(geometry.tableWidth>=geometry.viewportWidth-2,JSON.stringify(geometry));
      assert.equal(geometry.borderOwnership.theadBottom,0,JSON.stringify(geometry));
      assert.equal(geometry.borderOwnership.rowBottom,0,JSON.stringify(geometry));
      assert.ok(geometry.borderOwnership.headerBottom>=0.5,JSON.stringify(geometry));
    }finally{
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });

  await check('Table Surface v2 matches Reader vertical rhythm around blank-separated tables',async()=>{
    const source=[
      '## 已实现能力与代码证据',
      '',
      '| 能力 | 状态 | 主要实现/运行证据 |',
      '| --- | --- | --- |',
      '| Markdown 笔记读写 | Implemented | app/src/tools/notes.js |',
      '| 文件/附件/Canvas/ZIP/断点上传 | Implemented | app/src/tools/files.js |',
      '',
      'After table paragraph',
      '',
    ].join('\n');
    try{
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(180);
      const live=await page.evaluate(()=>{
        const heading=[...document.querySelectorAll('.cm-line')].find(el=>(el.textContent||'').includes('已实现能力与代码证据'));
        const viewport=document.querySelector('.cm-table-viewport');
        const after=[...document.querySelectorAll('.cm-line')].find(el=>(el.textContent||'').includes('After table paragraph'));
        const textRect=element=>{
          const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
          let first=null,last=null,node=walker.nextNode();
          while(node){if((node.nodeValue||'').trim()){first??=node;last=node;}node=walker.nextNode();}
          if(!first||!last)return element.getBoundingClientRect();
          const range=document.createRange();
          range.setStart(first,0);range.setEnd(last,(last.nodeValue||'').length);
          return range.getBoundingClientRect();
        };
        const h=textRect(heading),t=viewport.getBoundingClientRect(),a=textRect(after);
        return{before:t.top-h.bottom,after:a.top-t.bottom};
      });
      await mode('preview');await sleep(160);
      const reader=await page.evaluate(()=>{
        const heading=[...document.querySelectorAll('#preview h2')].find(el=>(el.textContent||'').includes('已实现能力与代码证据'));
        const viewport=document.querySelector('#preview .table-scroll');
        const after=[...document.querySelectorAll('#preview p')].find(el=>(el.textContent||'').includes('After table paragraph'));
        const textRect=element=>{
          const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
          let first=null,last=null,node=walker.nextNode();
          while(node){if((node.nodeValue||'').trim()){first??=node;last=node;}node=walker.nextNode();}
          if(!first||!last)return element.getBoundingClientRect();
          const range=document.createRange();
          range.setStart(first,0);range.setEnd(last,(last.nodeValue||'').length);
          return range.getBoundingClientRect();
        };
        const h=textRect(heading),t=viewport.getBoundingClientRect(),a=textRect(after);
        return{before:t.top-h.bottom,after:a.top-t.bottom};
      });
      assert.ok(Math.abs(live.before-reader.before)<=4,JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.after-reader.after)<=2,JSON.stringify({live,reader}));
    }finally{
      await page.evaluate(text=>{window.__testEditor.setMode('live');window.__testEditor.setValue(text,{resetHistory:true,silent:true});},fixture);
      await sleep(50);
    }
  });

  await check('Table Surface v2 hides root CodeMirror caret at atomic table boundaries',async()=>{
    const source=[
      'paragraph before',
      '',
      '| A | B |',
      '| --- | --- |',
      '| Alpha | Beta |',
      '',
      'paragraph after',
      '',
    ].join('\n');
    try{
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(160);
      const positions=await page.evaluate(()=>{
        const table=document.querySelector('.cm-table-widget');
        return{from:Number(table?.dataset.tableFrom),to:Number(table?.dataset.tableTo)};
      });
      for(const [side,pos] of Object.entries(positions)){
        await page.evaluate(position=>{
          const view=window.__testEditor._view;
          view.dispatch({selection:{anchor:position}});
          view.focus();
        },pos);
        await sleep(50);
        const paint=await page.evaluate(()=>{
          const host=document.querySelector('.markdown-source-view');
          const cursorLayer=document.querySelector('.cm-cursorLayer');
          const cursors=[...document.querySelectorAll('.cm-cursor')].map(el=>{
            const r=el.getBoundingClientRect(),style=getComputedStyle(el);
            return{height:r.height,visibility:style.visibility,display:style.display,opacity:style.opacity};
          });
          return{
            suppressed:host?.classList.contains('cm-table-root-caret-suppressed')||false,
            layerVisibility:cursorLayer?getComputedStyle(cursorLayer).visibility:'',
            cursors,
          };
        });
        assert.equal(paint.suppressed,true,JSON.stringify({side,pos,paint}));
        assert.equal(paint.layerVisibility,'hidden',JSON.stringify({side,pos,paint}));
        assert.ok(paint.cursors.every(cursor=>cursor.visibility==='hidden'||cursor.display==='none'||cursor.opacity==='0'),JSON.stringify({side,pos,paint}));
      }
    }finally{
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });

  await check('Table Surface v2 prose selection ending at an atomic table boundary has no widget-height range cursor',async()=>{
    const source=[
      '## Evidence heading',
      '',
      '| A | B |',
      '| --- | --- |',
      '| Alpha | Beta |',
      '',
    ].join('\n');
    try{
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(160);
      const points=await page.evaluate(()=>{
        const heading=[...document.querySelectorAll('.cm-line')].find(el=>(el.textContent||'').includes('Evidence heading'));
        const cell=document.querySelector('.cm-table-cell-editor');
        const a=heading.getBoundingClientRect(),b=cell.getBoundingClientRect();
        return{
          a:{x:Math.min(a.right-8,a.left+180),y:(a.top+a.bottom)/2},
          b:{x:b.left+Math.min(18,b.width/3),y:(b.top+b.bottom)/2},
        };
      });
      await page.mouse.move(points.a.x,points.a.y);
      await page.mouse.down();
      await page.mouse.move(points.b.x,points.b.y,{steps:12});
      await page.mouse.up();
      await sleep(100);
      const paint=await page.evaluate(()=>{
        const view=window.__testEditor._view;
        const table=document.querySelector('.cm-table-widget');
        const viewport=document.querySelector('.cm-table-viewport');
        const cursors=[...document.querySelectorAll('.cm-cursor')].map(el=>{
          const r=el.getBoundingClientRect();
          return{height:r.height,top:r.top,bottom:r.bottom};
        });
        return{
          empty:view.state.selection.main.empty,
          from:view.state.selection.main.from,
          to:view.state.selection.main.to,
          cursorCount:cursors.length,
          cursors,
          tableHeight:table?.getBoundingClientRect().height||0,
          tableScroll:viewport?.scrollLeft||0,
        };
      });
      assert.equal(paint.empty,false,JSON.stringify({points,paint}));
      assert.equal(paint.cursorCount,0,JSON.stringify({points,paint}));
      assert.equal(paint.tableScroll,0,JSON.stringify({points,paint}));
    }finally{
      await page.mouse.up().catch(()=>{});
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });

  await check('Table Surface v2 drag-selects text across cells without entering spreadsheet cell mode',async()=>{
    const source='| Alpha one | Beta two | Gamma three |\n| --- | --- | --- |\n| Delta four | Epsilon five | Zeta six |\n';
    try{
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(180);
      const points=await page.evaluate(()=>{
        const editors=[...document.querySelectorAll('.cm-table-cell-editor')];
        const start=editors.find(el=>(el.textContent||'').includes('Alpha one'));
        const end=editors.find(el=>(el.textContent||'').includes('Beta two'));
        const a=start.getBoundingClientRect(),b=end.getBoundingClientRect();
        return{
          a:{x:a.left+8,y:(a.top+a.bottom)/2},
          b:{x:b.right-8,y:(b.top+b.bottom)/2},
        };
      });
      await page.evaluate(()=>window.__testEditor._view.focus());
      await page.mouse.move(points.a.x,points.a.y);
      await page.mouse.down();
      await page.mouse.move(points.b.x,points.b.y,{steps:12});
      await page.mouse.up();
      await sleep(80);
      const selected=await page.evaluate(()=>{
        const selection=document.getSelection();
        const editors=[...document.querySelectorAll('.cm-table-cell-editor')];
        const prose=document.querySelector('.cm-content');
        const tableEditor=editors[0];
        const selectionLayer=document.querySelector('.cm-selectionLayer');
        const cursorLayer=document.querySelector('.cm-cursorLayer');
        return{
          text:selection?.toString()||'',
          collapsed:selection?.isCollapsed??true,
          editing:editors.filter(el=>el.contentEditable==='true'||el.classList.contains('is-editing')).length,
          activeClass:document.activeElement?.className||'',
          activeIsWidget:document.activeElement?.classList?.contains('cm-table-widget')||false,
          cmFocused:document.querySelector('.cm-editor')?.classList.contains('cm-focused')||false,
          domSelectionMode:document.querySelector('.markdown-source-view')?.classList.contains('cm-table-dom-selection-active')||false,
          rootSelectionVisibility:selectionLayer?getComputedStyle(selectionLayer).visibility:'',
          rootCursorVisibility:cursorLayer?getComputedStyle(cursorLayer).visibility:'',
          proseSelection:getComputedStyle(prose,'::selection').backgroundColor,
          tableSelection:getComputedStyle(tableEditor,'::selection').backgroundColor,
        };
      });
      assert.equal(selected.collapsed,false,JSON.stringify(selected));
      assert.match(selected.text,/Alpha one/);
      assert.match(selected.text,/Beta two/);
      assert.equal(selected.editing,0,JSON.stringify(selected));
      assert.equal(selected.activeIsWidget,false,JSON.stringify(selected));
      assert.equal(selected.cmFocused,true,JSON.stringify(selected));
      assert.equal(selected.domSelectionMode,true,JSON.stringify(selected));
      assert.equal(selected.rootSelectionVisibility,'hidden',JSON.stringify(selected));
      assert.equal(selected.rootCursorVisibility,'hidden',JSON.stringify(selected));
      assert.equal(selected.tableSelection,selected.proseSelection,JSON.stringify(selected));

      const alpha=page.locator('.cm-table-cell-editor').filter({hasText:'Alpha one'}).first();
      await alpha.click();await sleep(60);
      const editing=await alpha.evaluate(el=>({
        editable:el.contentEditable,
        editing:el.classList.contains('is-editing'),
        background:getComputedStyle(el).backgroundColor,
        shadow:getComputedStyle(el).boxShadow,
        rootSelectionVisibility:getComputedStyle(document.querySelector('.cm-selectionLayer')).visibility,
        rootCursorVisibility:getComputedStyle(document.querySelector('.cm-cursorLayer')).visibility,
        domEditMode:document.querySelector('.markdown-source-view')?.classList.contains('cm-table-dom-edit-active')||false,
      }));
      assert.equal(editing.editable,'true',JSON.stringify(editing));
      assert.equal(editing.editing,true,JSON.stringify(editing));
      assert.equal(editing.background,'rgba(0, 0, 0, 0)',JSON.stringify(editing));
      assert.equal(editing.shadow,'none',JSON.stringify(editing));
      assert.equal(editing.domEditMode,true,JSON.stringify(editing));
      assert.equal(editing.rootSelectionVisibility,'hidden',JSON.stringify(editing));
      assert.equal(editing.rootCursorVisibility,'hidden',JSON.stringify(editing));
    }finally{
      await page.mouse.up().catch(()=>{});
      await page.evaluate(()=>document.getSelection()?.removeAllRanges());
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });

  await check('Table Surface v2 cross-cell drag copy stays deterministic across repeated gestures',async()=>{
    const source='| Alpha one | Beta two | Gamma three |\n| --- | --- | --- |\n| Delta four | Epsilon five | Zeta six |\n';
    try{
      await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(180);
      for(let attempt=0;attempt<8;attempt+=1){
        await page.evaluate(()=>document.getSelection()?.removeAllRanges());
        const points=await page.evaluate(()=>{
          const editors=[...document.querySelectorAll('.cm-table-cell-editor')];
          const start=editors.find(el=>(el.textContent||'').includes('Alpha one'));
          const end=editors.find(el=>(el.textContent||'').includes('Beta two'));
          const a=start.getBoundingClientRect(),b=end.getBoundingClientRect();
          return{
            a:{x:a.left+6,y:(a.top+a.bottom)/2},
            b:{x:b.right-6,y:(b.top+b.bottom)/2},
          };
        });
        await page.evaluate(()=>window.__testEditor._view.focus());
        await page.mouse.move(points.a.x,points.a.y);
        await page.mouse.down();
        await page.mouse.move(points.b.x,points.b.y,{steps:6+attempt});
        await page.mouse.up();
        await sleep(30);
        const beforeCopy=await page.evaluate(()=>({
          text:document.getSelection()?.toString()||'',
          collapsed:document.getSelection()?.isCollapsed??true,
          active:document.querySelector('.markdown-source-view')?.classList.contains('cm-table-dom-selection-active')||false,
          rootSlice:(()=>{const v=window.__testEditor._view,s=v.state.selection.main;return v.state.sliceDoc(s.from,s.to)})(),
        }));
        assert.equal(beforeCopy.collapsed,false,JSON.stringify({attempt,beforeCopy}));
        assert.equal(beforeCopy.active,true,JSON.stringify({attempt,beforeCopy}));
        assert.match(beforeCopy.text,/Alpha one/,JSON.stringify({attempt,beforeCopy}));
        assert.match(beforeCopy.text,/Beta two/,JSON.stringify({attempt,beforeCopy}));
        await page.keyboard.press('Control+c');await sleep(30);
        const copied=await page.evaluate(()=>navigator.clipboard.readText());
        assert.match(copied,/Alpha one/,JSON.stringify({attempt,beforeCopy,copied}));
        assert.match(copied,/Beta two/,JSON.stringify({attempt,beforeCopy,copied}));
      }
    }finally{
      await page.mouse.up().catch(()=>{});
      await page.evaluate(()=>document.getSelection()?.removeAllRanges());
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });
}
