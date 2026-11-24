import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'git-restore-'));
const vault=path.join(root,'vault');
process.env.VAULT_PATH=vault;process.env.DATA_PATH=path.join(root,'data');
process.env.MAX_READ_BYTES='1024';process.env.GIT_AUTO_COMMIT='false';process.env.GIT_AUTO_COMMIT_SWEEP='false';process.env.GIT_ENABLED='true';process.env.VERSION_HISTORY_ENABLED='true';
process.env.RETRIEVAL_AUTO_EMBED='false';process.env.EMBEDDING_PROVIDER='disabled';
await fs.mkdir(vault);
const git=(...args)=>execFileSync('git',['-C',vault,...args],{encoding:'utf8'}).trim();
git('init');git('config','core.autocrlf','false');git('config','user.email','test@local');git('config','user.name','Test');
const original='---\ntitle: Old\n---\n# old\n\nend  \n\n';
await fs.writeFile(path.join(vault,'Note.md'),original);
git('add','.');git('commit','-m','first');const first=git('rev-parse','HEAD');
await fs.writeFile(path.join(vault,'Note.md'),'# second\n');git('add','.');git('commit','-m','second');
const {registerObsidianCapabilities}=await import('../src/capabilities.js');
const server=new McpServer({name:'git-restore',version:'1'});registerObsidianCapabilities(server);
const client=new Client({name:'test',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
const call=(name,args)=>client.callTool({name,arguments:args});
const good=(r)=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
test.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
test('Git restore preserves exact bytes and returns a reversible pre-write version',async()=>{
 const r=good(await call('restore_version',{path:'Note.md',revision:'HEAD~1',overwrite:true}));
 assert.equal(await fs.readFile(path.join(vault,'Note.md'),'utf8'),original);
 assert.equal(r.sourceRevision,first);assert.equal(typeof r.preWriteVersionId,'string');
 good(await call('restore_version',{versionId:r.preWriteVersionId,overwrite:true}));
 assert.equal(await fs.readFile(path.join(vault,'Note.md'),'utf8'),'# second\n');
});
test('Git restore requires overwrite, rejects stale revision and invalid selectors without changing bytes',async()=>{
 const before=await fs.readFile(path.join(vault,'Note.md'),'utf8');
 for(const args of [
 {path:'Note.md',revision:first},
 {path:'Note.md',revision:first,overwrite:true,ifMatch:'sha256:stale'},
 {path:'../Note.md',revision:first,overwrite:true},
 {path:'Note.md',revision:'--output=bad',overwrite:true},
 {path:'Note.md',revision:'HEAD:Note.md',overwrite:true},
 {path:'Note.md'}, {revision:'HEAD'},
 {versionId:'x',path:'Note.md',revision:'HEAD',overwrite:true},
 {path:'Note.md',revision:first,destination:'file.bin'},
 ]) {const r=await call('restore_version',args);assert.equal(r.isError,true,JSON.stringify(args));}
 assert.equal(await fs.readFile(path.join(vault,'Note.md'),'utf8'),before);
});
test('short commit restores to a missing destination; a planned restore pins historical bytes',async()=>{
 good(await call('restore_version',{path:'Note.md',revision:first.slice(0,8),destination:'New.md'}));
 assert.equal(await fs.readFile(path.join(vault,'New.md'),'utf8'),original);
 const p=good(await call('plan_restore_version',{path:'Note.md',revision:'HEAD~1',destination:'Planned.md'}));
 assert.equal(await fs.stat(path.join(vault,'Planned.md')).catch(()=>null),null);
 await fs.writeFile(path.join(vault,'Marker.md'),'advance HEAD\n');git('add','Marker.md');git('commit','-m','advance after planning');
 good(await call('apply_note_plan',{planId:p.planId,planHash:p.planHash,idempotencyKey:'git-restore-test-plan'}));
 assert.equal(await fs.readFile(path.join(vault,'Planned.md'),'utf8'),original);
});
test('replace_in_note defaults to every match and false selects only the first',async()=>{
 for(const [suffix,extra,count] of [['all',{},2],['first',{replaceAll:false},1]]){
 await fs.writeFile(path.join(vault,`${suffix}.md`),'one\n\ntwo\n\nthree');
 const r=good(await call('replace_in_note',{path:`${suffix}.md`,replacements:[{search:'\n\n',replace:'\nX\n',...extra}]}));
 assert.equal(r.replacements[0].replacements,count);
 assert.equal((await fs.readFile(path.join(vault,`${suffix}.md`),'utf8')).split('\nX\n').length-1,count);
 }
});
test('historical symlink, invalid UTF-8, NUL and oversized blobs are refused',async()=>{
 await fs.writeFile(path.join(vault,'Bad.md'),Buffer.from([0xff,0xfe]));
 await fs.writeFile(path.join(vault,'NullByte.md'),'text\0tail');
 await fs.writeFile(path.join(vault,'Large.md'),'x'.repeat(2048));
 git('add','Bad.md','NullByte.md','Large.md');
 const link=execFileSync('git',['-C',vault,'hash-object','-w','--stdin'],{input:'../outside.md',encoding:'utf8'}).trim();
 git('update-index','--add','--cacheinfo',`120000,${link},Link.md`);
 git('commit','-m','bad historical blobs');
 for(const name of ['Bad.md','NullByte.md','Large.md','Link.md']){
  const r=await call('restore_version',{path:name,revision:'HEAD',destination:'Rejected.md'});
  assert.equal(r.isError,true,name);assert.equal(await fs.stat(path.join(vault,'Rejected.md')).catch(()=>null),null);
 }
});
test('BOM and CRLF survive Git restore; planned writes refuse concurrent destination changes',async()=>{
 const raw='\ufeff# BOM\r\n\r\ntrailing  \r\n';
 await fs.writeFile(path.join(vault,'BOM.md'),raw);git('add','BOM.md');git('commit','-m','bom');
 good(await call('restore_version',{path:'BOM.md',revision:'HEAD',destination:'BOM-copy.md'}));
 assert.equal(await fs.readFile(path.join(vault,'BOM-copy.md'),'utf8'),raw);
 const p=good(await call('plan_restore_version',{path:'Note.md',revision:first,overwrite:true}));
 await fs.writeFile(path.join(vault,'Note.md'),'changed after planning\n');
 const r=await call('apply_note_plan',{planId:p.planId,planHash:p.planHash,idempotencyKey:'git-restore-concurrent'});
 assert.equal(r.isError,true);assert.equal(await fs.readFile(path.join(vault,'Note.md'),'utf8'),'changed after planning\n');
});

test('history-disabled Git overwrite refuses while create remains possible',()=>{
 const script=`import {assertGitRestoreHistory} from './src/git-note-version.js';
 assertGitRestoreHistory(false);
 try { assertGitRestoreHistory(true); process.exitCode=1; } catch(e) { if(!e.message.includes('VERSION_HISTORY_ENABLED')) throw e; }`;
 execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,VERSION_HISTORY_ENABLED:'false'},timeout:10000});
});
