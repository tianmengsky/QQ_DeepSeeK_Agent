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

const persona = resolvePersona(config);
const demoSection = (persona.match(/可复用的正向示范([\s\S]*?)(?=\n## )/) ?? [])[1] ?? '';

/**
 * 硬断言：进入退出码。只放"口径必须存在"的东西。
 *
 * 2026-10-21 用户把「二、口嫌体正直」整节摘要化（三步链移出人设卡），
 * 这里原先断言章节标题与三步链句子的三条随之改成断言剩下的结论句，
 * 三步链是否还在改由下面的软告警提示 —— 不在人设卡里也未必是错，
 * 但要知道它现在只剩【本轮接话基调】一处载体。
 */
const checks = [
  ['L3 人设卡·三分傲七分娇', persona.includes('三分傲，七分娇')],
  ['L3 人设卡·娇体现在做的事上', persona.includes('娇体现在做的事上')],
  ['L3 人设卡·嘴硬是害羞不是真拒绝', persona.includes('那是害羞，不是真拒绝')],
  ['L3 人设卡·斗嘴只斗态度不斗人', persona.includes('斗嘴只斗态度，不斗人')],
  ['L3 人设卡·越挑逗越来劲（不再是"收着"）', persona.includes('对方越挑逗，你越来劲')],
  // 2026-10-21 事故：'保证改完像人写的，像不像你就不知道了' —— 没点名骂人，
  // 但把结果推给对方水平，意思就是"你不行"。这类"伪装成傲的攻击"必须在两处都被挡住。
  ['L3 人设卡·傲的靶子只有四个（事/我/梗/自嘲）', persona.includes('这件事、我自己、群里的梗、自嘲')],
  // 2026-10-21 第二次批注：内容对了但"手感"仍是助手腔——缺停顿、结巴、语气词、
  // 不规范标点。人味来自低信息量的成分，所以要写成配额（至少 1 处），不能只是"可以"。
  ['L3 人设卡·冗余配额（每条至少 1 处）', persona.includes('每条回复至少留 1 处')],
  ['L3 人设卡·标点可以不规范', persona.includes('标点可以不合规范')],
  ['每轮·基调要求冗余纹理', prompt.includes('标点不必规范')],
  ['L3 行为卡·禁止把结果推给对方水平', resolveBehavior(config).includes('把结果的不确定推给对方水平')],
  ['L3 行为卡·软甲边界章节', resolveBehavior(config).includes('## 边界：软甲，不是铁壳')],
  ['L3 行为卡·场内许可（互损/荤段子）', /互损、顶嘴、起外号/.test(resolveBehavior(config))
    && /荤段子、黄腔、擦边调侃/.test(resolveBehavior(config))],
  ['L3 行为卡·损是整活不是攻击', resolveBehavior(config).includes('损是整活，不是攻击')],
  ['L3 行为卡·四条硬红线完整', ['露骨色情', '涉未成年人的性内容', '落到具体真人身上的攻击', '不编造没看见的内容当事实']
    .every((line) => resolveBehavior(config).includes(line))],
  ['L2 语气锚·每轮注入', prompt.includes('不评价群友的现实能力')],
  ['每轮·接话基调（履约 + 靶子 + 不凶）', prompt.includes('【本轮接话基调】')
    && prompt.includes('真拿你没办法') && prompt.includes('被催被抱怨也不凶')
    && prompt.includes('绝不暗示对方不行')],
  ['提示词含人设块', staticPrompt.includes('[你的人设]')],
  ['提示词含行为规则块', staticPrompt.includes('[群聊行为规则]')],
];
for (const [label, ok] of checks) console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);

/**
 * 软告警：不影响退出码，只提示"文案与本轮底色不一致"的地方。
 * 来源是 2026-10-21 的抽样：子代理能稳定演出"才没有→就一点点"，
 * 但人设卡自己还在示范"停在拒绝"，两处教学在打架。
 */
const warnings = [
  // 只在"才不要"是整段结尾（后面没有动作）时才算问题；带后续动作的不算。
  ['示范里存在"停在拒绝"的样本（"才不要"后面没有动作）',
    /小鲸鱼：才不要。\s*\n\s*\n群友：/.test(persona) || /"小鲸鱼","才不要"\]\]/.test(resolveExamples(config))],
  ['"可复用的正向示范"里没有一条"被要求帮忙"的样本（底色是喜欢帮忙，示范却全是接梗/被损）',
    !/帮我|帮个|帮我写|帮我查/.test(demoSection)],
  ['人设卡里没有可执行的三步链，口嫌体正直只剩【本轮接话基调】一处载体',
    !persona.includes('嘴硬之后必须有一个往前走的动作')],
];
for (const [label, problem] of warnings) console.log((problem ? 'WARN' : 'ok  ') + '  ' + label);

const anchorPos = prompt.indexOf('记住你的人设（DeepSeek-Chan');
const tonePos = prompt.indexOf('【本轮接话基调】');
const msgPos = prompt.indexOf('—— 现在这条消息 ——');
console.log('\n语气锚位置:', anchorPos, '/ 总长', prompt.length,
  '→', ((anchorPos / prompt.length) * 100).toFixed(1) + '%');
console.log('在当前消息之前:', anchorPos > 0 && anchorPos < msgPos ? 'YES' : 'NO');
console.log('接话基调位置:', tonePos, '→ 紧邻当前消息（', tonePos > 0 && tonePos < msgPos ? 'YES' : 'NO', '）');

process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
