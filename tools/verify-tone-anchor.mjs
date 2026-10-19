/**
 * 核对三层人设约束是否都进入拼装后的提示词。
 * 只做离线渲染，不接触 QQ、不读凭据、不发消息。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../lib/config.mjs';
import { buildPrompt } from '../lib/prompt/render.mjs';
import { resolvePersona, resolveBehavior, resolveExamples } from '../lib/prompt/text-sources.mjs';

const profile = fs.readFileSync('C:/Users/30481/.dsh/profiles/desktop/cordis.patch.yml', 'utf8');
const anchor = profile.match(/\n {4}toneAnchor: >-\r?\n((?: {6}\S[^\r\n]*\r?\n?)+)/)[1]
  .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');

const config = Config({
  personaFile: path.join(process.cwd(), 'persona.md'),
  behaviorFile: path.join(process.cwd(), 'behavior.md'),
  examplesFile: path.join(process.cwd(), 'examples.md'),
  toneAnchor: anchor, stickerHints: false, stickerCatalogPath: '',
  memoryEnabled: false, replyShapes: [],
});

const event = {
  message_type: 'group', group_id: 10, user_id: 200, self_id: 100, message_id: 1,
  sender: { nickname: '群友' },
  message: [{ type: 'text', data: { text: '大肥鱼怎么这么有攻击性了，我得好好制裁一下你了' } }],
};

const prompt = buildPrompt(event, config, { sourceRef: 'verify', floorManagement: true });
const staticPrompt = buildPrompt(event, config, { sourceRef: 'verify', includeStatic: true });

console.log('人设文件:', resolvePersona(config).length, '字符');
console.log('行为文件:', resolveBehavior(config).length, '字符');
console.log('示例文件:', resolveExamples(config).length, '字符');
console.log('toneAnchor:', anchor.length, '字符');
console.log('');

const checks = [
  ['L3 人设卡·斗嘴只斗态度不斗人', resolvePersona(config).includes('斗嘴只斗态度，不斗人')],
  ['L3 行为规则·硬边界章节', resolveBehavior(config).includes('## 硬边界（优先于其它一切风格要求）')],
  ['L2 语气锚·每轮注入', prompt.includes('不评价群友的现实能力')],
  ['提示词含人设块', staticPrompt.includes('[你的人设]')],
  ['提示词含行为规则块', staticPrompt.includes('[群聊行为规则]')],
];
for (const [label, ok] of checks) console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);

const anchorPos = prompt.indexOf('记住你的人设（DeepSeek-Chan');
const msgPos = prompt.indexOf('—— 现在这条消息 ——');
console.log('\n语气锚位置:', anchorPos, '/ 总长', prompt.length,
  '→', ((anchorPos / prompt.length) * 100).toFixed(1) + '%');
console.log('在当前消息之前:', anchorPos > 0 && anchorPos < msgPos ? 'YES' : 'NO');

process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
