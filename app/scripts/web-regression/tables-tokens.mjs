// Table Surface v2 tokens, viewport and cell paint.
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function registerTablesTokensChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('Table Surface v2 inherits Obsidian table tokens and keeps inline Markdown scoped to cell content',async()=>{
    const source='| Code | Issue | Link |\n| --- | --- | --- |\n| `index.html` | #7 | [[Target\\|alias]] |\n';
    const themeHref='/api/web/v1/theme.css?name=ThemeInheritanceProbe';
    try {
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await page.evaluate(async href=>{
        const link=document.querySelector('#community-theme');
        await new Promise((resolve,reject)=>{
          link.onload=()=>resolve();
          link.onerror=()=>reject(new Error('theme probe failed to load'));
          link.disabled=false;
          link.href=href;
        });
      },themeHref);
      await sleep(120);
      const live=await page.evaluate(()=>{
        const widget=document.querySelector('.cm-table-widget');
        const header=widget.querySelector('thead tr');
        const headerCell=widget.querySelector('th');
        const cells=[...widget.querySelectorAll('tbody td')];
        const code=cells[0]?.querySelector('code');
        const link=cells[2]?.querySelector('a');
        return{
          headerBackground:getComputedStyle(header).backgroundColor,
          headerColor:getComputedStyle(headerCell).color,
          textColor:getComputedStyle(cells[0]).color,
          codeTag:code?.tagName||'',
          codeText:code?.textContent||'',
          codeWidth:code?.getBoundingClientRect().width||0,
          codeColor:code?getComputedStyle(code).color:'',
          codeBackground:code?getComputedStyle(code).backgroundColor:'',
          cellWidth:cells[0]?.getBoundingClientRect().width||0,
          renderedSurface:cells[0]?.querySelector('.cm-table-cell-editor')?.classList.contains('markdown-rendered')||false,
          issueText:cells[1]?.textContent||'',
          issueTagCount:cells[1]?.querySelectorAll('.tag').length||0,
          linkText:link?.textContent||'',
          linkClass:link?.className||'',
        };
      });
      assert.equal(live.headerBackground,'rgb(31, 42, 53)',JSON.stringify(live));
      assert.equal(live.headerColor,'rgb(141, 152, 163)',JSON.stringify(live));
      assert.equal(live.textColor,'rgb(171, 182, 193)',JSON.stringify(live));
      assert.equal(live.codeTag,'CODE',JSON.stringify(live));
      assert.equal(live.codeText,'index.html',JSON.stringify(live));
      assert.equal(live.renderedSurface,true,JSON.stringify(live));
      assert.equal(live.codeColor,'rgb(121, 132, 143)',JSON.stringify(live));
      assert.equal(live.codeBackground,'rgb(41, 52, 63)',JSON.stringify(live));
      assert.ok(live.codeWidth>0&&live.codeWidth<live.cellWidth-8,JSON.stringify(live));
      assert.equal(live.issueText.trim(),'#7',JSON.stringify(live));
      assert.equal(live.issueTagCount,0,JSON.stringify(live));
      assert.equal(live.linkText,'alias',JSON.stringify(live));
      assert.match(live.linkClass,/internal-link/,JSON.stringify(live));

      await mode('preview');await sleep(100);
      const reader=await page.evaluate(()=>{
        const table=document.querySelector('#preview table');
        const header=table.querySelector('thead tr');
        const headerCell=table.querySelector('th');
        const cell=table.querySelector('tbody td');
        return{
          headerBackground:getComputedStyle(header).backgroundColor,
          headerColor:getComputedStyle(headerCell).color,
          textColor:getComputedStyle(cell).color,
        };
      });
      assert.equal(reader.headerBackground,'rgb(31, 42, 53)',JSON.stringify(reader));
      assert.equal(reader.headerColor,'rgb(141, 152, 163)',JSON.stringify(reader));
      assert.equal(reader.textColor,'rgb(171, 182, 193)',JSON.stringify(reader));
      assert.equal(await value(),source);
    } finally {
      await page.evaluate(()=>{
        const link=document.querySelector('#community-theme');
        link.disabled=true;
        link.removeAttribute('href');
      });
      await page.evaluate(text=>{window.__testEditor.setMode('live');window.__testEditor.setValue(text,{resetHistory:true,silent:true});},fixture);
      await sleep(50);
    }
  });

  await check('Table Surface v2 widens the table viewport into the full safe editor pane',async()=>{
    const headers=Array.from({length:8},(_,i)=>`Evidence ${i+1}`);
    const source=[
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(()=> '---').join(' | ')} |`,
      `| ${headers.map((_,i)=>`app/frontend/features/really-long-table-contract-${i+1}.js`).join(' | ')} |`,
      `| ${headers.map((_,i)=>`docs/architecture/table-surface/long-evidence-${i+1}.md`).join(' | ')} |`,
      '',
    ].join('\n');
    try{
      await page.setViewportSize({width:1800,height:1000});await sleep(80);
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(240);
      const before=await page.evaluate(()=>{
        const content=document.querySelector('.cm-content');
        const scroller=document.querySelector('.cm-scroller');
        const gutter=document.querySelector('.cm-gutters');
        const viewport=document.querySelector('.cm-table-viewport');
        const table=document.querySelector('.cm-live-table-element');
        const c=content.getBoundingClientRect(),s=scroller.getBoundingClientRect(),v=viewport.getBoundingClientRect();
        const g=gutter?.getBoundingClientRect?.();
        const firstEditor=document.querySelector('.cm-table-cell-editor');
        const firstText=(()=>{
          const walker=document.createTreeWalker(firstEditor,NodeFilter.SHOW_TEXT);
          let node=walker.nextNode();
          while(node&&!(node.nodeValue||'').trim())node=walker.nextNode();
          if(!node)return null;
          const range=document.createRange();
          range.setStart(node,0);range.setEnd(node,Math.min(1,(node.nodeValue||'').length));
          const r=range.getBoundingClientRect();
          return{left:r.left,right:r.right};
        })();
        return{
          content:{left:c.left,right:c.right,width:c.width},
          scroller:{left:s.left,right:s.left+scroller.clientWidth,width:scroller.clientWidth,scrollLeft:scroller.scrollLeft,scrollWidth:scroller.scrollWidth},
          gutter:g?{left:g.left,right:g.right,width:g.width}:null,
          viewport:{
            left:v.left,right:v.right,width:v.width,clientWidth:viewport.clientWidth,
            scrollWidth:viewport.scrollWidth,scrollLeft:viewport.scrollLeft,
            borderLeftWidth:parseFloat(getComputedStyle(viewport).borderLeftWidth)||0,
          },
          firstEditorLeft:firstEditor.getBoundingClientRect().left,
          firstText,
          firstPaddingLeft:parseFloat(getComputedStyle(firstEditor).paddingLeft)||0,
          tableWidth:table.getBoundingClientRect().width,
          extension:Number(viewport.dataset.tableSymmetricExtension||0),
          columnWidth:Number(viewport.dataset.tableColumnWidth||0),
          columnOffset:Number(viewport.dataset.tableColumnOffset||0),
          leftClamped:viewport.dataset.tableLeftClamped==='true',
          visibleWidth:Number(viewport.dataset.tableVisibleWidth||0),
          docOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
        };
      });
      assert.ok(before.content.width<=705,JSON.stringify(before));
      assert.ok(before.viewport.width>before.content.width+80,JSON.stringify(before));
      assert.ok(before.extension>40,JSON.stringify(before));
      const effectiveColumnLeft=before.content.left+before.columnOffset;
      const effectiveColumnRight=effectiveColumnLeft+before.columnWidth;
      assert.ok(Math.abs((effectiveColumnLeft-before.viewport.left)-(before.viewport.right-effectiveColumnRight))<=2,JSON.stringify(before));
      assert.ok(before.viewport.left>=before.scroller.left+14,JSON.stringify(before));
      // The fold gutter is in-flow CodeMirror chrome, but it deliberately
      // paints behind Table V2. A wide table may therefore extend through that
      // lane; the real safety boundary is the editor scroller/pane edge.
      if(before.gutter?.width>0.5) assert.ok(before.viewport.left<before.gutter.right,JSON.stringify(before));
      assert.ok(before.viewport.borderLeftWidth>=0.5,JSON.stringify(before));
      assert.ok(before.viewport.right<=before.scroller.right-14,JSON.stringify(before));
      assert.equal(before.scroller.scrollLeft,0,JSON.stringify(before));
      assert.equal(before.viewport.scrollLeft,0,JSON.stringify(before));
      assert.ok(before.firstEditorLeft>=before.viewport.left-0.5,JSON.stringify(before));
      assert.ok(before.firstText&&before.firstText.left>=before.viewport.left+Math.max(4,before.firstPaddingLeft-2),JSON.stringify(before));
      assert.ok(before.docOverflow<=1,JSON.stringify(before));
      assert.ok(before.viewport.scrollWidth>before.viewport.clientWidth+20,JSON.stringify(before));

      const first=page.locator('.cm-table-cell-editor').first();
      await first.click();await sleep(50);
      const afterClick=await page.evaluate(()=>({
        tableScroll:document.querySelector('.cm-table-viewport')?.scrollLeft||0,
        rootScroll:document.querySelector('.cm-scroller')?.scrollLeft||0,
      }));
      assert.equal(afterClick.tableScroll,0,JSON.stringify({before,afterClick}));
      assert.equal(afterClick.rootScroll,0,JSON.stringify({before,afterClick}));
      await page.keyboard.insertText('X');await sleep(50);
      const afterInput=await page.evaluate(()=>({
        tableScroll:document.querySelector('.cm-table-viewport')?.scrollLeft||0,
        rootScroll:document.querySelector('.cm-scroller')?.scrollLeft||0,
      }));
      assert.equal(afterInput.tableScroll,0,JSON.stringify({before,afterInput}));
      assert.equal(afterInput.rootScroll,0,JSON.stringify({before,afterInput}));
      await page.locator('.cm-table-cell-editor').nth(1).click();await sleep(50);
      const afterBlur=await page.evaluate(()=>({
        tableScroll:document.querySelector('.cm-table-viewport')?.scrollLeft||0,
        rootScroll:document.querySelector('.cm-scroller')?.scrollLeft||0,
      }));
      assert.equal(afterBlur.tableScroll,0,JSON.stringify({before,afterBlur}));
      assert.equal(afterBlur.rootScroll,0,JSON.stringify({before,afterBlur}));

      const box=await page.locator('.cm-table-viewport').boundingBox();
      await page.mouse.move(box.x+Math.min(120,box.width/2),box.y+Math.min(60,box.height/2));
      await page.mouse.wheel(520,0);await sleep(80);
      const after=await page.evaluate(()=>({
        tableScroll:document.querySelector('.cm-table-viewport')?.scrollLeft||0,
        rootScroll:document.querySelector('.cm-scroller')?.scrollLeft||0,
      }));
      assert.ok(after.tableScroll>0,JSON.stringify({before,after}));
      assert.equal(after.rootScroll,0,JSON.stringify({before,after}));
    }finally{
      await page.setViewportSize({width:1440,height:1000});await sleep(80);
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    }
  });

  await check('Table Surface v2 keeps Reader and Live table left extension aligned',async()=>{
    const source=[
      '## 已实现能力与代码证据',
      '',
      '| 能力 | 状态 | 主要实现/运行证据 | 测试/发布证据 | 当前边界 |',
      '|---|---|---|---|---|',
      '| Markdown 笔记读写、frontmatter、tags、section | Implemented | `.1` 直接源码：`app/src/tools/notes.js`, `app/src/obsidian.js`, `app/src/vault.js` | `.1` tool-contract 等测试 | Core 仍以 primary Vault 为核心 |',
      '| 文件/附件/Canvas/ZIP/断点上传 | Implemented | `.1` 直接源码：`app/src/tools/files.js`, `file-transfer.js` | `.1` file-transfer tests | 本地 Vault 文件系统 |',
      '| 搜索与 Obsidian 查询语法 | Implemented | `.1` 直接源码：`tools/search.js`, `search/*`, `vault-index.js` | `.1` search tests | path-based index |',
      '| Recall / embedding hybrid retrieval | Implemented | `.1` 直接源码：`retrieval.js`, `embeddings.js`, `tools/intelligence.js` | `.1` retrieval/embedding tests | secondary Web Vault 无同等 semantic backend |',
      '| backlinks / graph / related / link health | Implemented | `.1` 直接源码：`tools/links.js`, `tools/intelligence.js`, `vault-index.js` | `.1` link tests | 依赖 path/link resolver |',
      '',
    ].join('\n');
    try{
      await page.setViewportSize({width:2048,height:1060});await sleep(80);
      await open('A.md');
      // Reproduce the field case: Explorer and Outline are both visible on a
      // wide desktop viewport. Persisted localStorage state must not make this
      // parity gate accidentally exercise a one-sidebar layout.
      await page.evaluate(()=>{
        const shell=document.querySelector('.shell');
        if(shell?.classList.contains('sidebar-hidden')) document.querySelector('#files-toggle')?.click();
        // The rail is opened by the layout-layer toggle (#398: the ⋮ outline item is gone).
        if(shell?.classList.contains('context-hidden')){document.querySelector('#sidebar-toggle')?.click();}
      });
      await sleep(120);
      await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await sleep(220);
      const live=await page.evaluate(()=>{
        const column=document.querySelector('.cm-content');
        const viewport=document.querySelector('.cm-table-viewport');
        const gutter=document.querySelector('.cm-gutters');
        const scroller=document.querySelector('.cm-scroller');
        const firstEditor=document.querySelector('.cm-table-cell-editor');
        const c=column.getBoundingClientRect(),v=viewport.getBoundingClientRect(),g=gutter?.getBoundingClientRect?.();
        const s=scroller.getBoundingClientRect(),ss=getComputedStyle(scroller);
        const firstText=(()=>{
          const walker=document.createTreeWalker(firstEditor,NodeFilter.SHOW_TEXT);
          let node=walker.nextNode();
          while(node&&!(node.nodeValue||'').trim())node=walker.nextNode();
          if(!node)return null;
          const range=document.createRange();
          range.setStart(node,0);range.setEnd(node,Math.min(1,(node.nodeValue||'').length));
          const r=range.getBoundingClientRect();
          const x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
          const hit=document.elementFromPoint(x,y);
          return{left:r.left,right:r.right,hitClass:hit?.className||'',hitInsideTable:Boolean(hit?.closest?.('.cm-table-widget'))};
        })();
        return{
          columnLeft:c.left,columnRight:c.right,columnWidth:c.width,
          frameLeft:v.left,frameRight:v.right,frameWidth:v.width,
          relativeLeft:c.left-v.left,
          extension:Number(viewport.dataset.tableSymmetricExtension||0),
          columnOffset:Number(viewport.dataset.tableColumnOffset||0),
          gutter:g?{left:g.left,right:g.right,width:g.width}:null,
          firstText,
          firstEditorLeft:firstEditor?.getBoundingClientRect().left??null,
          pane:{left:s.left,right:s.right,width:s.width,clientWidth:scroller.clientWidth,paddingLeft:ss.paddingLeft,paddingRight:ss.paddingRight},
          shellClasses:document.querySelector('.shell')?.className||'',
        };
      });
      await mode('preview');await sleep(180);
      const reader=await page.evaluate(()=>{
        const column=document.querySelector('#preview .markdown-preview-sizer');
        const viewport=document.querySelector('#preview .table-scroll');
        const pane=document.querySelector('#preview');
        const c=column.getBoundingClientRect(),v=viewport.getBoundingClientRect(),p=pane.getBoundingClientRect(),ps=getComputedStyle(pane);
        return{
          columnLeft:c.left,columnRight:c.right,columnWidth:c.width,
          frameLeft:v.left,frameRight:v.right,frameWidth:v.width,
          relativeLeft:c.left-v.left,
          extension:parseFloat(getComputedStyle(viewport).getPropertyValue('--table-symmetric-extension'))||0,
          pane:{left:p.left,right:p.right,width:p.width,clientWidth:pane.clientWidth,paddingLeft:ps.paddingLeft,paddingRight:ps.paddingRight},
          shellClasses:document.querySelector('.shell')?.className||'',
        };
      });
      assert.ok(!live.shellClasses.includes('sidebar-hidden')&&!live.shellClasses.includes('context-hidden'),JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.pane.left-reader.pane.left)<=1,JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.pane.right-reader.pane.right)<=1,JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.pane.width-reader.pane.width)<=1,JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.pane.clientWidth-reader.pane.clientWidth)<=1,JSON.stringify({live,reader}));
      assert.ok(live.extension>1&&reader.relativeLeft>1,JSON.stringify({live,reader}));
      // The prose column itself is the canonical axis. Table-specific offsets
      // are not allowed to fake parity while normal Live content remains shifted.
      assert.ok(Math.abs(live.columnLeft-reader.columnLeft)<=1,JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.columnRight-reader.columnRight)<=1,JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.columnWidth-reader.columnWidth)<=2,JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.extension-reader.extension)<=1,JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.frameLeft-reader.frameLeft)<=1,JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.frameRight-reader.frameRight)<=1,JSON.stringify({live,reader}));
      assert.ok(Math.abs(live.frameWidth-reader.frameWidth)<=2,JSON.stringify({live,reader}));
      assert.equal(live.columnOffset,0,JSON.stringify({live,reader}));
      assert.ok(live.gutter&&live.gutter.right<=live.columnLeft&&live.columnLeft-live.gutter.right<=12,JSON.stringify({live,reader}));
      // A geometrically aligned frame is still wrong if CodeMirror's gutter
      // paints on top of the first cell. Hit-test the first visible glyph.
      assert.ok(live.firstText?.hitInsideTable,JSON.stringify({live,reader}));
      assert.ok(live.firstText.left>=live.frameLeft+4,JSON.stringify({live,reader}));
    }finally{
      await page.setViewportSize({width:1440,height:1000});await sleep(80);
      await page.evaluate(text=>{window.__testEditor.setMode('live');window.__testEditor.setValue(text,{resetHistory:true,silent:true});},fixture);
    }
  });

  await check('Table Surface v2 keeps semantic paint while a rendered cell enters source edit',async()=>{
    const rich='`index.html` **Strong** *Em* ~~Strike~~ ==Mark== [Link](https://example.com)';
    const source=`| Rich | Plain |\n| --- | --- |\n| ${rich} | ok |\n`;
    const themeHref='/api/web/v1/theme.css?name=ThemeInheritanceProbe';
    try{
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await page.evaluate(async href=>{
        const link=document.querySelector('#community-theme');
        await new Promise((resolve,reject)=>{
          link.onload=()=>resolve();
          link.onerror=()=>reject(new Error('theme probe failed to load'));
          link.disabled=false;
          link.href=href;
        });
      },themeHref);
      await sleep(140);

      const idle=await page.evaluate(()=>{
        const cell=[...document.querySelectorAll('.cm-table-cell-editor')].find(el=>(el.textContent||'').includes('index.html'));
        const code=cell?.querySelector('code');
        const s=getComputedStyle(code);
        return{
          text:cell?.textContent||'',
          codeColor:s?.color||'',
          codeBackground:s?.backgroundColor||'',
          codeFontSize:s?.fontSize||'',
          codeRadius:s?.borderTopLeftRadius||'',
          codePaddingTop:s?.paddingTop||'',
          codePaddingRight:s?.paddingRight||'',
        };
      });
      const code=page.locator('.cm-table-cell-editor code').filter({hasText:'index.html'}).first();
      await code.click();await sleep(80);

      const editing=await page.evaluate(()=>{
        const cell=document.querySelector('.cm-table-cell-editor.is-editing');
        const inline=cell?.querySelector('.cm-inline-code');
        const strong=cell?.querySelector('.cm-strong');
        const em=cell?.querySelector('.cm-em');
        const strike=cell?.querySelector('.cm-strikethrough');
        const highlight=cell?.querySelector('.cm-highlight');
        const link=cell?.querySelector('.cm-link');
        const codeStyle=inline?getComputedStyle(inline):null;
        const strongStyle=strong?getComputedStyle(strong):null;
        const emStyle=em?getComputedStyle(em):null;
        const strikeStyle=strike?getComputedStyle(strike):null;
        const highlightStyle=highlight?getComputedStyle(highlight):null;
        const linkStyle=link?getComputedStyle(link):null;
        return{
          editable:cell?.contentEditable||'',
          source:cell?.textContent||'',
          inlineText:inline?.textContent||'',
          code:{
            color:codeStyle?.color||'',
            background:codeStyle?.backgroundColor||'',
            fontSize:codeStyle?.fontSize||'',
            radius:codeStyle?.borderTopLeftRadius||'',
            paddingTop:codeStyle?.paddingTop||'',
            paddingRight:codeStyle?.paddingRight||'',
          },
          strong:{text:strong?.textContent||'',color:strongStyle?.color||'',weight:strongStyle?.fontWeight||''},
          em:{text:em?.textContent||'',color:emStyle?.color||''},
          strike:{text:strike?.textContent||'',color:strikeStyle?.color||''},
          highlight:{text:highlight?.textContent||'',color:highlightStyle?.color||'',background:highlightStyle?.backgroundColor||''},
          link:{text:link?.textContent||'',color:linkStyle?.color||''},
        };
      });
      assert.equal(editing.editable,'true',JSON.stringify(editing));
      assert.equal(editing.source,rich,JSON.stringify(editing));
      assert.equal(editing.inlineText,'`index.html`',JSON.stringify(editing));
      assert.deepEqual(editing.code,{
        color:idle.codeColor,
        background:idle.codeBackground,
        fontSize:idle.codeFontSize,
        radius:idle.codeRadius,
        paddingTop:idle.codePaddingTop,
        paddingRight:idle.codePaddingRight,
      },JSON.stringify({idle,editing}));
      assert.equal(editing.strong.text,'Strong',JSON.stringify(editing));
      assert.equal(editing.strong.color,'rgb(73, 161, 92)',JSON.stringify(editing));
      assert.equal(editing.em.text,'Em',JSON.stringify(editing));
      assert.equal(editing.em.color,'rgb(86, 118, 207)',JSON.stringify(editing));
      assert.equal(editing.strike.text,'Strike',JSON.stringify(editing));
      assert.equal(editing.strike.color,'rgb(173, 96, 189)',JSON.stringify(editing));
      assert.equal(editing.highlight.text,'Mark',JSON.stringify(editing));
      assert.equal(editing.highlight.background,'rgb(78, 65, 111)',JSON.stringify(editing));
      assert.equal(editing.highlight.color,'rgb(244, 244, 244)',JSON.stringify(editing));
      assert.equal(editing.link.text,'Link',JSON.stringify(editing));
      assert.equal(editing.link.color,'rgb(223, 136, 54)',JSON.stringify(editing));

      await page.locator('.cm-table-cell-editor').filter({hasText:'ok'}).first().click();await sleep(80);
      assert.equal(await value(),source);
    }finally{
      await page.evaluate(()=>{
        const link=document.querySelector('#community-theme');
        link.disabled=true;
        link.removeAttribute('href');
      });
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await sleep(50);
    }
  });

  await check('Table Surface v2 materializes a pre-registered offscreen table without raw-source fallback',async()=>{
    const prefix=Array.from({length:8000},(_,i)=>`long document line ${i} plain text`).join('\n');
    const table='| Late A | Late B | Late evidence path |\n| --- | --- | --- |\n| alpha | done | app/src/late/table-surface.js |\n| beta | open | docs/late/table-contract.md |\n';
    const source=prefix+'\n\n'+table+'\n';
    const tablePos=source.indexOf('| Late A |');
    try{
      await open('A.md');await mode('live');
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),source);
      await page.evaluate(pos=>window.__testEditor.scrollToPosition(pos),tablePos);
      await page.waitForFunction(()=>document.querySelector('.cm-table-widget'),null,{timeout:7000});
      await sleep(160);
      const result=await page.evaluate(()=>({
        widgetCount:document.querySelectorAll('.cm-table-widget').length,
        widgetText:document.querySelector('.cm-table-widget')?.innerText||'',
        rawVisible:[...document.querySelectorAll('.cm-line')].some(line=>(line.innerText||'').includes('| Late A | Late B | Late evidence path |')),
        balanced:document.querySelector('.cm-live-table-element')?.dataset.columnLayout||'',
        colCount:document.querySelectorAll('.cm-live-table-element colgroup[data-table-layout="balanced"] col').length,
      }));
      assert.equal(result.widgetCount,1,JSON.stringify(result));
      assert.match(result.widgetText,/Late A/);
      assert.match(result.widgetText,/Late evidence path/);
      assert.equal(result.rawVisible,false,JSON.stringify(result));
      assert.equal(result.balanced,'balanced',JSON.stringify(result));
      assert.equal(result.colCount,3,JSON.stringify(result));
    }finally{
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await page.evaluate(()=>window.__testEditor.scrollToPosition(0));
      await sleep(80);
    }
  });
}
