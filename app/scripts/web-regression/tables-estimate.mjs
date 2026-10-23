// Table Surface v2 offscreen block-height estimate contract: the estimate must
// be measured from the owning editor's themed DOM and must never be shared
// between simultaneous editors. Extracted as its own cohesive module so the
// scrolling module stays inside the line budget; registered by
// scripts/web-regression.mjs.
import assert from 'node:assert/strict';

export async function registerTablesEstimateChecks(ctx) {
  const { check, sleep, page, open, mode, fixture } = ctx;
  await check('Table Surface v2.11 estimate tracks a live theme change instead of a fixed pixel heuristic',async()=>{
    // Negative control for the first-frame geometry contract: the offscreen
    // height-map estimate must be a real measurement of the themed DOM. A
    // fixed pixel heuristic cannot follow a table-font change, so the
    // pre-scroll block height would disagree with the first painted table.
    const table=[
      '| 能力 | 状态 | 主要实现/运行证据 | 测试/发布证据 | 当前边界 |',
      '|---|---|---|---|---|',
      '| Markdown 笔记读写、frontmatter、tags、section | Implemented | `.1` 直接源码：`app/src/tools/notes.js`, `app/src/obsidian.js`, `app/src/vault.js` | `.1` tool-contract 等测试 | Core 仍以 primary Vault 为核心 |',
      '| 文件/附件/Canvas/ZIP/断点上传 | Implemented | `.1` 直接源码：`app/src/tools/files.js`, `file-transfer.js` | `.1` file-transfer tests | 本地 Vault 文件系统 |',
      '| 搜索与 Obsidian 查询语法 | Implemented | `.1` 直接源码：`tools/search.js`, `search/*`, `vault-index.js` | `.1` search tests | path-based index |',
      '| Recall / embedding hybrid retrieval | Implemented | `.1` 直接源码：`retrieval.js`, `embeddings.js`, `tools/intelligence.js` | `.1` retrieval/embedding tests | secondary Web Vault 无同等 semantic backend |',
      '| backlinks / graph / related / link health | Implemented | `.1` 直接源码：`tools/links.js`, `tools/intelligence.js`, `vault-index.js` | `.1` link tests | 依赖 path/link resolver |',
    ].join('\n')+'\n';
    const prefix=Array.from({length:2400},(_,i)=>`estimate-theme-prefix-${i} ordinary prose`).join('\n');
    const suffix=Array.from({length:600},(_,i)=>`estimate-theme-suffix-${i} ordinary prose`).join('\n');
    const source=prefix+'\n\n'+table+'\n'+suffix+'\n';
    const tablePos=source.indexOf('| 能力 | 状态 |');
    const measure=()=>page.evaluate(async({text,pos})=>{
      window.__testEditor.setValue(text,{resetHistory:true,silent:true});
      const view=window.__testEditor._view;
      const preBlock=view.lineBlockAt(Math.min(pos,view.state.doc.length));
      const preHeight=preBlock.height;
      const preEstimate=preBlock.widget?.estimatedHeight??null;
      const target=Math.max(0,preBlock.top-view.scrollDOM.clientHeight*0.45);
      view.scrollDOM.scrollTop=target;
      view.scrollDOM.dispatchEvent(new Event('scroll'));
      for(let turn=0;turn<40;turn+=1){
        await new Promise(resolve=>requestAnimationFrame(resolve));
        if(document.querySelector('.cm-table-widget'))break;
      }
      await new Promise(resolve=>requestAnimationFrame(resolve));
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const block=view.lineBlockAt(Math.min(pos,view.state.doc.length));
      const widget=document.querySelector('.cm-table-widget');
      const editor=widget?.querySelector('.cm-table-cell-editor');
      return{
        preHeight,
        preEstimate,
        mountHeight:block.height,
        widgetHeight:widget?widget.getBoundingClientRect().height:0,
        cellFont:editor?getComputedStyle(editor).fontSize:null,
        hasWidget:Boolean(widget),
      };
    },{text:source,pos:tablePos});
    try{
      await open('A.md');await mode('live');
      const base=await measure();
      await page.evaluate(()=>{
        const style=document.createElement('style');
        style.id='estimate-theme-override';
        style.textContent='.markdown-source-view.mod-cm6.is-live-preview{--table-text-size:22px}';
        document.head.append(style);
      });
      await sleep(120);
      const themed=await measure();
      assert.ok(base.hasWidget&&themed.hasWidget,JSON.stringify({base,themed}));
      assert.ok(Math.abs(base.preHeight-base.mountHeight)<=2,JSON.stringify({base,themed}));
      assert.ok(Math.abs(themed.preHeight-themed.mountHeight)<=2,JSON.stringify({base,themed}));
      assert.ok(Math.abs(base.preHeight-base.widgetHeight)<=2,JSON.stringify({base,themed}));
      assert.ok(Math.abs(themed.preHeight-themed.widgetHeight)<=2,JSON.stringify({base,themed}));
      assert.equal(themed.cellFont,'22px',JSON.stringify({base,themed}));
      assert.ok(
        Math.abs(themed.mountHeight-base.mountHeight)>2,
        `theme change must alter the real table height: ${JSON.stringify({base,themed})}`,
      );
    }finally{
      await page.evaluate(()=>document.getElementById('estimate-theme-override')?.remove());
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await page.evaluate(()=>window.__testEditor.scrollToPosition(0));
      await sleep(120);
    }
  });


  await check('Table Surface v2.11 keeps two simultaneous editors independent across fonts, widths and destruction order',async()=>{
    // Each table model must be measured against the EditorView that owns it:
    // a table in editor A must never reuse editor B's host, font or width, and
    // destroying/reconfiguring B must not degrade A to the fixed estimate.
    const table=[
      '| 能力 | 状态 | 主要实现/运行证据 | 测试/发布证据 | 当前边界 |',
      '|---|---|---|---|---|',
      '| Markdown 笔记读写、frontmatter、tags、section | Implemented | `.1` 直接源码：`app/src/tools/notes.js`, `app/src/obsidian.js`, `app/src/vault.js` | `.1` tool-contract 等测试 | Core 仍以 primary Vault 为核心 |',
      '| 文件/附件/Canvas/ZIP/断点上传 | Implemented | `.1` 直接源码：`app/src/tools/files.js`, `file-transfer.js` | `.1` file-transfer tests | 本地 Vault 文件系统 |',
      '| 搜索与 Obsidian 查询语法 | Implemented | `.1` 直接源码：`tools/search.js`, `search/*`, `vault-index.js` | `.1` search tests | path-based index |',
      '| Recall / embedding hybrid retrieval | Implemented | `.1` 直接源码：`retrieval.js`, `embeddings.js`, `tools/intelligence.js` | `.1` retrieval tests | secondary Web Vault 无同等 semantic backend |',
    ].join('\n')+'\n';
    const prefix=Array.from({length:1200},(_,i)=>`two-editor-prefix-${i} ordinary prose`).join('\n');
    const suffix=Array.from({length:300},(_,i)=>`two-editor-suffix-${i} ordinary prose`).join('\n');
    const source=prefix+'\n\n'+table+'\n'+suffix+'\n';
    const tablePos=source.indexOf('| 能力 | 状态 |');
    const setup=await page.evaluate(({source,tablePos})=>{
      const original=window.__testEditor;
      const style=document.createElement('style');
      style.id='two-editor-style';
      style.textContent=[
        '.two-editor-host{height:360px;overflow:hidden;margin:6px 0;border:1px solid #444}',
        '#two-editor-a{--table-text-size:15px;--line-width:640px;width:900px}',
        '#two-editor-b{--table-text-size:29px;--line-width:340px;width:520px}',
      ].join('\n');
      document.head.append(style);
      const makeHost=(id)=>{
        const host=document.createElement('div');
        host.id=id;
        host.className='editor markdown-source-view mod-cm6 cm-s-obsidian is-readable-line-width is-live-preview two-editor-host';
        document.body.append(host);
        return host;
      };
      const hostA=makeHost('two-editor-a');
      const hostB=makeHost('two-editor-b');
      const editorA=window.createObsidianEditor(hostA,()=>{});
      editorA.setMode('live');
      const editorB=window.createObsidianEditor(hostB,()=>{});
      editorB.setMode('live');
      const measurePre=(editor)=>{
        editor.setValue(source,{resetHistory:true,silent:true});
        const view=editor._view;
        const block=view.lineBlockAt(Math.min(tablePos,view.state.doc.length));
        return{
          blockHeight:block.height,
          estimate:block.widget?.estimatedHeight??null,
          viewBound:block.widget?.model?.measurementContext?.view===view,
          top:block.top,
        };
      };
      const preA=measurePre(editorA);
      const preB=measurePre(editorB);
      for(const editor of[editorA,editorB]){
        const view=editor._view;
        const block=view.lineBlockAt(Math.min(tablePos,view.state.doc.length));
        view.scrollDOM.scrollTop=Math.max(0,block.top-view.scrollDOM.clientHeight*0.45);
        view.scrollDOM.dispatchEvent(new Event('scroll'));
      }
      window.__twoEditors={original,style,hostA,hostB,editorA,editorB,source,tablePos};
      return{preA,preB};
    },{source,tablePos});
    try{
      await sleep(220);
      const mounted=await page.evaluate(()=>{
        const s=window.__twoEditors;
        const read=(editor)=>{
          const view=editor._view;
          const block=view.lineBlockAt(Math.min(s.tablePos,view.state.doc.length));
          const widget=view.contentDOM.querySelector('.cm-table-widget');
          return{blockHeight:block.height,widgetHeight:widget?widget.getBoundingClientRect().height:0,hasWidget:Boolean(widget)};
        };
        return{a:read(s.editorA),b:read(s.editorB)};
      });
      assert.equal(setup.preA.viewBound,true,JSON.stringify({setup,mounted}));
      assert.equal(setup.preB.viewBound,true,JSON.stringify({setup,mounted}));
      assert.ok(mounted.a.hasWidget&&mounted.b.hasWidget,JSON.stringify({setup,mounted}));
      assert.ok(Math.abs(setup.preA.blockHeight-mounted.a.blockHeight)<=2,JSON.stringify({setup,mounted}));
      assert.ok(Math.abs(setup.preB.blockHeight-mounted.b.blockHeight)<=2,JSON.stringify({setup,mounted}));
      assert.ok(Math.abs(Number(setup.preA.estimate)-mounted.a.blockHeight)<=2,JSON.stringify({setup,mounted}));
      assert.ok(Math.abs(Number(setup.preB.estimate)-mounted.b.blockHeight)<=2,JSON.stringify({setup,mounted}));
      assert.ok(
        Math.abs(mounted.a.blockHeight-mounted.b.blockHeight)>20,
        `editors with different fonts must not share a measurement: ${JSON.stringify({setup,mounted})}`,
      );
      // Destruction order 1: destroy B, editor A must still measure its own host.
      const afterDestroyB=await page.evaluate(({source,tablePos})=>{
        const s=window.__twoEditors;
        s.editorB.destroy();
        s.editorB=null;
        s.editorA.setValue(source,{resetHistory:true,silent:true});
        const view=s.editorA._view;
        const block=view.lineBlockAt(Math.min(tablePos,view.state.doc.length));
        return{blockHeight:block.height,estimate:block.widget?.estimatedHeight??null,viewBound:block.widget?.model?.measurementContext?.view===view};
      },{source,tablePos});
      assert.equal(afterDestroyB.viewBound,true,JSON.stringify({afterDestroyB}));
      assert.ok(Math.abs(afterDestroyB.blockHeight-mounted.a.blockHeight)<=2,JSON.stringify({afterDestroyB,mounted}));
      // Destruction order 2: recreate B, destroy A, editor B must still measure its own host.
      const afterDestroyA=await page.evaluate(({source,tablePos})=>{
        const s=window.__twoEditors;
        const editorB2=window.createObsidianEditor(s.hostB,()=>{});
        editorB2.setMode('live');
        s.editorA.destroy();
        s.editorA=null;
        editorB2.setValue(source,{resetHistory:true,silent:true});
        const view=editorB2._view;
        const block=view.lineBlockAt(Math.min(tablePos,view.state.doc.length));
        s.editorB2=editorB2;
        return{blockHeight:block.height,estimate:block.widget?.estimatedHeight??null,viewBound:block.widget?.model?.measurementContext?.view===view};
      },{source,tablePos});
      assert.equal(afterDestroyA.viewBound,true,JSON.stringify({afterDestroyA}));
      assert.ok(Math.abs(afterDestroyA.blockHeight-mounted.b.blockHeight)<=2,JSON.stringify({afterDestroyA,mounted}));
    }finally{
      await page.evaluate(()=>{
        const s=window.__twoEditors;
        if(!s)return;
        s.editorA?.destroy?.();
        s.editorB?.destroy?.();
        s.editorB2?.destroy?.();
        s.hostA?.remove?.();
        s.hostB?.remove?.();
        s.style?.remove?.();
        window.__testEditor=s.original;
        delete window.__twoEditors;
      });
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await page.evaluate(()=>window.__testEditor.scrollToPosition(0));
      await sleep(120);
    }
  });
}
