import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { TaskRouting, configSelection } from '../lib/conversation/task-routing.mjs';
import { auxSelection } from '../lib/agent/aux-model.mjs';
import { TaskScheduler } from '../lib/application/task-scheduler.mjs';
import { taskRegistry } from '../lib/conversation/task-sessions.mjs';
import { publishExecutionSource, closeExecutionSource, assertExecutionSource, activeExecutionSources, executionToolGuard, CROSS_CONVERSATION_STATE_KEY, sourceTtlMs, publishTurnSession, clearTurnSession, boundSource } from '../lib/agent/execution-scope.mjs';
import { bindToolSource } from '../lib/agent/tool-binding.mjs';
import { fileAuthority } from '../lib/conversation/task-ownership.mjs';
import { workspaceAction, workspaceDirectory, workspaceRoot, readWorkspaceFile } from '../lib/agent/workspace.mjs';
import { observeFloor, checkFloor } from '../lib/conversation/floor.mjs';
import { rig, message, request, response } from './helpers/bridge.mjs';
import { replyJournal } from '../lib/delivery/reply-journal.mjs';
import { InputBatches } from '../lib/conversation/input-batches.mjs';
import { Config } from '../lib/config.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-task-routing-')), stores = [], rigs = [];
const realFetch = globalThis.fetch;
let passed = 0, failed = 0;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const until = async (fn, timeout = 2000) => { const start = Date.now(); while (!fn()) { if (Date.now()-start > timeout) throw new Error('condition timeout'); await pause(5); } };
async function test(name, fn) { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name, e.stack); } }
function make(over = {}, llm = null) {
  const store = new Store(path.join(root, `${stores.length}.sqlite3`)); stores.push(store);
  const r = rig({ groupTrigger: 'all', selfIds: ['100'], taskRoutingMode: 'enabled',
    floorManagementEnabled: true, replyTimeoutMs: 10000, dialogueSessionMode: 'task', ...over }, '完成了本轮回答', store, llm);
  r.store = store; r.state.replyJournal ??= replyJournal(store); rigs.push(r); return r;
}
const route = (action = 'new', taskId = null, ids = ['1']) => ({ action, taskId, confidence: 1, evidenceIds: ids, reason: 'test-evidence' });
function admit(r, id = 1, text = '写程序', user = 200, group = 10, decision = route()) {
  const e = { ...message(id,text,group,user), __inputId: `100:${id}`, __receivedAt: Date.now() };
  observeFloor(r.config,r.registry,`group:${group}`,e);
  r.registry.record(r.registry.entry(`group:${group}`), { messageId: String(id), qq: String(user), who: String(user), text, at: Date.now(), bot: false });
  return r.state.taskRouting.admit(`group:${group}`,e,decision);
}

try {
  await test('辅助判断调用优先用 auxProvider/auxModel，未配则回落主模型，专用键压过 aux', async () => {
    const r = make({ auxProvider: 'auxP', auxModel: 'auxM', llmProvider: 'mainP', llmModel: 'mainM' });
    const sel = configSelection(r.ctx, r.config);
    assert.equal(sel.provider, 'auxP'); assert.equal(sel.model, 'auxM');
    // 短分类默认档位是 'off'。除了 a6api，其他 provider（deepseek-official 等）认这个值，
    // 必须**显式发**，否则会落到 provider 默认档（官方会话实测默认 high）继续思考。
    assert.equal(sel.reasoningEffort, 'off', '非 a6api 的 provider 要显式发 off');
    // a6api 的 Responses 路由拒绝任何显式档位（'off' 与默认 'max' 都报
    // UNSUPPORTED_REASONING_EFFORT），表现为 0ms 零正文的错误结束帧 —— 只能不发这个字段。
    const rA6 = make({ auxProvider: 'a6api', auxModel: 'auxM' });
    const selA6 = configSelection(rA6.ctx, rA6.config);
    assert.equal(selA6.reasoningEffort, undefined, 'a6api 必须省略思考档位字段');
    const r2 = make({ llmProvider: 'mainP', llmModel: 'mainM' });
    const sel2 = configSelection(r2.ctx, r2.config);
    assert.equal(sel2.provider, 'mainP'); assert.equal(sel2.model, 'mainM');
    const sel3 = auxSelection(r.ctx, r.config, { provider: 'hbP', model: 'hbM' });
    assert.equal(sel3.provider, 'hbP'); assert.equal(sel3.model, 'hbM', '心跳/记忆专用键必须优先');
  });

  await test('conversation mode serializes coordination for two authors without creating task Sessions or overwriting a live source', async () => {
    const r=make({dialogueSessionMode:'conversation'}),blocked=gate();
    r.ctx.sessionController.follow=()=>({async *[Symbol.asyncIterator](){
      yield {type:'snapshot',cursor:0};await blocked.promise;
      yield {type:'event',event:{seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:'归属明确的结果'}]}}}};
      yield {type:'event',event:{seq:2,type:'turn/end'}};
    }});
    try {
      const a=admit(r,1,'请求 A',200);r.state.taskScheduler.pump();await until(()=>r.prompts.length===1);
      const session=r.prompts[0].sessionId,ref=r.store.getState('qq-bridge:execution-session:'+session);
      const b=admit(r,2,'请求 B',300);r.state.taskScheduler.pump();await pause(20);
      assert.equal(r.prompts.length,1);assert.equal(r.store.getState('qq-bridge:execution-session:'+session),ref);
      assert.notEqual(a.task_id,b.task_id);assert.equal(r.registry.taskEntries?.size??0,0);
      blocked.resolve();await until(()=>r.prompts.length===2 && r.state.taskScheduler.active.size===0);
      assert.equal(r.prompts[1].sessionId,session);
      assert.match(r.prompts[1].content[0].text,new RegExp(b.task_id));
    } finally {blocked.resolve();await until(()=>r.state.taskScheduler.active.size===0);}
  });
  await test('a numeric interjection keeps shared history and uses the shared conversation workspace', async () => {
    const r = make(), blocked = gate();
    r.ctx.sessionController.follow = ({address}) => ({ async *[Symbol.asyncIterator]() {
      yield { type:'snapshot',cursor:0 };
      if (address.sessionId === 's1') await blocked.promise;
      yield { type:'event',event:{seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:'本轮回答'}]}}}};
      yield { type:'event',event:{seq:2,type:'turn/end'}};
    }});
    try {
      const original = admit(r,1,'写一份docs文档，内容是荒漠迷城的战术纸');
      r.state.taskScheduler.pump(); await until(()=>r.prompts.length===1);
      const other = admit(r,2,'34',300); r.state.taskScheduler.pump(); await until(()=>r.prompts.length===2);
      const prompt=r.prompts[1].content[0].text;
      assert.match(prompt,/写一份docs文档/); assert.match(prompt,/只处理上述消息 ID/);
      assert.doesNotMatch(prompt,/其他窗口任务|"authority":|"files":false/);
      assert.match(prompt,new RegExp(other.task_id));
      const scoped=taskRegistry(r.registry,r.state.taskRouting,other.task_id);
      const ref=r.store.getState('qq-bridge:execution-session:'+scoped.entry('group:10').sessionId) ||
        r.state.replyJournal.get(r.state.taskRouting.execution(other.id).turn_id)?.meta.sourceRef;
      // The second model may have finished already; republish its source to
      // exercise the conversation-scoped workspace guard.
      publishExecutionSource(r.store,ref,{conversation:'group:10',taskId:other.task_id,taskVersion:other.data.taskVersion,
        sessionId:scoped.entry('group:10').sessionId,workspaceScope:scoped.entry('group:10').workspaceScope,
        authority:other.data.authority,expiresAt:Date.now()+60000});
      const invoke=(name,arguments_)=>executionToolGuard(r.store,r.config,{name,arguments:arguments_,agent:{session:{id:scoped.entry('group:10').sessionId}}});
      assert.match(invoke('mcp__document-editor__create_word_document',{}),/output_path/);
      for(const [name,args] of [['mcp__qq__qq_workspace',{action:'write',source_ref:ref,path:'copy.txt',content:'shared'}],
        ['mcp__qq__qq_workspace',{action:'pack',source_ref:ref,output:'copy.zip'}]])
        assert.equal(invoke(name,args),undefined);
      assert.equal(invoke('mcp__qq__qq_send_file',{source_ref:ref,path:'copy.txt'}),undefined);
      assert.equal(invoke('mcp__qq__qq_workspace',{action:'list',source_ref:ref}),undefined);
      const originalSession=r.prompts[0].sessionId,originalRef=r.store.getState('qq-bridge:execution-session:'+originalSession);
      const originalSource=JSON.parse(r.store.getState('qq-bridge:execution-source:'+originalRef));
      assert.equal(originalSource.authority.files,true);
      assert.equal(executionToolGuard(r.store,r.config,{name:'mcp__document-editor__create_word_document',
        arguments:{output_path:path.join(workspaceDirectory(workspaceRoot(r.config),originalSource.workspaceScope),'result.docx')},
        agent:{session:{id:originalSession}}}),undefined);
      assert.equal(r.state.taskRouting.execution(original.id).state,'following');
    } finally { blocked.resolve(); await until(()=>r.state.taskScheduler.active.size===0); }
  });
  await test('identical active requests from either author are queries, including a stale new admission verdict', async () => {
    const r=make(),original=admit(r,1,'请写一份战术文档');
    for(const user of [200,300]) {
      const verdict=await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(2,'请写一份战术文档！',10,user));
      assert.equal(verdict.action,'query'); assert.equal(verdict.taskId,original.task_id);
    }
    const repeated=admit(r,3,'请写一份战术文档',300);
    assert.equal(repeated.data.detached,true); assert.equal(repeated.data.referencedTaskId,original.task_id);
    assert.equal(repeated.data.authority.files,false);
    assert.equal(r.state.taskRouting.execution(original.id).state,'queued');
  });
  await test('active work remains a routing candidate after more than twelve recent conversations', async () => {
    let result;
    const r=make({}, {async *stream(){yield {type:'text-delta',text:JSON.stringify(result)};}}),original=admit(r,1,'请写长文档');
    for(let i=2;i<20;i++) { const e=admit(r,i,'聊天'+i);r.state.taskRouting.setExecution(e.id,'model_finished');
      r.store.db.prepare("UPDATE bridge_task_entities SET state='model_finished',updated_at=? WHERE id=?").run(Date.now()+i,e.task_id); }
    assert.ok(r.state.taskRouting.tasks('group:10').some(t=>t.id===original.task_id));
    const e=message(22,'继续');e.message.unshift({type:'reply',data:{id:1}});
    result=route('query',original.task_id,['1','22']);
    const verdict=await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',e);
    assert.equal(verdict.action,'query');assert.equal(verdict.taskId,original.task_id);
  });
  await test('file authority uses complete owned batches and only explicit followups inherit it', async () => {
    assert.equal(fileAuthority([message(1,'34')],200,{data:{fileAuthorized:true}},'new').files,false);
    assert.equal(fileAuthority([message(1,'写一份'),message(2,'荒漠迷城的docs文档')],200).files,true);
    assert.equal(fileAuthority([message(1,'34'),message(2,'写文档',10,300)],200).files,false);
    assert.equal(fileAuthority([message(1,'改成蓝色')],200,{data:{fileAuthorized:true}},'amend').files,true);
    assert.equal(fileAuthority([message(1,'34')],200,{data:{fileAuthorized:true}},'continue').files,false);
  });
  await test('old in-flight sources keep the conversation workspace after HMR', async () => {
    const r=make(),e=admit(r,1,'34',300);
    const data={...e.data};delete data.authority;
    r.store.db.prepare('UPDATE bridge_executions SET data=? WHERE id=?').run(JSON.stringify(data),e.id);
    publishExecutionSource(r.store,'old',{conversation:'group:10',taskId:e.task_id,executionId:e.id,taskVersion:e.data.taskVersion,
      sessionId:'old-session',workspaceScope:'group:10/'+e.task_id,expiresAt:Date.now()+60000});
    assert.equal(assertExecutionSource(r.store,{ref:'old',conversation:'group:10'}).authority.files,false);
    assert.match(executionToolGuard(r.store,r.config,{name:'mcp__document-editor__create_word_document',arguments:{},agent:{session:{id:'old-session'}}}),/output_path/);
  });
  await test('task state follows recovery and declined executions instead of leaving stale running or queued labels', async () => {
    const r=make(),e=admit(r);r.state.taskRouting.setExecution(e.id,'recovering');
    assert.equal(r.state.taskRouting.get(e.task_id).state,'recovering');
    r.state.taskRouting.setExecution(e.id,'needs_attention');assert.equal(r.state.taskRouting.get(e.task_id).state,'needs_attention');
    const old=admit(r,2,'旁听'),data={...old.data};delete data.taskVersion;
    r.store.db.prepare("UPDATE bridge_executions SET state='declined',data=? WHERE id=?").run(JSON.stringify(data),old.id);
    r.state.taskRouting.sweep();assert.equal(r.state.taskRouting.get(old.task_id).state,'declined');
    const failed=admit(r,3,'写文档');r.state.taskRouting.summary(failed.task_id,failed,{reply:'失败了',failure:'tool-error'});
    r.state.taskRouting.setExecution(failed.id,'model_finished');assert.equal(r.state.taskRouting.get(failed.task_id).state,'failed');
    const waiting=admit(r,4,'写另一个程序');r.state.taskRouting.summary(waiting.task_id,waiting,{reply:'[WAIT]'});
    r.state.taskRouting.setExecution(waiting.id,'model_finished');assert.equal(r.state.taskRouting.get(waiting.task_id).state,'waiting_input');
  });
  await test('incomplete semantic routing defaults to shadow and keeps the legacy path', async () => {
    assert.equal(Config({}).taskRoutingMode, 'shadow');
  });
  await test('stable topics/tasks differ from executions and duplicate admission is atomic', async () => {
    const r = make(), first = admit(r), second = admit(r,2,'补充：红色',200,10,route('amend',first.task_id,['1','2']));
    assert.equal(first.task_id,second.task_id); assert.notEqual(first.id,second.id);
    assert.notEqual(r.state.taskRouting.get(first.task_id).topic_id,first.task_id);
    assert.equal(r.state.taskRouting.execution(first.id).state,'superseded');
    assert.equal(admit(r,2,'补充：红色',200,10,route('amend',first.task_id,['1','2'])).id,second.id);
    assert.equal(r.store.db.prepare('SELECT COUNT(*) n FROM bridge_input_routes').get().n,2);
  });
  await test('a long task does not hold the ordinary ingress or a short question Session', async () => {
    const r = make({}, {async *stream(){yield {type:'text-delta',text:JSON.stringify(route('new',null,['12']))};}}), blocked = gate();
    r.ctx.sessionController.follow = ({address}) => ({ async *[Symbol.asyncIterator]() {
      yield { type:'snapshot',cursor:0 };
      if (address.sessionId === 's1') await blocked.promise;
      yield { type:'event',event:{seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:'本轮结果'}]}}}};
      yield { type:'event',event:{seq:2,type:'turn/end'}};
    }});
    try {
      await r.handler(request(message(11,'帮我写一个程序')),response()); await until(() => r.prompts.length===1);
      await r.handler(request(message(12,'北京在哪里',10,300)),response());
      await until(() => r.prompts.length===2); await r.sendQueue.flush();
      assert.notEqual(r.prompts[0].sessionId,r.prompts[1].sessionId);
      assert.equal(r.state.taskScheduler.active.size,1);
      assert.ok(r.calls.some((c) => c.action==='send_group_msg'));
    } finally { blocked.resolve(); await until(() => r.state.taskScheduler.active.size===0); }
  });
  await test('same-author independent input batches get independent tasks, not an implicit amendment', async () => {
    const r = make(); await r.state.taskScheduler.admit('group:10',[message(1,'写程序')],{});
    await r.state.taskScheduler.admit('group:10',[message(2,'解释月亮')],{});
    await until(() => r.state.taskScheduler.active.size===0);
    const tasks = r.state.taskRouting.tasks('group:10'); assert.equal(tasks.length,2); assert.notEqual(tasks[0].id,tasks[1].id);
  });
  await test('查询排成自己的一轮 DSH 执行，不直连模型自答也不抢走原任务', async () => {
    let original;
    const r=make({dialogueSessionMode:'conversation',taskConcurrency:1,taskConversationConcurrency:1},
      {async *stream(req){yield {type:'text-delta',text:req.system.includes('归属路由器')
        ? JSON.stringify(route('query',original.task_id,['1','2'])) : '原写作任务仍在执行中'};}}),blocked=gate();
    r.ctx.sessionController.follow=()=>({async *[Symbol.asyncIterator](){yield {type:'snapshot',cursor:0};await blocked.promise;
      yield {type:'event',event:{seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:'写作完成'}]}}}};
      yield {type:'event',event:{seq:2,type:'turn/end'}};}});
    try {
      original=admit(r,1,'写一篇小说');r.state.taskScheduler.pump();await until(()=>r.prompts.length===1);
      await r.handler(request(message(2,'怎么样，可以写吗？')),response());
      assert.equal(r.state.taskRouting.execution(original.id).state,'following');
      assert.equal(r.state.taskRouting.get(original.task_id).owner,'200','查询不接管原任务');
      await until(()=>r.store.db.prepare("SELECT COUNT(*) n FROM bridge_executions WHERE json_extract(data,'$.detached')=1").get().n===1);
      const pending=r.store.db.prepare("SELECT data FROM bridge_executions WHERE json_extract(data,'$.detached')=1").all();
      assert.equal(pending.length,1,'查询要落成自己的一枚执行');
      assert.equal(JSON.parse(pending[0].data).route.action,'query');
      assert.equal(r.prompts.length,1,'长回合让出链路前不并发抢跑');
    } finally {blocked.resolve();}
    await until(()=>r.prompts.length===2);
    await until(()=>r.store.db.prepare("SELECT COUNT(*) n FROM bridge_executions WHERE json_extract(data,'$.detached')=1 AND state='model_finished'").get().n===1);
    await r.sendQueue.flush();
    assert.equal(r.state.taskRouting.get(original.task_id).owner,'200');
    await until(()=>r.state.taskScheduler.active.size===0);
  });
  await test('task Sessions persist beyond the old three-turn rotation and survive reload', async () => {
    const r = make({rotateEveryTurns:3}), e = admit(r), shared = r.registry.entry('group:10');
    r.registry.record(shared, { messageId: 'background', qq: '300', who: '旁观者', text: '刚才群里的背景', at: Date.now() - 1000, bot: false });
    const scoped = taskRegistry(r.registry,r.state.taskRouting,e.task_id);
    assert.ok(scoped.entry('group:10').window.some((m) => m.messageId === 'background'), '任务 Session 必须保留共享上下文');
    const session = await scoped.ensureSession('group:10'); scoped.entry('group:10').turns=10; scoped.persist('group:10');
    assert.equal(await scoped.ensureSession('group:10'),session);
    r.registry.taskEntries.clear(); assert.equal(await taskRegistry(r.registry,r.state.taskRouting,e.task_id).ensureSession('group:10'),session);
    const other=admit(r,2,'别的任务'); assert.notEqual(await taskRegistry(r.registry,r.state.taskRouting,other.task_id).ensureSession('group:10'),session);
  });
  await test('capacity and image guards replace a task Session while retaining factual summary', async () => {
    const r=make({taskContextMaxChars:10000}), e=admit(r), scoped=taskRegistry(r.registry,r.state.taskRouting,e.task_id);
    const first=await scoped.ensureSession('group:10'); scoped.entry('group:10').contextChars=10001;
    const second=await scoped.ensureSession('group:10'); assert.notEqual(first,second);
    scoped.entry('group:10').forceRotate=true; assert.notEqual(await scoped.ensureSession('group:10'),second);
    r.state.taskRouting.summary(e.task_id,e,{reply:'只生成结果，尚无发送回执',endReason:'completed'});
    const summary=r.state.taskRouting.get(e.task_id).data.summary;
    assert.equal(summary.artifactVerified,false); assert.equal(summary.deliveryVerified,false); assert.deepEqual(summary.coveredMessageIds,['1']);
  });
  await test('没有可被 steer 的任务时不调路由模型；变回可 steer 后立刻恢复调用', async () => {
    let calls = 0;
    const llm = { async *stream() {
      calls++;
      yield { type: 'text-delta', text: JSON.stringify(route('new', null, ['2'])) };
    } };
    const r = make({}, llm);
    const e = admit(r, 1, '写个程序');
    // 把它变成"早已结束"：执行终态 + 任务 updated_at 推到 steer 窗口之外。
    r.state.taskRouting.setExecution(e.id, 'model_finished');
    r.store.db.prepare('UPDATE bridge_task_entities SET state=?,updated_at=? WHERE id=?')
      .run('model_finished', Date.now() - 3600000, e.task_id);
    const before = calls;
    const verdict = await r.state.taskRouting.decide(r.ctx, r.registry, 'group:10',
      message(2, '北京天气'), r.state.controller.signal);
    assert.equal(calls, before, '会话里没有可 steer 的任务时不该调模型（这是省掉 2~3 秒的关键）');
    assert.equal(verdict.action, 'new');
    assert.equal(verdict.reason, 'independent-input');

    // 对照：把它变回"有在跑的执行" → 必须恢复调用，否则 amend/continue 会失活。
    r.state.taskRouting.setExecution(e.id, 'following');
    await r.state.taskRouting.decide(r.ctx, r.registry, 'group:10',
      message(3, '改成蓝色'), r.state.controller.signal);
    assert.ok(calls > before, '有可 steer 的任务时必须调模型');
  });

  await test('only owner can amend/cancel; observers can query and cross-conversation IDs fail', async () => {
    const r=make(), e=admit(r), task=r.state.taskRouting.get(e.task_id), router=r.state.taskRouting;
    assert.equal(router.validate('group:10',message(2,'取消',10,300),route('cancel',task.id,['1','2']),[task]).action,'clarify');
    assert.equal(router.validate('group:10',message(2,'好了没',10,300),route('query',task.id,['1','2']),[task]).action,'query');
    assert.throws(() => router.validate('group:11',message(2,'继续',11),route('continue',task.id,['1','2']),[task]));
    assert.throws(() => admit(r,3,'取消',300,10,route('cancel',task.id,['1','3'])));
  });
  await test('amend 无在跑回合时走持久化修订：同一任务新建执行、旧排队执行被 supersede', async () => {
    // 走真实的 TaskScheduler.admit 集成路径（而不是直接调 routing.admit），
    // 这样才覆盖得到"注入不可用 → 落持久化"这个分叉与它的计数。
    let verdict;
    const llm = { async *stream() { yield { type: 'text-delta', text: JSON.stringify(verdict) }; } };
    const r = make({}, llm);
    const first = admit(r, 1, '写一篇同人短篇');
    const task = r.state.taskRouting.get(first.task_id);
    verdict = route('amend', task.id, ['1', '2']);
    const e = { ...message(2, '结尾让她们在一起吧', 10, 200), __inputId: '100:2', __receivedAt: Date.now() };
    observeFloor(r.config, r.registry, 'group:10', e);
    r.registry.record(r.registry.entry('group:10'),
      { messageId: '2', qq: '200', who: '200', text: '结尾让她们在一起吧', at: Date.now(), bot: false });
    assert.equal(await r.state.taskScheduler.admit('group:10', [e]), true);
    assert.equal(r.stats.amendRouted, 1, '裁决为 amend 要被计数');
    assert.equal(r.stats.amendQueued, 1, '没有在跑回合时必须落到持久化修订');
    assert.equal(r.stats.amendInjected ?? 0, 0, '没有在跑回合就不该算注入成功');
    assert.equal(r.state.taskRouting.execution(first.id).state, 'superseded', '未提交的旧排队执行要被取代');
    const rows = r.store.db.prepare("SELECT data FROM bridge_executions WHERE task_id=? AND state!='superseded'").all(task.id);
    assert.equal(rows.length, 1, '修订要落在同一个任务上，不能新建任务');
    const exec = JSON.parse(rows[0].data);
    assert.equal(exec.route.action, 'amend');
    assert.equal(exec.detached, false, 'amend 不是脱离任务的动作');
    assert.equal(r.state.taskRouting.get(task.id).version, task.version + 1, '任务版本要 +1');
  });

  await test('amend 有在跑回合且 agent 可注入时走注入：不新建执行、计入 injected', async () => {
    let verdict;
    const llm = { async *stream() { yield { type: 'text-delta', text: JSON.stringify(verdict) }; } };
    const r = make({}, llm);
    const first = admit(r, 1, '写一篇同人短篇');
    // 把这条执行变成"正在跑"，并挂上活跃的 reply journal 与一个可注入的 agent。
    const turnId = 'group:10#m1';
    r.state.taskRouting.setExecution(first.id, 'following', { turnId });
    const taskNow = r.state.taskRouting.get(first.task_id);
    r.state.taskRouting.setExecution(first.id, 'following', { taskVersion: taskNow.version });
    const exec = r.state.taskRouting.execution(first.id);
    r.state.taskScheduler.active.set(first.id, { ...exec, data: exec.data });
    r.state.replyJournal.begin(turnId, 'group:10',
      { sessionId: 'sess-1', turnId, floorPolicy: { version: 0, originals: [], messageIds: [] } });
    r.state.replyJournal.active.add(turnId);
    const injected = [];
    r.ctx.agents = new Map([['sess-1', { status: 'running', inject: (m) => injected.push(m) }]]);
    verdict = route('amend', first.task_id, ['1', '2']);
    const e = { ...message(2, '结尾让她们在一起吧', 10, 200), __inputId: '100:2', __receivedAt: Date.now() };
    observeFloor(r.config, r.registry, 'group:10', e);
    r.registry.record(r.registry.entry('group:10'),
      { messageId: '2', qq: '200', who: '200', text: '结尾让她们在一起吧', at: Date.now(), bot: false });
    assert.equal(await r.state.taskScheduler.admit('group:10', [e]), true);
    assert.equal(r.stats.amendInjected, 1, '有在跑回合就该注入');
    assert.equal(r.stats.amendQueued ?? 0, 0, '注入成功就不该再排一个修订回合');
    assert.equal(injected.length, 1);
    assert.match(injected[0].content[0].text, /补充/, '注入的是"原请求作者的补充"消息');
    assert.equal(r.stats.humanInterjections, 1);
  });

  await test('route rejects forged evidence, low confidence and unsupported cancellation', async () => {
    const r=make(), e=admit(r), task=r.state.taskRouting.get(e.task_id);
    for(const p of [route('amend',task.id,['999']), {...route('amend',task.id,['1','2']),confidence:.2},route('cancel',task.id,['1','2'])])
      assert.throws(() => r.state.taskRouting.validate('group:10',message(2,'北京在哪里'),p,[task]));
  });
  await test('时间线引用不再让整条裁决作废，伪造 ID 仍被清掉', async () => {
    const r=make(), e=admit(r), task=r.state.taskRouting.get(e.task_id);
    const current=message(3,'北京天气',10,300);
    /**
     * '2' 是模型在提示词时间线里看到的引用证据，不是任务来源。
     * 旧实现在 allowed 之外见一个 ID 就整条丢掉 → invalid-verdict → 白等再退回 new。
     */
    const fresh=r.state.taskRouting.validate('group:10',current,route('new',null,['3','2']),[task],[current],
      {semantic:true,timelineIds:['2']});
    assert.equal(fresh.action,'new');
    assert.deepEqual(fresh.evidenceIds,['3','2'],'可引用的时间线 ID 保留，不属于任何一类的被清掉');
    // 模型偶尔把数组写成字符串：宽容收下，不因此作废整条裁决。
    const asString=r.state.taskRouting.validate('group:10',current,{...route('new',null,['3']),evidenceIds:'3'},
      [task],[current],{semantic:true,timelineIds:['2']});
    assert.equal(asString.action,'new');
    // 伪造的 999 不在输入/任务来源/时间线里：清掉后没有当前消息 ID → 仍然拒。
    assert.throws(()=>r.state.taskRouting.validate('group:10',current,route('new',null,['999']),[task],[current],
      {semantic:true,timelineIds:['2']}));
    // amend 的归属仍必须由任务来源 ID 证明；多引一个伪造 ID 只是被清掉。
    const amend=r.state.taskRouting.validate('group:10',message(4,'改成蓝色',10,200),
      route('amend',task.id,['4','1','999']),[task],[message(4,'改成蓝色',10,200)],{semantic:true,timelineIds:['2']});
    assert.equal(amend.action,'amend');
    assert.deepEqual(amend.evidenceIds,['4','1']);
    assert.throws(()=>r.state.taskRouting.validate('group:10',message(5,'改成蓝色',10,200),
      route('amend',task.id,['999']),[task],[message(5,'改成蓝色',10,200)],{semantic:true,timelineIds:['2']}));
  });
  await test('ambiguous targets clarify without executing either task', async () => {
    const r=make({}, {async *stream(){yield {type:'text-delta',text:JSON.stringify(route('clarify',null,['3']))};}});
    admit(r); admit(r,2,'另一个程序');
    const proposal=await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(3,'取消'),r.state.controller.signal);
    assert.equal(proposal.action,'clarify'); assert.equal(r.prompts.length,0);
  });
  await test('explicit reply amendments reuse the target, while observer replies only read', async () => {
    let result;
    const r=make({}, {async *stream(){yield {type:'text-delta',text:JSON.stringify(result)};}}), e=admit(r), owner=message(2,'改成蓝色');
    result=route('amend',e.task_id,['1','2']);owner.message.unshift({type:'reply',data:{id:1}});
    const decided=await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',owner,r.state.controller.signal);
    assert.equal(decided.action,'amend'); assert.equal(decided.taskId,e.task_id);
    owner.user_id=300; assert.equal((await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',owner)).action,'clarify');
  });
  await test('semantic route uses evidence and cannot expand target permissions', async () => {
    let result; const llm={async *stream(){yield {type:'text-delta',text:JSON.stringify(result)};}};
    const r=make({},llm), e=admit(r); result=route('continue',e.task_id,['1','2']);
    assert.equal((await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(2,'把刚才的逻辑详细讲一下'))).taskId,e.task_id);
    result=route('amend',e.task_id,['1','2']); assert.equal((await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(2,'详讲一下',10,300))).action,'clarify');
    result=route('continue','task-forged',['1','2']); assert.equal((await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(2,'继续'))).action,'new');
  });
  await test('shadow mode records routing but dispatches no new task', async () => {
    const r=make({taskRoutingMode:'shadow'});
    assert.equal(await r.state.taskScheduler.admit('group:10',[message(1,'写程序')]),false);
    assert.equal(r.store.db.prepare('SELECT COUNT(*) n FROM bridge_routes WHERE mode=?').get('shadow').n,1);
    assert.equal(r.store.db.prepare('SELECT COUNT(*) n FROM bridge_executions').get().n,0);
  });
  await test('semantic verdict arriving after a task version change cannot steer stale work', async () => {
    let original;
    const r=make({}, {async *stream(){r.store.db.prepare('UPDATE bridge_task_entities SET version=version+1 WHERE id=?').run(original.task_id);
      yield {type:'text-delta',text:JSON.stringify(route('amend',original.task_id,['1','2']))};}});
    original=admit(r);
    const verdict=await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(2,'结尾让她们在一起吧'));
    assert.equal(verdict.action,'new');assert.equal(verdict.taskId,null);
  });
  await test('shadow observation cannot call a hanging routing model before the ordinary reply', async () => {
    let calls = 0;
    const r = make({ taskRoutingMode: 'shadow', inputDebounceMs: 10, inputShortDebounceMs: 10 },
      { async *stream() { calls++; await new Promise(() => {}); } });
    admit(r);
    await r.handler(request(message(2, '刚才那个继续')), response());
    await until(() => r.prompts.length === 1);
    assert.equal(calls, 0);
    assert.equal(r.state.taskScheduler.snapshot().mode, 'shadow');
  });
  await test('an independent question reaches semantic routing even with existing tasks', async () => {
    let calls = 0;
    const r = make({}, { async *stream() { calls++; yield {type:'text-delta',text:JSON.stringify(route('new',null,['2']))}; } });
    admit(r);
    await r.handler(request(message(2, '北京在哪里', 10, 300)), response());
    await until(() => r.prompts.length === 2);
    assert.equal(calls, 1);
  });
  await test('natural followups, quoted independent questions and non-keyword cancellation use contextual semantics', async () => {
    let result, input, calls=0;
    const r=make({}, {async *stream(request){calls++;input=JSON.parse(request.messages[0].content[0].text);
      yield {type:'text-delta',text:JSON.stringify(result)};}}),e=admit(r,1,'写一篇小说');
    result=route('query',e.task_id,['1','2']);
    assert.equal((await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(2,'怎么样，可以写吗？'))).action,'query');
    assert.equal(input.tasks[0].busy,true);assert.equal(input.tasks[0].sourceMessages[0].text,'写一篇小说');
    result=route('amend',e.task_id,['1','3']);
    assert.equal((await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(3,'结尾让她们在一起吧'))).action,'amend');
    result=route('new',null,['4']);const independent=message(4,'北京天气怎么样');independent.message.unshift({type:'reply',data:{id:1}});
    assert.equal((await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',independent)).action,'new');
    assert.equal(input.referencedTaskId,e.task_id);
    result=route('cancel',e.task_id,['1','5']);
    assert.equal((await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(5,'这篇先别弄了，我不需要了'))).action,'cancel');
    assert.equal(calls,4);
  });
  await test('unavailable or invalid semantic verdicts preserve normal delivery without steering old work', async () => {
    const r=make(),e=admit(r);
    for(const text of ['结尾让她们在一起吧','改成蓝色','北京天气怎么样']) {
      const verdict=await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(2,text));
      assert.equal(verdict.action,'new');assert.equal(verdict.taskId,null);
      assert.deepEqual(verdict.evidenceIds,['2']);assert.equal(verdict.reason,'semantic-route-fallback');
    }
    r.ctx.llm={async *stream(){yield {type:'text-delta',text:JSON.stringify(route('amend',e.task_id,['1']))};}};
    const verdict=await r.state.taskRouting.decide(r.ctx,r.registry,'group:10',message(2,'结尾让她们在一起吧'));
    assert.equal(verdict.action,'new');assert.equal(r.state.taskRouting.get(e.task_id).version,e.data.taskVersion);
  });
  await test('routing outages still submit complete group and private inputs to DSH and deliver final replies', async () => {
    const hanging={stream(){return {[Symbol.asyncIterator](){let timer;return {
      next:()=>new Promise(resolve=>{timer=setTimeout(()=>resolve({done:true}),1000);}),
      return:async()=>{clearTimeout(timer);return {done:true};}};}};}};
    // 空流 = 模型什么都没返回。必须记成 empty-output 而不是 invalid-json：
    // 线上 192 条 invalid-json 的 fallbackDetail 就是空串，把诊断全带偏了。
    const outages=[[null,'unavailable'],[{async *stream(){yield {type:'text-delta',text:'invalid JSON'};}},'invalid-json'],
      [{async *stream(){}},'empty-output'],
      [{async *stream(){yield {type:'reasoning-delta',text:'想了半天'};}},'empty-output'],
      [{async *stream(){throw new Error('provider unavailable');}},'stream-error'],[hanging,'timeout']];
    for(const privateChat of [false,true]) for(const [llm,expectedCause] of outages) {
      const r=make({dialogueSessionMode:'conversation',taskRouteTimeoutMs:20},llm);
      const key=privateChat?'user:200':'group:10';
      const old=admit(r,1,'原写作任务');
      r.state.taskRouting.setExecution(old.id,'recovering',{turnId:'old-rpc'});
      if(privateChat) r.store.db.prepare('UPDATE bridge_task_entities SET conversation=? WHERE id=?').run(key,old.task_id);
      const events=[message(2,'帮我做一个手机版能玩的2D射击游戏，用一个HTML打开'),message(3,'北京天气怎么样')];
      for(const input of events){input.__inputId='100:'+input.message_id;
        if(privateChat){input.message_type='private';delete input.group_id;}}
      assert.equal(await r.state.taskScheduler.admit(key,events),true);
      await until(()=>r.prompts.length===1 && r.state.taskScheduler.active.size===0);
      await r.sendQueue.flush();
      const execution=r.state.taskRouting.execution(r.store.db.prepare('SELECT execution_id FROM bridge_input_routes WHERE message_id=?').get('2').execution_id);
      assert.equal(execution.data.detached,false);assert.notEqual(execution.task_id,old.task_id);
      assert.equal(execution.conversation,key);assert.equal(execution.owner,'200');
      assert.equal(execution.data.route.reason,'semantic-route-fallback');
      assert.equal(r.stats.lastTaskRoute.reason,'semantic-route-fallback');
      // 原因必须能区分这几种故障，否则"白等 4 秒"和"本来就该失败"无从分辨。
      assert.equal(execution.data.route.fallbackCause,expectedCause);
      assert.equal(r.stats.lastTaskRoute.fallbackCause,expectedCause);
      assert.equal(typeof execution.data.route.fallbackDetail,'string');
      // 空输出要写清"收到了什么"：分片、reasoning 段数、耗时，缺一不可。
      if (expectedCause === 'empty-output')
        assert.match(execution.data.route.fallbackDetail,
          /^收到 0 段正文 \/ reasoning \d+ 段 \/ 用时 \d+ms（正文 0 字/);
      assert.deepEqual(execution.data.inputEvents.map(e=>e.message_id),[2,3]);
      assert.equal(r.state.taskRouting.get(old.task_id).version,old.data.taskVersion);
      assert.equal(r.state.taskRouting.execution(old.id).state,'recovering');
      assert.equal(r.state.replyJournal.get(execution.turn_id).meta.inputIds.length,2);
      assert.match(r.prompts[0].content[0].text,/2D射击游戏/);assert.match(r.prompts[0].content[0].text,/北京天气怎么样/);
      const sent=r.calls.filter(c=>c.action===(privateChat?'send_private_msg':'send_group_msg'));
      assert.ok(sent.length>0);assert.match(JSON.stringify(sent),/完成了本轮回答/);
      assert.doesNotMatch(JSON.stringify(sent),/对不起，我的系统出了些问题/);
    }
  });
  await test('cancelled routing admission cannot fall back into a new execution', async () => {
    const r=make({}, {stream(){return {[Symbol.asyncIterator](){return {next:()=>new Promise(()=>{}),return:async()=>({done:true})};}};}});
    admit(r);const controller=new AbortController();
    const pending=r.state.taskScheduler.admit('group:10',[message(2,'新问题')],{signal:controller.signal});
    controller.abort();await assert.rejects(pending,{name:'AbortError'});
    assert.equal(r.store.db.prepare('SELECT COUNT(*) n FROM bridge_executions').get().n,1);
  });
  await test('enabled routing preserves one author burst, passive context and all durable input ownership', async () => {
    const r = make({ inputDebounceMs: 10, inputShortDebounceMs: 40, inputMaxWaitMs: 200 });
    const reaction = message('reaction', '', 10, 300);
    reaction.message = [{ type: 'face', data: { id: 64 } }];
    for (const e of [message('request', '画个小狗'), message('color', '白色的'), reaction, message('hat', '戴帽子')])
      await r.handler(request(e), response());
    await until(() => r.prompts.length === 1);
    await until(() => r.state.taskScheduler.active.size === 0);
    assert.equal(r.store.db.prepare('SELECT COUNT(*) n FROM bridge_executions').get().n, 1);
    const execution = r.state.taskRouting.execution(r.store.db.prepare('SELECT id FROM bridge_executions').get().id);
    assert.deepEqual(execution.data.inputEvents.map((e) => e.message_id), ['request', 'color', 'reaction', 'hat']);
    assert.equal(r.store.db.prepare('SELECT COUNT(*) n FROM bridge_input_routes').get().n, 4);
    const prompt = r.prompts[0].content[0].text;
    for (const text of ['画个小狗', '白色的', '戴帽子']) assert.ok(prompt.includes(text));
    const journal = r.state.replyJournal.get(execution.turn_id);
    assert.equal(journal.meta.inputIds.length, 4);
    assert.equal(journal.meta.floorPolicy.originals.length, 4);
  });
  await test('HMR after batch admission before prompt preserves every routed input exactly once', async () => {
    const r = make();
    const events = [message('request', '画个小狗'), message('color', '白色的')]
      .map((e) => ({ ...e, __inputId: `100:${e.message_id}`, __receivedAt: Date.now() }));
    r.state.inputBatches.add('group:10', events[0]); r.state.inputBatches.add('group:10', events[1]);
    r.state.inputBatches.dispose();
    r.state.taskRouting.admit('group:10', events[0], route('new', null, ['request']), 'enabled', events);
    const restored = new InputBatches({ ...r, config: r.config, registry: r.registry, state: r.state,
      stats: r.stats, run() { throw new Error('must not resubmit'); }, onError() {} });
    restored.restore();
    assert.equal(restored.entry('group:10').events.length, 0);
    restored.dispose();
  });
  await test('disabled turn cap reuses conversation beyond three turns and restores its prompt budget', async () => {
    const r = make({ rotateEveryTurns: 0, conversationContextMaxChars: 10000 });
    const first = await r.registry.ensureSession('group:10');
    const entry = r.registry.entry('group:10'); entry.turns = 30; entry.contextChars = 9999;
    r.registry.persist('group:10'); r.registry.byKey.delete('group:10');
    assert.equal(r.registry.entry('group:10').contextChars, 9999);
    assert.equal(await r.registry.ensureSession('group:10'), first);
    r.registry.entry('group:10').contextChars = 10000;
    assert.notEqual(await r.registry.ensureSession('group:10'), first);
    assert.equal(r.registry.entry('group:10').contextChars, 0);
  });
  await test('cross-conversation send is refused by default and allowed only when the shared switch is on', async () => {
    const r = make({ dialogueSessionMode: 'conversation' });
    const sessionId = await r.registry.ensureSession('group:10');
    // 闸门会先核对任务实体，所以这里必须用真实的 task/execution，不能编一个 ID。
    const e = admit(r, 1, '写个东西');
    const ref = 'ref-cross-test';
    publishExecutionSource(r.store, ref, { conversation: 'group:10', taskId: e.task_id,
      taskVersion: e.data.taskVersion, sessionId, workspaceScope: 'group:10',
      expiresAt: Date.now() + 600000 });
    const invoke = (name, args) => executionToolGuard(r.store, r.config, { name, arguments: args, agent: { session: { id: sessionId } } });
    // 默认关闭：目标必须是本轮会话。
    assert.equal(r.store.getState(CROSS_CONVERSATION_STATE_KEY), null, 'switch must be absent until published');
    assert.match(invoke('mcp__qq__qq_say', { source_ref: ref, conversation: 'group:11', text: '去别的群' }), /目标必须属于当前任务会话/);
    assert.match(invoke('mcp__qq__qq_send_group_msg', { source_ref: ref, group_id: 11, message: 'x' }), /目标必须属于当前任务会话/);
    assert.equal(invoke('mcp__qq__qq_say', { source_ref: ref, conversation: 'group:10', text: '本群' }), undefined);
    // 打开开关后放行跨会话；归属来自 Session 注入，模型自填的 source_ref 不再参与判定。
    r.store.setState(CROSS_CONVERSATION_STATE_KEY, 'true');
    assert.equal(invoke('mcp__qq__qq_say', { source_ref: ref, conversation: 'group:11', text: '去别的群' }), undefined);
    assert.equal(invoke('mcp__qq__qq_send_group_msg', { source_ref: ref, group_id: 11, message: 'x' }), undefined);
    assert.equal(invoke('mcp__qq__qq_say', { source_ref: 'other-ref', conversation: 'group:11', text: 'x' }), undefined);
    // 文件仍绑定创建它的会话工作区，跨会话开关不解除这层归属。
    assert.match(invoke('mcp__qq__qq_send_file', { source_ref: ref, conversation: 'group:11', path: 'a.zip' }), /文件属于当前 QQ 会话工作区/);
    assert.equal(invoke('mcp__qq__qq_send_file', { source_ref: ref, conversation: 'group:10', path: 'a.zip' }), undefined);
  });
  await test('closing a source clears its Session pointer so later non-task turns are not judged by a stale lease', async () => {
    const r = make({ dialogueSessionMode: 'conversation' });
    const sessionId = await r.registry.ensureSession('group:10');
    const e = admit(r, 1, '写个东西');
    const ref = 'ref-pointer-test';
    publishExecutionSource(r.store, ref, { conversation: 'group:10', taskId: e.task_id,
      taskVersion: e.data.taskVersion, sessionId, workspaceScope: 'group:10',
      expiresAt: Date.now() + 600000 });
    assert.equal(r.store.getState('qq-bridge:execution-session:' + sessionId), ref);
    closeExecutionSource(r.store, ref);
    // 指针必须清空：否则同一 Session 之后的心跳/戳回合会被按已关闭的旧来源拒绝。
    assert.equal(r.store.getState('qq-bridge:execution-session:' + sessionId), '', 'dangling session pointer must be cleared');
    assert.equal(executionToolGuard(r.store, r.config, { name: 'mcp__qq__qq_say',
      arguments: { conversation: 'group:10', text: '心跳回合的发言' }, agent: { session: { id: sessionId } } }), undefined,
      'a non-task turn must fall back instead of inheriting the closed source');
  });
  await test('source TTL matches the memory_origins window so neither check expires first', async () => {
    // 4 分钟 vs 10 分钟的两套时钟会造成"第 4～10 分钟第一道放行、第二道报错"。
    assert.equal(sourceTtlMs({ replyTimeoutMs: 180000 }), 600000);
    assert.equal(sourceTtlMs({ replyTimeoutMs: 10000 }), 600000);
    assert.equal(sourceTtlMs({ replyTimeoutMs: 900000 }), 960000);
  });

  await test('twenty-turn dialogue lifecycle survives reload, refreshes persona and never reuses the old Session', async () => {
    assert.equal(Config({}).rotateEveryTurns,20);
    const r=make({dialogueSessionMode:'conversation',persona:'LIFECYCLE-PERSONA'});
    const first=await r.registry.ensureSession('group:10');
    const privateSession=await r.registry.ensureSession('user:200');
    workspaceAction(workspaceRoot(r.config),'group:10',{action:'write',path:'lifecycle.txt',content:'保留文件'});
    for(let n=1;n<=21;n++) {
      const e=admit(r,n,'生命周期消息'+n);r.state.taskScheduler.pump();
      await until(()=>r.state.taskRouting.execution(e.id).state==='model_finished' && r.state.taskScheduler.active.size===0);
      assert.equal(r.prompts.length,n);
      if(n<=20) assert.equal(r.prompts[n-1].sessionId,first);
      const entry=r.registry.entry('group:10');
      assert.equal(entry.turns,n<=20?n:1);
      if(n===10) {
        entry.contextChars=60001; // Character estimates no longer shorten a fixed lifecycle.
        r.registry.persist('group:10');r.registry.byKey.delete('group:10');
        assert.equal(r.registry.entry('group:10').turns,10);
      }
      if(n===20) {r.registry.persist('group:10');r.registry.byKey.delete('group:10');}
    }
    const next=r.prompts[20].sessionId;assert.notEqual(next,first);
    assert.equal(await r.registry.ensureSession('group:10'),next);
    assert.equal(await r.registry.ensureSession('user:200'),privateSession);
    assert.match(r.prompts[20].content[0].text,/LIFECYCLE-PERSONA/);
    assert.doesNotMatch(r.prompts[19].content[0].text,/LIFECYCLE-PERSONA/);
    assert.equal(readWorkspaceFile(workspaceRoot(r.config),'group:10','lifecycle.txt').toString(),'保留文件');
    const restored=new TaskScheduler({...r,config:r.config,store:r.store,sendQueue:r.sendQueue});restored.restore();
    await pause(10);assert.equal(r.prompts.length,21);
  });
  await test('cancel is scoped to one task even with the same owner; queued work is stopped', async () => {
    const r=make(), a=admit(r), b=admit(r,2,'第二项程序');
    admit(r,3,'取消 '+a.task_id,200,10,route('cancel',a.task_id,['1','3']));
    assert.equal(r.state.taskRouting.execution(a.id).state,'cancelled');
    assert.equal(checkFloor(r.store,'group:10',{stableTaskId:a.task_id,messageIds:['1']}).reason,'request-cancelled');
    assert.equal(checkFloor(r.store,'group:10',{stableTaskId:b.task_id,messageIds:['2']}).action,'keep');
  });
  await test('amendment invalidates only the earlier revision of its task', async () => {
    const r=make(), a=admit(r), b=admit(r,2,'第二任务');
    admit(r,3,'改成蓝色',200,10,route('amend',a.task_id,['1','3']));
    assert.equal(checkFloor(r.store,'group:10',{stableTaskId:a.task_id,taskVersion:a.data.taskVersion}).reason,'request-updated');
    assert.equal(checkFloor(r.store,'group:10',{stableTaskId:b.task_id,taskVersion:b.data.taskVersion}).action,'keep');
  });
  await test('conversation workspaces share files across tasks and reject traversal', async () => {
    const r=make(), a=admit(r), b=admit(r,2,'其他'), workspace=path.join(root,'files');
    const ra=taskRegistry(r.registry,r.state.taskRouting,a.task_id), rb=taskRegistry(r.registry,r.state.taskRouting,b.task_id);
    const sa=ra.entry('group:10').workspaceScope, sb=rb.entry('group:10').workspaceScope;
    assert.equal(sa,'group:10'); assert.equal(sb,sa);
    rb.entry('group:10').workspaceScope='group:10/'+b.task_id;
    assert.equal(taskRegistry(r.registry,r.state.taskRouting,b.task_id).entry('group:10').workspaceScope,sa);
    workspaceAction(workspace,sa,{action:'write',path:'main.py',content:'A'});
    assert.equal(readWorkspaceFile(workspace,sb,'main.py').toString(),'A');
    assert.throws(()=>readWorkspaceFile(workspace,'group:11','main.py'));
    assert.throws(()=>readWorkspaceFile(workspace,'user:10','main.py'));
    assert.throws(()=>workspaceDirectory(workspace,'group:10/'+a.task_id));
    assert.throws(()=>readWorkspaceFile(workspace,sa,'../other/main.py'));
    assert.throws(()=>workspaceDirectory(workspace,'group:10/task-../../other'));
  });
  await test('execution leases do not overwrite or clear other tasks and reject closed/stale versions', async () => {
    const r=make(), a=admit(r), b=admit(r,2,'其他');
    const lease=(e,ref)=>publishExecutionSource(r.store,ref,{conversation:'group:10',taskId:e.task_id,executionId:e.id,
      taskVersion:e.data.taskVersion,workspaceScope:'group:10',expiresAt:Date.now()+60000});
    lease(a,'source-a');lease(b,'source-b'); assert.equal(activeExecutionSources(r.store).length,2);
    closeExecutionSource(r.store,'source-a'); assert.equal(activeExecutionSources(r.store).length,1);
    assert.throws(()=>assertExecutionSource(r.store,{ref:'source-a',conversation:'group:10'}));
    assert.equal(assertExecutionSource(r.store,{ref:'source-b',conversation:'group:10'}).taskId,b.task_id);
    admit(r,3,'改成蓝色',200,10,route('amend',b.task_id,['2','3']));
    assert.throws(()=>assertExecutionSource(r.store,{ref:'source-b',conversation:'group:10'}));
  });
  await test('查询与澄清也由 DSH 回答：提交真实提示词，但不接管原任务', async () => {
    const r=make(), original=admit(r); r.state.taskRouting.setExecution(original.id,'recovering',{turnId:'long'});
    r.state.replyJournal.begin('long','group:10',{event:message(1,'写程序'),requestId:'old-rpc',sessionId:'old-session'});
    const e=admit(r,2,'进度如何',300,10,route('query',original.task_id,['1','2']));
    assert.equal(e.data.detached,true); assert.equal(e.data.referencedTaskId,original.task_id);
    assert.equal(e.data.authority.files,false,'脱离原任务的查询不能借用写文件权限');
    r.state.taskScheduler.pump(); await until(()=>r.state.taskRouting.execution(e.id).state==='model_finished');
    await r.sendQueue.flush();
    assert.equal(r.prompts.length,1,'查询必须经 DSH 回答，不许桥自己生成');
    assert.equal(r.state.taskRouting.get(original.task_id).owner,'200','查询不许抢走原任务');
    assert.equal(r.state.taskRouting.execution(original.id).state,'recovering','原执行不被改写');
  });
  await test('clarify 没有任务指向也建成自己的 DSH 回合，不再有无人设的旁路澄清', async () => {
    // 线上 2026-10-20 12:18：'现在知道谁是谁了' 被判 clarify 后桥自己生成
    // 「你指的是哪件事？请说说具体指向」。现在任何正文都必须经 DSH。
    const r = make({}, { async *stream(req) {
      yield { type: 'text-delta', text: /归属路由器/.test(req.system ?? '')
        ? JSON.stringify(route('clarify', null, ['1', '2'])) : '你说的是刚才那件事吗' };
    } });
    const original = admit(r, 1, '写个程序');
    r.state.taskRouting.setExecution(original.id, 'following');
    const e = { ...message(2, '现在知道谁是谁了'), __inputId: '100:2', __receivedAt: Date.now() };
    observeFloor(r.config, r.registry, 'group:10', e);
    r.registry.record(r.registry.entry('group:10'),
      { messageId: '2', qq: '200', who: '200', text: '现在知道谁是谁了', at: Date.now(), bot: false });
    assert.equal(await r.state.taskScheduler.admit('group:10', [e]), true, '澄清也要进调度器');
    const rows = r.store.db.prepare("SELECT data FROM bridge_executions WHERE json_extract(data,'$.detached')=1").all();
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].data).route.action, 'clarify');
    r.state.taskScheduler.pump();
    await until(() => r.prompts.length === 1);
    assert.equal(r.state.taskRouting.get(original.task_id).owner, '200');
  });
  await test('reload of an owned uncertain prompt never submits another model request', async () => {
    const r=make(), e=admit(r); r.state.replyJournal.begin('old','group:10',{event:message(1,'写程序'),requestId:'rpc-old',sessionId:'old-session'});
    r.state.taskRouting.setExecution(e.id,'following',{turnId:'old'});
    const scheduler=new TaskScheduler({...r,config:r.config,store:r.store,sendQueue:r.sendQueue});scheduler.restore();
    await pause(20); assert.equal(r.prompts.length,0); assert.equal(scheduler.routing.execution(e.id).state,'recovering');
  });
  await test('reload before onBeforePrompt safely resumes a durable queued execution', async () => {
    const r=make(),e=admit(r);r.state.taskRouting.setExecution(e.id,'starting');r.state.taskScheduler.restore();
    await until(()=>r.prompts.length===1);await until(()=>r.state.taskScheduler.active.size===0);
    assert.equal(r.state.taskRouting.execution(e.id).state,'model_finished');
  });
  await test('owned outcome recovery creates a factual summary without resubmission', async () => {
    const r=make(),e=admit(r);r.state.replyJournal.begin('old','group:10',{event:message(1,'写程序')});
    r.state.replyJournal.output('old',{reply:'结果',endReason:'completed'});
    r.state.taskRouting.setExecution(e.id,'recovering',{turnId:'old'});r.state.taskScheduler.restore();
    assert.equal(r.prompts.length,0);assert.equal(r.state.taskRouting.get(e.task_id).data.summary.result,'结果');
  });
  await test('scheduler bounds parallel work and serves another group before a flood drains', async () => {
    const r=make({taskConcurrency:2,taskConversationConcurrency:1}),blocked=gate(),starts=[];
    r.state.taskScheduler.run=async(e)=>{starts.push(e.conversation);await blocked.promise;r.state.taskRouting.setExecution(e.id,'model_finished');};
    for(let n=1;n<=10;n++)admit(r,n,'任务'+n,200,10);
    admit(r,99,'另群任务',300,11);r.state.taskScheduler.pump();
    await until(()=>starts.length===2);assert.deepEqual(new Set(starts),new Set(['group:10','group:11']));assert.equal(r.state.taskScheduler.active.size,2);
    blocked.resolve();await until(()=>r.state.taskScheduler.active.size===0);
  });
  await test('same task queue is serialized; unresolved prior ownership blocks only that task', async () => {
    const r=make(),a=admit(r);r.state.taskRouting.setExecution(a.id,'recovering',{turnId:'unknown'});
    const follow=admit(r,2,'改成蓝色',200,10,route('amend',a.task_id,['1','2'])),other=admit(r,3,'另一问题',300);
    r.state.taskScheduler.pump();await until(()=>r.state.taskRouting.execution(other.id).state==='model_finished');
    assert.equal(r.state.taskRouting.execution(follow.id).state,'queued');assert.equal(r.prompts.length,1);
  });
  await test('WAIT expiry becomes visible attention and idle final tasks archive without losing pending ownership', async () => {
    const r=make({taskWaitExpiryMs:1000,taskIdleArchiveMs:1000}),a=admit(r),b=admit(r,2,'第二');
    r.store.db.prepare("UPDATE bridge_task_entities SET state='waiting_input',updated_at=? WHERE id=?").run(1,a.task_id);
    r.store.db.prepare("UPDATE bridge_task_entities SET state='model_finished',updated_at=? WHERE id=?").run(1,b.task_id);
    r.state.taskRouting.sweep(3000);assert.equal(r.state.taskRouting.get(a.task_id).state,'needs_attention');assert.equal(r.state.taskRouting.get(b.task_id).state,'model_finished');
    r.state.taskRouting.setExecution(b.id,'model_finished');r.state.taskRouting.sweep(4000);assert.equal(r.state.taskRouting.get(b.task_id).state,'archived');
  });
  await test('summary does not overwrite a newer task revision or authorize artifacts', async () => {
    const r=make(),a=admit(r);admit(r,2,'改为蓝色',200,10,route('amend',a.task_id,['1','2']));
    r.state.taskRouting.summary(a.task_id,a,{reply:'旧结果',endReason:'completed',taskResultReady:true});
    assert.equal(r.state.taskRouting.get(a.task_id).data.summary,undefined);
  });
  await test('host injects the turn source so qq_poke / qq_react never need a model-supplied key', async () => {
    const r = make({ dialogueSessionMode: 'conversation' });
    const sessionId = await r.registry.ensureSession('group:10');
    const e = admit(r, 1, '戳一下 GPT');
    const ref = 'ref-poke-regression';
    publishExecutionSource(r.store, ref, { conversation: 'group:10', taskId: e.task_id,
      taskVersion: e.data.taskVersion, sessionId, workspaceScope: 'group:10', expiresAt: Date.now() + 600000 });
    publishTurnSession(r.store, sessionId, { conversation: 'group:10', sourceRef: ref });
    const invoke = (name, args) => executionToolGuard(r.store, r.config,
      { name, arguments: args, agent: { session: { id: sessionId } } });
    // 截图里的原故障：poke 的 schema 没有 source_ref，模型不可能填；旧 guard 因此永远拒绝。
    assert.equal(invoke('mcp__qq__qq_poke', { group_id: 10, user_id: 200 }), undefined);
    assert.equal(invoke('mcp__qq__qq_react', { message_id: '1', emoji_id: 128077 }), undefined);
    // 模型乱填一个来源也不影响判定：归属只认宿主按 Session 绑定的那一条。
    assert.equal(invoke('mcp__qq__qq_poke', { group_id: 10, user_id: 200, source_ref: 'forged' }), undefined);
    clearTurnSession(r.store, sessionId);
    assert.equal(boundSource(r.store, sessionId)?.sourceRef, ref, '任务回合仍可按执行来源解析归属');
  });
  await test('tool dispatch replaces frozen arguments with the host-injected source', async () => {
    const r = make({ dialogueSessionMode: 'conversation' });
    const sessionId = await r.registry.ensureSession('group:10');
    const ref = 'ref-inject';
    publishTurnSession(r.store, sessionId, { conversation: 'group:10', sourceRef: ref });
    const exec = { name: 'mcp__qq__qq_poke',
      arguments: Object.freeze({ group_id: 10, user_id: 200 }), agent: { session: { id: sessionId } } };
    bindToolSource(r.store, exec);
    assert.equal(exec.arguments.source_ref, ref, '宿主注入的来源必须出现在派发参数里');
    assert.equal(exec.arguments.group_id, 10);
    assert.deepEqual(Object.keys(exec.arguments).sort(), ['group_id', 'source_ref', 'user_id']);
    // 模型自填的值会被覆盖，而不是被信任。
    const forged = { name: 'mcp__qq__qq_poke',
      arguments: Object.freeze({ group_id: 10, user_id: 200, source_ref: 'forged' }), agent: { session: { id: sessionId } } };
    bindToolSource(r.store, forged);
    assert.equal(forged.arguments.source_ref, ref);
    // 非 QQ 工具和没有回合绑定的 Session 保持原参数。
    const other = { name: 'pwsh', arguments: Object.freeze({ command: 'echo' }), agent: { session: { id: sessionId } } };
    bindToolSource(r.store, other);
    assert.deepEqual(other.arguments, { command: 'echo' });
    const unbound = { name: 'mcp__qq__qq_poke', arguments: Object.freeze({ group_id: 10, user_id: 200 }),
      agent: { session: { id: 'desktop-session' } } };
    bindToolSource(r.store, unbound);
    assert.equal(unbound.arguments.source_ref, undefined, '桌面会话的手动调用不伪造归属');
  });
  await test('inTurnInjectionMode=all 把新消息注进正在思考的回合，不调语义路由也不新建任务', async () => {
    const r = make({ inTurnInjectionMode: 'all' }), blocked = gate();
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      await blocked.promise;
      yield { type: 'event', event: { seq: 1, type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '本轮回答' }] } } } };
      yield { type: 'event', event: { seq: 2, type: 'turn/end' } };
    } });
    try {
      const first = admit(r, 1, '写一份战术文档');
      r.state.taskScheduler.pump(); await until(() => r.prompts.length === 1);
      const sessionId = r.prompts[0].sessionId;
      const agent = { id: sessionId, status: 'running', injections: [],
        inject(m) { this.injections.push(m); } };
      r.ctx.agents = new Map([[sessionId, agent]]);
      // 强制注入的意义之一就是省掉这次调用：它一旦被走到，这里会直接抛错。
      r.ctx.llm = { stream() { throw new Error('强制注入不该调用语义路由模型'); } };
      const follow = { ...message(2, '结尾改成开放式', 10, 300), __inputId: '100:2', __receivedAt: Date.now() };
      observeFloor(r.config, r.registry, 'group:10', follow);
      assert.equal(await r.state.taskScheduler.admit('group:10', [follow]), true);
      assert.equal(agent.injections.length, 1);
      assert.match(agent.injections[0].content[0].text, /结尾改成开放式/);
      assert.match(agent.injections[0].source.rpcId, /^qq-interject:/);
      assert.equal(r.prompts.length, 1, '注入不能再提交一次 prompt');
      assert.equal(r.state.taskScheduler.active.size, 1, '同一轮仍在跑，没有新执行');
      assert.equal(r.state.taskRouting.execution(first.id).data.inputEvents.length, 2);
      assert.equal(r.stats.interjected, 1);
      assert.equal(r.stats.humanInterjections, undefined, '这条不是 amend 计数');
    } finally { blocked.resolve(); await until(() => r.state.taskScheduler.active.size === 0); }
  });
  await test('diagnostics report bounded evidence/latencies and explicit unavailable token data', async () => {
    const r=make();admit(r,1,'秘密正文不能输出');const snapshot=r.state.taskScheduler.snapshot();
    assert.equal(snapshot.latency.routing.samples,1);assert.equal(snapshot.tokenUsage,null);assert.equal(snapshot.cacheUsage,null);
    assert.ok(!JSON.stringify(snapshot).includes('秘密正文'));assert.deepEqual(snapshot.recentRoutes[0].evidenceIds,['1']);
  });
} finally {
  for(const r of rigs){r.state.disposed=true;r.state.controller.abort();r.state.inputBatches?.dispose();r.sendQueue.dispose();}
  await pause(30);for(const s of stores)s.db.close();globalThis.fetch=realFetch;fs.rmSync(root,{recursive:true,force:true});
}
console.log(`\n${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
