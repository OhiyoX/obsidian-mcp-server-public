import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocumentSession } from '../frontend/app/features/session/document-session.js';
import { createHashQueue } from '../src/app/events/hash-queue.js';
import { createDedupCache } from '../src/app/events/dedup.js';

function openedSession() {
  const session=createDocumentSession();
  session.commitOpen(session.beginOpen({vaultId:'v',path:'A.md'}),{path:'A.md',content:'A base',revision:'a1'});
  return session;
}

test('independent review: recreating identical content after a delivered deletion is not a duplicate',()=>{
  const cache=createDedupCache({ttlMs:30000,maxSize:20});
  const created={vaultId:'v',path:'a.md',type:'note.created',revision:'r1'};
  cache.remember(created);
  cache.remember({vaultId:'v',path:'a.md',type:'note.deleted'});
  assert.equal(cache.seen(created),false);
});

test('independent review: new A typing while B loads cannot be discarded by B response',()=>{
  const session=openedSession();
  const ticket=session.beginOpen({vaultId:'v',path:'B.md'});
  session.noteLocalEdit('A typed during B request');
  const result=session.commitOpen(ticket,{path:'B.md',content:'B body',revision:'b1'});
  assert.equal(result.applied,false);
  assert.equal(session.path,'A.md');
  assert.equal(session.liveText,'A typed during B request');
});

test('independent review: explicitly confirmed reload may discard preexisting dirty text',()=>{
  const session=openedSession();
  session.noteLocalEdit('preexisting draft');
  // The UI obtains confirmation BEFORE beginOpen. No new edits happen during this request.
  const ticket=session.beginOpen({vaultId:'v',path:'A.md'});
  const result=session.commitOpen(ticket,{path:'A.md',content:'disk version',revision:'a2'});
  assert.equal(result.applied,true);
  assert.equal(session.liveText,'disk version');
  assert.equal(session.isDirty(),false);
});

test('independent review: clear must not hide active hash work or exceed physical concurrency',async()=>{
  const queue=createHashQueue({maxConcurrency:1,maxPending:4});
  let release,started;let active=0,maxActive=0;
  const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  const first=queue.enqueuePath('A',async()=>{active++;maxActive=Math.max(active,maxActive);started();await gate;active--;});
  const settledFirst=first.catch(()=>{});
  await ready;queue.clear();
  const second=queue.enqueuePath('B',async()=>{active++;maxActive=Math.max(active,maxActive);active--;});
  await new Promise(r=>setTimeout(r,10));release();
  await Promise.all([settledFirst,second]);
  assert.equal(maxActive,1);
  assert.equal(queue.inFlight,0);
});
