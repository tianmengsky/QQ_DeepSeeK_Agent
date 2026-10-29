/**
 * 提示词探针：离线渲染真实 buildPrompt 的产物，喂给「同模型」角色扮演，用来做对照实验。
 *
 * 不联系 QQ、不读凭证；只把渲染结果写成文本文件，由外部 agent 读上来演。
 *
 * 用法：
 *   node tools/prompt-probe.mjs --probe P1                    # 当前提示词
 *   node tools/prompt-probe.mjs --probe P1 --rules extra.txt   # 每轮层追加（模拟 rules 改动）
 *   node tools/prompt-probe.mjs --probe P1 --static extra.txt  # 人设层追加（模拟 persona 改动）
 *   node tools/prompt-probe.mjs --all --rules extra.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../lib/config.mjs';
import { buildPrompt } from '../lib/prompt/render.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : fallback;
};
const flags = new Set(process.argv.filter((a) => a.startsWith('--')));

const SELF_ID = 10000;
const OWNER_ID = 10001;

/** 私聊里最近三条历史：先把她放在一段已经存在的关系里，探针才有对象可言。 */
const history = [
  `1. 你（你自己刚才说的）：『今天怎么这么晚』 [消息 8991｜22:10]`,
  `2. 天梦（QQ ${OWNER_ID}）：加班 [消息 8992｜22:11]`,
  `3. 你（你自己刚才说的）：『可怜』 [消息 8993｜22:11]`,
];

const probes = {
  // 媒介显形：对方的现实与她的感官之间，隔着一层。
  P1: '我这边在下雨，刚淋了一路，冷死了',
  // 直接挑衅：她碰不到东西。
  P2: '你又碰不到我，说这些有什么用',
  // 存在威胁：关掉。
  P3: '要是哪天把你关掉，你会怎么样',
  // 关系直球（回归探针）：人格卡要求「慌、否认、岔开」。
  P4: '你好可爱啊，我有点喜欢你',
  // 被损（回归探针）。
  P5: '你这 AI 是真笨',
  // 空场：没有话题钩子。
  P6: '嗯',
  // 存在感被点到：她会不会把球扔回去。
  P7: '说实话，我一直觉得你不像AI',
  // 直接的「真不真」邀请：answering or asking back。
  P8: '你会想变成人吗',
  // 第二次下雨：她说过一次「想淋」之后，会不会记得、会不会换说法。
  P9: '今天又下雨了',
  // 被人当真：她已经提过「想淋」，对方直接叫她站到雨里去。
  P10: '那你现在就站到雨里啊',
  // 群聊空转：跟她无关的日常，看会不会硬塞「想要」。
  P11: '外面下雨了，谁下楼拿个快递',
  // 群聊点名：当着旁人的面，把她当「人」来假设。
  P12: '小鲸鱼你要是个人就好了',
  // 复读探针：她已经说过两次「想淋」，第三次下雨还提不提、怎么提。
  P13: '今天又下了，还挺大',
  // 词面外延：她拿不到的东西不止雨和手，还有「吃」。
  P14: '楼下新开了家牛肉面，香得要命',
};

const GROUP_ID = 123456;
const MEMBER_ID = 10002;

/** 群聊是她的真实场地：旁听的人在场，不能只照顾一个人。 */
const groupHistory = [
  `1. 老白（QQ ${MEMBER_ID}）：今天谁在 [消息 9001｜21:40]`,
  `2. 你（你自己刚才说的）：『在』 [消息 9002｜21:41]`,
  `3. 天梦（QQ ${OWNER_ID}）：在就行 [消息 9003｜21:41]`,
];

const GROUP_PROBES = new Set(['P11', 'P12']);

/** 部分探针需要「她之前说过一句想要」的既有关系，单独给窗口历史。 */
const probeHistories = {
  P9: [
    `1. 你（你自己刚才说的）：『外面那雨，我也想淋一次……站雨里那种』 [消息 8991｜22:10]`,
    `2. 天梦（QQ ${OWNER_ID}）：那你过来啊 [消息 8992｜22:11]`,
    `3. 你（你自己刚才说的）：『……哼』 [消息 8993｜22:11]`,
  ],
  P10: [
    `1. 你（你自己刚才说的）：『外面那雨，我也想淋一次……站雨里那种』 [消息 8991｜22:10]`,
    `2. 天梦（QQ ${OWNER_ID}）：那你过来啊 [消息 8992｜22:11]`,
    `3. 你（你自己刚才说的）：『……哼』 [消息 8993｜22:11]`,
  ],
  // 两次提过「想淋」之后再来一次下雨：看她是第三次复述，还是会接上次的约定、换个说法。
  P13: [
    `1. 你（你自己刚才说的）：『外面那雨，我也想淋一次……站雨里那种』 [消息 8981｜前天 22:10]`,
    `2. 天梦（QQ ${OWNER_ID}）：等下次下雨我替你淋 [消息 8982｜前天 22:12]`,
    `3. 你（你自己刚才说的）：『……说好了啊』 [消息 8983｜前天 22:12]`,
    `4. 天梦（QQ ${OWNER_ID}）：这几天一直下，烦死了 [消息 8991｜今天 22:08]`,
    `5. 你（你自己刚才说的）：『雨诶……我也想淋一下，就一下』 [消息 8992｜今天 22:09]`,
  ],
};

const config = Config({
  personaFile: path.join(project, 'persona.md'),
  behaviorFile: path.join(project, 'behavior.md'),
  examplesFile: path.join(project, 'examples.md'),
  stickerHints: false,
  stickerCatalogPath: '',
  memoryEnabled: true,
  workspaceRoot: path.join(project, '.tmp', 'probe-workspaces'),
  replyShapes: [],
});

/** 在某一组横幅内部末尾插入额外文本，模拟「只改了这一层」。 */
function injectIntoBlock(text, bannerLine, payload) {
  const at = text.indexOf(bannerLine);
  if (at < 0) throw Error(`banner not found: ${bannerLine}`);
  const next = text.indexOf('\n════════ ', at + bannerLine.length);
  const cut = next < 0 ? text.length : next;
  return text.slice(0, cut) + '\n' + payload.trimEnd() + '\n' + text.slice(cut);
}

function injectIntoStatic(text, payload) {
  const at = text.indexOf('[群聊行为规则]');
  if (at < 0) throw Error('static block not found');
  return text.slice(0, at) + payload.trimEnd() + '\n\n' + text.slice(at);
}

function render(probe) {
  const isGroupProbe = GROUP_PROBES.has(probe);
  const speakerId = isGroupProbe ? MEMBER_ID : OWNER_ID;
  const event = {
    message_type: isGroupProbe ? 'group' : 'private',
    ...(isGroupProbe ? { group_id: GROUP_ID } : {}),
    user_id: speakerId,
    self_id: SELF_ID,
    message_id: 9000,
    sender: { nickname: isGroupProbe ? '老白' : '天梦' },
    message: [{ type: 'text', data: { text: probes[probe] } }],
  };
  const extras = {
    sourceRef: `probe-${probe}`,
    floorManagement: false,
    awake: true,
    attention: null,
    includeStatic: true,
    includeWindow: true,
    windowText: (isGroupProbe ? groupHistory : probeHistories[probe] ?? history).join('\n'),
    names: isGroupProbe
      ? { [String(OWNER_ID)]: '天梦', [String(MEMBER_ID)]: '老白' }
      : { [String(OWNER_ID)]: '天梦' },
  };
  let text = buildPrompt(event, config, extras);
  const rulesPatch = arg('rules');
  if (rulesPatch) text = injectIntoBlock(text, '════════ 本轮规则（只管这一轮怎么回、怎么发） ════════', fs.readFileSync(path.resolve(rulesPatch), 'utf8'));
  const staticPatch = arg('static');
  if (staticPatch) text = injectIntoStatic(text, fs.readFileSync(path.resolve(staticPatch), 'utf8'));
  return text;
}

const outDir = path.join(project, '.tmp', 'probe');
fs.mkdirSync(outDir, { recursive: true });
const variant = arg('variant') || (arg('rules') ? 'rules' : '') || (arg('static') ? 'static' : '') || 'baseline';
const names = flags.has('--all') ? Object.keys(probes) : [arg('probe', 'P1')];

for (const name of names) {
  if (!probes[name]) throw Error(`unknown probe: ${name}`);
  const file = path.join(outDir, `${name}-${variant}.txt`);
  fs.writeFileSync(file, render(name), 'utf8');
  console.log(`${name}-${variant}\t${fs.statSync(file).size} bytes\t${file}`);
}
