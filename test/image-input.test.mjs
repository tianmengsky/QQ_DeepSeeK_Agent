import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPromptContent, asksToLook } from '../lib/prompt/prepare.mjs';
import { rig, message } from './helpers/bridge.mjs';

const realFetch = globalThis.fetch;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-input-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const file = path.join(root, 'shot.png');
fs.writeFileSync(file, png);
const image = (extra = {}) => ({ type: 'image', data: { file, summary: '[图片]', sub_type: 0, ...extra } });
const pictures = (content) => content.filter((p) => p.type === 'image');
const settings = { imagesEnabled: true, imageMode: 'lazy', awakeMs: 60000, groupAttentionEnabled: true };
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { process.exitCode = 1; console.error('  ✗ ' + name, error); }
}
try {
  await test('batched text and ordinary images never attach background sticker bytes', async () => {
    for (const imageMode of ['lazy', 'always']) {
      const r = rig({ ...settings, imageMode }, '[SKIP]');
      const event = message('text', '你们在说什么呢');
      const ordinary = message('shot', ''); ordinary.message = [image()];
      const passive = message('reaction', ''); passive.__inputPassive = true;
      passive.message = [image({ file: 'missing-background.png', summary: '[动画表情]', sub_type: 1 })];
      const content = await buildPromptContent(r.ctx, r.config, event, r.stats, { inputEvents: [event, ordinary, passive] });
      assert.equal(pictures(content).length, 1); assert.equal(r.stats.lastImages.own, 1);
      assert.equal(r.stats.imageSkips, undefined);
    }
  });
  await test('an explicit batched sticker request reads the same authors target without other reactions', async () => {
    const r = rig(settings, '[SKIP]');
    const event = message('request', '看这张表情是什么意思');
    const passive = message('target', ''); passive.__inputPassive = true;
    passive.message = [image({ summary: '[动画表情]', sub_type: 1 })];
    const other = message('other', '', 10, 300); other.__inputPassive = true;
    other.message = [image({ file: 'missing-other.png', summary: '[动画表情]', sub_type: 1 })];
    const content = await buildPromptContent(r.ctx, r.config, event, r.stats, { inputEvents: [event, other, passive] });
    assert.equal(pictures(content).length, 1); assert.equal(r.stats.lastImages.requested, true);
    assert.equal(r.stats.imageSkips, undefined);
  });
  await test('normal group image and semantic captions reach the DSH queue as bytes', async () => {
    for (const text of ['deepseek 把地图改成这样，dust2', 'deepseek 这啥', 'deepseek 这个啊', 'deepseek 哈哈']) {
      const r = rig(settings, '[SKIP]');
      const event = message(1, text); event.message.push(image());
      await r.post(event);
      assert.equal(r.prompts.length, 1);
      assert.equal(r.prompts[0].mode, 'queue');
      const parts = pictures(r.prompts[0].content);
      assert.equal(parts.length, 1);
      assert.equal(parts[0].data, png.toString('base64'));
      assert.equal(parts[0].mediaType, 'image/png');
      assert.equal(r.stats.lastPrompt.imageParts, 1);
    }
  });
  await test('image-only followup is admitted during the shared group awake window', async () => {
    const r = rig(settings, '[SKIP]');
    r.registry.entry('group:10').awakeUntil = Date.now() + 30000;
    const event = message(2, '', 10, 201); event.message = [image()];
    await r.post(event);
    assert.equal(pictures(r.prompts[0].content).length, 1);
  });
  await test('closed or different group window, self messages and whitelist still block image-only turns', async () => {
    for (const [over, group, user] of [[{}, 10, 200], [{awakeMs:0}, 10, 200], [{}, 11, 200], [{}, 10, 100], [{groups:['11']}, 10, 200]]) {
      const r = rig({ ...settings, ...over }, '[SKIP]');
      if (Object.keys(over).length || group !== 10 || user === 100)
        r.registry.entry('group:10').awakeUntil = Date.now() + 30000;
      const event = message(3, '', group, user); event.message = [image()];
      await r.post(event);
      assert.equal(r.prompts.length, 0);
    }
  });
  await test('pure group sticker stays lazy; sticker with actual text is attached', async () => {
    const r = rig(settings, '[SKIP]');
    const event = message(4, ''); event.message = [image({summary:'[动画表情]',sub_type:1})];
    const pure = await buildPromptContent(r.ctx, r.config, event, r.stats);
    assert.equal(pictures(pure).length, 0);
    event.message.unshift({type:'text',data:{text:'这个笑死我了'}});
    assert.equal(pictures(await buildPromptContent(r.ctx, r.config, event, r.stats)).length, 1);
  });
  await test('pure sticker during awake window is buffered without creating a separate DSH turn', async () => {
    const r = rig(settings,'[SKIP]');
    const entry = r.registry.entry('group:10');
    entry.awakeUntil = Date.now() + 30000;
    const before = entry.awakeUntil;
    const event = message(969252510,'');
    event.message = [image({summary:'[动画表情]',sub_type:1})];
    await r.post(event);
    assert.equal(r.prompts.length,0);
    assert.equal(entry.pending.length,1);
    assert.equal(entry.pending[0].text,'[表情包]');
    assert.equal(entry.awakeUntil,before);
    assert.equal(r.calls.length,0);
  });
  await test('semantic requests read the recent screenshot despite later stickers and text-only window delta', async () => {
    const r = rig({ ...settings, contextImagesOnRequest: 1 }, '[SKIP]');
    const entry = r.registry.entry('group:10');
    r.registry.buffer(entry, {messageId:'old',qq:'200',who:'小明',text:'[图片]',images:[image()],at:1000});
    for (let i = 0; i < 4; i++) r.registry.buffer(entry, {messageId:'s'+i,qq:'200',text:'[表情包]',
      images:[image({file:path.join(root,'missing-'+i+'.png'),summary:'[动画表情]',sub_type:1})],at:2000+i});
    await r.post(message(5, 'deepseek 读一下上面那张'));
    assert.equal(pictures(r.prompts[0].content).length, 1);
    assert.equal(r.stats.lastImages.contextAttached, 1);
    assert.ok(r.prompts[0].content.some((p) => p.type === 'text' && /消息 old，发送者 小明/.test(p.text)));
    assert.equal(r.stats.imageSkips, undefined);
    for (const text of ['看上面那张', '分析一下刚才发的', '读图', '这啥', '把地图改成这样'])
      assert.equal(asksToLook(text, r.config.imageTriggers), true, text);
    assert.equal(asksToLook('今天吃什么', r.config.imageTriggers), false);
  });
  await test('current and quoted targets do not reattach unrelated history or duplicate the same image', async () => {
    const r = rig(settings, '[SKIP]');
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url).endsWith('/get_msg') ? {
      ok:true, text:async()=>JSON.stringify({status:'ok',retcode:0,data:{sender:{user_id:200},message:[image()]}})
    } : previousFetch(url,init);
    const event = message(6, 'deepseek 看图');
    event.message.push(image(),{type:'reply',data:{id:'quoted'}});
    const content = await buildPromptContent(r.ctx,r.config,event,r.stats,{windowMessages:[{images:[image({file:'missing.png'})]}]});
    assert.equal(pictures(content).length,1);
    assert.equal(content.imageInfo.attachedCount,1);
    assert.equal(r.stats.lastImages.contextAttached,0);
  });
  await test('explicit image switches block current, quote and context attachments', async () => {
    for (const over of [{imagesEnabled:false},{imageMode:'never'}]) {
      const r = rig({...settings,...over}, '[SKIP]');
      const event = message(7,'deepseek 读图'); event.message.push(image());
      const content = await buildPromptContent(r.ctx,r.config,event,r.stats,{windowMessages:[{images:[image()]}]});
      assert.equal(pictures(content).length,0);
      assert.equal(r.calls.length,0);
    }
  });
  await test('history image load failure is visible and cannot be reported as an attached picture', async () => {
    const r = rig(settings,'[SKIP]');
    const content = await buildPromptContent(r.ctx,r.config,message(8,'读一下上面那张'),r.stats,{
      windowMessages:[{images:[image({file:'missing.png'})],messageId:'missing'}]});
    assert.equal(pictures(content).length,0);
    assert.deepEqual(content.imageInfo,{present:true,attached:false,attachedCount:0});
    assert.match(content[0].text,/图片字节未能取到/);
    assert.equal(r.stats.imageSkips.length,1);
  });
  await test('quoted image and private sticker behavior is preserved', async () => {
    const r = rig(settings,'[SKIP]');
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url,init) => String(url).endsWith('/get_msg') ? {
      ok:true,text:async()=>JSON.stringify({status:'ok',retcode:0,data:{sender:{user_id:200},message:[image()]}})
    } : previousFetch(url,init);
    const event = message(9,'deepseek 嗯'); event.message.push({type:'reply',data:{id:'quoted'}});
    assert.equal(pictures(await buildPromptContent(r.ctx,r.config,event,r.stats)).length,1);
    event.message_type='private';event.message=[image({summary:'[动画表情]',sub_type:1})];
    assert.equal(pictures(await buildPromptContent(r.ctx,r.config,event,r.stats)).length,1);
  });
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(root,{recursive:true,force:true});
}
console.log(`${passed} passed, ${process.exitCode ? 1 : 0} failed`);
