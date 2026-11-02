// Vault theme.css inheritance in Reader and Live.
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function registerThemeInheritanceChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('inline code inherits the real vault theme.css in Reader and Live',async()=>{
    const source='# Inline code theme\n\nUse `index.html` and `tools/sync-docs.mjs`.\n';
    const themeHref='/api/web/v1/theme.css?name=ThemeInheritanceProbe';
    try {
      await open('A.md');
      await mode('live');
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
      await sleep(60);

      await mode('preview');await sleep(60);
      const reader=await page.evaluate(()=>{
        const code=document.querySelector('#preview code');
        const rendered=document.querySelector('#preview .markdown-preview-view');
        const style=getComputedStyle(code);
        return{
          classes:rendered?.className||'',
          color:style.color,
          background:style.backgroundColor,
          fontSize:style.fontSize,
          radius:style.borderTopLeftRadius,
          paddingTop:style.paddingTop,
          paddingRight:style.paddingRight,
        };
      });

      await mode('live');await sleep(60);
      const live=await page.evaluate(()=>{
        const code=document.querySelector('.cm-live-inline-code');
        const style=getComputedStyle(code);
        return{
          classes:code?.className||'',
          color:style.color,
          background:style.backgroundColor,
          fontSize:style.fontSize,
          radius:style.borderTopLeftRadius,
          paddingTop:style.paddingTop,
          paddingRight:style.paddingRight,
        };
      });

      const expected={
        color:'rgb(121, 132, 143)',
        background:'rgb(41, 52, 63)',
        fontSize:'13px',
        radius:'11px',
        paddingTop:'3px',
        paddingRight:'7px',
      };
      assert.match(reader.classes,/\bmarkdown-rendered\b/,JSON.stringify(reader));
      assert.match(live.classes,/\bcm-inline-code\b/,JSON.stringify(live));
      for(const [field,value] of Object.entries(expected)){
        assert.equal(reader[field],value,JSON.stringify({reader,live,field}));
        assert.equal(live[field],value,JSON.stringify({reader,live,field}));
      }
    } finally {
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await page.evaluate(()=>{
        const link=document.querySelector('#community-theme');
        link.disabled=true;
        link.removeAttribute('href');
      });
      await sleep(40);
    }
  });
  await check('Reader table scroll viewport keeps one fixed side frame while content moves',async()=>{
    const source=`| ${Array.from({length:10},(_,i)=>`Column ${i+1}`).join(' | ')} |\n| ${Array(10).fill('---').join(' | ')} |\n| ${Array.from({length:10},(_,i)=>`frontend/features/reader-long-path-${i+1}.js`).join(' | ')} |`;
    const themeHref='/api/web/v1/theme.css?name=ThemeInheritanceProbe';
    try {
      await page.setViewportSize({width:1000,height:900});await sleep(80);
      await open('A.md');
      await mode('live');
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
      await mode('preview');await sleep(120);
      const before=await page.evaluate(()=>{
        const wrapper=document.querySelector('#preview .table-scroll');
        const table=wrapper?.querySelector('table');
        const first=table?.querySelector('tr > :first-child');
        const last=table?.querySelector('tr > :last-child');
        const ws=getComputedStyle(wrapper),ts=getComputedStyle(table),fs=getComputedStyle(first),ls=getComputedStyle(last);
        const w=wrapper.getBoundingClientRect(),t=table.getBoundingClientRect();
        return{
          overflow:wrapper?.dataset.tableOverflow,
          scrollWidth:wrapper?.scrollWidth||0,clientWidth:wrapper?.clientWidth||0,
          scrollLeft:wrapper?.scrollLeft||0,
          wrapper:{left:w.left,right:w.right,top:w.top,bottom:w.bottom,height:w.height},
          table:{left:t.left,right:t.right,top:t.top,bottom:t.bottom,height:t.height},
          wrapperLeft:ws.borderLeftWidth,wrapperRight:ws.borderRightWidth,
          wrapperLeftColor:ws.borderLeftColor,wrapperRightColor:ws.borderRightColor,
          tableLeft:ts.borderLeftWidth,tableRight:ts.borderRightWidth,
          firstLeft:fs.borderLeftWidth,lastRight:ls.borderRightWidth,
          firstShadow:fs.boxShadow,lastShadow:ls.boxShadow,
        };
      });
      assert.equal(before.overflow,'true',JSON.stringify(before));
      assert.ok(before.scrollWidth>before.clientWidth+10,JSON.stringify(before));
      assert.equal(before.wrapperLeft,'1px',JSON.stringify(before));
      assert.equal(before.wrapperRight,'1px',JSON.stringify(before));
      assert.equal(before.wrapperLeftColor,'rgb(109, 119, 129)',JSON.stringify(before));
      assert.equal(before.wrapperRightColor,'rgb(109, 119, 129)',JSON.stringify(before));
      assert.equal(before.tableLeft,'0px',JSON.stringify(before));
      assert.equal(before.tableRight,'0px',JSON.stringify(before));
      assert.equal(before.firstLeft,'0px',JSON.stringify(before));
      assert.equal(before.lastRight,'0px',JSON.stringify(before));
      assert.equal(before.firstShadow,'none',JSON.stringify(before));
      assert.equal(before.lastShadow,'none',JSON.stringify(before));
      assert.ok(Math.abs(before.wrapper.top-before.table.top)<=0.5,JSON.stringify(before));
      assert.ok(Math.abs(before.wrapper.bottom-before.table.bottom)<=0.5,JSON.stringify(before));
      assert.ok(Math.abs(before.wrapper.height-before.table.height)<=1,JSON.stringify(before));

      const after=await page.evaluate(()=>{
        const wrapper=document.querySelector('#preview .table-scroll');
        const table=wrapper.querySelector('table');
        wrapper.scrollLeft=Math.max(1,wrapper.scrollWidth-wrapper.clientWidth);
        const ws=getComputedStyle(wrapper),w=wrapper.getBoundingClientRect(),t=table.getBoundingClientRect();
        return{
          scrollLeft:wrapper.scrollLeft,
          wrapper:{left:w.left,right:w.right},
          table:{left:t.left,right:t.right},
          wrapperLeft:ws.borderLeftWidth,wrapperRight:ws.borderRightWidth,
        };
      });
      assert.ok(after.scrollLeft>0,JSON.stringify(after));
      assert.ok(Math.abs(after.wrapper.left-before.wrapper.left)<=0.5&&Math.abs(after.wrapper.right-before.wrapper.right)<=0.5,JSON.stringify({before,after}));
      assert.ok(after.table.left<before.table.left-10,JSON.stringify({before,after}));
      assert.equal(after.wrapperLeft,'1px',JSON.stringify(after));
      assert.equal(after.wrapperRight,'1px',JSON.stringify(after));
    } finally {
      await page.setViewportSize({width:1440,height:1000});await sleep(80);
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await page.evaluate(()=>{
        const link=document.querySelector('#community-theme');
        link.disabled=true;
        link.removeAttribute('href');
      });
      await sleep(40);
    }
  });
  await check('semantic Markdown text inherits the real vault theme.css in Reader and Live',async()=>{
    const source='## Theme heading\n\n**Strong probe** and *Em probe* and ~~Strike probe~~ and [Link probe](https://example.com).\n\n> Quote probe\n\n- List probe\n\n==Highlight probe==\n';
    const themeHref='/api/web/v1/theme.css?name=ThemeInheritanceProbe';
    const expected={
      heading:'rgb(201, 71, 72)',
      strong:'rgb(73, 161, 92)',
      emphasis:'rgb(86, 118, 207)',
      strike:'rgb(173, 96, 189)',
      link:'rgb(223, 136, 54)',
      quote:'rgb(71, 174, 181)',
      list:'rgb(188, 129, 62)',
      highlightBg:'rgb(78, 65, 111)',
      highlightColor:'rgb(244, 244, 244)',
    };
    const styleOf=(selector)=>page.evaluate((sel)=>{
      const el=document.querySelector(sel);
      if(!el) return null;
      const s=getComputedStyle(el);
      return{color:s.color,background:s.backgroundColor,fontWeight:s.fontWeight,className:el.className||'',text:el.textContent||''};
    },selector);
    try {
      await open('A.md');
      await mode('live');
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
      await sleep(60);

      await mode('preview');await sleep(60);
      const reader={
        heading:await styleOf('#preview h2'),
        strong:await styleOf('#preview strong'),
        emphasis:await styleOf('#preview em'),
        strike:await styleOf('#preview s, #preview del'),
        link:await styleOf('#preview a[href="https://example.com"]'),
        quote:await styleOf('#preview blockquote'),
        list:await styleOf('#preview li'),
        highlight:await styleOf('#preview mark'),
      };

      await mode('live');await sleep(80);
      const live={
        heading:await styleOf('.cm-header-2'),
        strong:await styleOf('.cm-strong'),
        emphasis:await styleOf('.cm-em'),
        strike:await styleOf('.cm-strikethrough'),
        link:await styleOf('.cm-link'),
        quote:await styleOf('.HyperMD-quote'),
        list:await styleOf('.HyperMD-list-line'),
        highlight:await styleOf('.cm-highlight'),
      };

      for(const group of [reader,live]){
        for(const [name,value] of Object.entries(group)) assert.ok(value,JSON.stringify({name,group}));
        assert.equal(group.heading.color,expected.heading,JSON.stringify(group));
        assert.equal(group.strong.color,expected.strong,JSON.stringify(group));
        assert.equal(group.strong.fontWeight,'543',JSON.stringify(group));
        assert.equal(group.emphasis.color,expected.emphasis,JSON.stringify(group));
        assert.equal(group.strike.color,expected.strike,JSON.stringify(group));
        assert.equal(group.link.color,expected.link,JSON.stringify(group));
        assert.equal(group.quote.color,expected.quote,JSON.stringify(group));
        assert.equal(group.list.color,expected.list,JSON.stringify(group));
        assert.equal(group.highlight.background,expected.highlightBg,JSON.stringify(group));
        assert.equal(group.highlight.color,expected.highlightColor,JSON.stringify(group));
      }
    } finally {
      await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
      await page.evaluate(()=>{
        const link=document.querySelector('#community-theme');
        link.disabled=true;
        link.removeAttribute('href');
      });
      await sleep(40);
    }
  });
  await check('task checkbox inherits low-specificity vault theme.css in Reader and Live',async()=>{
    const source='- [ ] TASK THEME OPEN\n- [x] TASK THEME DONE\n';
    const themeHref='/api/web/v1/theme.css?name=ThemeInheritanceProbe';
    const read=selector=>page.evaluate(sel=>{
      const el=document.querySelector(sel);
      if(!el)return null;
      const style=getComputedStyle(el);
      return{
        width:style.width,
        height:style.height,
        radius:style.borderTopLeftRadius,
        border:style.borderTopColor,
        checked:Boolean(el.checked),
      };
    },selector);
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
      await sleep(80);

      await mode('preview');await sleep(60);
      const reader=await read('#preview .task-list-item-checkbox');
      await mode('live');await sleep(60);
      const live=await read('.cm-live-task-checkbox');

      for(const value of [reader,live]){
        assert.ok(value,JSON.stringify({reader,live}));
        assert.equal(value.width,'19px',JSON.stringify({reader,live}));
        assert.equal(value.height,'19px',JSON.stringify({reader,live}));
        assert.equal(value.radius,'7px',JSON.stringify({reader,live}));
        assert.equal(value.border,'rgb(91, 132, 173)',JSON.stringify({reader,live}));
        assert.equal(value.checked,false,JSON.stringify({reader,live}));
      }
    }finally{
      await page.evaluate(()=>{
        const link=document.querySelector('#community-theme');
        link.disabled=true;
        link.removeAttribute('href');
      });
      await page.evaluate(text=>{window.__testEditor.setMode('live');window.__testEditor.setValue(text,{resetHistory:true,silent:true});},fixture);
      await sleep(50);
    }
  });
}
