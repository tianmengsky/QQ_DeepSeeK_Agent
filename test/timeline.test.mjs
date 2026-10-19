import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { rig } from './helpers/bridge.mjs';
import { ConversationRegistry } from '../lib/conversation/registry.mjs';
import { refreshWindowFromQQHistory } from '../lib/conversation/history.mjs';
import { sortWindow } from '../lib/conversation/context.mjs';
import { registryRecordSelf } from '../lib/delivery/reply-delivery.mjs';
import { statusSnapshot } from '../lib/routes/status.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-timeline-'));
const originalFetch = globalThis.fetch;
const store = new Store(path.join(temp, 'test.sqlite3'));
let passed = 0;
async function test(label, fn) { await fn(); passed++; console.log('  ✓ ' + label); }
try {
  await test('same-second messages preserve order rather than sorting opaque QQ identifiers', () => {
    const messages = [{at:1000,sourceSeq:900,text:'你明天不上课吗'},
      {at:1000,sourceSeq:3,text:'来嘛，明天周日'}];
    assert.deepEqual(sortWindow(messages).map((m) => m.text), messages.map((m) => m.text));
  });
  await test('self messages persist their original send timestamp', () => {
    const r = rig({}, '', store);
    const entry = r.registry.entry('group:10');
    registryRecordSelf(r.config, entry, '自己的回复', {store,conversation:'group:10',onebotId:'reply'});
    const event = store.readEvents('group:10', {latest:true}).messages.at(-1);
    assert.ok(event.payload.at > 0);
    assert.equal(event.payload.at, entry.window.at(-1).at);
  });
  await test('reload repairs legacy self timestamps without treating old replies as new', () => {
    const r = rig({}, '', store), entry = r.registry.entry('group:20');
    const rec = store.recordEvent({conversation:'group:20',kind:'self_message',payload:{text:'你明天不上课吗',messageId:'old'},deliverable:false});
    store.db.prepare('UPDATE events SET created_at=? WHERE id=?').run(10000,rec.id);
    store.upsertConversation('group:20', {lastMessageAt:11000});
    entry.window = [{text:'你明天不上课吗',messageId:'old',bot:true,at:Date.now()},
      {text:'来嘛，明天周日',messageId:'new',qq:'200',at:11000}];
    entry.lastAttentionDecision={conversation:'group:20',messageId:'new',phase:'agent-silent',at:11000};
    r.registry.persist('group:20');
    const restored = new ConversationRegistry(r.ctx,r.config,store);
    restored.restoreConversation('group:20');
    assert.deepEqual(restored.entry('group:20').window.map((m)=>m.text), ['你明天不上课吗','来嘛，明天周日']);
    assert.equal(restored.entry('group:20').window[0].at,10000);
    assert.equal(statusSnapshot(r.config,restored,r.state,{}).replyPolicy.lastAttentionDecision.phase,'agent-silent');
  });
  await test('protocol history corrects polluted local times and keeps chronological adjacency', async () => {
    const r = rig({contextFromQQHistory:true,selfIds:['100']});
    const entry=r.registry.entry('group:30');
    entry.window=[{bot:true,qq:'',text:'你明天不上课吗',messageId:'900',at:Date.now()},
      {qq:'200',text:'来嘛，明天周日',messageId:'2',at:20000}];
    globalThis.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({status:'ok',retcode:0,data:{messages:[
      {user_id:100,message_id:'900',time:10,message:[{type:'text',data:{text:'你明天不上课吗'}}]},
      {user_id:200,message_id:'2',time:20,message:[{type:'text',data:{text:'来嘛，明天周日'}}]},
    ]}})});
    await refreshWindowFromQQHistory(r.ctx,r.config,r.registry,entry,'group:30',r.stats);
    assert.deepEqual(entry.window.map((m)=>m.messageId),['900','2']);
    assert.equal(entry.window[0].at,10000);
  });
  console.log(`全部通过：${passed} 项`);
} finally { globalThis.fetch=originalFetch; store.db.close(); fs.rmSync(temp,{recursive:true,force:true}); }
