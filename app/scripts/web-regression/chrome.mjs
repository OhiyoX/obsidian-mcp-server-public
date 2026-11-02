// Application chrome (themed controls, responsive topbar, theme toggle).
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';

export async function registerChromeChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await check('themed controls and responsive topbar stay inside the viewport',async()=>{
    await page.locator('#settings-open').click();
    const modeControl=page.locator('#color-mode').locator('..');
    assert.equal(await modeControl.locator('.select-native').count(),1);
    await modeControl.locator('.select-trigger').click();
    const darkOption=modeControl.locator('.select-option[data-value="dark"]');
    await darkOption.waitFor();
    const popupColors=await modeControl.locator('.select-menu').evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
    assert.notEqual(popupColors.background,'rgba(0, 0, 0, 0)');
    assert.notEqual(popupColors.background,popupColors.color);
    await darkOption.click();
    assert.equal(await page.locator('html').evaluate(el=>el.classList.contains('theme-dark')),true);
    await modeControl.locator('.select-trigger').click();
    await modeControl.locator('.select-option[data-value="light"]').click();
    assert.equal(await page.locator('html').evaluate(el=>el.classList.contains('theme-light')),true);
    await page.locator('#settings-close').click();

    await open('A.md');await mode('preview');
    const taskStyle=await page.locator('.preview .task-list-item-checkbox').first().evaluate(el=>({appearance:getComputedStyle(el).appearance,border:getComputedStyle(el).borderColor,background:getComputedStyle(el).backgroundColor}));
    assert.equal(taskStyle.appearance,'none',`preview task appearance: ${JSON.stringify(taskStyle)}`);
    assert.notEqual(taskStyle.border,taskStyle.background);
    await page.evaluate(()=>window.__testEditor.setValue('- [ ] one\n- [x] two',{resetHistory:true,silent:true}));
    await mode('live');
    const liveTask=page.locator('.cm-live-task-checkbox').first();
    await liveTask.waitFor();
    assert.equal(await liveTask.evaluate(el=>getComputedStyle(el).appearance),'none','live task appearance');
    const beforeTask=await value();
    await liveTask.click();
    assert.notEqual(await value(),beforeTask);

    await page.evaluate(()=>window.__testEditor.setValue('- [x] plain completed\n- [x] \`inline\` trailing completed',{resetHistory:true,silent:true}));
    await sleep(80);
    const completedColors=await page.evaluate(()=>{
      const lines=[...document.querySelectorAll('.cm-line')];
      const plain=lines.find(el=>el.textContent.includes('plain completed'));
      const rich=lines.find(el=>el.textContent.includes('trailing completed'));
      const findTextParent=(root,needle)=>{
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
        for(let node=walker.nextNode();node;node=walker.nextNode()){
          if(node.nodeValue.includes(needle))return node.parentElement;
        }
        return null;
      };
      const trailing=findTextParent(rich,'trailing completed');
      const code=rich?.querySelector('.cm-live-inline-code');
      return {
        plainLine:getComputedStyle(plain).color,
        richLine:getComputedStyle(rich).color,
        trailing:getComputedStyle(trailing).color,
        code:getComputedStyle(code).color,
        richHtml:rich?.innerHTML||'',
      };
    });
    assert.equal(completedColors.richLine,completedColors.plainLine,JSON.stringify(completedColors));
    assert.equal(completedColors.trailing,completedColors.plainLine,JSON.stringify(completedColors));
    assert.notEqual(completedColors.code,completedColors.plainLine,JSON.stringify(completedColors));

    await page.evaluate(()=>window.__testEditor.setValue('- [x] plain completed\n- [x] prefix `inline` **strong** trailing completed',{resetHistory:true,silent:true}));
    await mode('preview');
    await sleep(80);
    const readerCompleted=await page.evaluate(()=>{
      const tasks=[...document.querySelectorAll('.preview .task-list-item')];
      const plain=tasks.find(el=>el.textContent.includes('plain completed'));
      const rich=tasks.find(el=>el.textContent.includes('trailing completed'));
      return {
        count:tasks.length,
        checked:tasks.filter(el=>el.classList.contains('is-checked')&&el.dataset.task==='x').length,
        plainColor:plain?getComputedStyle(plain).color:null,
        richColor:rich?getComputedStyle(rich).color:null,
        richText:rich?.textContent||'',
        codeCount:rich?.querySelectorAll('code').length||0,
        strongCount:rich?.querySelectorAll('strong').length||0,
        labels:rich?.querySelectorAll('.task-list-item-label').length||0,
      };
    });
    assert.equal(readerCompleted.count,2,JSON.stringify(readerCompleted));
    assert.equal(readerCompleted.checked,2,JSON.stringify(readerCompleted));
    assert.equal(readerCompleted.plainColor,readerCompleted.richColor,JSON.stringify(readerCompleted));
    assert.equal((readerCompleted.richText.match(/prefix/g)||[]).length,1,JSON.stringify(readerCompleted));
    assert.equal((readerCompleted.richText.match(/trailing completed/g)||[]).length,1,JSON.stringify(readerCompleted));
    assert.equal(readerCompleted.codeCount,1,JSON.stringify(readerCompleted));
    assert.equal(readerCompleted.strongCount,1,JSON.stringify(readerCompleted));
    assert.equal(readerCompleted.labels,0,JSON.stringify(readerCompleted));
    assert.equal(readerCompleted.richText.includes('`'),false,JSON.stringify(readerCompleted));
    assert.equal(readerCompleted.richText.includes('**'),false,JSON.stringify(readerCompleted));

    await page.evaluate(text=>window.__testEditor.setValue(text,{resetHistory:true,silent:true}),fixture);
    await mode('preview');
    if(process.env.WEB_CAPTURE_MOBILE)await page.screenshot({path:path.join(outputRoot,'desktop-layout.png'),fullPage:false});
    await page.setViewportSize({width:390,height:844});
    await sleep(100);
    // U18 + U29: the rail's show/hide control now lives in the topbar's actions, and an open
    // narrow drawer covers it (its scrim owns "tap outside"); dismiss the drawer from inside
    // it — picking the already-active panel tab is the U7 collapse path (same pane-layout.setOpen).
    if(await page.locator('.shell').evaluate(el=>el.classList.contains('context-open')))await page.locator('#context-sidebar .context-view-btn.is-active').click();
    const mobile=await page.evaluate(()=>{
      const rect=el=>{const value=el.getBoundingClientRect();return {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height};};
      const topbar=document.querySelector('.topbar').getBoundingClientRect();
      const actions=document.querySelector('.topbar-actions').getBoundingClientRect();
      const status=document.querySelector('.topbar-status').getBoundingClientRect();
      const preview=rect(document.querySelector('.preview'));
      const sizer=rect(document.querySelector('.preview .markdown-preview-sizer'));
      const heading=rect(document.querySelector('.preview h1'));
      const property=rect(document.querySelector('.preview .property'));
      const propertyKey=rect(document.querySelector('.preview .metadata-property-key'));
      const propertyValue=rect(document.querySelector('.preview .metadata-property-value'));
      const touchTargets=[...document.querySelectorAll('.topbar button')].map(el=>({el,rect:el.getBoundingClientRect()})).filter(item=>item.rect.width>0&&item.rect.height>0).map(({el,rect})=>({label:el.getAttribute('aria-label')||el.textContent.trim(),width:rect.width,height:rect.height}));
      const contextHeader=document.querySelector('.context-header').getBoundingClientRect();
      const outlineItem=document.querySelector('.outline-item')?.getBoundingClientRect();
      return {scrollWidth:document.documentElement.scrollWidth,innerWidth,topbarRight:topbar.right,actionsRight:actions.right,statusWidth:status.width,statusBarCount:document.querySelectorAll('.status-bar').length,topbarHeight:topbar.height,liveStatusDisplay:getComputedStyle(document.querySelector('.topbar-status')).display,liveStatusLabel:document.querySelector('#live-status-label')?.textContent,contextHeaderHeight:contextHeader.height,outlineItemHeight:outlineItem?.height,touchTargets,preview,sizer,heading,property,propertyKey,propertyValue,sidebarShadow:getComputedStyle(document.querySelector('.sidebar')).boxShadow,contextShadow:getComputedStyle(document.querySelector('.context-sidebar')).boxShadow};
    });
    assert.equal(mobile.scrollWidth,mobile.innerWidth);
    assert.ok(Math.abs(mobile.topbarRight-mobile.innerWidth)<1);
    assert.ok(mobile.topbarRight-mobile.actionsRight<=8);
    assert.ok(mobile.statusWidth>0,JSON.stringify(mobile));
    assert.ok(['flex','inline-flex'].includes(mobile.liveStatusDisplay));
    assert.ok(mobile.liveStatusLabel,JSON.stringify(mobile));
    assert.equal(mobile.statusBarCount,0,JSON.stringify({field:'statusBarCount',mobile}));
    assert.ok(mobile.topbarHeight>=51&&mobile.topbarHeight<=54,JSON.stringify(mobile));
    assert.ok(mobile.touchTargets.every(target=>target.width>=44&&target.height>=44),JSON.stringify(mobile.touchTargets));
    assert.ok(mobile.heading.left-mobile.preview.left<=16,JSON.stringify(mobile));
    assert.ok(mobile.preview.right-mobile.heading.right>=-1,JSON.stringify(mobile));
    assert.ok(Math.abs(mobile.sizer.width-(mobile.preview.width-28))<=2,JSON.stringify(mobile));
    assert.ok(mobile.property.width<=mobile.sizer.width+1,JSON.stringify(mobile));
    assert.ok(mobile.propertyValue.top>=mobile.propertyKey.bottom-1,JSON.stringify(mobile));
    assert.equal(mobile.sidebarShadow,'none',JSON.stringify({field:'sidebarShadow',mobile}));
    assert.equal(mobile.contextShadow,'none',JSON.stringify({field:'contextShadow',mobile}));
    assert.ok(mobile.contextHeaderHeight>=58,JSON.stringify(mobile));
    assert.ok((mobile.outlineItemHeight||0)>=44,JSON.stringify(mobile));

    await mode('live');
    await page.locator('.cm-content').waitFor();
    const mobileLiveAxis=await page.evaluate(()=>{
      const scroller=document.querySelector('.cm-scroller');
      const content=document.querySelector('.cm-content');
      return {
        scrollbarGutter:getComputedStyle(scroller).scrollbarGutter,
        contentWidth:content.getBoundingClientRect().width,
      };
    });
    assert.equal(mobileLiveAxis.scrollbarGutter,'auto',JSON.stringify(mobileLiveAxis));
    assert.ok(Math.abs(mobileLiveAxis.contentWidth-mobile.sizer.width)<=1,JSON.stringify({readerWidth:mobile.sizer.width,live:mobileLiveAxis}));
    await mode('preview');

    if(process.env.WEB_CAPTURE_MOBILE)await page.screenshot({path:path.join(outputRoot,'mobile-layout.png'),fullPage:false});
    await page.locator('#document-actions-toggle').click();
    const actionTargets=await page.locator('#document-actions-menu button:visible').evaluateAll(items=>items.map(el=>{const rect=el.getBoundingClientRect();return {width:rect.width,height:rect.height};}));
    assert.equal(actionTargets.length,2,'the ⋮ menu holds document actions only (#398 removed the outline item)');
    assert.ok(actionTargets.every(target=>target.width>=44&&target.height>=44),JSON.stringify(actionTargets));
    if(process.env.WEB_CAPTURE_MOBILE)await page.screenshot({path:path.join(outputRoot,'mobile-document-actions.png'),fullPage:false});
    await page.keyboard.press('Escape');
    await page.locator('.view-mode-toggle:visible').click();
    if(process.env.WEB_CAPTURE_MOBILE)await page.screenshot({path:path.join(outputRoot,'mobile-view-mode.png'),fullPage:false});
    await page.keyboard.press('Escape');
    await page.locator('#menu').click();
    await page.locator('.sidebar-actions').waitFor();
    assert.notEqual(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).boxShadow),'none');
    assert.equal(await page.locator('#outline-toggle').count(),0,'the ⋮ outline item is gone (#398)');
    assert.equal(await page.locator('#sidebar-toggle').count(),1,'the topbar layout toggle is one home for the rail entry');
    assert.equal(await page.locator('.sidebar-actions #settings-open').count(),0);
    assert.equal(await page.locator('.sidebar-footer #settings-open').count(),1);
    assert.equal(await page.locator('.sidebar-footer .search-help').count(),0);
    assert.equal(await page.locator('.search-row .search-help').count(),1);
    const sidebarHeader=await page.evaluate(()=>{
      const head=document.querySelector('.sidebar-head').getBoundingClientRect();
      const actions=document.querySelector('.sidebar-actions').getBoundingClientRect();
      const search=document.querySelector('.search-row').getBoundingClientRect();
      return {headHeight:head.height,actionsHeight:actions.height,gapActionsToSearch:search.top-actions.bottom};
    });
    // Sorting lives in the file-toolbar row (desktop file-explorer shape), so the header
    // is toolbar + search only and every row sits on the same small gap.
    assert.ok(sidebarHeader.headHeight<=200,JSON.stringify(sidebarHeader));
    assert.ok(sidebarHeader.gapActionsToSearch<=8,JSON.stringify(sidebarHeader));
    // #508: the tab-row divider belongs to the full-width header, not to the `.sidebar-tabs` strip.
    // The strip ends before the pane close button (28px), so the 1px line used to stop ~37 logical
    // px short of the pane edge and the close button sat inside the gap (owner screenshot +
    // pixel probe 74 physical px @ DPR 2). The right pane already does it this way (.context-header).
    const sidebarDivider=await page.evaluate(()=>{
      const head=document.querySelector('.sidebar-head');
      const tabs=document.querySelector('.sidebar-tabs');
      const sidebar=document.querySelector('.sidebar');
      const h=head.getBoundingClientRect(),t=tabs.getBoundingClientRect(),s=sidebar.getBoundingClientRect();
      return {
        headBorderBottom:getComputedStyle(head).borderBottomWidth,
        tabsBorderBottom:getComputedStyle(tabs).borderBottomWidth,
        headWidth:h.width,tabsWidth:t.width,headRight:h.right,sidebarWidth:s.width,sidebarRight:s.right,
      };
    });
    assert.notEqual(sidebarDivider.headBorderBottom,'0px',`the header must own the divider (#508): ${JSON.stringify(sidebarDivider)}`);
    assert.equal(sidebarDivider.tabsBorderBottom,'0px',`the tab strip must not own the divider (#508): ${JSON.stringify(sidebarDivider)}`);
    assert.ok(sidebarDivider.headWidth-sidebarDivider.tabsWidth>=28,`the divider must cover the pane-close band (#508): ${JSON.stringify(sidebarDivider)}`);
    assert.ok(sidebarDivider.sidebarWidth-sidebarDivider.headWidth<=16,`the divider must reach the pane edge (#508): ${JSON.stringify(sidebarDivider)}`);
    // The sort menu must open from the toolbar trigger, stay inside the viewport and
    // write the chosen spec back to the checked option.
    await page.locator('#explorer-sort-toggle').click();
    const sortMenu=await page.evaluate(()=>{
      const menu=document.querySelector('#explorer-sort-menu');
      const rect=menu.getBoundingClientRect();
      return {open:!menu.hidden,position:getComputedStyle(menu).position,checked:menu.querySelector('[aria-checked="true"]')?.dataset.sortKey,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight};
    });
    assert.equal(sortMenu.open,true,JSON.stringify(sortMenu));
    assert.equal(sortMenu.position,'fixed',JSON.stringify(sortMenu));
    assert.equal(sortMenu.checked,'name',JSON.stringify(sortMenu));
    assert.ok(sortMenu.left>=0&&sortMenu.right<=sortMenu.width,JSON.stringify(sortMenu));
    assert.ok(sortMenu.top>=0&&sortMenu.bottom<=sortMenu.height,JSON.stringify(sortMenu));
    await page.locator('#explorer-sort-menu [data-sort-key="modified"][data-sort-direction="desc"]').click();
    assert.equal(await page.evaluate(()=>document.querySelector('#explorer-sort-menu [aria-checked="true"]')?.dataset.sortKey),'modified');
    assert.equal(await page.evaluate(()=>document.querySelector('#explorer-sort-menu').hidden),true);
    // The search-syntax help card must escape the sidebar's `overflow: hidden` box
    // (the absolute card was clipped by 48px at the default 270px sidebar) and must be
    // dismissible from outside so it can never trap the note list.
    // Navigation only (U4): the search row now lives in the search tab panel, so the drawer
    // selects that tab (the file/actions panel is in front by default).
    if(await page.locator('[data-sidebar-tab="search"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="search"]').click();
    await page.locator('.search-row .search-help > summary').click();
    const helpCard=await page.evaluate(()=>{
      const card=document.querySelector('.search-help-card');
      const rect=card.getBoundingClientRect();
      return {open:document.querySelector('.search-help').open,position:getComputedStyle(card).position,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight};
    });
    assert.equal(helpCard.open,true,JSON.stringify(helpCard));
    assert.equal(helpCard.position,'fixed',JSON.stringify(helpCard));
    assert.ok(helpCard.left>=0&&helpCard.right<=helpCard.width,JSON.stringify(helpCard));
    assert.ok(helpCard.top>=0&&helpCard.bottom<=helpCard.height,JSON.stringify(helpCard));
    await page.locator('.search-row .search').click();
    assert.equal(await page.evaluate(()=>document.querySelector('.search-help').open),false);
    // Navigation only (U4): the search row now lives in the search tab panel, so the file
    // tab is restored for the remaining checks (they drive the tree / sidebar actions).
    if(await page.locator('[data-sidebar-tab="files"]').getAttribute('aria-selected')!=='true')await page.locator('[data-sidebar-tab="files"]').click();
    await page.locator('.vault-switcher .select-trigger').click();
    const vaultPopup=await page.evaluate(()=>{
      const trigger=document.querySelector('.vault-switcher .select-trigger').getBoundingClientRect();
      const menu=document.querySelector('.vault-switcher .select-menu').getBoundingClientRect();
      return {triggerTop:trigger.top,menuTop:menu.top,menuBottom:menu.bottom,innerHeight};
    });
    assert.ok(vaultPopup.menuTop<vaultPopup.triggerTop,JSON.stringify(vaultPopup));
    assert.ok(vaultPopup.menuTop>=0 && vaultPopup.menuBottom<=vaultPopup.innerHeight,JSON.stringify(vaultPopup));
    await page.locator('.vault-switcher .select-trigger').click();
    await page.locator('.scrim').click({force:true});
    await page.setViewportSize({width:1440,height:1000});
  });
  await check('the desktop document header keeps only 实时 / 保存 / 📖 / ⋮ / 右栏开关 and the menu drives the actions',async()=>{
    // U10 desktop parity: the header right edge carries the sync status, Save, the
    // reading-view switch (📖), the more-options menu (⋮) and — since U29 / #371 — the right-rail
    // show/hide control, which the seat ruling freezes as a topbar action at every width (its
    // `#sidebar-toggle` has exactly one DOM home and stays reachable while the rail is collapsed).
    // Nothing else: copy link, Publish and the outline switch live in the ⋮ menu.
    await page.setViewportSize({width:1440,height:1000});
    await open('A.md');
    await mode('preview');
    const header=await page.evaluate(()=>{
      const actions=document.querySelector('.topbar-actions');
      const rect=el=>{const value=el.getBoundingClientRect();return {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height};};
      const key=el=>el.id||el.className.trim().split(/\s+/).pop();
      const icon=el=>el.querySelector('use')?.getAttribute('href')?.split('#').pop()??null;
      return {
        order:[...actions.children].map((el,index)=>({key:key(el),icon:icon(el),box:rect(el)})),
        viewModeToggles:document.querySelectorAll('.view-mode-toggle').length,
        statusBarCount:document.querySelectorAll('.status-bar').length,
        removedIds:{copy:document.querySelectorAll('#copy-note-link').length,publish:document.querySelectorAll('#publish-toggle').length,outlineChip:document.querySelectorAll('.topbar-outline').length},
        actionsRight:rect(actions).right,
        headerRight:rect(document.querySelector('.topbar')).right,
      };
    });
    assert.deepEqual(header.order.map(item=>item.key),['topbar-status','save','topbar-view-mode','document-actions','sidebar-toggle'],JSON.stringify(header));
    assert.ok(header.order.every(item=>item.box.width>0&&item.box.height>0),`every header control is really laid out: ${JSON.stringify(header.order)}`);
    assert.equal(header.order[2].icon,'book-open','the reading-view switch is the desktop book-open glyph');
    assert.equal(header.order[3].icon,'more-vertical','the menu trigger is the desktop vertical ellipsis');
    // U29: the rail toggle is the actions' rightmost control and keeps its frozen identity.
    assert.equal(header.order[4].icon,'panel-right','the rail toggle is the mirrored panel glyph, last in the action row');
    assert.ok(header.headerRight-header.actionsRight>=0&&header.headerRight-header.actionsRight<=12,`the action row sits flush against the header padding (${JSON.stringify({actionsRight:header.actionsRight,headerRight:header.headerRight})})`);
    assert.equal(header.viewModeToggles,1,'exactly one view-mode control is rendered (no status-bar duplicate)');
    assert.equal(header.statusBarCount,0,'U21: the removed bottom status bar is not rendered at all');
    assert.deepEqual(header.removedIds,{copy:0,publish:0,outlineChip:0},'no independent copy-link / Publish / outline chip survives');

    // 📖: the three modes switch from the header and exactly one is checked each time.
    for(const name of ['raw','live','preview']){
      await mode(name);
      const state=await page.evaluate(()=>({
        checked:[...document.querySelectorAll('.view-mode-item[aria-checked="true"]')].map(el=>el.dataset.mode),
        toggleExpanded:document.querySelector('.view-mode-toggle').getAttribute('aria-expanded'),
        toggleIcon:document.querySelector('.view-mode-toggle use')?.getAttribute('href')?.split('#').pop(),
        editorVisible:!document.querySelector('#editor').hidden,
        previewVisible:!document.querySelector('#preview').hidden,
      }));
      assert.deepEqual(state.checked,[name],`${name}: exactly one checked mode (${JSON.stringify(state)})`);
      assert.equal(state.toggleExpanded,'false',`${name}: the reading-view menu closed`);
      assert.equal(state.editorVisible,name!=='preview',`${name}: the editor host follows the mode`);
      assert.equal(state.previewVisible,name==='preview',`${name}: the reader follows the mode`);
    }

    // ⋮: open, the two real document actions are visible and enabled. #398 removed the outline
    // item: the rail is driven by the layout-layer #sidebar-toggle, and opening/closing the menu
    // must never touch it.
    const railBefore=await page.locator('.shell').evaluate(shell=>shell.classList.contains('context-hidden'));
    await page.waitForFunction(()=>document.querySelector('[data-document-link]')&&!document.querySelector('[data-document-link]').disabled);
    await page.locator('#document-actions-toggle').click();
    const menu=await page.locator('#document-actions-menu').evaluate(el=>{
      const rect=el.getBoundingClientRect();
      return {
        hidden:el.hidden,
        expanded:document.querySelector('#document-actions-toggle').getAttribute('aria-expanded'),
        items:[...el.querySelectorAll('button')].map(button=>({label:button.textContent.trim(),disabled:button.disabled,icon:button.querySelector('use')?.getAttribute('href')?.split('#').pop(),box:{width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}})),
        box:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height},
        viewport:{width:innerWidth,height:innerHeight},
      };
    });
    assert.equal(menu.hidden,false,JSON.stringify(menu));
    assert.equal(menu.expanded,'true','the trigger reports the open menu');
    assert.deepEqual(menu.items.map(item=>item.icon),['link','globe-2'],JSON.stringify(menu));
    assert.deepEqual(menu.items.map(item=>item.label),['复制文档链接','Publish'],JSON.stringify(menu));
    assert.equal(menu.items[0].disabled,false,'the copy-link item is enabled once the publish state is loaded');
    assert.ok(menu.items.every(item=>item.box.width>0&&item.box.height>0),JSON.stringify(menu));
    assert.ok(menu.box.left>=0&&menu.box.right<=menu.viewport.width&&menu.box.top>=0&&menu.box.bottom<=menu.viewport.height,JSON.stringify(menu));
    assert.equal(await page.locator('#outline-toggle').count(),0,'the ⋮ outline item is gone (#398)');
    assert.equal(await page.locator('.shell').evaluate(shell=>shell.classList.contains('context-hidden')),railBefore,'opening the ⋮ menu never touches the rail');
    if(process.env.WEB_CAPTURE_MOBILE)await page.screenshot({path:path.join(outputRoot,'desktop-document-actions.png'),fullPage:false});
    // The layout-layer toggle is the one rail entry: it flips the rail exactly once, closes the
    // open ⋮ menu as an outside click, and keeps aria-pressed/title in sync with the DOM.
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-pressed'),String(!railBefore),'the layout toggle reports the current rail state');
    await page.locator('#sidebar-toggle').click();
    const railAfter=await page.evaluate(()=>({
      hidden:document.querySelector('.shell').classList.contains('context-hidden'),
      pressed:document.querySelector('#sidebar-toggle').getAttribute('aria-pressed'),
      menuHidden:document.querySelector('#document-actions-menu').hidden,
      triggerExpanded:document.querySelector('#document-actions-toggle').getAttribute('aria-expanded'),
    }));
    assert.equal(railAfter.hidden,!railBefore,'one #sidebar-toggle press flips the rail exactly once');
    assert.equal(railAfter.pressed,String(railBefore),'the layout toggle reports the new rail state');
    assert.equal(railAfter.menuHidden,true,'the outside click also closes the open ⋮ menu');
    assert.equal(railAfter.triggerExpanded,'false');
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('.shell').evaluate(shell=>shell.classList.contains('context-hidden')),railBefore,'the rail state is restored for the remaining checks');
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-pressed'),String(!railBefore),'and the toggle reports it again');
  });
  // U35 (#407): the popup/menu state machine is shared (`ui/popup-menu.js`), but the topbar and
  // the note-context rail own different interaction scopes. Real Chromium is the only place the
  // cross-scope half can be proven end to end: both ⋮ menus are open at the same time, two
  // topbar menus still exclude each other, and Escape — owned by the primitive in the capture
  // phase, ahead of the shell-wide Escape handler — closes the menu and hands the focus back to
  // the trigger that owns it.
  await check('the topbar ⋮ and the right-rail section ⋮ are independent popup scopes, and Escape returns focus',async()=>{
    await open('A.md');
    await page.waitForFunction(()=>document.querySelector('[data-document-link]')&&!document.querySelector('[data-document-link]').disabled);
    const railBefore=await page.locator('.shell').evaluate(shell=>shell.classList.contains('context-hidden'));
    const viewBefore=await page.evaluate(()=>document.querySelector('[data-context-view][aria-selected="true"]')?.getAttribute('data-context-view')??null);
    if(railBefore)await page.locator('#sidebar-toggle').click();
    await page.locator('[data-context-view="outgoing"]').click();
    await sleep(80);
    const snapshot=()=>page.evaluate(()=>{
      const railHead=document.querySelector('#outgoing-menu-toggle')?.closest('.context-panel-head');
      return {
        topbarHidden:document.querySelector('#document-actions-menu').hidden,
        topbarExpanded:document.querySelector('#document-actions-toggle').getAttribute('aria-expanded'),
        railHidden:railHead?.querySelector('.context-section-menu')?.hidden??null,
        railExpanded:document.querySelector('#outgoing-menu-toggle').getAttribute('aria-expanded'),
        viewHidden:document.querySelector('.view-mode-menu').hidden,
        viewExpanded:document.querySelector('.view-mode-toggle').getAttribute('aria-expanded'),
        activeTag:document.activeElement?.tagName??null,
        activeInViewMenu:Boolean(document.activeElement?.closest?.('.view-mode-menu')),
        activeViewToggle:document.activeElement===document.querySelector('.view-mode-toggle'),
      };
    });
    // Scope isolation: a pointer-open topbar menu and a keyboard-opened rail menu coexist. The
    // rail menu is opened from the keyboard so no `pointerdown` reaches the topbar popup's
    // outside-dismissal path — which is exactly the state the two scopes are allowed to reach.
    await page.locator('#document-actions-toggle').click();
    await page.evaluate(()=>document.querySelector('#outgoing-menu-toggle').focus());
    await page.keyboard.press('Enter');
    let state=await snapshot();
    assert.equal(state.railHidden,false,`the rail ⋮ menu opens: ${JSON.stringify(state)}`);
    assert.equal(state.railExpanded,'true',JSON.stringify(state));
    assert.equal(state.topbarHidden,false,`and the topbar ⋮ stays open (other scope): ${JSON.stringify(state)}`);
    assert.equal(state.topbarExpanded,'true',JSON.stringify(state));
    // Escape closes the transient menus (each open controller owns its own listener).
    await page.keyboard.press('Escape');
    state=await snapshot();
    assert.equal(state.topbarHidden,true,`Escape closes the topbar ⋮: ${JSON.stringify(state)}`);
    assert.equal(state.railHidden,true,`and the rail ⋮ too: ${JSON.stringify(state)}`);
    assert.equal(state.topbarExpanded,'false',JSON.stringify(state));
    assert.equal(state.railExpanded,'false',JSON.stringify(state));
    // Same scope still excludes: a keyboard-open reading-view menu closes the topbar ⋮ and, on
    // Escape, hands the focus back to its own trigger instead of leaving it in the DOM.
    await page.evaluate(()=>document.querySelector('.view-mode-toggle').focus());
    await page.keyboard.press('Enter');
    state=await snapshot();
    assert.equal(state.viewHidden,false,`the reading-view menu opens: ${JSON.stringify(state)}`);
    assert.equal(state.activeInViewMenu,true,`and it owns the focus: ${JSON.stringify(state)}`);
    assert.equal(state.viewExpanded,'true',JSON.stringify(state));
    await page.locator('#document-actions-toggle').click();
    state=await snapshot();
    assert.equal(state.topbarHidden,false,JSON.stringify(state));
    assert.equal(state.viewHidden,true,`opening the topbar ⋮ closed the reading-view menu (same scope): ${JSON.stringify(state)}`);
    assert.equal(state.viewExpanded,'false',JSON.stringify(state));
    await page.evaluate(()=>document.querySelector('.view-mode-toggle').focus());
    await page.keyboard.press('Enter');
    state=await snapshot();
    assert.equal(state.topbarHidden,true,`and the reverse direction holds too: ${JSON.stringify(state)}`);
    assert.equal(state.viewHidden,false,JSON.stringify(state));
    await page.keyboard.press('Escape');
    state=await snapshot();
    assert.equal(state.viewHidden,true,`Escape closes the reading-view menu: ${JSON.stringify(state)}`);
    assert.equal(state.activeViewToggle,true,`and returns the focus to its trigger: ${JSON.stringify(state)}`);
    // Leave the shell as it was found for the remaining checks.
    if(viewBefore&&viewBefore!=='outgoing')await page.locator(`[data-context-view="${viewBefore}"]`).click();
    if(railBefore)await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('.shell').evaluate(shell=>shell.classList.contains('context-hidden')),railBefore,'the rail state is restored for the remaining checks');
  });
  await check('Publish theme icon stays painted while switching light and dark',async()=>{
    const csrf=await page.locator('meta[name="csrf-token"]').getAttribute('content');
    const publishResponse=await page.request.post(`${base}/api/web/v1/publish`,{
      headers:{'X-CSRF-Token':csrf},
      data:{action:'publish',path:'Properties.md'},
    });
    assert.equal(publishResponse.status(),200);
    const published=await publishResponse.json();
    const publicPage=await browser.newPage({viewport:{width:900,height:700}});
    try {
      await publicPage.goto(`${base}${published.publicPath}`);
      await publicPage.waitForSelector('#publish-theme-toggle');
      await publicPage.waitForSelector('.publish-document .properties');
      const publicProperties=await publicPage.locator('.publish-document .properties').innerText();
      assert.match(publicProperties,/Original property/);
      assert.match(publicProperties,/alpha/);
      assert.match(publicProperties,/中文/);
      const publicDate=await publicPage.locator('.publish-document .property',{hasText:'date'}).locator('time').getAttribute('datetime');
      assert.match(publicDate,/^2026-09-14T/);
      assert.match(publicProperties,/first line/);
      assert.match(publicProperties,/count/);
      assert.match(publicProperties,/\b0\b/);
      assert.doesNotMatch(publicProperties,/published/);
      assert.doesNotMatch(publicProperties,/tester/);
      assert.doesNotMatch(publicProperties,/browser-secret/);
      assert.doesNotMatch(publicProperties,/publish_properties/);
      assert.doesNotMatch(await publicPage.content(),/browser-secret/);
      const result=await publicPage.evaluate(async()=>{
        const button=document.querySelector('#publish-theme-toggle');
        const slot=button.querySelector('.publish-theme-icon-slot');
        const moon=button.querySelector('.publish-theme-icon-moon');
        const sun=button.querySelector('.publish-theme-icon-sun');
        const hrefs=()=>[moon.querySelector('use').getAttribute('href'),sun.querySelector('use').getAttribute('href')];
        const sample=()=>{
          const slotRect=slot.getBoundingClientRect();
          return {
            dark:document.documentElement.classList.contains('theme-dark'),
            moon:Number(getComputedStyle(moon).opacity),
            sun:Number(getComputedStyle(sun).opacity),
            slotWidth:slotRect.width,
            slotHeight:slotRect.height,
          };
        };
        const beforeHrefs=hrefs();
        const samples=[sample()];
        button.click();
        for(let i=0;i<4;i+=1){await new Promise(resolve=>requestAnimationFrame(resolve));samples.push(sample());}
        button.click();
        for(let i=0;i<4;i+=1){await new Promise(resolve=>requestAnimationFrame(resolve));samples.push(sample());}
        return {beforeHrefs,afterHrefs:hrefs(),samples};
      });
      assert.deepEqual(result.afterHrefs,result.beforeHrefs);
      assert.ok(result.samples.some(item=>item.dark));
      assert.ok(result.samples.some(item=>!item.dark));
      assert.ok(result.samples.every(item=>Math.max(item.moon,item.sun)>=0.99),JSON.stringify(result.samples));
      assert.ok(result.samples.every(item=>item.slotWidth>=14&&item.slotHeight>=14),JSON.stringify(result.samples));
    } finally {
      await publicPage.close();
      const revoke=await page.request.post(`${base}/api/web/v1/publish`,{
        headers:{'X-CSRF-Token':csrf},
        data:{action:'revoke',path:'Properties.md'},
      });
      assert.equal(revoke.status(),200);
    }
  });
}
