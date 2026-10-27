import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildPromptContent, asksToLook } from '../lib/prompt/prepare.mjs';
import { Store } from '../lib/store.mjs';
import { EpisodeLedger } from '../lib/memory/episodes.mjs';
import { readImageCatalog, recordImageRead } from '../lib/agent/image-catalog.mjs';
import { loadImagePart } from '../lib/transport/media.mjs';
import { boundSource } from '../lib/agent/execution-scope.mjs';
import { rig, message } from './helpers/bridge.mjs';

const realFetch = globalThis.fetch;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-input-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const file = path.join(root, 'shot.png');
fs.writeFileSync(file, png);
const image = (extra = {}) => ({ type: 'image', data: { file, summary: '[图片]', sub_type: 0, ...extra } });
const pictures = (content) => content.filter((p) => p.type === 'image');
const sharp = createRequire(new URL('../qq-mcp/package.json', import.meta.url))('sharp');
const multi = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3,
    background: { r: i * 40, g: 100, b: 200 } } }).png().toBuffer();
  const target = path.join(root, `image-${i}.png`);
  fs.writeFileSync(target, bytes);
  return { segment: image({ file: target }), data: bytes.toString('base64') };
}));
const settings = { imagesEnabled: true, imageMode: 'lazy', awakeMs: 60000, groupAttentionEnabled: true };
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { process.exitCode = 1; console.error('  ✗ ' + name, error); }
}
try {
  await test('one message keeps all six addresses while attaching only the first four distinct pictures in order', async () => {
    const r = rig(settings, '[SKIP]'), event = message('multi', 'deepseek 比较这几张图');
    event.message.push(...multi.map((m) => m.segment));
    const content = await buildPromptContent(r.ctx, r.config, event, r.stats);
    assert.deepEqual(pictures(content).map((p) => p.data), multi.slice(0, 4).map((m) => m.data));
    assert.equal(content.imageCatalog[0].messageId, 'multi');
    assert.equal(content.imageCatalog[0].images.length, 6);
    assert.deepEqual(content.imageCatalog[0].attached, [0, 1, 2, 3]);
    assert.match(content[0].text, /qq_read_image/);
    assert.ok(content.some((p) => p.type === 'text' && p.text === '【消息 multi，图片 2】'));
    assert.equal(r.calls.filter((c) => c.action === 'get_image').length, 4);
    assert.equal(content[0].text.includes(root), false);
  });
  await test('duplicates and an unavailable image do not consume the four successful attachments', async () => {
    const r = rig(settings, '[SKIP]'), event = message('repeated', 'deepseek 看这些图');
    event.message.push(multi[0].segment, multi[0].segment, image({ file: 'unavailable.png' }),
      ...multi.slice(1).map((m) => m.segment));
    const content = await buildPromptContent(r.ctx, r.config, event, r.stats);
    assert.deepEqual(pictures(content).map((p) => p.data), multi.slice(0, 4).map((m) => m.data));
    assert.equal(r.stats.imageSkips.length, 1);
    assert.deepEqual(content.imageCatalog[0].attached, [0, 1, 3, 4, 5]);
  });
  await test('batched image bubbles retain earlier pictures and their message addresses', async () => {
    const r = rig(settings, '[SKIP]');
    const events = multi.slice(0, 3).map((m, i) => ({ ...message('bubble-' + i, ''), message: [m.segment] }));
    const event = message('request-many', 'deepseek 对比这几张');
    const content = await buildPromptContent(r.ctx, r.config, event, r.stats, { inputEvents: [...events, event] });
    assert.deepEqual(pictures(content).map((p) => p.data), multi.slice(0, 3).map((m) => m.data));
    assert.deepEqual(content.imageCatalog.map((m) => m.messageId), ['bubble-0', 'bubble-1', 'bubble-2']);
    assert.equal(r.stats.lastImages.requested, true);
  });
  await test('a one-picture historical budget retains the complete older image group for lazy reading', async () => {
    const r = rig({ ...settings, contextImagesOnRequest: 1 }, '[SKIP]');
    const windowMessages = [
      { messageId: 'random-id-900', qq: '200', at: 2000, images: [multi[2].segment] },
      { messageId: 'random-id-999', qq: '200', at: 1000, images: multi.slice(0, 2).map((m) => m.segment) },
    ];
    const content = await buildPromptContent(r.ctx, r.config, message('ask-many', 'deepseek 看前面几张图'),
      r.stats, { windowMessages });
    assert.deepEqual(pictures(content).map((p) => p.data), [multi[2].data]);
    assert.deepEqual(content.imageCatalog.map((m) => m.messageId), ['random-id-999', 'random-id-900']);
    assert.deepEqual(content.imageCatalog.map((m) => m.attached), [[], [0]]);
    const current = message('new-picture', 'deepseek 比较这些图'); current.message.push(multi[3].segment);
    const withCurrent = await buildPromptContent(r.ctx, r.config, current, r.stats, { windowMessages });
    assert.equal(pictures(withCurrent).length, 1);
    assert.equal(withCurrent.imageCatalog.length, 3);
    assert.equal(withCurrent.imageCatalog[0].images.length, 2);
    const off = rig({ ...settings, contextImagesOnRequest: 0 }, '[SKIP]');
    const lazy = await buildPromptContent(off.ctx, off.config, message('lazy-many', '看前面几张图'), off.stats, { windowMessages });
    assert.equal(pictures(lazy).length, 0);
    assert.equal(lazy.imageCatalog.length, 2);
    assert.equal(off.calls.length, 0);
  });
  await test('quoted multiple images use the quoted message ID and expose the unreturned fifth picture', async () => {
    const r = rig(settings, '[SKIP]'), previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url).endsWith('/get_msg') ? {
      ok: true, text: async () => JSON.stringify({ status: 'ok', retcode: 0,
        data: { sender: { user_id: 200 }, message: multi.slice(0, 5).map((m) => m.segment) } }),
    } : previousFetch(url, init);
    const event = message('quoting', 'deepseek 看这几张'); event.message.push({ type: 'reply', data: { id: 'quoted-five' } });
    const content = await buildPromptContent(r.ctx, r.config, event, r.stats);
    assert.equal(pictures(content).length, 4);
    assert.equal(content.imageCatalog[0].messageId, 'quoted-five');
    assert.equal(content.imageCatalog[0].images.length, 5);
    assert.deepEqual(content.imageCatalog[0].attached, [0, 1, 2, 3]);
  });
  await test('the DSH queue sees the complete source-bound catalog before a model can call the tool', async () => {
    const store = new Store(path.join(root, 'catalog.sqlite3'));
    try {
      const r = rig(settings, '[SKIP]', store); r.state.sourceLedger = new EpisodeLedger(store);
      let queued = false;
      r.ctx.sessionController.prompt = async (request) => {
        const bound = boundSource(store, request.sessionId);
        assert.equal(bound.conversation, 'group:10');
        const catalog = readImageCatalog(store, bound.sourceRef, bound.conversation);
        assert.equal(catalog.messages[0].images.length, 6);
        assert.deepEqual(catalog.messages[0].attached, [0, 1, 2, 3]);
        assert.equal(request.mode, 'queue');
        queued = true;
      };
      const event = message('queued-multi', 'deepseek 看这组图'); event.message.push(...multi.map((m) => m.segment));
      await r.post(event);
      assert.equal(queued, true, r.stats.lastError);
    } finally { store.db.close(); }
  });
  await test('a successful lazy retry is real image evidence for delivery and session rotation', async () => {
    const store = new Store(path.join(root, 'retry.sqlite3')), retryFile = path.join(root, 'retry.png');
    try {
      const r = rig({ ...settings, rotateAfterImage: true, imageHallucinationPattern: '图片里是' }, '图片里是一只猫。', store);
      r.state.sourceLedger = new EpisodeLedger(store);
      r.ctx.sessionController.prompt = async (request) => {
        assert.equal(pictures(request.content).length, 0);
        const bound = boundSource(store, request.sessionId);
        const catalog = readImageCatalog(store, bound.sourceRef, bound.conversation);
        fs.writeFileSync(retryFile, png);
        const result = await loadImagePart(r.config, catalog.messages[0].images[0]);
        assert.equal(result.part.data, png.toString('base64'));
        recordImageRead(store, bound.sourceRef, bound.conversation, 'retry', 0);
      };
      const event = message('retry', 'deepseek 看图'); event.message.push(image({ file: retryFile }));
      await r.post(event); await r.sendQueue.drain?.();
      assert.ok(r.calls.some((c) => c.action === 'send_group_msg' && JSON.stringify(c.payload).includes('图片里是一只猫')), r.stats.lastError);
      assert.equal(r.stats.imageTurnsRotated, 1);
      assert.equal(r.stats.imageHallucinations, undefined);
    } finally { store.db.close(); }
  });
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
      assert.deepEqual(content.imageCatalog, []);
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
