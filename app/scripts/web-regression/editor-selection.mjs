// Selection, resource revisions and code-card editing.
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function registerEditorSelectionChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('LP-08 relative resource revisions distinguish same basenames', async()=>{
    const urls=await page.evaluate(()=>{
      const render=sourcePath=>{
        const host=document.createElement('div');
        host.innerHTML=window.renderObsidianMarkdown('![[pixel.svg]]',{sourcePath,vaultId:'v',assetRevisions:{'v::one/pixel.svg':'r-one','v::two/pixel.svg':'r-two'}});
        return host.querySelector('img').getAttribute('src');
      };
      return [render('one/note.md'),render('two/note.md')];
    });
    assert.equal(new URL(urls[0],base).searchParams.get('rev'),'r-one');
    assert.equal(new URL(urls[1],base).searchParams.get('rev'),'r-two');
  });
  await check('reader uses latest source even with an older fragment context',async()=>{
    const rendered=await page.evaluate(()=>{
      const stale=window.prepareObsidianDocumentContext('old body\n\n[ref]: https://old.example');
      const host=document.createElement('div');
      host.innerHTML=window.renderObsidianMarkdown('new body [link][ref]\n\n[ref]: https://new.example',{documentContext:stale});
      return {text:host.textContent,href:host.querySelector('a')?.href};
    });
    assert.match(rendered.text,/new body/);assert.doesNotMatch(rendered.text,/old body/);
    assert.equal(rendered.href,'https://new.example/');
  });
  await check('LP-07 code card reveals editable fences on click and tables edit in place',async()=>{
    const codePosition=await page.evaluate(()=>window.__testEditor._view.state.doc.toString().indexOf('const value')+6);
    await page.evaluate(pos=>window.__testEditor.scrollToPosition(pos),codePosition);
    await sleep(100);
    assert.equal(await page.locator('.cm-live-rendered-code').count(),0);
    assert.ok(await page.locator('.cm-live-code').count());
    const codeClick=await page.evaluate(expected=>{
      const view=window.__testEditor._view;
      const rect=view.coordsAtPos(expected);if(!rect)throw Error('code position is not rendered');
      return{x:rect.left,y:(rect.top+rect.bottom)/2,expected};
    },codePosition);
    await page.mouse.click(codeClick.x,codeClick.y);
    assert.equal(await page.evaluate(()=>window.__testEditor._view.state.selection.main.head),codeClick.expected);
    const codeDragRange=await page.evaluate(()=>{
      const text=window.__testEditor._view.state.doc.toString(),from=text.indexOf('# fake heading');
      return{from,to:from+'# fake heading'.length};
    });
    await page.evaluate(pos=>window.__testEditor.scrollToPosition(pos),codeDragRange.from);
    await sleep(100);
    assert.equal(await page.locator('.cm-live-rendered-code').count(),0);
    const codeDrag=await page.evaluate(range=>{
      const view=window.__testEditor._view,a=view.coordsAtPos(range.from),b=view.coordsAtPos(range.to);
      if(!a||!b)throw Error('code drag endpoints are not rendered');
      return{from:{x:a.left,y:(a.top+a.bottom)/2},to:{x:b.left,y:(b.top+b.bottom)/2}};
    },codeDragRange);
    await page.mouse.move(codeDrag.from.x,codeDrag.from.y);await page.mouse.down();await page.mouse.move(codeDrag.to.x,codeDrag.to.y,{steps:12});await page.mouse.up();
    const codeSelection=await page.evaluate(()=>({text:window.__testEditor.getSelection(),range:window.__testEditor._view.state.selection.main.toJSON(),widgets:document.querySelectorAll('.cm-live-rendered-code').length,selectionRects:document.querySelectorAll('.cm-selectionBackground').length,selectionZ:getComputedStyle(document.querySelector('.cm-selectionLayer')).zIndex}));
    if(!/# fake heading/.test(codeSelection.text))throw Error(`code drag selection failed: ${JSON.stringify(codeSelection)}`);
    assert.ok(codeSelection.selectionRects>0);
    assert.ok(Number(codeSelection.selectionZ)>0);
    await sleep(80);
    const revealState=await page.evaluate(()=>({selection:window.__testEditor._view.state.selection.main.toJSON(),value:window.__testEditor.getValue()}));
    const renderedAfterClick=await page.locator('.cm-live-rendered-code').count();
    if(renderedAfterClick!==0)throw Error(`atomic code widget unexpectedly returned: ${JSON.stringify(revealState)}`);
    assert.ok(await page.locator('.cm-live-code-lang-line').count());
    assert.ok(await page.locator('.cm-live-code-fence-line').count());
    assert.ok(await page.locator('.cm-line').filter({hasText:'```js'}).count());
    assert.equal(await page.locator('.cm-live-code-lang-select').count(),0);
    await page.locator('.cm-live-code').first().click();
    await page.keyboard.type('Z');
    assert.match(await value(),/Z# fake heading|# fake headingZ|Zconst value|const valueZ|# fake heading\nZconst value/);
    await page.keyboard.press('Backspace');
    assert.equal(await value(),fixture);
    await page.evaluate(()=>window.__testEditor.scrollToPosition(window.__testEditor.getValue().indexOf('| first')));
    await sleep(80);
    assert.ok(await page.locator('.cm-table-widget').count());
    assert.equal(await page.locator('.cm-live-table-divider,.cm-live-table-row,.cm-live-table-cell').count(),0);
    await page.locator('.cm-table-cell-editor').first().click();
    assert.equal(await page.locator('.cm-live-heading, .cm-live-code, .cm-live-inline-code').count()>0,true);
  });
  await check('LP-06 selection stays visible across every styled Live surface',async()=>{
    const source='# Styled\n\n> quoted **strong** and `inline code`\n\n- list with ==highlight== and [[Target|alias]]\n\n| Head | Value |\n| --- | --- |\n| cell | `table code` |\n\n```js\nconst selected = true;\n```\n\n---\n\nend paragraph\n';
    try {
      await open('A.md');
      await mode('live');
      await page.evaluate(text=>{window.__testEditor.setValue(text,{resetHistory:true,silent:true});window.__testEditor.scrollToPosition(0);},source);await sleep(120);
      const styles=await page.evaluate(()=>({quote:document.querySelectorAll('.cm-live-quote').length,inline:document.querySelectorAll('.cm-live-inline-code').length,table:document.querySelectorAll('.cm-table-widget').length,code:document.querySelectorAll('.cm-live-code').length,atomicCode:document.querySelectorAll('.cm-live-rendered-code').length,hrHeight:document.querySelector('.cm-live-hr')?.getBoundingClientRect().height||0,selectionZ:Number(getComputedStyle(document.querySelector('.cm-selectionLayer')).zIndex),cursorZ:Number(getComputedStyle(document.querySelector('.cm-cursorLayer')).zIndex)}));
      assert.ok(styles.quote&&styles.inline&&styles.table&&styles.code);assert.equal(styles.atomicCode,0);assert.ok(styles.selectionZ>0&&styles.cursorZ>styles.selectionZ);
      const points=await page.evaluate(()=>{
        const view=window.__testEditor._view,text=view.state.doc.toString();
        const pointerAt=pos=>{
          const r=view.coordsAtPos(pos);if(!r)throw Error('styled selection position is not rendered');
          for(const dy of [0,-2,2,-4,4,-8,8,-12,12])for(const dx of [0,-.25,.25,-.5,.5,-1,1,-2,2,4,8,12]){
            const point={x:r.left+dx,y:(r.top+r.bottom)/2+dy};
            if(view.posAtCoords(point)===pos)return point;
          }
          throw Error(`styled selection has no pointer pixel for source position ${pos}`);
        };
        const from=text.indexOf('quoted'),to=text.indexOf('end paragraph')+'end paragraph'.length;
        return{a:pointerAt(from),b:pointerAt(to),from,to};
      });
      await page.mouse.move(points.a.x,points.a.y);await page.mouse.down();await page.mouse.move(points.b.x,points.b.y,{steps:24});
      const during=await page.evaluate(()=>{const rect=document.querySelector('.cm-selectionBackground'),style=rect?getComputedStyle(rect):null;return{rects:document.querySelectorAll('.cm-selectionBackground').length,text:window.__testEditor.getSelection(),background:style?.backgroundColor||'',edge:style?.boxShadow||''};});
      assert.ok(during.rects>0);assert.match(during.text,/inline code/);assert.match(during.text,/const selected/);
      assert.notEqual(during.background,'rgba(0, 0, 0, 0)');assert.equal(during.edge,'none');
      await page.screenshot({path:path.join(outputRoot,'styled-selection-during-drag.png'),fullPage:false});
      await page.evaluate(()=>{for(const el of [document.documentElement,document.body]){el.classList.remove('theme-light');el.classList.add('theme-dark');}});
      await page.screenshot({path:path.join(outputRoot,'styled-selection-during-drag-dark.png'),fullPage:false});
      await page.evaluate(()=>{for(const el of [document.documentElement,document.body]){el.classList.remove('theme-dark');el.classList.add('theme-light');}});
      await page.mouse.up();await sleep(80);
      const after=await page.evaluate(()=>{const hr=document.querySelector('.cm-live-hr-active'),divider=document.querySelector('.cm-live-table-divider-active');return{text:window.__testEditor.getSelection(),rects:document.querySelectorAll('.cm-selectionBackground').length,selectedInlineChips:[...document.querySelectorAll('.cm-live-inline-code')].filter(el=>/inline code|table code/.test(el.textContent||'')).length,listSources:document.querySelectorAll('.cm-live-list-source').length,hrBorder:hr?getComputedStyle(hr).borderTopWidth:'0px',hrHeight:hr?.getBoundingClientRect().height||0,dividerBorder:divider?getComputedStyle(divider).borderBottomWidth:'0px',atomicCode:document.querySelectorAll('.cm-live-rendered-code').length};});
      assert.match(after.text,/quoted/);assert.match(after.text,/const selected/);assert.ok(after.rects>0);assert.ok(after.selectedInlineChips>=1);assert.ok(after.listSources>0);assert.notEqual(after.hrBorder,'0px',JSON.stringify(after));assert.ok(Math.abs(after.hrHeight-styles.hrHeight)<=1,JSON.stringify({styles,after}));assert.equal(after.dividerBorder,'0px',JSON.stringify(after));assert.equal(after.atomicCode,0);
    } finally {await page.mouse.up().catch(()=>{});await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);}
  });
  await check('LP-06 inline-code click stays on the clicked source line',async()=>{
    const source='从 Windows：\n\n```powershell\n.\\scripts\\edge.ps1 sleep-guard status -SshHost 192.0.2.20\n.\\scripts\\edge.ps1 sleep-guard install -SshHost 192.0.2.20\n.\\scripts\\edge.ps1 sleep-guard on -SshHost 192.0.2.20\n.\\scripts\\edge.ps1 sleep-guard off -SshHost 192.0.2.20\n```\n\n- 当前 idle 仍是 launchd `caffeinate -i`；`-dims` 等下次 deploy。\n- 合盖验收（约 10:49）：`AppleClamshellState=Yes`，uptime 未中断。\n';
    try {
      await page.evaluate(text=>{window.__testEditor.setValue(text,{resetHistory:true,silent:true});window.__testEditor.scrollToPosition(0);},source);
      await sleep(120);
      const point=await page.evaluate(()=>{
        const el=[...document.querySelectorAll('.cm-live-inline-code')].find(node=>(node.textContent||'').includes('caffeinate -i'));
        if(!el)throw Error('rendered caffeinate inline code missing');
        const rect=el.getBoundingClientRect();return{x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2};
      });
      await page.mouse.click(point.x,point.y);
      await sleep(80);
      const landing=await page.evaluate(()=>{const view=window.__testEditor._view,head=view.state.selection.main.head;return{head,line:view.state.doc.lineAt(head).text,cursor:(()=>{const r=document.querySelector('.cm-cursor')?.getBoundingClientRect();return r?{top:r.top,left:r.left}:null;})()};});
      if(!landing.line.includes('caffeinate -i'))throw Error(`inline-code click landed on wrong line: ${JSON.stringify(landing)}`);
    } finally {await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);}
  });
}
