import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { rig, message, request, response } from './helpers/bridge.mjs';
import { DelegatedWork } from '../lib/application/delegated-work.mjs';
import { injectOwnedAmendment } from '../lib/application/interjections.mjs';
import { publishExecutionSource, executionSource, closeExecutionSource, executionToolGuard } from '../lib/agent/execution-scope.mjs';
import { runTurn } from '../lib/agent/runner.mjs';
import { taskRegistry } from '../lib/conversation/task-sessions.mjs';
import { workspaceDirectory, workspaceRoot } from '../lib/agent/workspace.mjs';
import { contextMessage } from '../lib/conversation/context.mjs';
import { replyJournal } from '../lib/delivery/reply-journal.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delegation-')), rigs = [], realFetch = globalThis.fetch;
let passed = 0, failed = 0;
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const route = (action = 'new', taskId = null) => ({ action, taskId, confidence: 1, evidenceIds: ['1'], reason: 'fixture' });
async function test(name, fn) { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name, e.stack); } }
function make() {
  const store = new Store(path.join(root, rigs.length + '.sqlite3'));
  const r = rig({ taskRoutingMode: 'enabled', taskProgressEnabled: false, groupTrigger: 'all', replyTimeoutMs: 10000 }, '完成', store);
  r.store = store; r.state.replyJournal ??= replyJournal(store); rigs.push(r); r.ctx.agents = new Map(); r.runs = [];
  r.ctx.subagents = { getProvider: name => name === 'spawn' ? { name } : null,
    async start(provider, request) {
      assert.equal(provider, 'spawn'); const done = gate();
      const child = { id: 'child-' + r.runs.length, status: 'running', injections: [],
        session: { id: 'child-' + r.runs.length, header: { parentSession: request.parent.id, cwd: request.parent.session.header.cwd } },
        inject(m) { this.injections.push(m); } };
      const run = { id: child.id, localAgent: child, request, result: done.promise, disposed: false,
        finish(result = { stopReason: 'completed', output: [{ type: 'text', text: '文件 result.txt 已写好，待父代理核对' }] }) {
          child.status = 'idle'; done.resolve(result);
        }, async dispose() { this.disposed = true; } };
      request.signal.addEventListener('abort', () => run.finish({ stopReason: 'aborted', output: [] }), { once: true });
      r.runs.push(run); r.state.delegatedWork.bindChild(child);
      return run;
    } };
  r.state.delegatedWork = new DelegatedWork({ ctx: r.ctx, config: r.config, registry: r.registry, state: r.state, store, stats: r.stats });
  r.state.taskScheduler.pump = () => {}; // Inspect completion admission without fake external sends.
  return r;
}
async function source(r, id = 1, user = 200, group = 10) {
  const event = { ...message(id, '写一份长文档', group, user), __inputId: '100:' + id };
  const key = 'group:' + group, e = r.state.taskRouting.admit(key, event, route());
  const sessionId = await taskRegistry(r.registry, r.state.taskRouting, e.task_id).ensureSession(key);
  const parent = r.ctx.agents.get(sessionId) ?? { id: sessionId, status: 'running', injections: [],
    session: { id: sessionId, header: { cwd: workspaceDirectory(workspaceRoot(r.config), key) } }, inject(m) { this.injections.push(m); } };
  r.ctx.agents.set(sessionId, parent);
  const ref = r.state.sourceLedger.origin(key, contextMessage(event));
  publishExecutionSource(r.store, ref, { conversation: key, sessionId, taskId: e.task_id, executionId: e.id,
    taskVersion: e.data.taskVersion, expiresAt: Date.now() + 10000 });
  const turnId = 'turn-' + id;
  r.state.replyJournal.begin(turnId, key, { event, sessionId, sourceRef: ref, stableTaskId: e.task_id,
    floorPolicy: { originals: [event], messageIds: [String(id)] }, inputIds: [event.__inputId] });
  r.state.replyJournal.active.add(turnId); r.state.taskRouting.setExecution(e.id, 'following', { turnId });
  r.state.taskScheduler.active.set(e.id, e);
  return { event, ref, e, sessionId, parent, turnId, exec: { agent: parent, signal: r.state.controller.signal }, key };
}
async function start(r, s) { return r.state.delegatedWork.start({ source_ref: s.ref, description: '撰写战术文档', prompt: '完整委派需求及验收标准' }, s.exec); }

try {
  await test('delegation availability requires visible preset tools, not only a running native provider', async () => {
    const r=make(),s=await source(r),defs=r.state.delegatedWork.tools(),key={};let released=0;
    r.ctx.tools={schemas(scope){return scope===key?defs.filter(t=>t.name!=='qq_delegate'):defs;}};
    r.ctx.agentPresets={async acquireScope(){return{key,async [Symbol.asyncDispose](){released++;}};}};
    await r.state.delegatedWork.refreshToolVisibility();
    let status=r.state.delegatedWork.snapshot();assert.equal(status.nativeAvailable,true);assert.equal(status.available,false);
    assert.deepEqual(status.tools.preset.missing,['qq_delegate']);assert.equal(released,1);
    r.ctx.tools.schemas=()=>defs;await r.state.delegatedWork.refreshToolVisibility();
    status=r.state.delegatedWork.snapshot();assert.equal(status.available,true);assert.deepEqual(status.tools.preset.missing,[]);
    assert.equal(status.tools.sessions[0].sessionId,s.sessionId);assert.equal(released,2);
  });
  await test('oversized or empty delegation/control/progress arguments fail before starting or steering work', async () => {
    const r=make(),s=await source(r),service=r.state.delegatedWork;
    await assert.rejects(service.start({description:'task',prompt:'',source_ref:s.ref},s.exec),/完整 prompt/);
    await assert.rejects(service.start({description:'task',prompt:'x'.repeat(20001),source_ref:s.ref},s.exec),/完整 prompt/);
    assert.equal(r.runs.length,0);assert.equal(service.rows(s.key).length,0);
    const j=await start(r,s),child=r.runs[0].localAgent;
    assert.throws(()=>service.control({job_id:j.job_id,action:'amend',message:'x'.repeat(4001),source_ref:s.ref},s.exec),/4000/);
    assert.throws(()=>service.control({job_id:j.job_id,action:'amend',source_ref:s.ref},s.exec),/4000/);
    assert.throws(()=>service.progress({job_id:j.job_id,text:'x'.repeat(401),source_ref:s.ref},{agent:child}),/400/);
    assert.equal(child.injections.length,0);
  });
  await test('new tasks share one conversation Session and topic; another group has its own Session', async () => {
    const r = make(), a = await source(r), b = await source(r, 2, 300), c = await source(r, 3, 200, 11);
    assert.notEqual(a.e.task_id, b.e.task_id); assert.equal(a.sessionId, b.sessionId);
    assert.equal(r.state.taskRouting.get(a.e.task_id).topic_id, r.state.taskRouting.get(b.e.task_id).topic_id);
    assert.notEqual(c.sessionId, a.sessionId);
    r.registry.entry(a.key).contextChars = r.config.conversationContextMaxChars + 1;
    assert.equal(await r.registry.ensureSession(a.key), a.sessionId);
    r.registry.entry(a.key).turns = 20;
    assert.notEqual(await r.registry.ensureSession(a.key), a.sessionId);
  });
  await test('native child is bound before first step, inherits cwd and has no shell/admin/final-send tools', async () => {
    const r = make(), s = await source(r), j = await start(r, s), child = r.runs[0].localAgent;
    assert.equal(r.store.getState('qq-bridge:execution-session:' + child.session.id), s.ref);
    assert.equal(child.session.header.cwd, s.parent.session.header.cwd);
    assert.equal(r.runs[0].request.maxDepth, 1);
    for (const forbidden of ['pwsh', 'subagent', 'send_message', 'mcp__qq__qq_manage_group', 'mcp__qq__qq_send_file'])
      assert.ok(!r.runs[0].request.toolFilter.allow.includes(forbidden));
    assert.equal(executionToolGuard(r.store, r.config, { agent: child, name: 'mcp__qq__qq_workspace', arguments: { source_ref: s.ref, conversation: s.key } }), undefined);
    assert.match(executionToolGuard(r.store, r.config, { agent: child, name: 'mcp__qq__qq_say', arguments: { source_ref: s.ref, conversation: 'group:11' } }), /目标/);
    assert.equal(j.state, 'running');
  });
  await test('prompt facts merge a live worker with its parent and retain complete completion results', async () => {
    const r=make(),s=await source(r),j=await start(r,s);
    r.state.taskLedger.begin(s.turnId,s.key,{event:s.event,stableTaskId:s.e.task_id});
    r.state.taskLedger.set(s.turnId,'running');
    r.state.delegatedWork.save(j.job_id,'running',{progress:'WORKER-STAGE',progressAt:1234});
    const text=r.state.taskLedger.context(s.key,r.state.replyJournal,{owner:'200'});
    const rows=text.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
    assert.equal(rows.length,1);assert.equal(rows[0].job_id,j.job_id);
    assert.equal(rows[0].progress,'WORKER-STAGE');assert.equal(rows[0].progressAt,1234);
    assert.doesNotMatch(text,/sessionId|executionId|messageIds|completionBasis/);
    assert.equal(r.state.taskLedger.context(s.key,r.state.replyJournal,{owner:'200',taskId:s.e.task_id,delegatedResult:true}),'');
    assert.equal(r.state.taskLedger.facts(s.key,r.state.replyJournal).length,2);
    const longResult='RESULT-'.repeat(300),completion={jobId:j.job_id,state:'completed',result:longResult};
    r.state.taskRouting.setExecution(s.e.id,'following',{delegatedResult:completion});
    const current=r.state.taskRouting.context(s.e.task_id,s.e.id);
    assert.ok(current.includes(longResult));assert.doesNotMatch(current,/其他窗口任务|topicId|ownedMessageIds/);
  });
  await test('background work keeps source open when parent ends and completion is admitted exactly once', async () => {
    const r = make(), s = await source(r), j = await start(r, s);
    s.parent.status = 'idle'; r.state.replyJournal.active.delete(s.turnId);
    closeExecutionSource(r.store, s.ref); assert.equal(executionSource(r.store, s.ref).state, 'active');
    r.state.taskRouting.setExecution(s.e.id, 'model_finished');
    const done = r.state.delegatedWork.live.get(j.job_id).done; r.runs[0].finish(); await done;
    r.state.delegatedWork.reconcile(); r.state.delegatedWork.reconcile();
    const completion = r.state.taskRouting.execution('execution-' + j.job_id);
    assert.equal(completion.task_id, s.e.task_id); assert.equal(completion.data.delegatedResult.state, 'completed');
    assert.equal(r.store.db.prepare('SELECT COUNT(*) n FROM bridge_executions WHERE id=?').get(completion.id).n, 1);
    assert.equal(executionSource(r.store, s.ref).state, 'closed'); assert.equal(r.runs[0].disposed, true);
    r.store.db.prepare('UPDATE memory_origins SET expires_at=? WHERE ref=?').run(Date.now()-1,s.ref);
    r.state.delegatedWork.reconcile();assert.equal(r.state.delegatedWork.get(j.job_id).state,'completed');
    assert.equal(r.prompts.length, 0, '委派和捕获结果不阻塞主窗口或偷建普通回合');
  });
  await test('two authors work under the same dialogue; a third worker waits and starts only after capacity frees', async () => {
    const r = make(), a = await source(r), ja = await start(r,a), b = await source(r,2,300), jb = await start(r,b);
    assert.equal(a.sessionId,b.sessionId); assert.notEqual(ja.agent_id,jb.agent_id);
    assert.equal(r.store.getState('qq-bridge:execution-session:' + ja.agent_id), a.ref);
    assert.equal(r.store.getState('qq-bridge:execution-session:' + jb.agent_id), b.ref);
    const c = await source(r,3,400), jc=await start(r,c); assert.equal(jc.state,'queued'); assert.equal(r.runs.length,2);
    const facts = r.state.taskLedger.facts(a.key,r.state.replyJournal);
    assert.equal(facts.filter(f=>f.completionBasis==='native-subagent' && f.state==='running').length,2);
    assert.equal(r.state.taskRouting.busy(a.e.task_id),true);
    const done=r.state.delegatedWork.live.get(ja.job_id).done;r.runs[0].finish();await done;
    await r.state.delegatedWork.dispatch();assert.equal(r.runs.length,3);
    assert.equal(r.state.delegatedWork.get(jc.job_id).state,'running');
  });
  await test('status remains readable during background work, but only the original author may amend it', async () => {
    const r=make(),a=await source(r),j=await start(r,a),b=await source(r,2,300);
    const status=r.state.delegatedWork.tools().find(t=>t.name==='qq_delegate_status');
    assert.equal(status.execute({source_ref:b.ref},b.exec)[0].job_id,j.job_id);
    assert.throws(()=>r.state.delegatedWork.control({source_ref:b.ref,job_id:j.job_id,action:'amend',message:'改成别的'},b.exec),/本人/);
    const fresh=await source(r,3,200);
    assert.equal(r.state.delegatedWork.control({source_ref:fresh.ref,job_id:j.job_id,action:'amend',message:'加一章'},fresh.exec).accepted,true);
    assert.match(r.runs[0].localAgent.injections[0].content[0].text,/加一章/);
  });
  await test('child stage summary updates facts and injects only its own active parent execution', async () => {
    const r=make(),s=await source(r),j=await start(r,s),child=r.runs[0].localAgent;
    r.state.delegatedWork.progress({source_ref:s.ref,job_id:j.job_id,text:'已核实两份资料，正在写正文'}, {agent:child});
    assert.equal(s.parent.injections.length,1); assert.match(r.state.delegatedWork.get(j.job_id).data.progress,/两份资料/);
    await source(r,2,300); // Same Session now belongs to another request.
    r.state.delegatedWork.progress({source_ref:s.ref,job_id:j.job_id,text:'正文已生成'}, {agent:child});
    assert.equal(s.parent.injections.length,1);
    assert.throws(()=>r.state.delegatedWork.progress({source_ref:s.ref,job_id:j.job_id,text:'伪造'},s.exec),/进度必须属于当前工作子代理/);
  });
  await test('native error produces a failure completion, never an invented success', async () => {
    const r=make(),s=await source(r),j=await start(r,s),done=r.state.delegatedWork.live.get(j.job_id).done;
    r.runs[0].finish({stopReason:'error',output:[],diagnostic:'search adapter failed'}); await done;
    const e=r.state.taskRouting.execution('execution-'+j.job_id);assert.equal(e.data.delegatedResult.state,'failed');
    assert.equal(e.data.delegatedResult.diagnostic,'search adapter failed');
  });
  await test('cancellation aborts child and never queues a result after cancellation', async () => {
    const r=make(),s=await source(r),j=await start(r,s),done=r.state.delegatedWork.live.get(j.job_id).done;
    r.state.taskRouting.admit(s.key,message(2,'取消',10,200),route('cancel',s.e.task_id));
    r.state.delegatedWork.reconcile();await done;
    assert.equal(r.state.delegatedWork.get(j.job_id).state,'cancelled');
    assert.equal(r.state.taskRouting.execution('execution-'+j.job_id),null);
    assert.equal(r.runs[0].disposed,true);
  });
  await test('human amendment is durably claimed and injected once without bumping task version or new Session', async () => {
    const r=make(),s=await source(r),e=message(2,'改成蓝色');
    assert.equal(injectOwnedAmendment(r.state.taskScheduler,s.key,[e],route('amend',s.e.task_id)),true);
    assert.equal(s.parent.injections.length,1);assert.equal(r.state.taskRouting.get(s.e.task_id).version,s.e.data.taskVersion);
    assert.equal(injectOwnedAmendment(r.state.taskScheduler,s.key,[e],route('amend',s.e.task_id)),true);
    assert.equal(s.parent.injections.length,1);assert.equal(r.prompts.length,0);
    assert.deepEqual(r.state.replyJournal.get(s.turnId).meta.floorPolicy.messageIds,['1','2']);
    assert.equal(injectOwnedAmendment(r.state.taskScheduler,s.key,[message(3,'改为红色',10,300)],route('amend',s.e.task_id)),false);
    assert.equal(injectOwnedAmendment(r.state.taskScheduler,s.key,[message(4,'新问题')],route('new')),false);
  });
  await test('a human amendment steers its matching background worker even when parent is idle', async () => {
    const r=make(),s=await source(r),j=await start(r,s);
    s.parent.status='idle';r.state.replyJournal.active.delete(s.turnId);r.state.taskScheduler.active.clear();
    r.state.taskRouting.setExecution(s.e.id,'model_finished');
    assert.equal(injectOwnedAmendment(r.state.taskScheduler,s.key,[message(2,'再加一章')],route('amend',s.e.task_id)),true);
    assert.equal(r.runs[0].localAgent.injections.length,1);assert.equal(s.parent.injections.length,0);
    const done=r.state.delegatedWork.live.get(j.job_id).done;r.runs[0].finish();await done;
    assert.equal(r.state.taskRouting.execution('execution-'+j.job_id).data.inputEvents.length,2);
  });
  await test('idle parent falls back to normal amendment admission instead of waking an unowned turn', async () => {
    const r=make(),s=await source(r);s.parent.status='idle';
    assert.equal(injectOwnedAmendment(r.state.taskScheduler,s.key,[message(2,'改成蓝色')],route('amend',s.e.task_id)),false);
    assert.equal(s.parent.injections.length,0);
  });
  await test('semantic admission steers natural amendments but separates progress and other-author requests', async () => {
    const r=make(),s=await source(r);let verdict;
    r.ctx.llm={async *stream(){yield {type:'text-delta',text:JSON.stringify(verdict)};}};
    const decide=(action,id)=>({action,taskId:s.e.task_id,confidence:1,evidenceIds:['1',String(id)],reason:'semantic-context'});
    verdict=decide('amend',2);
    assert.equal(await r.state.taskScheduler.admit(s.key,[message(2,'结尾让她们在一起吧')]),true);
    assert.equal(s.parent.injections.length,1);
    verdict=decide('query',3);
    await r.state.taskScheduler.admit(s.key,[message(3,'怎么样，可以写吗？')]);
    const query=r.state.taskRouting.execution(r.store.db.prepare('SELECT execution_id FROM bridge_input_routes WHERE id=?').get('100:3').execution_id);
    assert.equal(query.data.readOnly,true);assert.equal(query.data.referencedTaskId,s.e.task_id);
    verdict={...decide('new',4),taskId:null};
    await r.state.taskScheduler.admit(s.key,[message(4,'帮我查一下天气',10,300)]);
    const other=r.state.taskRouting.execution(r.store.db.prepare('SELECT execution_id FROM bridge_input_routes WHERE id=?').get('100:4').execution_id);
    assert.notEqual(other.task_id,s.e.task_id);assert.equal(other.owner,'300');
    verdict=decide('amend',5);
    await r.state.taskScheduler.admit(s.key,[message(5,'结尾让她们在一起吧',10,300)]);
    assert.equal(s.parent.injections.length,1);
    assert.equal(r.state.taskRouting.get(s.e.task_id).version,s.e.data.taskVersion);
  });
  await test('progress-shaped prefix and natural correction aggregate before semantic injection during a live parent', async () => {
    const r=make(),s=await source(r);let input;
    Object.assign(r.config,{taskProgressEnabled:true,inputDebounceMs:10,inputShortDebounceMs:40,inputMaxWaitMs:200});
    r.ctx.llm={async *stream(req){input=JSON.parse(req.messages[0].content[0].text);
      yield {type:'text-delta',text:JSON.stringify({action:'amend',taskId:s.e.task_id,confidence:1,evidenceIds:['1','2','3'],reason:'natural-correction'})};}};
    await r.handler(request(message(2,'怎么样了')),response());
    await r.handler(request(message(3,'结尾让她们在一起吧')),response());
    const deadline=Date.now()+2000;
    while(!s.parent.injections.length){if(Date.now()>deadline)throw new Error('semantic injection timeout');await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal(s.parent.injections.length,1);
    assert.equal(input.inputTimeline.length,2);assert.equal(input.message.text,'怎么样了\n结尾让她们在一起吧');
    const ids=r.state.taskRouting.execution(s.e.id).data.inputEvents.map(e=>String(e.message_id));
    assert.deepEqual(ids,['1','2','3']);assert.equal(r.prompts.length,0);
  });
  await test('uncertain injection preserves input ownership and invalidates unrevised output/tool authority', async () => {
    const r=make(),s=await source(r);s.parent.inject=()=>{throw new Error('inbox unavailable');};
    assert.equal(injectOwnedAmendment(r.state.taskScheduler,s.key,[message(2,'改成蓝色')],route('amend',s.e.task_id)),true);
    assert.equal(r.state.taskRouting.get(s.e.task_id).state,'needs_attention');
    assert.equal(r.state.taskRouting.get(s.e.task_id).version,s.e.data.taskVersion+1);
    assert.equal(r.store.db.prepare('SELECT execution_id FROM bridge_input_routes WHERE id=?').get('100:2').execution_id,s.e.id);
    assert.match(executionToolGuard(r.store,r.config,{agent:s.parent,name:'mcp__qq__qq_say',arguments:{source_ref:s.ref,conversation:s.key}}),/要求已更新/);
  });
  await test('child QQ progress uses successful receipt time; UNKNOWN, replay and dry-run never enter shared history', async () => {
    const r=make(),s=await source(r),j=await start(r,s),child=r.runs[0].localAgent;
    child.session.snapshotEvents=()=>[{type:'tool/call',data:{callId:'say',name:'mcp__qq__qq_say',arguments:{source_ref:s.ref,conversation:s.key,text:'已完成资料核验'}}}];
    const sentAt=Date.now()-1000;
    const event=(status,patch={})=>({type:'tool/result',time:Date.now(),data:{callId:'say',message:{structuredContent:{receipt:{id:'receipt',status,sentAt,onebotId:'real-qq-id',...patch}},content:[]}}});
    r.state.delegatedWork.onEvent(child.session,event('UNKNOWN'));
    r.state.delegatedWork.onEvent(child.session,event('SUCCEEDED',{replayed:true}));
    r.state.delegatedWork.onEvent(child.session,event('SUCCEEDED',{dryRun:true}));
    assert.equal(r.registry.entry(s.key).window.filter(m=>m.bot).length,0);
    r.state.delegatedWork.onEvent(child.session,event('SUCCEEDED'));
    const spoken=r.registry.entry(s.key).window.find(m=>m.messageId==='real-qq-id');
    assert.equal(spoken.at,sentAt);assert.equal(r.state.delegatedWork.get(j.job_id).data.progressAt,sentAt);
  });
  await test('injected new step drops the pre-amendment draft and delivers only revised closing text', async () => {
    const r=make();let requestId;
    r.ctx.sessionController.prompt=async p=>{requestId=p.requestId;};
    r.ctx.sessionController.follow=()=>({async *[Symbol.asyncIterator](){
      yield {type:'snapshot',cursor:0};
      const frame=(seq,type,data)=>({type:'event',event:{seq,type,data}});
      yield frame(1,'turn/start',{turn:1});yield frame(2,'user/message',{turn:1,source:{rpcId:requestId}});
      yield frame(3,'assistant/message',{turn:1,message:{content:[{type:'text',text:'旧版草稿'}]}});
      yield frame(4,'user/message',{turn:1,source:{rpcId:'qq-interject:real-amendment'}});
      yield frame(5,'assistant/message',{turn:1,message:{content:[{type:'text',text:'已纳入补充的最终答案'}]}});
      yield frame(6,'turn/end',{turn:1,reason:{kind:'completed'}});
    }});
    const result=await runTurn(r.ctx,r.config,r.registry,'group:10',[{type:'text',text:'原要求'}],r.stats);
    assert.equal(result.reply,'已纳入补充的最终答案');
  });
  await test('restored running child is needs_attention and is never silently restarted', async () => {
    const r=make(),s=await source(r),j=await start(r,s);
    const recovered=new DelegatedWork({ctx:r.ctx,config:r.config,registry:r.registry,state:r.state,store:r.store,stats:r.stats});
    assert.equal(recovered.get(j.job_id).state,'needs_attention');assert.equal(recovered.live.size,0);
    assert.equal(executionSource(r.store,s.ref).state,'closed');
    assert.equal(r.runs.length,1);recovered.closed=true;
  });
} finally {
  for(const r of rigs){r.state.disposed=true;r.state.controller.abort();await r.state.delegatedWork.dispose();
    r.state.inputBatches?.dispose();r.state.taskProgress?.dispose();r.sendQueue.dispose();r.store.db.close();}
  globalThis.fetch=realFetch;fs.rmSync(root,{recursive:true,force:true});
}
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
