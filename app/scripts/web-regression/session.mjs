// Chromium page, console/dialog capture and login helpers (open/mode/value).
import assert from 'node:assert/strict';

export async function openBrowserSession({ chromium, chromiumExecutable, base, password, sleep }) {
  // Issue #380: launch the binary `env.mjs` resolved and pinned. Reading
  // `process.env.CHROMIUM_EXECUTABLE` directly would silently accept an unresolved value.
  const executablePath=chromiumExecutable||process.env.CHROMIUM_EXECUTABLE||'';
  assert.ok(executablePath,'openBrowserSession requires the pinned Chromium executable (issue #380)');
  const browser=await chromium.launch({headless:true,executablePath});
  // Exercise cursor rasterization under a HiDPI grid instead of only DPR=1.
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:2});
  page.setDefaultTimeout(7000);
  const errors=[];
  const dialogs=[];
  // Issue #414 (C): the asset request log has to start before the first navigation so the
  // first checks can prove that the shell paints without the editor/reader bundles.
  const assetRequests=[];
  page.on('request',request=>{const url=request.url();if(url.includes('/app/assets/'))assetRequests.push(url.split('?')[0].split('/').pop());});
  page.on('pageerror',error=>errors.push(error.stack||error.message));
  page.on('console',message=>{if(message.type()==='error' && /CodeMirror|RangeError|plugin crashed/.test(message.text()))errors.push(message.text());});
  page.on('dialog',dialog=>{dialogs.push({type:dialog.type(),message:dialog.message()});dialog.accept();});
  // Capture the public factory result without modifying production code or application state.
  await page.addInitScript(()=>{
    Object.defineProperty(window,'createObsidianEditor',{configurable:true,set(factory){
      Object.defineProperty(window,'createObsidianEditor',{configurable:true,writable:true,value(...args){const editor=factory(...args);window.__testEditor=editor;return editor;}});
    }});
  });
  const login=await page.request.post(`${base}/auth/login`,{form:{username:'browser-test',password}});
  assert.equal(login.status(),200);
  await page.goto(`${base}/app`);
  await page.waitForSelector('.note[title="A.md"]');
  const requestedAsset=(name)=>assetRequests.includes(name);
  const assetGlobals=()=>page.evaluate(()=>({
    loader:Boolean(window.__obsidianWebAssets),
    editor:typeof window.createObsidianEditor==='function',
    reader:typeof window.renderObsidianMarkdown==='function',
  }));
  async function open(name){
    const response=page.waitForResponse(r=>{
      if(r.request().method()!=='GET'||!r.url().includes('/api/web/v1/note?'))return false;
      return new URL(r.url()).searchParams.get('path')===name;
    });
    await page.locator(`.note[title="${name}"]`).click();
    assert.equal((await response).status(),200);
    await page.waitForFunction(n=>document.querySelector('#current-path').textContent===n,name);
    // U41: `reader.js` and (on document open) `editor.js` are on demand now, so "the note is
    // open" is only true once the reading renderer and the captured editor instance exist.
    // Waiting here keeps every scenario's assertions on the same contract.
    await page.waitForFunction(()=>typeof window.renderObsidianMarkdown==='function',null,{timeout:10000});
    await page.waitForFunction(()=>Boolean(window.__testEditor),null,{timeout:10000});
  }
  async function mode(name){
    await page.locator('.view-mode-toggle:visible').click();
    await page.locator(`.view-mode-menu:not([hidden]) .view-mode-item[data-mode="${name}"]`).click();
    await sleep(80);
    // U41: clicking into an editable surface is what fetches and materializes `editor.js`;
    // wait for the captured instance before a caller drives `window.__testEditor`.
    if(name==='live'||name==='raw')await page.waitForFunction(()=>Boolean(window.__testEditor),null,{timeout:10000});
  }
  const value=()=>page.evaluate(()=>window.__testEditor.getValue());
  return { browser, page, errors, dialogs, open, mode, value, requestedAsset, assetGlobals };
}
