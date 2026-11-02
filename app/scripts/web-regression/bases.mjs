// Final desktop/mobile screenshots plus the Web Bases full-phase browser contract.
// Extracted verbatim from the former single-file harness; registered by scripts/web-regression.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { createWebBasesFixtureVault } from '../web-bases-fixtures.mjs';
import { registerWebBasesChecks, registerWebBasesParityChecks } from '../web-bases-checks.mjs';
// Issue #409 review (batch 5): the Base view listbox focus handoff + surface lifecycle
// regressions, driven on this block's own fixture page.
import { registerBaseSelectKeyboardChecks } from './bases-select-keyboard.mjs';
import { createSortDriver } from '../web-bases-panels.mjs';

export async function registerBasesChecks(ctx) {
  const { check, sleep, page, errors, dialogs, open, mode, value, vault, base, outputRoot, fixture, expectedHeadings, propertiesFixture, root, appRoot, browser, serverErrors } = ctx;
  await open('A.md');await mode('live');
  await page.screenshot({path:path.join(outputRoot,'desktop-live.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await sleep(300);
  // U18: the rail's show/hide control now lives in the layout tab row, and an open narrow
  // drawer covers it; dismiss the drawer from inside it — picking the already-active panel
  // tab is the U7 collapse path (same single pane-layout.setOpen).
  if(await page.locator('.shell').evaluate(el=>el.classList.contains('context-open')))await page.locator('#context-sidebar .context-view-btn.is-active').click();
  if(await page.locator('.shell').evaluate(el=>el.classList.contains('sidebar-open')))await page.locator('#menu').click();
  await sleep(250);
  await page.screenshot({path:path.join(outputRoot,'mobile-live.png'),fullPage:true});
  // Wave C: Web Bases full-phase browser contract. A dedicated fixture Vault + real
  // server + page keeps every existing scenario's Vault untouched while sharing this
  // harness's check()/results, so any Base failure fails the same gate. The page gets
  // the same __testEditor capture hook as the main page (dirty-navigation checks).
  {
    const webBasesRoot=path.join(root,'web-bases');
    const webBasesFixtures=await createWebBasesFixtureVault(webBasesRoot);
    const webBasesPort=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    const webBasesBase=`http://127.0.0.1:${webBasesPort}`;
    const webBasesPassword=randomBytes(24).toString('hex');
    const webBasesChild=spawn(process.execPath,['server.js'],{cwd:appRoot,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
      HOST:'127.0.0.1',PORT:String(webBasesPort),DATA_PATH:path.join(webBasesRoot,'data'),
      OAUTH_ENABLED:'true',PUBLIC_BASE_URL:webBasesBase,OAUTH_INITIAL_USERNAME:'browser-test',OAUTH_INITIAL_PASSWORD:webBasesPassword,
      OAUTH_ADMIN_PASSWORD:webBasesPassword,API_KEY:'',GIT_ENABLED:'false',GIT_AUTO_COMMIT:'false',GIT_AUTO_PUSH:'false',
      EMBEDDING_PROVIDER:'disabled',EMBEDDING_EDGE_PROVIDER:'disabled',EMBEDDING_EDGE_BASE_URL:'',EMBEDDING_EDGE_REGISTRY_URL:'',RETRIEVAL_AUTO_EMBED:'false',WEB_FILE_WATCH_DEBOUNCE_MS:'50',
      ...webBasesFixtures.serverEnv}});
    webBasesChild.stderr.on('data',d=>serverErrors.push(d.toString()));
    webBasesChild.stdout.resume();
    let webBasesPage;
    try {
      for(let n=0;n<150;n++){try{if((await fetch(`${webBasesBase}/healthz`)).ok)break;}catch{} if(webBasesChild.exitCode!==null)throw Error('Web Bases test server exited');await sleep(100);}
      webBasesPage=await browser.newPage({viewport:{width:1440,height:1000}});
      webBasesPage.setDefaultTimeout(10000);
      webBasesPage.on('pageerror',error=>errors.push(error.stack||error.message));
      await webBasesPage.addInitScript(()=>{
        Object.defineProperty(window,'createObsidianEditor',{configurable:true,set(factory){
          Object.defineProperty(window,'createObsidianEditor',{configurable:true,writable:true,value(...args){const editor=factory(...args);window.__testEditor=editor;return editor;}});
        }});
      });
      let webBasesLoggedIn=false;
      const webBasesLogin=async()=>{
        if(webBasesLoggedIn)return;
        const response=await webBasesPage.request.post(`${webBasesBase}/auth/login`,{form:{username:'browser-test',password:webBasesPassword}});
        assert.equal(response.status(),200,`Web Bases login failed with ${response.status()}`);
        webBasesLoggedIn=true;
      };
      const webBasesOpen=async(notePath)=>{
        await webBasesLogin();
        const response=webBasesPage.waitForResponse(candidate=>{if(candidate.request().method()!=='GET'||!candidate.url().includes('/api/web/v1/note?'))return false;return new URL(candidate.url()).searchParams.get('path')===notePath;});
        await webBasesPage.locator(`.note[title="${notePath}"]`).click();
        assert.equal((await response).status(),200);
        await webBasesPage.waitForFunction(wanted=>document.querySelector('#current-path')?.textContent===wanted,notePath);
        // U41: the reader/editor bundles are on demand now, so a scripted edit must wait for
        // the captured editor instance instead of relying on a boot-time global.
        await webBasesPage.waitForFunction(()=>Boolean(window.__testEditor),null,{timeout:10000});
      };
      const webBasesGrant=async(vaultId)=>{
        const adminLogin=await webBasesPage.request.post(`${webBasesBase}/admin/auth/login`,{form:{password:webBasesPassword}});
        assert.ok([200,303].includes(adminLogin.status()),`Web Bases admin login returned ${adminLogin.status()}`);
        const accounts=await webBasesPage.request.get(`${webBasesBase}/admin/auth?tab=accounts`);
        const html=await accounts.text();
        const csrf=html.match(/name="csrf" value="([^"]+)"/)?.[1];
        const userId=html.match(/name="id" value="([0-9a-f-]{36})"/)?.[1];
        assert.ok(csrf,'Web Bases admin CSRF token not found');
        assert.ok(userId,'Web Bases OAuth user id not found');
        const grantBody=new URLSearchParams();
        grantBody.append('csrf',csrf);grantBody.append('id',userId);
        for(const scope of ['obsidian.read','obsidian.write','obsidian.files'])grantBody.append('allowedScope',scope);
        for(const vault of [webBasesFixtures.vaultId,vaultId])grantBody.append('allowedVault',vault);
        const update=await webBasesPage.request.post(`${webBasesBase}/admin/auth/oauth/user/scopes`,{data:grantBody.toString(),headers:{'content-type':'application/x-www-form-urlencoded'}});
        assert.ok([200,303].includes(update.status()),`Web Bases grant update returned ${update.status()}`);
        webBasesLoggedIn=false;
      };
      await webBasesLogin();
      await registerWebBasesChecks({check,page:webBasesPage,serverUrl:webBasesBase,phase:'full',login:webBasesLogin,open:webBasesOpen,sleep,fixtures:webBasesFixtures,grantVaultAccess:webBasesGrant,applySortViaPopover:createSortDriver(webBasesPage,sleep)});
      // D3 parity extension (full phase, appended on top of the §15.8 items).
      await registerWebBasesParityChecks({check,page:webBasesPage,serverUrl:webBasesBase,login:webBasesLogin,open:webBasesOpen,sleep,fixtures:webBasesFixtures,grantVaultAccess:webBasesGrant,applySortViaPopover:createSortDriver(webBasesPage,sleep)});
      // Issue #409 review (batch 5): the two defects the real-application probe found.
      await registerBaseSelectKeyboardChecks({check,page:webBasesPage,serverUrl:webBasesBase,fixtures:webBasesFixtures,login:webBasesLogin,sleep});
    } finally {
      await webBasesPage?.close().catch(()=>{});
      if(webBasesChild.exitCode===null){webBasesChild.kill();await new Promise(resolve=>{if(webBasesChild.exitCode!==null)resolve();else webBasesChild.once('exit',resolve);});}
    }
  }
}
