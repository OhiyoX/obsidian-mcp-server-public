// Table Surface v2 stable geometry while scrolling and exposing tables.
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function registerTablesScrollChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('Table Surface v2.11 primes final geometry before the first observable table frame',async()=>{
    const prefix=Array.from({length:3600},(_,i)=>`mount-prefix-${i} ordinary prose`).join('\n');
    const table=[
      '| 能力 | 状态 | 主要实现/运行证据 | 测试/发布证据 | 当前边界 |',
      '|---|---|---|---|---|',
      '| Markdown 笔记读写、frontmatter、tags、section | Implemented | `.1` 直接源码：`app/src/tools/notes.js`, `app/src/obsidian.js`, `app/src/vault.js` | `.1` tool-contract 等测试 | Core 仍以 primary Vault 为核心 |',
      '| 文件/附件/Canvas/ZIP/断点上传 | Implemented | `.1` 直接源码：`app/src/tools/files.js`, `file-transfer.js` | `.1` file-transfer tests | 本地 Vault 文件系统 |',
      '| 搜索与 Obsidian 查询语法 | Implemented | `.1` 直接源码：`tools/search.js`, `search/*`, `vault-index.js` | `.1` search tests | path-based index |',
      '| Recall / embedding hybrid retrieval | Implemented | `.1` 直接源码：`retrieval.js`, `embeddings.js`, `tools/intelligence.js` | `.1` retrieval/embedding tests | secondary Web Vault 无同等 semantic backend |',
      '| backlinks / graph / related / link health | Implemented | `.1` 直接源码：`tools/links.js`, `tools/intelligence.js`, `vault-index.js` | `.1` link tests | 依赖 path/link resolver |',
    ].join('\n')+'\n';
    const suffix=Array.from({length:1200},(_,i)=>`mount-suffix-${i} ordinary prose`).join('\n');
    const source=prefix+'\n\n'+table+'\n'+suffix+'\n';
    const tablePos=source.indexOf('| 能力 | 状态 |');
    try{
      await open('A.md');await mode('live');
      const prep=await page.evaluate(({text,pos})=>{
        window.__testEditor.setValue(text,{resetHistory:true,silent:true});
        const view=window.__testEditor._view;
        const rect=view.scrollDOM.getBoundingClientRect();
        const preBlock=view.lineBlockAt(Math.min(pos,view.state.doc.length));
        const trace={
          pre:{
            blockTop:preBlock.top,
            blockHeight:preBlock.height,
            estimatedHeight:preBlock.widget?.estimatedHeight??null,
          },
          mount:null,
          frames:[],
        };
        window.__tableFirstFrameTrace=trace;
        const sample=()=>{
          const widget=document.querySelector('.cm-table-widget');
          if(!widget||trace.mount)return;
          const viewport=widget.querySelector('.cm-table-viewport');
          const block=view.lineBlockAt(Math.min(pos,view.state.doc.length));
          const snapshot=()=>({
            scrollTop:view.scrollDOM.scrollTop,
            blockTop:block.top,
            blockHeight:block.height,
            tableTop:widget.getBoundingClientRect().top,
            tableHeight:widget.getBoundingClientRect().height,
            signature:viewport?.dataset.tableLayoutSignature||'',
            colgroup:Boolean(widget.querySelector('colgroup[data-table-layout="balanced"]')),
          });
          trace.mount=snapshot();
          let frame=0;
          const next=()=>{
            const currentBlock=view.lineBlockAt(Math.min(pos,view.state.doc.length));
            trace.frames.push({
              frame,
              scrollTop:view.scrollDOM.scrollTop,
              blockTop:currentBlock.top,
              blockHeight:currentBlock.height,
              tableTop:widget.getBoundingClientRect().top,
              tableHeight:widget.getBoundingClientRect().height,
              signature:viewport?.dataset.tableLayoutSignature||'',
            });
            frame+=1;
            if(frame<5)requestAnimationFrame(next);
          };
          requestAnimationFrame(next);
        };
        const observer=new MutationObserver(sample);
        observer.observe(view.contentDOM,{childList:true,subtree:true});
        window.__tableFirstFrameCleanup=()=>observer.disconnect();
        sample();
        return{
          x:(rect.left+rect.right)/2,
          y:(rect.top+rect.bottom)/2,
          viewportHeight:view.scrollDOM.clientHeight,
        };
      },{text:source,pos:tablePos});

      await page.mouse.move(prep.x,prep.y);
      let mounted=false;
      for(let turn=0;turn<28&&!mounted;turn+=1){
        const state=await page.evaluate(pos=>{
          const view=window.__testEditor._view;
          const block=view.lineBlockAt(Math.min(pos,view.state.doc.length));
          return{
            scrollTop:view.scrollDOM.scrollTop,
            blockTop:block.top,
            viewportHeight:view.scrollDOM.clientHeight,
          };
        },tablePos);
        const target=Math.max(0,state.blockTop-state.viewportHeight*0.45);
        const remaining=target-state.scrollTop;
        const delta=remaining>0
          ? Math.min(8000,Math.max(480,remaining*0.72))
          : -Math.min(1600,Math.max(240,Math.abs(remaining)+240));
        await page.mouse.wheel(0,delta);
        mounted=await page.evaluate(()=>Boolean(window.__tableFirstFrameTrace?.mount));
      }
      assert.equal(mounted,true,JSON.stringify(await page.evaluate(()=>window.__tableFirstFrameTrace)));
      const trace=await page.evaluate(async()=>{
        for(let frame=0;frame<6;frame+=1)await new Promise(resolve=>requestAnimationFrame(resolve));
        return window.__tableFirstFrameTrace;
      });
      assert.ok(trace.mount?.signature,JSON.stringify(trace));
      assert.equal(trace.mount?.colgroup,true,JSON.stringify(trace));
      assert.ok(Number(trace.pre?.estimatedHeight)>0,JSON.stringify(trace));
      assert.ok(
        Math.abs(Number(trace.pre?.blockHeight)-Number(trace.mount?.blockHeight))<=2,
        JSON.stringify(trace),
      );
      assert.equal(trace.frames.length,5,JSON.stringify(trace));
      const painted=[trace.mount,...trace.frames].filter(sample=>(
        sample?.signature && Number(sample?.tableHeight)>0
      ));
      assert.ok(painted.length>=2,JSON.stringify(trace));
      assert.ok(painted.every(sample=>sample.signature===trace.mount.signature),JSON.stringify(trace));
      const spread=(key)=>{
        const values=painted.map(sample=>sample?.[key]).filter(Number.isFinite);
        return values.length?Math.max(...values)-Math.min(...values):0;
      };
      // Playwright wheel input may keep moving the compositor for a few frames
      // after the DOM mutation that exposes the widget, so scrollTop/tableTop
      // are not valid causal signals here. This check isolates the structural
      // contract: every observable table frame must already have one stable
      // balanced layout and block height. The separate trusted-wheel regression
      // owns end-to-end scroll stability once input has settled.
      assert.ok(spread('blockHeight')<=2,JSON.stringify(trace));
      assert.ok(spread('tableHeight')<=2,JSON.stringify(trace));
    }finally{
      await page.evaluate(()=>window.__tableFirstFrameCleanup?.()).catch(()=>{});
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await page.evaluate(()=>window.__testEditor.scrollToPosition(0));
      await sleep(80);
    }
  });


  await check('Table Surface v2.11 stays stable under repeated trusted fast-wheel input across a table boundary',async()=>{
    const prefix=Array.from({length:3600},(_,i)=>`wheel-prefix-${i} ordinary prose`).join('\n');
    const table=[
      '| 能力 | 状态 | 主要实现/运行证据 | 测试/发布证据 | 当前边界 |',
      '|---|---|---|---|---|',
      '| Markdown 笔记读写、frontmatter、tags、section | Implemented | `.1` 直接源码：`app/src/tools/notes.js`, `app/src/obsidian.js`, `app/src/vault.js` | `.1` tool-contract 等测试 | Core 仍以 primary Vault 为核心 |',
      '| 文件/附件/Canvas/ZIP/断点上传 | Implemented | `.1` 直接源码：`app/src/tools/files.js`, `file-transfer.js` | `.1` file-transfer tests | 本地 Vault 文件系统 |',
      '| 搜索与 Obsidian 查询语法 | Implemented | `.1` 直接源码：`tools/search.js`, `search/*`, `vault-index.js` | `.1` search tests | path-based index |',
      '| Recall / embedding hybrid retrieval | Implemented | `.1` 直接源码：`retrieval.js`, `embeddings.js`, `tools/intelligence.js` | `.1` retrieval/embedding tests | secondary Web Vault 无同等 semantic backend |',
      '| backlinks / graph / related / link health | Implemented | `.1` 直接源码：`tools/links.js`, `tools/intelligence.js`, `vault-index.js` | `.1` link tests | 依赖 path/link resolver |',
    ].join('\n')+'\n';
    const suffix=Array.from({length:1400},(_,i)=>`wheel-suffix-${i} ordinary prose`).join('\n');
    const source=prefix+'\n\n'+table+'\n'+suffix+'\n';
    const tablePos=source.indexOf('| 能力 | 状态 |');
    try{
      await open('A.md');await mode('live');
      const prep=await page.evaluate(({text,pos})=>{
        window.__testEditor.setValue(text,{resetHistory:true,silent:true});
        const view=window.__testEditor._view;
        const block=view.lineBlockAt(pos);
        const rect=view.scrollDOM.getBoundingClientRect();
        window.__fastWheelTrace={wheel:[],scroll:[]};
        const trace=window.__fastWheelTrace;
        const onWheel=(event)=>{
          trace.wheel.push({time:performance.now(),deltaY:event.deltaY,scrollTop:view.scrollDOM.scrollTop});
        };
        const onScroll=()=>{
          const current=view.lineBlockAt(Math.min(pos,view.state.doc.length));
          trace.scroll.push({
            time:performance.now(),
            scrollTop:view.scrollDOM.scrollTop,
            blockTop:current.top,
            blockHeight:current.height,
            domWidget:Boolean(document.querySelector('.cm-table-widget')),
          });
        };
        view.scrollDOM.addEventListener('wheel',onWheel,{capture:true});
        view.scrollDOM.addEventListener('scroll',onScroll);
        window.__fastWheelCleanup=()=>{
          view.scrollDOM.removeEventListener('wheel',onWheel,true);
          view.scrollDOM.removeEventListener('scroll',onScroll);
        };
        return{
          x:(rect.left+rect.right)/2,
          y:(rect.top+rect.bottom)/2,
          tableTop:block.top,
          viewportHeight:view.scrollDOM.clientHeight,
          estimate:block.widget?.estimatedHeight??null,
        };
      },{text:source,pos:tablePos});

      await page.mouse.move(prep.x,prep.y);
      let reached=false;
      const wheelPlan=[];
      for(let turn=0;turn<28;turn+=1){
        const state=await page.evaluate(pos=>{
          const view=window.__testEditor._view;
          const block=view.lineBlockAt(Math.min(pos,view.state.doc.length));
          return{
            scrollTop:view.scrollDOM.scrollTop,
            blockTop:block.top,
            viewportHeight:view.scrollDOM.clientHeight,
            domWidget:Boolean(document.querySelector('.cm-table-widget')),
          };
        },tablePos);
        if(state.domWidget){reached=true;break;}
        // Stay deliberately fast while far away, then taper only enough to
        // guarantee that the wheel sequence actually crosses the table instead
        // of jumping completely past its virtualization window.
        const target=Math.max(0,state.blockTop-state.viewportHeight*0.45);
        const remaining=target-state.scrollTop;
        if(remaining<=0){
          await page.mouse.wheel(0,-Math.min(1600,Math.max(240,Math.abs(remaining)+240)));
        }else{
          const delta=Math.min(8000,Math.max(480,remaining*0.72));
          wheelPlan.push({turn,...state,target,remaining,delta});
          await page.mouse.wheel(0,delta);
        }
        await sleep(18);
        reached=await page.evaluate(()=>Boolean(document.querySelector('.cm-table-widget')));
        if(reached)break;
      }
      assert.equal(reached,true,JSON.stringify({prep,wheelPlan,trace:await page.evaluate(()=>window.__fastWheelTrace)}));

      const settle=await page.evaluate(async pos=>{
        const view=window.__testEditor._view;
        const values=[];
        for(let frame=0;frame<10;frame+=1){
          await new Promise(resolve=>requestAnimationFrame(resolve));
          const block=view.lineBlockAt(Math.min(pos,view.state.doc.length));
          const widget=document.querySelector('.cm-table-widget');
          values.push({
            frame,
            scrollTop:view.scrollDOM.scrollTop,
            blockTop:block.top,
            blockHeight:block.height,
            tableTop:widget?.getBoundingClientRect().top??null,
            signature:widget?.querySelector('.cm-table-viewport')?.dataset.tableLayoutSignature||'',
          });
        }
        return values;
      },tablePos);
      const trace=await page.evaluate(()=>window.__fastWheelTrace);
      assert.ok(trace.wheel.length>=2,JSON.stringify({prep,trace,settle}));
      assert.ok(settle[0]?.signature,JSON.stringify({prep,trace,settle}));
      const spread=(key)=>{
        const nums=settle.map(x=>x[key]).filter(Number.isFinite);
        return nums.length?Math.max(...nums)-Math.min(...nums):0;
      };
      // No user input occurs during these ten frames. Any movement here is a
      // height-map/viewport correction caused by table materialization.
      assert.ok(spread('scrollTop')<=2,JSON.stringify({prep,trace,settle}));
      assert.ok(spread('blockTop')<=2,JSON.stringify({prep,trace,settle}));
      assert.ok(spread('blockHeight')<=2,JSON.stringify({prep,trace,settle}));
      assert.ok(spread('tableTop')<=2,JSON.stringify({prep,trace,settle}));
    }finally{
      await page.evaluate(()=>window.__fastWheelCleanup?.()).catch(()=>{});
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await page.evaluate(()=>window.__testEditor.scrollToPosition(0));
      await sleep(80);
    }
  });

  await check('Table Surface v2.10 stays stable while local scrolling first exposes an offscreen table',async()=>{
    const prefix=Array.from({length:3200},(_,i)=>`stable-scroll-prefix-${i} ordinary prose`).join('\n');
    const table=[
      '| 能力 | 状态 | 主要实现/运行证据 | 测试/发布证据 | 当前边界 |',
      '|---|---|---|---|---|',
      '| Markdown 笔记读写、frontmatter、tags、section | Implemented | `.1` 直接源码：`app/src/tools/notes.js`, `app/src/obsidian.js`, `app/src/vault.js` | `.1` tool-contract 等测试 | Core 仍以 primary Vault 为核心 |',
      '| 文件/附件/Canvas/ZIP/断点上传 | Implemented | `.1` 直接源码：`app/src/tools/files.js`, `file-transfer.js` | `.1` file-transfer tests | 本地 Vault 文件系统 |',
      '| 搜索与 Obsidian 查询语法 | Implemented | `.1` 直接源码：`tools/search.js`, `search/*`, `vault-index.js` | `.1` search tests | path-based index |',
      '| Recall / embedding hybrid retrieval | Implemented | `.1` 直接源码：`retrieval.js`, `embeddings.js`, `tools/intelligence.js` | `.1` retrieval/embedding tests | secondary Web Vault 无同等 semantic backend |',
      '| backlinks / graph / related / link health | Implemented | `.1` 直接源码：`tools/links.js`, `tools/intelligence.js`, `vault-index.js` | `.1` link tests | 依赖 path/link resolver |',
    ].join('\n')+'\n';
    const suffix=Array.from({length:900},(_,i)=>`stable-scroll-suffix-${i} ordinary prose`).join('\n');
    const source=prefix+'\n\n'+table+'\n'+suffix+'\n';
    const tablePos=source.indexOf('| 能力 | 状态 |');
    try{
      await open('A.md');await mode('live');
      const before=await page.evaluate(({text,pos})=>{
        window.__testEditor.setValue(text,{resetHistory:true,silent:true});
        const view=window.__testEditor._view;
        const block=view.lineBlockAt(pos);
        return{
          widget:Boolean(block.widget),
          estimatedHeight:block.widget?.estimatedHeight??null,
          blockHeight:block.height,
          blockTop:block.top,
          scrollTop:view.scrollDOM.scrollTop,
          contentHeight:view.contentHeight,
        };
      },{text:source,pos:tablePos});

      // A structural replacement that can change block height must already be
      // represented in CodeMirror's height map before the viewport reaches it.
      assert.equal(before.widget,true,JSON.stringify(before));
      assert.ok(Number(before.estimatedHeight)>0,JSON.stringify(before));

      const crossing=await page.evaluate(async pos=>{
        const view=window.__testEditor._view;
        const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
        // First settle the ordinary long-document height map several viewports
        // before the table. This deliberately removes CodeMirror's generic
        // first-jump correction for distant prose from the table-specific
        // assertion below.
        const initialBlock=view.lineBlockAt(pos);
        const warmTarget=Math.max(
          0,
          initialBlock.top-view.scrollDOM.clientHeight*4.5,
        );
        view.scrollDOM.scrollTop=warmTarget;
        view.scrollDOM.dispatchEvent(new Event('scroll'));
        for(let frame=0;frame<6;frame+=1)await nextFrame();

        const warm={
          scrollTop:view.scrollDOM.scrollTop,
          blockTop:view.lineBlockAt(pos).top,
          blockHeight:view.lineBlockAt(pos).height,
          domWidget:Boolean(document.querySelector('.cm-table-widget')),
        };

        const steps=[];
        const stepPx=Math.max(96,Math.min(180,view.scrollDOM.clientHeight*0.22));
        for(let index=0;index<32;index+=1){
          const requested=view.scrollDOM.scrollTop+stepPx;
          view.scrollDOM.scrollTop=requested;
          const assigned=view.scrollDOM.scrollTop;
          view.scrollDOM.dispatchEvent(new Event('scroll'));
          await nextFrame();
          const afterFirstFrame=view.scrollDOM.scrollTop;
          await nextFrame();
          const afterSecondFrame=view.scrollDOM.scrollTop;
          const block=view.lineBlockAt(pos);
          const widget=document.querySelector('.cm-table-widget');
          const viewport=widget?.querySelector('.cm-table-viewport');
          steps.push({
            index,
            requested,
            assigned,
            afterFirstFrame,
            afterSecondFrame,
            firstFrameCorrection:afterFirstFrame-assigned,
            secondFrameCorrection:afterSecondFrame-afterFirstFrame,
            blockTop:block.top,
            blockHeight:block.height,
            domWidget:Boolean(widget),
            rawVisible:[...document.querySelectorAll('.cm-line')].some(line=>(line.textContent||'').includes('| 能力 | 状态 | 主要实现/运行证据 |')),
            layoutSignature:viewport?.dataset.tableLayoutSignature||'',
            tableTop:widget?.getBoundingClientRect().top??null,
          });
          if(widget)break;
        }

        const firstVisibleIndex=steps.findIndex(step=>step.domWidget);
        const firstVisible=firstVisibleIndex>=0?steps[firstVisibleIndex]:null;
        const settle=[];
        if(firstVisible){
          for(let frame=0;frame<6;frame+=1){
            await nextFrame();
            const block=view.lineBlockAt(pos);
            const widget=document.querySelector('.cm-table-widget');
            settle.push({
              frame,
              scrollTop:view.scrollDOM.scrollTop,
              blockTop:block.top,
              blockHeight:block.height,
              tableTop:widget?.getBoundingClientRect().top??null,
              layoutSignature:widget?.querySelector('.cm-table-viewport')?.dataset.tableLayoutSignature||'',
            });
          }
        }
        return {warm,stepPx,steps,firstVisibleIndex,firstVisible,settle};
      },tablePos);

      assert.equal(crossing.warm.domWidget,false,JSON.stringify({before,crossing}));
      assert.ok(crossing.firstVisible,JSON.stringify({before,crossing}));
      assert.ok(crossing.steps.every(step=>!step.rawVisible),JSON.stringify({before,crossing}));
      assert.ok(crossing.firstVisible.layoutSignature,JSON.stringify({before,crossing}));
      // This is the user-visible contract: while normal wheel-sized movement
      // crosses into the table, materializing/measuring the block must not add
      // a second vertical correction on either the first or following frame.
      assert.ok(Math.abs(crossing.firstVisible.firstFrameCorrection)<=2,JSON.stringify({before,crossing}));
      assert.ok(Math.abs(crossing.firstVisible.secondFrameCorrection)<=2,JSON.stringify({before,crossing}));
      const spread=(key,values=crossing.settle)=>{
        if(!values.length)return 0;
        return Math.max(...values.map(sample=>sample[key]))-Math.min(...values.map(sample=>sample[key]));
      };
      assert.ok(spread('scrollTop')<=2,JSON.stringify({before,crossing}));
      assert.ok(spread('blockTop')<=2,JSON.stringify({before,crossing}));
      assert.ok(spread('blockHeight')<=2,JSON.stringify({before,crossing}));
      assert.ok(spread('tableTop')<=2,JSON.stringify({before,crossing}));
    }finally{
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await page.evaluate(()=>window.__testEditor.scrollToPosition(0));
      await sleep(80);
    }
  });
}
