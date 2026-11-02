// Editor and reader rendering (outline, markdown, code, markers, caret).
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function registerEditorRenderChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('LP-01 real EditorView non-active blocks and repeated mode switches',async()=>{
    await open('A.md');
    for(let i=0;i<5;i++){await mode('live');assert.ok(await page.locator('.cm-live-heading,.cm-live-code,.cm-live-table').count());await mode('raw');}
    await mode('live');assert.equal(await value(),fixture);assert.deepEqual(errors,[]);
    assert.equal(await page.locator('.cm-live-rendered-block').count(),0);
  });
  await check('LP-09 outline excludes fenced fake heading and supports Setext',async()=>{
    await open('A.md');
    await mode('live');
    const headings=await page.evaluate(()=>window.__testEditor.getHeadings());
    assert.deepEqual(headings.map(h=>h.text),expectedHeadings);
    for(const h of headings)assert.ok(fixture.slice(h.from,h.to).includes(h.text));
    assert.deepEqual(await page.locator('#outline-list .outline-item').allTextContents(),expectedHeadings);
  });
  await check('outline keeps stable DOM and active selection across view-mode switches',async()=>{
    await open('A.md');
    await mode('live');
    await page.evaluate(()=>{
      const items=[...document.querySelectorAll('#outline-list .outline-item')];
      items.forEach((item,index)=>{item.dataset.stabilityToken=`outline-${index}`;});
      window.__outlineMutations=[];
      window.__outlineObserver=new MutationObserver(records=>{
        window.__outlineMutations.push(...records.filter(record=>record.type==='childList'));
      });
      window.__outlineObserver.observe(document.querySelector('#outline-list'),{childList:true,subtree:true});
    });
    for(const next of ['preview','live','raw','live'])await mode(next);
    const stability=await page.evaluate(()=>{
      window.__outlineObserver.disconnect();
      const items=[...document.querySelectorAll('#outline-list .outline-item')];
      return {
        tokens:items.map(item=>item.dataset.stabilityToken),
        childListMutations:window.__outlineMutations.length,
        activeCount:items.filter(item=>item.classList.contains('is-active')).length,
      };
    });
    assert.deepEqual(stability.tokens,expectedHeadings.map((_,index)=>`outline-${index}`));
    assert.equal(stability.childListMutations,0);
    assert.equal(stability.activeCount,1);
  });
  await check('outline navigation holds the requested active item during smooth scrolling',async()=>{
    await open('A.md');
    await mode('live');
    await page.evaluate(()=>{
      const section=index=>`# Section ${index}\n\n${'long paragraph for scrolling\n\n'.repeat(35)}`;
      window.__testEditor.setValue([1,2,3,4].map(section).join('\n'),{resetHistory:true,silent:true});
    });
    await mode('preview');
    await page.locator('#outline-list .outline-item').last().click();
    const samples=await page.evaluate(async()=>{
      const values=[];const end=performance.now()+700;
      while(performance.now()<end){
        values.push(document.querySelector('#outline-list .outline-item.is-active')?.textContent||'');
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      return values;
    });
    assert.deepEqual([...new Set(samples)],['Section 4']);
    await page.locator('#preview').hover();
    await page.mouse.wheel(0,-10000);
    await sleep(160);
    assert.equal(await page.locator('#outline-list .outline-item.is-active').textContent(),'Section 1');
    await page.evaluate(source=>{
      window.__testEditor.setValue(source,{resetHistory:true,silent:true});
    },fixture);
    await mode('live');
  });
  await check('comprehensive Markdown and Obsidian fixture renders without source loss',async()=>{
    await open('A.md');
    await mode('live');
    const requiredSource=[
      /^---\n[\s\S]*?\n---\n/,
      /\*\*bold\*\*/,
      /==highlight==/,
      /\[\[Target\|aliased target\]\]/,
      /!\[\[pixel\.svg\]\]/,
      /> \[!NOTE\]\+/,
      /- \[ \] Open task/,
      /\$\$\n[\s\S]*?\\frac\{1\}\{3\}/,
      /\[\^fixture-note\]:/,
      /\^fixture-block/,
      /#nested\/tag/,
    ];
    for(const pattern of requiredSource)assert.match(fixture,pattern);
    await mode('preview');
    const rendered=await page.evaluate(()=>{
      const host=document.querySelector('#preview');
      return{
        headings:[1,2,3,4,5,6].map(level=>host.querySelectorAll(`h${level}`).length),
        tables:host.querySelectorAll('table').length,
        codeBlocks:host.querySelectorAll('pre > code').length,
        blockquotes:host.querySelectorAll('blockquote').length,
        callouts:host.querySelectorAll('.callout').length,
        tasks:host.querySelectorAll('input.task-list-item-checkbox').length,
        highlights:host.querySelectorAll('mark').length,
        footnotes:host.querySelectorAll('.footnotes').length,
        internalLinks:host.querySelectorAll('a.internal-link').length,
        embeds:host.querySelectorAll('.internal-embed').length,
        tags:host.querySelectorAll('a.tag').length,
        text:host.textContent||'',
      };
    });
    assert.deepEqual(rendered.headings,[1,2,1,1,1,1]);
    assert.ok(rendered.tables>=1,JSON.stringify(rendered));
    assert.ok(rendered.codeBlocks>=3,JSON.stringify(rendered));
    assert.ok(rendered.blockquotes>=2,JSON.stringify(rendered));
    assert.ok(rendered.callouts>=1,JSON.stringify(rendered));
    assert.equal(rendered.tasks,2,JSON.stringify(rendered));
    assert.ok(rendered.highlights>=1,JSON.stringify(rendered));
    assert.ok(rendered.footnotes>=1,JSON.stringify(rendered));
    assert.ok(rendered.internalLinks>=4,JSON.stringify(rendered));
    assert.ok(rendered.embeds>=2,JSON.stringify(rendered));
    assert.ok(rendered.tags>=2,JSON.stringify(rendered));
    for(const text of ['Actual heading','Expandable callout','Footnote definition','Target heading'])assert.match(rendered.text,new RegExp(text));
    await mode('live');
    assert.equal(await value(),fixture);
  });
  await check('LP-10 shared references render real links and HTML remains sanitized',async()=>{
    const result=await page.evaluate(()=>{
      const source='- [label][ref]\n\n[ref]: https://example.com/reference';
      const ctx=window.prepareObsidianDocumentContext(source,{sourcePath:'ref.md'});
      const markup=window.renderObsidianMarkdown('- [label][ref]',{fragment:true,documentContext:ctx,blockId:'test'});
      const template=document.createElement('template');template.innerHTML=markup;
      const unsafe=window.renderObsidianMarkdown('[bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>');
      const clean=document.createElement('template');clean.innerHTML=unsafe;
      return {href:template.content.querySelector('a')?.getAttribute('href'),unsafeNodes:clean.content.querySelectorAll('script,[onerror],a[href^="javascript:"]').length};
    });
    assert.equal(result.href,'https://example.com/reference');assert.equal(result.unsafeNodes,0);
  });
  await check('closed code renders as a card outside the selection while tables stay in-place',async()=>{
    const result=await page.evaluate(()=>{
      const code=document.querySelector('.cm-live-code');
      const codeStart=document.querySelector('.cm-live-code-start');
      const codeTop=document.querySelector('.cm-live-code-lang-line');
      const table=document.querySelector('.cm-table-widget');
      return {
        atomicCodeWidgets:document.querySelectorAll('.cm-live-rendered-code').length,
        codeLines:document.querySelectorAll('.cm-live-code').length,
        codeFamily:code?getComputedStyle(code).fontFamily:'',
        codeText:code?.textContent||'',
        codeColor:code?getComputedStyle(code).color:'',
        codeBackground:code?getComputedStyle(code).backgroundColor:'',
        codePadding:codeStart?getComputedStyle(codeStart).padding:'',
        codeRadius:codeTop?getComputedStyle(codeTop).borderRadius:'',
        visibleFenceLines:[...document.querySelectorAll('.cm-line')].filter(el=>/```/.test(el.textContent||'')).length,
        tableCount:document.querySelectorAll('.cm-table-widget').length,
      };
    });
    assert.equal(result.atomicCodeWidgets,0);
    assert.ok(result.codeLines>=2);
    assert.match(result.codeText,/# fake heading|const value = 1/);
    assert.ok(result.tableCount>0);
    assert.match(result.codeFamily,/mono|consolas|menlo|courier/i);
    assert.notEqual(result.codeBackground,'rgba(0, 0, 0, 0)');
    assert.notEqual(result.codePadding,'0px');
    assert.notEqual(result.codeRadius,'0px');
    assert.notEqual(result.codeColor,'rgba(0, 0, 0, 0)');
    assert.equal(result.visibleFenceLines,0);
  });
  await check('code geometry and typography stay stable across language, selection, and reading mode',async()=>{
    const source='`inline sample`\n\n```\nplain line\n```\n\n```powershell\nWrite-Host language\n```\n';
    try {
      await open('A.md');
      await mode('live');
      await page.evaluate(text=>{window.__testEditor.setValue(text,{resetHistory:true,silent:true});window.__testEditor.scrollToPosition(0);},source);
      await sleep(120);
      const live=await page.evaluate(()=>{
        const fences=[...document.querySelectorAll('.cm-live-code-lang-line')];
        const blocks=fences.map(open=>{
          const body=[];let node=open.nextElementSibling;
          while(node&&!node.classList.contains('cm-live-code-fence-line')){if(node.classList.contains('cm-live-code'))body.push(node);node=node.nextElementSibling;}
          const close=node;
          const a=open.getBoundingClientRect(),first=body[0]?.getBoundingClientRect(),last=body.at(-1)?.getBoundingClientRect(),z=close?.getBoundingClientRect();
          return{top:first?first.top-a.top:null,bottom:z&&last?z.bottom-last.bottom:null,openHeight:a.height,closeHeight:z?.height||null,bodyFont:body[0]?getComputedStyle(body[0]).font:''};
        });
        const inline=document.querySelector('.cm-live-inline-code-content');
        const code=document.querySelector('.cm-live-code');
        const font=el=>{const s=getComputedStyle(el);return{family:s.fontFamily,size:s.fontSize,weight:s.fontWeight,style:s.fontStyle,spacing:s.letterSpacing,lineHeight:s.lineHeight};};
        return{blocks,inlineFont:font(inline),codeFont:font(code)};
      });
      assert.equal(live.blocks.length,2);
      for(const block of live.blocks){assert.ok(Math.abs(block.top-13)<=1,JSON.stringify(block));assert.ok(Math.abs(block.bottom-13)<=1,JSON.stringify(block));assert.ok(Math.abs(block.openHeight-13)<=1);assert.ok(Math.abs(block.closeHeight-13)<=1);}
      assert.deepEqual(live.blocks[0],live.blocks[1]);
      const inlinePoint=await page.locator('.cm-live-inline-code-content').first().evaluate(el=>{const r=el.getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2};});
      await page.mouse.click(inlinePoint.x,inlinePoint.y);
      await sleep(80);
      const selected=await page.evaluate(()=>{
        const inline=document.querySelector('.cm-live-inline-code-content');
        const code=document.querySelector('.cm-live-code');
        const font=el=>{const s=getComputedStyle(el);return{family:s.fontFamily,size:s.fontSize,weight:s.fontWeight,style:s.fontStyle,spacing:s.letterSpacing,lineHeight:s.lineHeight};};
        return{inlineFont:font(inline),codeFont:font(code),chip:inline.classList.contains('cm-live-inline-code'),sourceText:inline.textContent,hiddenMarks:inline.querySelectorAll('.cm-live-source-mark-hidden').length};
      });
      assert.deepEqual(selected.inlineFont,live.inlineFont);
      assert.deepEqual(selected.codeFont,live.codeFont);
      assert.equal(selected.chip,true);
      assert.equal(selected.sourceText,'`inline sample`');
      assert.equal(selected.hiddenMarks,0);
      await mode('preview');
      const reading=await page.evaluate(()=>[...document.querySelectorAll('#preview pre')].map(pre=>{
        const code=pre.querySelector(':scope > code'),a=pre.getBoundingClientRect(),b=code.getBoundingClientRect(),ps=getComputedStyle(pre),cs=getComputedStyle(code);
        return{top:b.top-a.top-parseFloat(ps.borderTopWidth),bottom:a.bottom-b.bottom-parseFloat(ps.borderBottomWidth),font:cs.font,lineHeight:cs.lineHeight,before:getComputedStyle(pre,'::before').content,after:getComputedStyle(pre,'::after').content,codeBefore:getComputedStyle(code,'::before').content,codeAfter:getComputedStyle(code,'::after').content};
      }));
      assert.equal(reading.length,2);
      for(const block of reading){assert.ok(Math.abs(block.top-13)<=1,JSON.stringify(block));assert.ok(Math.abs(block.bottom-13)<=1,JSON.stringify(block));assert.equal(block.before,'none');assert.equal(block.after,'none');assert.equal(block.codeBefore,'none');assert.equal(block.codeAfter,'none');}
      assert.deepEqual(reading[0],reading[1]);
      assert.equal(reading[0].lineHeight,live.codeFont.lineHeight);
    } finally {await mode('live');await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);}
  });
  await check('list marker reveals only near source and never shifts body geometry',async()=>{
    const source='- list item with `inline code`\n\n> quoted line\n';
    try {
      await open('A.md');
      await mode('live');
      await page.evaluate(text=>{window.__testEditor.setValue(text,{resetHistory:true,silent:true});window.__testEditor.scrollToPosition(0);},source);
      await sleep(80);
      const sample=async pos=>page.evaluate(async position=>{
        const view=window.__testEditor._view;
        view.dispatch({selection:{anchor:position}});
        view.focus();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const text=view.state.doc.toString();
        const contentPos=text.indexOf('list item');
        const inline=document.querySelector('.cm-live-inline-code');
        const marker=document.querySelector('.cm-live-list-mark');
        const body=view.coordsAtPos(contentPos);
        const mark=marker?.getBoundingClientRect();
        const after=marker?getComputedStyle(marker,'::after'):null;
        const markerStart=view.coordsAtPos(0),markerEnd=view.coordsAtPos(1),afterSourceSpace=view.coordsAtPos(2);
        const bodySpaceStart=view.coordsAtPos(contentPos+4),bodySpaceEnd=view.coordsAtPos(contentPos+5);
        return{
          listX:body?.left,
          chipWidth:inline?.getBoundingClientRect().width,
          markerWidth:mark?.width,
          markerAdvance:markerEnd.left-markerStart.left,
          sourceSpaceAdvance:afterSourceSpace.left-markerEnd.left,
          bodySpaceAdvance:bodySpaceEnd.left-bodySpaceStart.left,
          markerClass:marker?.className||'',
          markerText:marker?.textContent||'',
          bulletContent:after?.content||'none',
        };
      },pos);
      const positions=await page.evaluate(()=>{
        const text=window.__testEditor.getValue();
        return{
          markerStart:0,
          markerEnd:1,
          bodyStart:text.indexOf('list item'),
          listMiddle:text.indexOf('list item')+4,
          quoteMiddle:text.indexOf('quoted line')+4,
          inlineMiddle:text.indexOf('inline code')+4,
        };
      });
      const near=[positions.markerStart,positions.markerEnd,positions.bodyStart];
      const far=[positions.listMiddle,positions.quoteMiddle,positions.inlineMiddle];
      const nearStates=[];
      const farStates=[];
      for(const pos of near){nearStates.push(await sample(pos));await sleep(30);}
      for(const pos of far){farStates.push(await sample(pos));await sleep(30);}
      const states=[...nearStates,...farStates];
      const first=states[0];
      for(const state of states){
        assert.ok(Math.abs(state.listX-first.listX)<.6,JSON.stringify({positions,states}));
        assert.ok(Math.abs(state.markerWidth-first.markerWidth)<.6,JSON.stringify({positions,states}));
        assert.ok(Math.abs(state.markerWidth-state.markerAdvance)<.6,JSON.stringify({positions,state}));
        assert.ok(Math.abs(state.chipWidth-first.chipWidth)<.6,JSON.stringify({positions,states}));
      }
      for(const state of nearStates){
        // When raw '-' is exposed, its following visual gap must be exactly the
        // same single-space advance as an ordinary source space in the body.
        assert.ok(Math.abs(state.sourceSpaceAdvance-state.bodySpaceAdvance)<.2,JSON.stringify({positions,state}));
      }
      assert.ok(nearStates.every(state=>/cm-live-list-source/.test(state.markerClass)),JSON.stringify({positions,nearStates}));
      assert.ok(farStates.every(state=>!/cm-live-list-source/.test(state.markerClass)),JSON.stringify({positions,farStates}));
      assert.ok(farStates.every(state=>/cm-live-list-bullet/.test(state.markerClass)),JSON.stringify({positions,farStates}));
      assert.ok(farStates.every(state=>/•/.test(state.bulletContent)),JSON.stringify({positions,farStates}));
      assert.ok(states.every(state=>state.markerText==='-'),JSON.stringify({positions,states}));
    } finally {await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);}
  });
  await check('active heading source marker stays in normal flow without overlapping text',async()=>{
    const source='# Heading title\n';
    try {
      await page.evaluate(text=>{window.__testEditor.setValue(text,{resetHistory:true,silent:true});const view=window.__testEditor._view;view.dispatch({selection:{anchor:text.indexOf('Heading')+3}});},source);
      await sleep(80);
      const geometry=await page.evaluate(()=>{
        const view=window.__testEditor._view,a=view.coordsAtPos(0),b=view.coordsAtPos(1),c=view.coordsAtPos(2);
        const heading=document.querySelector('.cm-line.cm-live-heading');
        return{
          markerStart:a.left,
          markerEnd:b.left,
          textStart:c.left,
          lineText:heading?.textContent||'',
          paddingBottom:heading?(parseFloat(getComputedStyle(heading).paddingBottom)||0):0,
        };
      });
      assert.match(geometry.lineText,/# Heading title/);
      assert.ok(geometry.markerEnd-geometry.markerStart>2,JSON.stringify(geometry));
      assert.ok(geometry.textStart>geometry.markerEnd,JSON.stringify(geometry));
      assert.ok(geometry.paddingBottom>=14,JSON.stringify(geometry));
      await page.screenshot({path:path.join(outputRoot,'active-heading-source-flow.png'),fullPage:false});
    } finally {await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);}
  });
  await check('H1 marker-start and title-middle use the same caret paint path',async()=>{
    const source='# 2026-09-14 Edge 防休眠\n';
    try {
      await open('B.md');
      await open('A.md');
      await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      const middle=source.indexOf('14');
      const sample=async pos=>page.evaluate(async position=>{
        const view=window.__testEditor._view;
        view.dispatch({selection:{anchor:position}});
        view.focus();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const contentStyle=getComputedStyle(view.contentDOM);
        const cursors=[...view.dom.querySelectorAll('.cm-cursor')].map(cursor=>{
          const style=getComputedStyle(cursor),rect=cursor.getBoundingClientRect();
          return{
            className:cursor.className,
            inlineStyle:cursor.getAttribute('style')||'',
            left:rect.left,right:rect.right,width:rect.width,height:rect.height,
            display:style.display,opacity:style.opacity,visibility:style.visibility,
            backgroundColor:style.backgroundColor,borderLeftWidth:style.borderLeftWidth,
            translate:style.translate,transform:style.transform,
          };
        });
        return{
          position,
          head:view.state.selection.main.head,
          dpr:window.devicePixelRatio,
          contentCaretColor:contentStyle.caretColor,
          contentFontSize:contentStyle.fontSize,
          cursors,
        };
      },pos);
      const atStart=await sample(0);
      const inMiddle=await sample(middle);
      console.log('CARET_H1_DIAG '+JSON.stringify({atStart,inMiddle}));
      assert.equal(atStart.cursors.length,1,JSON.stringify({atStart,inMiddle}));
      assert.equal(inMiddle.cursors.length,1,JSON.stringify({atStart,inMiddle}));
      assert.equal(atStart.contentCaretColor,inMiddle.contentCaretColor,JSON.stringify({atStart,inMiddle}));
      assert.ok(Math.abs(atStart.cursors[0].width-inMiddle.cursors[0].width)<.01,JSON.stringify({atStart,inMiddle}));
      assert.equal(atStart.cursors[0].className,inMiddle.cursors[0].className,JSON.stringify({atStart,inMiddle}));
    } finally {
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });
  await check('editable RAW and Live use a visible CodeMirror caret while reader hides the editor surface',async()=>{
    const source='plain caret thickness\n\n## \ninline `code`\n\n| h1 | h2 |\n| --- | --- |\n| a | b |\n\n```js\nconst x = 1\n```\n';
    try {
      // Force an actual identity transition. open('A.md') alone is not a safe
      // synchronization point when A.md is already current because #current-path
      // already matches before the async open request commits.
      await open('B.md');
      await open('A.md');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      const positions=[
        0,
        source.indexOf('caret')+2,
        source.indexOf('## ')+3,
        source.indexOf('inline')+8,
        source.indexOf('| --- |')+2,
        source.indexOf('```js')+3,
      ];
      const sampleCaret=position=>page.evaluate(async pos=>{
        const view=window.__testEditor._view;
        view.dispatch({selection:{anchor:pos}});
        view.focus();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const cursor=document.querySelector('.cm-cursor');
        if(!cursor)return{present:false,head:view.state.selection.main.head};
        const style=getComputedStyle(cursor),rect=cursor.getBoundingClientRect();
        return{
          present:true,
          head:view.state.selection.main.head,
          display:style.display,
          visibility:style.visibility,
          opacity:style.opacity,
          left:rect.left,
          right:rect.right,
          width:rect.width,
          height:rect.height,
          dpr:window.devicePixelRatio,
          translate:style.translate,
          borderLeftWidth:style.borderLeftWidth,
          backgroundColor:style.backgroundColor,
        };
      },position);

      for(const surface of ['raw','live']){
        await mode(surface);
        const samples=[];
        for(const pos of positions){
          const sample=await sampleCaret(pos);
          samples.push(sample);
          assert.equal(sample.head,pos,JSON.stringify({surface,pos,sample}));
          assert.equal(sample.present,true,JSON.stringify({surface,pos,sample}));
          assert.notEqual(sample.display,'none',JSON.stringify({surface,pos,sample}));
          // Blink animation may toggle visibility/opacity, but layout width and
          // paint path must be identical at line-start and in-line positions.
          assert.ok(sample.height>0,JSON.stringify({surface,pos,sample}));
          assert.ok(Math.abs(sample.width-2)<.15,JSON.stringify({surface,pos,sample}));
          assert.equal(sample.dpr,2,JSON.stringify({surface,pos,sample}));
          const leftPhysical=sample.left*sample.dpr,rightPhysical=sample.right*sample.dpr;
          assert.ok(Math.abs(leftPhysical-Math.round(leftPhysical))<.02,JSON.stringify({surface,pos,sample,leftPhysical}));
          assert.ok(Math.abs(rightPhysical-Math.round(rightPhysical))<.02,JSON.stringify({surface,pos,sample,rightPhysical}));
          assert.equal(parseFloat(sample.borderLeftWidth),0,JSON.stringify({surface,pos,sample}));
          assert.doesNotMatch(sample.backgroundColor,/^(?:rgba\(0, 0, 0, 0\)|transparent)$/,JSON.stringify({surface,pos,sample}));
        }
        const widths=samples.map(sample=>sample.width);
        assert.ok(Math.max(...widths)-Math.min(...widths)<.05,JSON.stringify({surface,widths,samples}));
      }

      await mode('preview');
      const readerSurface=await page.evaluate(()=>({
        editorHidden:document.querySelector('#editor').hidden,
        previewHidden:document.querySelector('#preview').hidden,
        editorRect:document.querySelector('#editor').getBoundingClientRect().height,
      }));
      assert.equal(readerSurface.editorHidden,true,JSON.stringify(readerSurface));
      assert.equal(readerSurface.previewHidden,false,JSON.stringify(readerSurface));
      assert.equal(readerSurface.editorRect,0,JSON.stringify(readerSurface));
    } finally {
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      // This check intentionally enters Reading mode. Restore the shared harness
      // surface so following legacy checks don't inherit a hidden #editor.
      await mode('live');
    }
  });
  await check('workspace sidebars keep desktop-like dividers and restrained scrollbars',async()=>{
    const chrome=await page.evaluate(()=>{
      const divider=document.querySelector('.pane-resizer-left');
      const ribbon=document.querySelector('.ribbon');
      const list=document.querySelector('.note-list');
      const dividerStyle=getComputedStyle(divider);
      const ribbonStyle=getComputedStyle(ribbon);
      const listStyle=getComputedStyle(list);
      const thumbStyle=getComputedStyle(list,'::-webkit-scrollbar-thumb');
      const trackStyle=getComputedStyle(list,'::-webkit-scrollbar-track');
      return{
        dividerWidth:divider.getBoundingClientRect().width,
        dividerBackground:dividerStyle.backgroundColor,
        ribbonBorderWidth:ribbonStyle.borderRightWidth,
        ribbonBorderColor:ribbonStyle.borderRightColor,
        scrollbarColor:listStyle.scrollbarColor,
        scrollbarWidth:listStyle.scrollbarWidth,
        thumbBackground:thumbStyle.backgroundColor,
        thumbBorder:thumbStyle.borderLeftWidth,
        trackBackground:trackStyle.backgroundColor,
      };
    });
    assert.equal(chrome.dividerWidth,1);
    assert.notEqual(chrome.dividerBackground,'rgba(0, 0, 0, 0)');
    assert.equal(chrome.ribbonBorderWidth,'1px');
    assert.notEqual(chrome.ribbonBorderColor,'rgba(0, 0, 0, 0)');
    assert.equal(chrome.scrollbarWidth,'thin');
    assert.match(chrome.scrollbarColor,/rgba?\(/);
    assert.notEqual(chrome.thumbBackground,'rgba(0, 0, 0, 0)');
    assert.equal(chrome.thumbBorder,'3px');
    assert.equal(chrome.trackBackground,'rgba(0, 0, 0, 0)');
    await page.screenshot({path:path.join(outputRoot,'workspace-scrollbars-and-dividers.png'),fullPage:false});
  });
}
