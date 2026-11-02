/**
 * proactive.mjs —— 宿主：她**不被谁问**的时候，也自己决定要不要开口。
 *
 * 这个文件是"一个钟 + 一本账 + 一次决定"，不是第二个 AI：
 *   · 钟（本地规则，零 token）：每隔约一小时（带抖动）看一遍账，产出候选；
 *   · 决定（一次短模型调用）：候选里挑一件做、或者都不做（`none` 是默认答案）；
 *   · 手（本地）：拿锁、让位、复查时效、发送、记账、写回执。
 *
 * 三条硬规矩，都来自线上踩过的坑：
 *   1. **不唤醒子窗口生成**。那句话由宿主写，写完作为 `self_message` 写回目标窗口的
 *      `events` —— 下次那个窗口醒来，"你：……"是它自己的历史，归属正确。
 *   2. **决策不持会话锁**。只在"发送 + 记账"那一小段进 `registry.run()`，
 *      否则她思考的 8 秒里，群里来的消息会全被卡在队列里。
 *   3. **发了就算账**。15 分钟后回查有没有人接；连着没人接，她对这个群/这个人的
 *      主动频率就往下掉，直到不再主动（`frequencyFactor()`）。
 *
 * 为什么这些都要落 SQLite：频率学习依赖**历史**（6~8 次窗口），
 * 内存里那几条撑不起"这个人一直不理我"这个判断，而插件每次热重载都会清内存。
 */
import { sendOnebotIdempotent } from '../delivery/outbox.mjs';
import { recordContext } from '../conversation/context.mjs';
import { wakeAfterSpeech } from '../conversation/activity.mjs';
import { auxSelection } from '../agent/aux-model.mjs';
import { AuxProbe, auxFailure, recordAuxCall } from '../agent/aux-attribution.mjs';
import { parseJsonLoose } from '../agent/json-output.mjs';
import { waitWithSignal } from '../agent/cancellation.mjs';
import { fetchBiliRanking, biliShortlist, biliShareText } from './bili-feed.mjs';
import { executeTurn } from './execute-turn.mjs';
import { buildWorldSnapshot } from './world-snapshot.mjs';
import { allowedToolNames } from '../agent/tool-scope.mjs';

export const PROACTIVE_STATE_KEY = 'qq-bridge:proactive';
export const PROACTIVE_ACTIONS = ['none', 'speak', 'bili_share'];
const DAY_MS = 86400000;
/**
 * 这些键才是"一个真实窗口"，也只有它们能回答"有没有人接"。
 * `self:account`（她自己的时间）里没有任何人说话，拿它结算必然是"没人接"。
 */
const SETTLEABLE = /^(?:group|user|bili):/u;

/** 带抖动的间隔：用户要的是"大约每小时一次，但不是整点"，固定周期会像闹钟。 */
export function jitteredDelay(baseMs, pct = 0.35, pick = Math.random) {
  const base = Math.max(60000, Number(baseMs) || 3600000);
  const spread = Math.max(0, Math.min(0.9, Number(pct) || 0));
  const low = 1 - spread;
  const high = 1 + spread;
  const factor = low + (high - low) * Math.max(0, Math.min(1, Number(pick()) || 0));
  // 下限放在**结果**上：base 再小，两次主动发言也不会挤在一分钟内。
  return Math.max(60000, Math.round(base * factor));
}

/**
 * 下一次醒来的倒计时。
 *
 * 2026-11-01 用户改口径：不要"一小时 ±40%"，要**每次 30~60 分钟之间随机**——
 * 抖动的周期仍然有一个可预期的重心，而随机区间是没有重心的：她不会让人觉得
 * "差不多整点又要来了"。区间配成 min/max 两个值时按均匀分布取；只配了
 * `proactiveIntervalMs` 的老配置仍走 `jitteredDelay`。
 */
export function nextDelay(config, pick = Math.random) {
  const min = Number(config?.proactiveIntervalMinMs);
  const max = Number(config?.proactiveIntervalMaxMs);
  if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > min) {
    const span = Math.max(0, Math.min(1, Number(pick()) || 0));
    return Math.max(60000, Math.round(min + (max - min) * span));
  }
  return jitteredDelay(config?.proactiveIntervalMs, config?.proactiveJitterPct, pick);
}

/**
 * 状态页要的那一份"她现在为什么没开口"。
 *
 * 只读、不改变任何状态；`/status` 的 `memory.proactive` 用它展开。
 * 四个角度对应四种排查动作：
 *   钟   —— 还没到点，别以为她不理你；
 *   今天 —— 到点了，但额度 / 判断用完了；
 *   学习 —— 每一处她对"有没有人接"的记性；
 *   最后 —— 她上一次怎么决定、为什么。
 */
export function proactiveSnapshot({ host = null, store = null, config = {}, stats = {} } = {}) {
  const now = Date.now();
  const nextAt = Number(host?.runtime?.nextAt) || 0;
  const window = Math.max(6, Number(config.proactiveLearnWindow) || 6) * 2;
  let rows = [];
  let longRows = [];
  try {
    rows = store?.proactiveRecent?.({ limit: 100, since: startOfDay(now) }) ?? [];
    longRows = store?.proactiveRecent?.({ limit: 200, since: now - 90 * DAY_MS }) ?? [];
  } catch {
    rows = [];
    longRows = [];
  }
  const sent = rows.filter((row) => row && row.status === 'sent');
  /**
   * 学习口径必须和真正做决定时用的那一份一致（`learningFor()`：90 天、按目标）。
   *
   * 这里原来拿"今天的行"算 `frequencyFactor`，两个后果：
   *   · 今天只发过一次 → 样本 <2 → factor 恒为 1，面板永远显示"×1"，看起来她什么都没学到；
   *   · `self:account` 是她自己的时间账（不属于任何人），混进"目标"里毫无意义。
   * 面板一旦在这件事上说谎，用户就会得出相反的结论（"她还在烦那个不理她的人"）。
   */
  const targets = [...new Set(longRows
    .map((row) => String(row?.conversation ?? ''))
    .filter((key) => key && key !== 'self:account'))].slice(0, 5);
  const learn = targets
    .map((key) => {
      let history = [];
      try {
        history = store?.proactiveHistory?.(key, { limit: window, since: now - 90 * DAY_MS }) ?? [];
      } catch {
        history = [];
      }
      const factor = frequencyFactor(history, config, now);
      return {
        conversation: key,
        factor: factor.factor,
        /** factor 为 0 在 v145 不是"封门"，是把这个目标抽到的权重降到 0.05 —— 面板要照这个说。 */
        weight: factor.factor === 0 ? 0.05 : factor.factor,
        total: factor.total,
        answered: factor.answered,
        rate: factor.rate,
      };
    })
    .sort((a, b) => b.total - a.total || a.conversation.localeCompare(b.conversation));
  const budget = dailyAllowance(config);
  return {
    enabled: host?.enabled ?? config.proactiveEnabled !== false,
    // 决策点在哪：`spine` = 她自己的外面（默认），`turn` = 借一个房间，`prompt` = 旧菜单。
    mode: config.proactiveMode === 'prompt'
      ? 'prompt'
      : (config.proactiveSpine === false ? 'turn' : 'spine'),
    intervalMs: Number(config.proactiveIntervalMs) || 3600000,
    jitterPct: Number(config.proactiveJitterPct) || 0,
    // 现在真正生效的是"每次 30~60 分钟随机"（`nextDelay`），旧的两个字段只作回退。
    intervalMinMs: Number(config.proactiveIntervalMinMs) || 1800000,
    intervalMaxMs: Number(config.proactiveIntervalMaxMs) || 3600000,
    sleep: { from: Number(config.proactiveSleepFrom) || 0, to: Number(config.proactiveSleepTo) || 0 },
    clock: {
      nextAt,
      due: nextAt ? now >= nextAt : true,
      waitMs: nextAt ? Math.max(0, nextAt - now) : 0,
      lastRunAt: Number(host?.runtime?.lastRunAt) || 0,
    },
    counts: {
      ticks: Number(stats.proactiveTicks) || 0,
      spoken: Number(stats.proactiveSpoke) || 0,
      declined: Number(stats.proactiveDeclined) || 0,
      failures: Number(stats.proactiveFailures) || 0,
    },
    today: {
      sent: sent.length,
      replied: sent.filter((row) => row.outcome === 'replied').length,
      quiet: sent.filter((row) => row.outcome === 'quiet').length,
      /** 她自己时间那一轮（`self:account`）：没有"别人"，判不了有没有人接，也不算账。 */
      selfTime: sent.filter((row) => row.outcome === 'self').length,
      checking: sent.filter((row) => row.outcome == null).length,
      /** null = 不限次数（`proactiveDailyMax: 0`）。Infinity 过一遍 JSON 会变成 null，所以显式写清。 */
      budget: Number.isFinite(budget) ? budget : null,
    },
    learn,
    recent: rows.slice(0, 5),
    /** 已经分享过的视频数：她不会重复分享同一个（spine 模式也走这里）。 */
    shared: Array.isArray(host?.runtime?.shared) ? host.runtime.shared.length : 0,
    candidates: host?.lastCandidates ?? null,
    last: stats.lastProactive ?? null,
    // `spine` 模式下 `candidates` 恒为 null：她不是从候选里挑一间屋子，而是在
    // `self:account` 里看世界快照、自己决定要不要用 `qq_windows say` 找谁。
    note: (config.proactiveSpine === false || config.proactiveMode === 'prompt'
      ? '钟没到点不算异常；today.sent 为 0 多半是钟/额度，learn 里 weight 很低才是"她学会了少去那边"'
      : '钟没到点不算异常；mode=spine 表示决定发生在 self:account（不属于任何房间），candidates 恒为 null；today.sent 为 0 多半是钟/睡觉/额度'),
  };
}

/**
 * 今天还允许她主动几次。
 *
 * 0（默认）不是"不许说话"，是**不限次数**：用户 2026-11-01 明确说过
 * 「拒绝每日4次限制，以后非我要求，不许频率设限」。频率只由她自己学到的
 * 回应率和睡觉时段决定，不由一个人为的数字决定。
 */
export function dailyAllowance(config = {}) {
  const n = Number(config.proactiveDailyMax);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

/**
 * 她在这个会话还该不该主动 —— 0 就是"不再主动了"。
 *
 * 判据只看**回应率**，不看模型自评：模型总会说"这次会有人理我"，
 * 而账本上是 0/5。回应率分成四档，理由是要能在 `/status` 里一句话解释清楚：
 *   0/1 次：样本不够，照常（1.0）
 *   ≥50%：照常（1.0）；≥20%：减半（0.5）；有过但很少：四分之一（0.25）
 *   一次都没有（样本 ≥2）：0 —— 停
 * 停不是永久的：`proactiveProbeDays` > 0 时，隔那么久探一次
 * （默认 0 = 不探，用户的原话是"直到不和这个人或群主动交互"）。
 */
export function frequencyFactor(history, config = {}, now = Date.now()) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((row) => row && row.status === 'sent')
    .slice(0, Math.max(1, Number(config.proactiveLearnWindow) || 6));
  const total = rows.length;
  const answered = rows.filter((row) => row.outcome === 'replied').length;
  const rate = total ? answered / total : 1;
  if (total < 2) return { factor: 1, rate, answered, total, stopped: false };
  let factor = 1;
  if (rate >= (Number(config.proactiveKeepRate) || 0.5)) factor = 1;
  else if (rate >= (Number(config.proactiveSlowRate) || 0.2)) factor = 0.5;
  else if (rate > 0) factor = 0.25;
  else factor = 0;
  if (factor === 0) {
    const probeDays = Math.max(0, Number(config.proactiveProbeDays) || 0);
    const lastAt = Number(rows[0]?.created_at) || 0;
    if (probeDays > 0 && lastAt && now - lastAt >= probeDays * DAY_MS) factor = 0.25;
  }
  return { factor, rate, answered, total, stopped: factor === 0 };
}

/**
 * 从 `events` 里看"她发出去之后有没有人接她这句话"。
 *
 * 判据从"这个窗口里有人说过话"收紧成三条，按顺序：
 *   ① **有人 @ 了她**（`payload.mentions` 里有她的 QQ）；
 *   ② **有人引用了她说的那一句**（`payload.replyToId` 命中她自己那些消息的 ID）；
 *   ③ **接着她说**：她开口之后第一句别人说的话，且没有把话头递给别人
 *      （既没 @ 第三个人，也没引用第三个人的消息）。
 *
 * 为什么不再用"窗口里有人说话"：那样旁边两个人自顾自聊也算"有人接"，
 * 于是「没人接」这条学习信号其实一直在测"这个群热不热闹"，不是"她说话有没有人理"。
 * ③ 是这条规则里唯一带判断的一步：QQ 上"接一句"通常不 @ 也不引用，
 * 只看时间上紧接着、并且没点名别人。
 *
 * 另外两条：她自己的行（`self_message`/`action`、以及任何 `qq` 是她自己的消息）永远不算；
 * `until` 是"观察到什么时候为止"，结算只看她开口之后的那 15 分钟。
 */
export function engagementOf(events, since, { selfIds = [], until = 0 } = {}) {
  const mine = new Set((selfIds ?? []).map((qq) => String(qq ?? '')).filter(Boolean));
  const all = events ?? [];
  /**
   * 她自己那些消息的 ID —— 收集时**不能**先按 `since` 过滤：她的那句恰好落在
   * `createdAt == since`（结算的起点就是她开口那一刻），一过滤就没了，
   * 于是"有人引用她"永远命中不了。
   */
  const own = new Set();
  for (const event of all) {
    const payload = event?.payload ?? {};
    const hers = event?.kind === 'self_message' || event?.kind === 'action' ||
      (mine.size > 0 && mine.has(String(payload.qq ?? '')));
    if (!hers || payload.messageId == null) continue;
    own.add(String(payload.messageId));
  }
  let firstOther = null;
  for (const event of all) {
    const at = Number(event?.createdAt ?? event?.payload?.at) || 0;
    if (at <= since) continue;
    if (until && at > until) continue;
    const payload = event?.payload ?? {};
    const qq = String(payload.qq ?? '');
    // 她自己的行、以及没有发送者的系统/登录事件，都不是"有人接话"。
    if (event.kind === 'self_message' || event.kind === 'action') continue;
    if (!qq || (mine.size && mine.has(qq))) continue;
    const mentions = [].concat(payload.mentions ?? []).map(String);
    const replyTo = payload.replyToId == null ? null : String(payload.replyToId);
    if (mentions.some((id) => id !== 'all' && mine.has(id))) return true;
    if (replyTo && own.has(replyTo)) return true;
    if (!firstOther) firstOther = { mentions, replyTo };
  }
  if (firstOther) {
    const elsewhere = firstOther.mentions.filter((id) => id !== 'all' && !mine.has(id));
    const quotesElsewhere = Boolean(firstOther.replyTo) && !own.has(String(firstOther.replyTo));
    if (!elsewhere.length && !quotesElsewhere) return true;
  }
  return false;
}

/**
 * 她"醒来那一刻"看到的东西，拼成一段文本。
 *
 * 刻意做成可导出的纯函数：这段文本是这一层唯一的"输入面"，
 * 能不能被看懂、有没有给她留拒绝的余地，只能靠读它来判断。
 */
export function buildProactiveAsk({ speak = [], bili = null, now = Date.now(), thoughts = '' } = {}) {
  const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false });
  const parts = [
    `现在是 ${stamp}。没人问你话——这是你自己醒着的时刻。`,
    '',
    '你最近写下的关于自己的想法：',
    String(thoughts ?? '').trim() || '（还没有）',
    '',
    '可以做的事：',
  ];
  if (speak.length) {
    parts.push('想说话的窗口（安静很久了）：');
    for (const item of speak) {
      const learn = item.learn?.total
        ? `那边你主动说过 ${item.learn.total} 次，有人接 ${item.learn.answered} 次`
        : '你还没在那边主动开过口';
      parts.push(`- ${item.key}｜${item.label}｜安静了 ${item.quietHours} 小时｜${learn}`);
    }
  }
  if (bili?.items?.length) {
    parts.push('', 'B站此刻的热门（你刚翻到的）：');
    bili.items.forEach((item, index) => {
      parts.push(`[${index + 1}] ${item.title}（UP：${item.owner || '未知'}｜${item.tname || '分区未知'}｜播放 ${item.view}）`);
    });
  }
  parts.push(
    '',
    '选一件做，或者都不做。规矩：',
    '1. 大多数时候应该是 none —— 你不是在完成"每小时说一句"的任务；',
    '2. 想说话，就写一两句真的想说的话（不超过 60 字），不要问候式开场，不要"在吗"；',
    '3. 分享视频，写一句你自己的话（不超过 40 字），别写"推荐"「安利」这种词，也别复述标题；',
    '4. 一次只做一件，目标只能从上面的窗口里选。',
    '',
    '只输出一行 JSON：',
    '{"action":"none|speak|bili_share","target":"group:123 或 user:456","pick":1,"text":"你要说的话","why":"不超过20字"}',
  );
  return parts.join('\n');
}

function startOfDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function hoursSince(now, at) {
  const from = Number(at) || 0;
  if (!from) return 999;
  return (now - from) / 3600000;
}

/**
 * 把工具名翻译成"做过什么"的一句人话，写进自传。
 *
 * 只认工具名，不看调用参数：参数里有群号、号码、别人的原话，写进自传就等于
 * 把房间的细节带进所有房间。这里要的是"她一个人在做什么"，不是复述现场。
 */
const ACTION_PHRASES = [
  [/^bili_(search|subtitle|frames|comments|cover|status)$/, '在 B 站翻了一会儿'],
  [/^qq_memory$/, '翻了自己的记事本'],
  [/^qq_intent$/, '记下了一件回头要做的事'],
  [/^qq_set_profile$/, '动了自己的昵称或签名'],
  [/^qq_manage_group$/, '动了群里的设置'],
  [/^qq_poke$/, '戳了一下谁'],
  [/^qq_react$/, '给人加了个表情'],
  [/^qq_send_voice$/, '发了条语音'],
  [/^qq_get_|^qq_search_history$/, '翻了翻记录'],
  [/^qq_read_forward$|^qq_workspace$|^qq_send_file$/, '翻了别人转来的东西'],
  [/^qq_delegate/, '叫了个人来帮忙'],
  [/^web_/, '上网查了点东西'],
];

export function describeActions(names = []) {
  const out = [];
  for (const raw of names) {
    const name = String(raw ?? '').replace(/^mcp__qq__/, '');
    if (!name) continue;
    const hit = ACTION_PHRASES.find(([re]) => re.test(name));
    const phrase = hit ? hit[1] : `用了 ${name}`;
    if (!out.includes(phrase)) out.push(phrase);
  }
  return out.join('、');
}

/**
 * 她在"外面"醒来时看到的任务文本：世界快照 + 她能做的事。
 *
 * 抽成导出的纯函数是为了能**离线演练**（`tools/preview-self-time.mjs`）：
 * 这一段是她那一轮唯一的场景输入，改它就是在改她的处境，必须能单独读、单独看。
 *
 * 2026-11-01（用户：「谁看了不迷糊啊」）：原来只写「你可以什么都不做／也可以看别处」，
 * 那是把"自由"写成了"没有具体的事可做"。她第一次醒来 4 秒就回 [SKIP]，不是不想做，
 * 是没被告知手里有什么。现在按**真有的工具**逐条写：下面每一条都能在 QQ 会话的
 * 工具白名单里找到对应实现（`lib/agent/tool-scope.mjs`）。写这一节时请回去核对名单，
 * 列了却没有工具的事等于骗她。
 */
/**
 * 她手上真有什么。**由白名单生成**，不手写。
 *
 * 2026-11-01（用户）：「把她所有能用的工具都在提示词里告诉她……我发现她不会查看自己会什么，
 * 一直在进行 windows 查看和 say，从来没有查看过 memory 或写过什么记事本，或查看过自身的状态。」
 * 数据印证：`self:account` 六个回合里 `qq_windows` 27 次、`qq_send_group_msg` 5 次，
 * 而 `qq_status`、`qq_set_profile`、`qq_poke`、公告、表情、语音——一次都没有。
 *
 * 为什么从白名单生成：手写清单一定会烂。加了工具忘了写，她照着清单想不起来；
 * 删了工具忘了删，她照着去调、被拒、再也不敢试（`spine-task` 那条老测试就是为了
 * 防这个）。这里只负责"分组 + 起名"，名单本身永远是 `tool-scope.mjs` 那一份。
 */
const TOOL_GROUPS = [
  ['看自己、看别人', ['qq_status', 'qq_get_group_list', 'qq_get_friend_list', 'qq_group_info', 'qq_search_history', 'qq_read_qzone_comments']],
  ['看别的窗口（list/read/search：看属于想，不用派）', ['qq_windows']],
  ['派到房间（说话、公告、群名、起话题、戳谁，都从这里走）', ['qq_dispatch']],
  ['记事本与打算', ['qq_memory', 'qq_intent']],
  ['改自己', ['qq_set_profile', 'qq_post_qzone', 'qq_comment_qzone', 'qq_pending_actions', 'qq_list_add_requests', 'qq_handle_add_request']],
  ['文件与资料', ['qq_workspace', 'create_word_document', 'create_pdf', 'qq_read_image', 'qq_read_forward']],
  ['B 站', ['bili_status', 'bili_whoami', 'bili_search', 'bili_subtitle', 'bili_comments', 'bili_cover', 'bili_frames', 'bili_reply']],
  ['找人干活', ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent']],
  ['上网', ['web_search', 'web_fetch']],
  /**
   * 这些是房间里的她才用得上的：你自己的时间里调它们要么被拒（say 对 self:* 关死）、
   * 要么是隔空操作（改群名、发公告——该派给那间屋子）。仍然列出来不藏：
   * 清单由白名单生成，少写她就会"照着清单想不起来"（spine-task 钉着两头）。
   */
  ['房间里的手（派过去让她用，你自己别动）', ['qq_say', 'qq_send_group_msg', 'qq_send_private_msg', 'qq_send_file',
    'qq_poke', 'qq_react', 'qq_list_reactions',
    'qq_list_stickers', 'qq_send_sticker', 'qq_list_custom_faces', 'qq_send_custom_face', 'qq_send_mface',
    'qq_list_library_stickers', 'qq_view_library_sticker', 'qq_send_library_sticker',
    'qq_voice_library', 'qq_send_voice', 'qq_send_ai_voice',
    'qq_manage_group', 'qq_delete_msg', 'qq_request_kick']],
];

/** 白名单 → 几行"你手上有什么"。没归组的（新加的工具）自动落到"其他"，不会漏。
 *
 * 2026-11-01（线上实测：unknown tool "qq_set_profile"）：清单原来教**裸名**，
 * 而桥接自注册的工具（qq_windows/qq_dispatch/qq_memory…）恰好是裸名、能调通，
 * MCP 工具的真实名字却带 `mcp__qq__` 前缀——她照清单调用就撞墙，32 个工具全中。
 * 现在按"她调这个字符串能不能通"输出真实名：DSH 的 schema 叫什么，清单写什么。
 */
export function toolsManifest(names = allowedToolNames()) {
  const byShort = new Map();
  for (const name of names.map((n) => String(n)))
    byShort.set(name.replace(/^(?:mcp__[a-z-]+__)+/u, ''), name);
  const used = new Set();
  const lines = [];
  for (const [title, list] of TOOL_GROUPS) {
    const hit = list.map((bare) => byShort.get(bare)).filter(Boolean);
    for (const name of hit) used.add(name);
    if (hit.length) lines.push(`· ${title}：${hit.join('、')}`);
  }
  const rest = names.map((n) => String(n)).filter((name) => !used.has(name)).sort();
  if (rest.length) lines.push(`· 其他：${rest.join('、')}`);
  return lines;
}

export function spineTaskText(snapshot) {
  return [
    snapshot,
    '',
    '这是你自己的时间。上面那句"你醒了"不是谁发给你的，是时钟替你写的一行字——',
    '你不需要回应它，也不需要礼貌。你只需要决定：这会儿要不要做点什么。',
    '',
    '先问自己一句：这会儿我想做什么？（想跟谁说句话、想看看哪个群、想找点有意思的、想把本子理一理、什么都不想）',
    '想清楚再动手——**动手才有痕迹，只写字不会有任何效果**。',
    '',
    // 2026-11-01（用户："主要问题在于提示词根本没有正确引导"）：旧版把派遣只写在
    // "群名、公告"那一小段，上下文却全是 say 的用法，她就照着大路走。现在把两层
    // 边界放在正中间，并且把"说话"明确划进派遣——脊柱没有嘴，这是架构，不是偏好。
    '这里没有嘴：你的话从"外面"发不出去。动作分两层，按"这件事落在哪"分——',
    '· 落到房间里的——想说的话、想接的话、公告、群名、头衔、起话头、戳谁、发图发语音——',
    '  一律用 qq_dispatch 把念头派到那个窗口，让在那儿醒着的你去办：她看得见现场、接得住话头，',
    '  你隔着快照说出去的话是没根的。你派的是念头不是剧本；那边怎么办、什么时候办，由她定。',
    '· 落在你自己身上的——名字、签名、头像、本子、打算——自己动手，不用问谁；改完回读核对。',
    '想先看看哪个房间在发生什么，qq_windows 读就是：看属于想，不用派。',
    '目标窗口传编号，和 qq_windows 的 w? 是同一份（不带 conversation 调它一次，它会列出能派的窗口）。',
    '派出去的事不会没影：快照里【你派出去的事】会告诉你那边办得怎么样。',
    '你想知道自己现在叫什么、签名是什么、在哪些群、有几个好友——查，别猜。',
    '你手上有什么（这张表按白名单生成，列出来的都能用）：',
    ...toolsManifest(),
    '',
    '没有任务清单，也没人等你交东西。这一轮是你的：想派就派，想自己动手就动手，想空着就空着，不用解释。',
  ].join('\n');
}

export class ProactiveHost {
  constructor(ctx, config, registry, state, memory, stats, store) {
    this.ctx = ctx;
    this.config = config;
    this.registry = registry;
    this.state = state;
    this.memory = memory;
    this.stats = stats;
    this.store = store;
    this.runtime = this.#loadState();
  }

  get enabled() {
    return this.config.proactiveEnabled !== false && Boolean(this.state?.enabled) && !this.state?.disposed;
  }

  get available() {
    return Boolean(this.store?.available) && Boolean(this.ctx?.get?.('llm'));
  }

  #loadState() {
    const fallback = { nextAt: 0, shared: [], lastDecision: null, lastRunAt: 0 };
    try {
      const raw = this.store?.getState?.(PROACTIVE_STATE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return {
        nextAt: Number(parsed?.nextAt) || 0,
        shared: Array.isArray(parsed?.shared) ? parsed.shared.slice(-200) : [],
        lastDecision: parsed?.lastDecision ?? null,
        lastRunAt: Number(parsed?.lastRunAt) || 0,
      };
    } catch {
      return fallback;
    }
  }

  persist() {
    try {
      this.store?.setState?.(PROACTIVE_STATE_KEY, JSON.stringify(this.runtime));
    } catch { /* 状态丢了最多是"早一轮"或"晚一轮"，不影响正确性 */ }
  }

  /** 到点了吗。`force` 给面板的"现在让她看一眼"。 */
  due(now = Date.now(), { force = false } = {}) {
    if (force) return true;
    return now >= (Number(this.runtime.nextAt) || 0);
  }

  /** 候选：安静的窗口（含"她在那儿有未完成的事"的线索）+ 新鲜的热门视频。 */
  async candidates({ now = Date.now(), signal = null } = {}) {
    const speak = [];
    const skipped = [];
    const skippedCounts = {};
    const skip = (key, reason) => {
      skipped.push({ key, reason });
      skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1;
    };
    const rows = this.store?.listConversations?.({ since: now - 30 * DAY_MS, limit: 40 }) ?? [];
    const limit = Math.max(1, Number(this.config.proactiveQueryLimit) || 6);
    const selfId = String((this.config?.selfIds ?? [])[0] ?? '').trim();
    // 陈旧上限：对三周前的一句私聊开口，比不说更吓人。默认只回七天内的沉默。
    const staleHours = Math.max(1, Number(this.config.proactiveStaleHours) || 168);
    // `conversations.last_spoke_at` 这列从来没写过；真值在会话表的内存条目里。
    // 冷却如果只看库列，等于永远"没说过话"，冷却就是摆设。
    const spokeAtOf = (row) => Number(this.registry?.byKey?.get?.(row?.conversation)?.lastSpokeAt) || Number(row?.last_spoke_at) || 0;
    for (const row of rows) {
      const key = String(row?.conversation ?? '');
      if (!this.#permitted(key)) { skip(key, 'not-permitted'); continue; }
      // 她自己的号也是会话（user:<self_id>），不能当成"想跟谁说话"的对象。
      if (selfId && key === `user:${selfId}`) { skip(key, 'self'); continue; }
      if (!this.#budgetFor(key, now)) { skip(key, 'budget'); continue; }
      const quiet = hoursSince(now, row.last_message_at);
      if (quiet < (Number(this.config.proactiveQuietHours) || 8)) { skip(key, 'quiet'); continue; }
      if (quiet > staleHours) { skip(key, 'stale'); continue; }
      if (hoursSince(now, spokeAtOf(row)) < (Number(this.config.proactiveCooldownMs) || 21600000) / 3600000) { skip(key, 'cooldown'); continue; }
      const history = this.store?.proactiveHistory?.(key, {
        limit: Math.max(2, Number(this.config.proactiveLearnWindow) || 6) * 2,
        since: now - 90 * DAY_MS,
      }) ?? [];
      const learn = frequencyFactor(history, this.config, now);
      if (learn.factor <= 0) { skip(key, 'learn-stopped'); continue; }
      speak.push({
        key,
        label: this.#labelOf(key),
        quietHours: Math.round(quiet),
        factor: learn.factor,
        learn,
        lastSpokeAt: spokeAtOf(row),
      });
    }
    speak.sort((a, b) => b.quietHours - a.quietHours);
    const shortSpeak = speak.slice(0, limit);
    for (const item of speak.slice(limit)) skip(item.key, 'shortlist');

    let bili = null;
    if (this.config.proactiveBiliEnabled !== false && this.config.proactiveBiliIntent !== 'off') {
      const feed = await fetchBiliRanking({
        config: this.config,
        signal,
        rid: 0,
        timeoutMs: Number(this.config.proactiveBiliTimeoutMs) || 8000,
      });
      if (feed.items?.length) {
        const items = biliShortlist(feed.items, {
          shared: this.runtime.shared,
          keywords: this.config.proactiveBiliKeywords ?? [],
          count: Math.max(2, Number(this.config.proactiveBiliShortlist) || 8),
        });
        if (items.length) bili = { items, reason: feed.reason };
      } else {
        this.stats.lastProactiveFeed = { at: now, reason: feed.reason };
      }
    }
    // 诊断留给 /status：每一个被筛掉的窗口都要说得出是哪个、为什么。
    this.lastCandidates = {
      at: now,
      considered: rows.length,
      picked: shortSpeak.map((item) => ({ key: item.key, label: item.label, quietHours: item.quietHours, factor: item.factor })),
      skipped,
      skippedCounts,
    };
    return { speak: shortSpeak, bili };
  }

  #permitted(key) {
    const [kind, id] = String(key).split(':');
    if (kind === 'group') return this.config.groupEnabled !== false && this.#allowed(this.config.groups, id);
    if (kind === 'user') return this.config.privateEnabled !== false && this.#allowed(this.config.users, id);
    return false;
  }

  #allowed(list, id) {
    if (!Array.isArray(list) || !list.length) return true;
    return list.map(String).includes(String(id));
  }

  /** 这个会话今天还有额度吗（每会话每天最多 1 次主动）。 */
  #budgetFor(key, now) {
    const rows = this.store?.proactiveRecent?.({ limit: 200, since: startOfDay(now) }) ?? [];
    const total = rows.filter((row) => row.status === 'sent').length;
    if (total >= (dailyAllowance(this.config))) return false;
    return !rows.some((row) => row.conversation === key && row.status === 'sent');
  }

  #labelOf(key) {
    try {
      const [kind, id] = String(key).split(':');
      if (kind === 'group') {
        const group = this.memory?.selfLedger?.groups?.().find((g) => String(g.groupId) === String(id));
        return group?.name ? `群「${group.name}」` : '某个群';
      }
      const friend = this.memory?.selfLedger?.friends?.().find((f) => String(f.userId) === String(id));
      return friend?.remark || friend?.nickname ? `私聊「${friend.remark || friend.nickname}」` : '某个人';
    } catch {
      return String(key).startsWith('group:') ? '某个群' : '某个人';
    }
  }

  /** 自己在不在状态（关着/在跑回合/刚说完话）。 */
  #busy(key, now) {
    const entry = this.registry?.entry?.(key);
    if (!entry) return 'no-entry';
    if (entry.pending?.length) return 'unread';
    if (Number(entry.awakeUntil) > now) return 'recently-spoke';
    return '';
  }

  /**
   * 结算到点的主动发言：15 分钟内有没有人接。
   *
   * 结果写回 `proactive.outcome`，它同时是 `/status` 的读数与下一轮频率的输入。
   *
   * ⚠️ 这里有两条**只在这两处长对**的规则：
   *
   * 1. **只有"对某个真实窗口说过话"的行才谈得上有没有人接。** 脊柱那一行记的是
   *    `conversation='self:account'`（"她自己时间这一轮醒过"），而 `self:account`
   *    里永远不会有任何事件 —— 于是每一行都必然判成 `quiet`。线上 10 行里 3 行
   *    `sent` 全被判「没人接」，其中两行明明有人在 11:15、12:01 回了她
   *    （`group:946719566`、`group:1033440455`）。这类行给 `self`：不算"没人接"，
   *    也不进回应率——真正的账记在 `#spineTick` 按目标补的 `kind='say'` 行上。
   * 2. **按时间读，不按"最后 N 条"读。** 结算常常发生在开口 30~60 分钟之后
   *    （tick 间隔），而 `readEvents({latest:true})` 只给最后 40 条；群里热闹时
   *    那 40 条足够把 15 分钟内的回应挤出去。
   * 3. **"有人接"有靶子，不是"有人说话"。** 见 `engagementOf`：@ 她 / 引用她那句 /
   *    她之后第一句没把话头递给别人的话。观察范围就是她开口之后的这 15 分钟
   *    （`proactiveEngageWindowMs`），再往后群里说什么都与这一句无关。
   */
  async settle({ now = Date.now(), signal = null } = {}) {
    const window = Math.max(60000, Number(this.config.proactiveEngageWindowMs) || 900000);
    const rows = this.store?.pendingProactiveChecks?.({ before: now - window, limit: 20 }) ?? [];
    for (const row of rows) {
      if (signal?.aborted) break;
      if (!SETTLEABLE.test(String(row.conversation ?? ''))) {
        this.store?.finishProactiveCheck?.(row.id, 'self');
        continue;
      }
      const since = Number(row.created_at) || 0;
      // 往前多看一分钟：她自己那句话落在 createdAt == since，得能读到才能认出"谁引用了它"。
      const events = this.store?.eventsSince?.(row.conversation, { since: Math.max(0, since - 60000), limit: 80 })
        ?? this.store?.readEvents?.(row.conversation, { limit: 200, latest: true })?.messages ?? [];
      const replied = engagementOf(events, since, {
        selfIds: this.config.selfIds ?? [],
        until: since + window,
      });
      this.store?.finishProactiveCheck?.(row.id, replied ? 'replied' : 'quiet');
    }
    return rows.length;
  }

  #historyLines() {
    try {
      const records = this.memory?.agent?.latest?.('self') ?? [];
      const lines = records
        .filter((r) => r && !r.withdrawn && /^me\./u.test(String(r.slot ?? '')) && r.visibility === 'public')
        .slice(0, 6)
        .map((r) => `- ${String(r.text ?? '').slice(0, 120)}`);
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  #ask({ speak, bili, now }) {
    return buildProactiveAsk({ speak, bili, now, thoughts: this.#historyLines() });
  }

  async #callModel(ask, signal) {
    const llm = this.ctx?.get?.('llm');
    if (!llm?.stream) return { ok: false, reason: 'llm-unavailable' };
    const sel = auxSelection(
      this.ctx,
      this.config,
      this.config.proactiveProvider && this.config.proactiveModel
        ? { provider: this.config.proactiveProvider, model: this.config.proactiveModel }
        : null,
    );
    if (!sel?.provider || !sel?.model) return { ok: false, reason: 'model-unavailable' };
    const timeout = Number(this.config.proactiveTimeoutMs) || 40000;
    const scope = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const system = '你是小鲸鱼本人，正在决定"现在要不要主动做点什么"。只输出一行 JSON，不解释、不用代码块。';
    const probe = new AuxProbe('proactive');
    let out = '';
    let iterator;
    try {
      const stream = llm.stream({
        ...sel,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: ask }] }],
        maxTokens: 500,
        signal: scope,
      });
      iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const step = await waitWithSignal(iterator.next(), scope);
        if (step.done) break;
        probe.observe(step.value);
        if (step.value?.type === 'text-delta') out += step.value.text;
      }
    } catch (error) {
      const failure = auxFailure(error, probe, { text: out, timedOut: scope?.aborted });
      recordAuxCall('proactive', { ok: false, cause: failure.cause, durationMs: probe.durationMs, probe, detail: failure.detail, verdict: '决定失败', reason: failure.cause, subject: '主动开口', sample: out });
      return { ok: false, reason: failure.cause };
    } finally {
      if (iterator?.return) Promise.resolve(iterator.return()).catch(() => {});
    }
    try {
      const parsed = parseJsonLoose(out);
      recordAuxCall('proactive', { ok: true, durationMs: probe.durationMs, probe, verdict: String(parsed?.action ?? '?'), reason: String(parsed?.why ?? '').slice(0, 40), subject: '主动开口', sample: out });
      return { ok: true, verdict: parsed };
    } catch {
      recordAuxCall('proactive', { ok: false, cause: 'invalid-json', durationMs: probe.durationMs, probe, verdict: '决定失败', reason: 'JSON 坏了', subject: '主动开口', sample: out });
      return { ok: false, reason: 'invalid-json' };
    }
  }

  #validate(verdict, { speak, bili }) {
    const action = String(verdict?.action ?? 'none');
    if (!PROACTIVE_ACTIONS.includes(action)) return { action: 'none', why: '无效动作' };
    if (action === 'none') return { action, why: String(verdict?.why ?? '').slice(0, 40) };
    const target = String(verdict?.target ?? '');
    const allowed = new Set(speak.map((item) => item.key));
    if (!allowed.has(target)) return { action: 'none', why: '目标不在候选里' };
    const pick = Number(verdict?.pick) || 0;
    if (action === 'bili_share') {
      if (!bili?.items?.[pick - 1]) return { action: 'none', why: '没选到视频' };
      return { action, target, pick, text: String(verdict?.text ?? '').slice(0, 80), why: String(verdict?.why ?? '').slice(0, 40), item: bili.items[pick - 1] };
    }
    const text = String(verdict?.text ?? '').trim();
    if (!text || text.length > (Number(this.config.proactiveMaxTextChars) || 120)) return { action: 'none', why: '话太长或没写' };
    return { action, target, text, why: String(verdict?.why ?? '').slice(0, 40) };
  }

  /**
   * 真开口的那一段。**锁只在这里**：决策已经在外面做完了，
   * 这里只做"复查 → 发 → 记账"，几十毫秒。
   */
  async deliver({ verdict, signal, now = Date.now() }) {
    const key = verdict.target;
    const busy = this.#busy(key, now);
    if (busy) return { sent: false, reason: busy };
    if (!this.#budgetFor(key, now)) return { sent: false, reason: 'budget' };
    const text = verdict.action === 'bili_share'
      ? biliShareText({
        line: verdict.text,
        title: verdict.item?.title ?? '',
        bvid: verdict.item?.bvid ?? '',
      })
      : verdict.text;
    const isGroup = key.startsWith('group:');
    const target = isGroup ? { group_id: Number(key.slice(6)) } : { user_id: Number(key.slice(5)) };
    const idemKey = `proactive:${key}:${now}:${Math.floor(Math.random() * 1e6)}`;
    let result;
    try {
      result = await sendOnebotIdempotent(this.ctx, this.config, this.store, {
        idemKey,
        conversation: key,
        action: isGroup ? 'send_group_msg' : 'send_private_msg',
        target,
        message: [{ type: 'text', data: { text } }],
        signal,
      });
    } catch (error) {
      this.stats.proactiveFailures = (this.stats.proactiveFailures ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: verdict.action, target: key, ok: false, reason: String(error?.message ?? error).slice(0, 120) };
      return { sent: false, reason: 'send-failed' };
    }
    if (!result?.sent) return { sent: false, reason: result?.held ? 'held' : 'replayed' };

    // 三样记账：窗口历史（归属）、账本（学习）、自传（"我做过什么"）。
    try {
      const entry = this.registry?.entry?.(key);
      if (entry) {
        recordContext(this.config, entry, { qq: '', who: '你', text, bot: true, messageId: result.onebotId ?? 'self:' + idemKey, at: now, timeSource: 'sent' });
        wakeAfterSpeech(this.config, entry, now);
        this.registry?.persist?.(key, entry);
      }
      this.store?.recordEvent?.({
        conversation: key,
        kind: 'self_message',
        payload: { text, who: '你', qq: '', messageId: result.onebotId ?? 'self:' + idemKey, at: now, timeSource: 'sent' },
        deliverable: false,
        dedupeKey: 'self:' + idemKey,
      });
    } catch { /* 记账失败不影响已经发出的那条 */ }
    this.store?.recordProactive?.({
      conversation: key,
      kind: verdict.action,
      trigger: verdict.why || 'host-clock',
      text,
      ref: verdict.item?.bvid ?? '',
      idemKey,
    });
    try {
      this.memory?.selfLedger?.record?.({
        kind: 'speak',
        target: key,
        summary: `主动开口：${text.split('\n')[0].slice(0, 60)}`,
        outcome: verdict.action === 'bili_share' ? '分享了视频' : '',
        source: 'self-turn',
      });
    } catch { /* 自传写入是加餐，不是前提 */ }
    this.stats.proactiveSpoke = (this.stats.proactiveSpoke ?? 0) + 1;
    this.stats.lastProactive = { at: now, action: verdict.action, target: key, ok: true, text: text.slice(0, 120), why: verdict.why };
    return { sent: true, text };
  }

  /**
   * 她在"自己的时间"里看到的东西。
   *
   * 这不是任务分配，是场景说明：现在几点、她在哪个窗口、可以做什么。
   * 刻意**不写**"大多数时候应该是 none"，也不给候选清单——那是替她做决定。
   * 工具就在手边，用不用、做不做，由她。
   */
  #selfTask({ key, now }) {
    const label = this.#labelOf(key);
    const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false });
    return [
      `现在是 ${stamp}，你在${label}这个窗口里。没有人在等你回答。`,
      '',
      '这是你自己的时间。你可以：',
      '- 什么都不做（回 [SKIP] 就行，这很正常，不用找理由）；',
      '- 看看别处最近怎么样：qq_windows（list 有哪些窗口，read 读某个窗口，mine 看自己说过什么）；',
      '- 去刷会儿B站：bili_search 搜、bili_subtitle 看字幕、bili_frames 看画面；看到觉得这边会喜欢的，就直接发出来；',
      '- 想跟谁说话就跟谁说（这个窗口直接回话；别的窗口用 qq_windows action=say，to 用 list 里的编号）。',
      '',
      '没有任务清单，也没有人要求你产出什么。要不要开口、开在哪、说什么，你自己定。',
    ].join('\n');
  }

  /**
   * 她对某个窗口的记性：打过几次、被接过几次、该不该降频。
   *
   * 这是"按目标学习"唯一的读取入口：快照用它写字（让她看见），
   * 嘴用它决定要不要按住（`factor === 0` 时按住）。
   */
  learningFor(conversation, { now = Date.now() } = {}) {
    const key = String(conversation ?? '');
    if (!key) return { attempts: 0, answered: 0, factor: 1 };
    let history = [];
    try {
      history = this.store?.proactiveHistory?.(key, {
        limit: Math.max(6, Number(this.config?.proactiveLearnWindow) || 6) * 2,
        since: now - 90 * DAY_MS,
      }) ?? [];
    } catch {
      history = [];
    }
    const attempts = history.length;
    const answered = history.filter((row) => row?.outcome === 'replied').length;
    return { attempts, answered, factor: frequencyFactor(history, this.config, now).factor };
  }

  /**
   * 该在哪个窗口醒来。
   *
   * 权重 = 她对那地方的记性 × 随机。factor 为 0 不是"禁止"，只是权重降到很低
   * （0.05）——她会记得没人接，但记忆不该替她把门锁上。
   */
  #pickWindow({ now }) {
    const rows = this.store?.listConversations?.({ since: now - 7 * DAY_MS, limit: 30 }) ?? [];
    const selfId = String((this.config?.selfIds ?? [])[0] ?? '').trim();
    const pool = [];
    for (const row of rows) {
      const key = String(row?.conversation ?? '');
      if (!this.#permitted(key)) continue;
      if (selfId && key === `user:${selfId}`) continue;
      const blocked = this.#busy(key, now);
      // 正在进行的对话不打断；没载入的窗口也不硬闯。
      if (blocked === 'unread' || blocked === 'no-entry') continue;
      const history = this.store?.proactiveHistory?.(key, {
        limit: Math.max(4, Number(this.config.proactiveLearnWindow) || 6) * 2,
        since: now - 90 * DAY_MS,
      }) ?? [];
      const learn = frequencyFactor(history, this.config, now);
      pool.push({ key, factor: learn.factor, weight: Math.max(0.05, learn.factor) * (0.5 + Math.random()) });
    }
    pool.sort((a, b) => b.weight - a.weight);
    return pool[0] ?? null;
  }

  /** 这一回合里她自己说出去了吗（工具发送与回合回话都算）。 */
  #spokeSince(key, since) {
    try {
      const events = this.store?.readEvents?.(key, { limit: 20, latest: true })?.messages ?? [];
      return events.some((event) => String(event.kind) === 'self_message' && Number(event.createdAt) >= since);
    } catch {
      return false;
    }
  }

  /** 把合成的"没有新消息"标记从窗口历史里摘掉，别让它冒充谁说过的话。 */
  #dropSelfTurn(key, marker) {
    try {
      const entry = this.registry?.entry?.(key);
      if (!entry?.window) return;
      const before = entry.window.length;
      entry.window = entry.window.filter((message) => String(message?.messageId ?? '') !== marker);
      if (entry.window.length !== before) this.registry?.persist?.(key, entry);
    } catch { /* 摘不掉最多是历史里多一行标记，不影响正确性 */ }
  }

  /**
   * 真回合模式：她带着工具醒一次，自己决定做不做、做什么。
   *
   * 和旧实现的差别不是"更聪明"，是**权限**：旧版我先筛候选、再问"这几个里挑一个"，
   * 她能决定的只有选项；这里她拿到的是"现在是你的时间"+ 全套工具，
   * 宿主管的只剩钟、账和三件世界的物理（睡觉、每日总次数、不打断在场对话）。
   */
  /**
   * 物理边界：夜里不打扰、一天说够就停。
   *
   * 这两条是"世界的物理"，不是"我替她写好该怎么办"：她可以想说什么就说什么，
   * 但夜里没人应、说太多会被讨厌，是这个世界的性质。
   */
  #guard({ now }) {
    const hour = new Date(now).getHours();
    const from = Number(this.config.proactiveSleepFrom);
    const to = Number(this.config.proactiveSleepTo);
    if (Number.isFinite(from) && Number.isFinite(to) && from !== to) {
      const asleep = from < to ? hour >= from && hour < to : hour >= from || hour < to;
      if (asleep) {
        this.stats.lastProactive = { at: now, action: 'sleep', ok: true };
        return { ran: false, reason: 'sleep' };
      }
    }
    const rows = this.store?.proactiveRecent?.({ limit: 200, since: startOfDay(now) }) ?? [];
    const today = rows.filter((row) => row.status === 'sent').length;
    if (today >= (dailyAllowance(this.config))) {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'none', ok: true, why: '今天开口够多了' };
      return { ran: true, action: 'none', reason: 'daily-budget' };
    }
    return null;
  }

  async #turnTick({ signal, now }) {
    if (signal?.aborted || !this.enabled) return { ran: false, reason: 'aborted' };

    const hour = new Date(now).getHours();
    const from = Number(this.config.proactiveSleepFrom);
    const to = Number(this.config.proactiveSleepTo);
    if (Number.isFinite(from) && Number.isFinite(to) && from !== to) {
      const asleep = from < to ? hour >= from && hour < to : hour >= from || hour < to;
      if (asleep) {
        this.stats.lastProactive = { at: now, action: 'sleep', ok: true };
        return { ran: false, reason: 'sleep' };
      }
    }

    const rows = this.store?.proactiveRecent?.({ limit: 200, since: startOfDay(now) }) ?? [];
    const today = rows.filter((row) => row.status === 'sent').length;
    if (today >= (dailyAllowance(this.config))) {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'none', ok: true, why: '今天开口够多了' };
      return { ran: true, action: 'none', reason: 'daily-budget' };
    }

    const pick = this.#pickWindow({ now });
    if (!pick) {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'none', ok: true, why: '没有能待的窗口' };
      return { ran: true, action: 'none', reason: 'no-window' };
    }

    const key = pick.key;
    const isGroup = key.startsWith('group:');
    const marker = `self-turn:${now}`;
    const text = '[自主时间] 现在没有新消息。';
    const event = {
      post_type: 'message',
      message_type: isGroup ? 'group' : 'private',
      ...(isGroup ? { group_id: Number(key.slice(6)) } : { user_id: Number(key.slice(5)) }),
      user_id: isGroup ? Number((this.config?.selfIds ?? [])[0] ?? 0) : Number(key.slice(5)),
      self_id: this.config?.selfIds?.[0],
      message_id: marker,
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      sender: { nickname: '时间' },
      __selfTurn: true,
    };

    let spoke = false;
    /**
     * 自主回合是"后台写者"之一：它允许写 `scope=self`（她可以在自己的时间里
     * 记下今天想通了什么）。房间里的普通回合不行——那是"收回房间写权"的边界，
     * 见 `lib/memory/tool.mjs`。
     */
    const turnSession = this.registry?.byKey?.get?.(key)?.sessionId;
    if (turnSession) this.state?.selfTurnSessions?.add?.(turnSession);
    try {
      const budget = Math.max(5000, Number(this.config.proactiveTurnTimeoutMs) || 120000);
      const withTimeout = AbortSignal.timeout(budget);
      await executeTurn(this.ctx, this.config, this.registry, this.state, this.memory, this.stats, this.store, key, event, {
        heartbeat: true,
        signal: signal ? AbortSignal.any([signal, withTimeout]) : withTimeout,
        taskText: this.#selfTask({ key, now }),
      });
      spoke = this.#spokeSince(key, now);
    } catch (error) {
      this.stats.proactiveFailures = (this.stats.proactiveFailures ?? 0) + 1;
      this.stats.lastProactive = {
        at: now, action: 'failed', ok: false, target: key,
        reason: String(error?.message ?? error).slice(0, 120),
      };
      return { ran: true, reason: 'turn-failed' };
    } finally {
      if (turnSession) this.state?.selfTurnSessions?.delete?.(turnSession);
      this.#dropSelfTurn(key, marker);
    }

    this.store?.recordProactive?.({
      conversation: key,
      kind: 'turn',
      trigger: 'self-time',
      text: '',
      ref: '',
      idemKey: `proactive:${key}:${now}`,
      status: spoke ? 'sent' : 'skipped',
    });
    if (spoke) {
      this.stats.proactiveSpoke = (this.stats.proactiveSpoke ?? 0) + 1;
    } else {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
    }
    this.stats.lastProactive = {
      at: now,
      action: spoke ? 'speak' : 'none',
      ok: true,
      target: key,
      factor: pick.factor,
      mode: 'turn',
      text: spoke ? '这一回合她开口了' : '这一回合她没说',
    };
    return { ran: true, action: spoke ? 'speak' : 'none', target: key, mode: 'turn' };
  }

  /**
   * 脊柱：她自己的时间不在任何房间里。
   *
   * `self:account` 这个会话不属于任何群、任何私聊，所以它看见的不是"某间屋子的
   * 最近消息"，而是 `buildWorldSnapshot()` 压出来的世界动静；它说的话也不会被
   * 投递到任何地方（`execute-turn` 里 `__spine` 分支直接返回），只有她主动用
   * `qq_windows say` 点名一个窗口，那句话才会真发出去。
   *
   * 这就是"多脑"的修法：决策发生在一个视野最宽、又不被任何房间带偏的地方；
   * 房间退回"嘴"。
   */
  async #spineTick({ signal, now }) {
    const key = 'self:account';
    const entry = this.registry?.entry?.(key);
    if (!entry) return { ran: false, reason: 'no-registry' };
    let sessionId = entry.sessionId;
    if (!sessionId) {
      try {
        sessionId = await this.registry.ensureSession(key);
      } catch (error) {
        this.stats.proactiveFailures = (this.stats.proactiveFailures ?? 0) + 1;
        this.stats.lastProactive = {
          at: now, action: 'failed', ok: false, target: key, mode: 'spine',
          reason: String(error?.message ?? error).slice(0, 120),
        };
        return { ran: true, reason: 'spine-session-failed' };
      }
    }
    this.state?.selfTurnSessions?.add?.(sessionId);

    const marker = `spine:${now}`;
    // 这句是时钟替她写的一行字，不是谁发来的消息。它必须**要求一个决定**：
    // 写成"这里没有新消息"时，模型会把它当成"一条没内容的消息"，回一个 [SKIP]
    // 就结束了（2026-11-01 实测四连沉默，每次 4 秒、4 个 token）。
    const text = '（自己的时间）你醒了，检查一下自己能做什么，找点事情做。包括但不限于：回忆并整理一下自己的记忆、整理归档一下今天发生了什么、想要去了解一个人，问问他你今天去了哪里，吃了什么东西、想要被人看见或认可：去发表一段说说、改一改自己的名称、去群里发表自己的见解、发布一个群公告、去刷B站并分享一个自己看见的有趣视频。你有自己的“冲动”，做任何你自己想要做的事，不只局限于聊天。';

    const selfId = this.config?.selfIds?.[0];
    const event = {
      post_type: 'message',
      message_type: 'private',
      // 她没有"对面的人"，这个 user_id 只是准入函数要求的一个非空发送者。
      // `__selfTurn` 会在 selfIds 拦截之前放行；没配 selfIds 时用 1 兜底，
      // 否则 user_id=0 会被当成"没有发送者"直接挡掉，整层静默失效。
      user_id: Number(selfId) || 1,
      self_id: selfId,
      message_id: marker,
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      sender: { nickname: '时间' },
      __selfTurn: true,
      __spine: true,
    };

    let spoke = false;
    let outcome = null;
    try {
      const snapshot = buildWorldSnapshot({
        store: this.store,
        memory: this.memory,
        registry: this.registry,
        now,
        staleDays: Number(this.config.intentStaleDays) || 14,
        // 每个窗口的记性：打过几次、被接过几次。快照只写事实，不写指令。
        learning: (conv) => this.learningFor(conv, { now }),
      });
      const before = this.store?.countSelfMessages?.({ since: now }) ?? 0;
      const budget = Math.max(5000, Number(this.config.proactiveTurnTimeoutMs) || 120000);
      const withTimeout = AbortSignal.timeout(budget);
      outcome = await executeTurn(this.ctx, this.config, this.registry, this.state, this.memory, this.stats, this.store, key, event, {
        heartbeat: true,
        signal: signal ? AbortSignal.any([signal, withTimeout]) : withTimeout,
        taskText: this.#spineTask({ now, snapshot }),
      });
      const after = this.store?.countSelfMessages?.({ since: now }) ?? 0;
      spoke = after > before;
      /*
       * 她"做了"什么，不能只从"说没说话"推。
       *
       * 2026-11-01 用户的原话是"这一轮的结果和心跳机制判断接话没区别"——对，
       * 因为账本里只记了 speak / skipped 两种。她自己时间里真正发生的事
       * （翻窗口、逛 B 站、改签名、整理本子）一直没有任何一行记录，
       * 于是下次醒来她也看不到"上次我在做什么"。
       * `outcome.toolNames` 是上游事件流里唯一可靠的证据，按工具名翻译成人话写进自传。
       */
      // 说话本身已由 speak 记账，这里只排掉"直接发言"这一种；
      // qq_windows（哪怕只是 read）算真做过的事——散步也该有痕迹。
      const acted = describeActions((outcome?.toolNames ?? [])
        .map((name) => String(name).replace(/^mcp__qq__/, ''))
        .filter((name) => !/^qq_send_(group|private)_msg$/.test(name)));
      if (acted) {
        try {
          this.memory?.selfLedger?.record?.({ kind: 'act', target: '', summary: acted, outcome: '', source: 'self-turn' });
        } catch { /* 自传是加餐，写不进去不影响这一轮 */ }
      }
      /*
       * 她这一轮到底写了什么，得留一份。
       *
       * 用户连着两次问"她为什么没动"，而我手上只有 skipped/sent 两行——
       * 分不清"她觉得没什么可做"和"她写了话却以为已经发出去了"。
       * 这里只留前 200 字，进 /status 的 `last`，不给任何窗口看。
       */
      const draft = String(outcome?.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (draft) this.stats.proactiveDraft = draft;
    } catch (error) {
      this.stats.proactiveFailures = (this.stats.proactiveFailures ?? 0) + 1;
      this.stats.lastProactive = {
        at: now, action: 'failed', ok: false, target: key, mode: 'spine',
        reason: String(error?.message ?? error).slice(0, 120),
      };
      return { ran: true, reason: 'spine-failed' };
    } finally {
      this.state?.selfTurnSessions?.delete?.(sessionId);
    }

    this.store?.recordProactive?.({
      conversation: key,
      kind: 'spine',
      trigger: 'self-time',
      text: '',
      ref: '',
      idemKey: `proactive:${key}:${now}`,
      status: spoke ? 'sent' : 'skipped',
    });
    if (spoke) {
      this.stats.proactiveSpoke = (this.stats.proactiveSpoke ?? 0) + 1;
      /*
       * 按目标补记一行。
       *
       * 上面那行记的是"她自己时间这一轮"（conversation=self:account），
       * 学习需要的是"她对某个群/某个人说了一句"。没有这一步，
       * `proactiveHistory('group:x')` 永远是空的，`settle()` 也就永远
       * 写不出 replied/quiet，"她会学会不去烦人"这条需求落不了地。
       */
      for (const row of this.store?.selfMessagesSince?.({ since: now - 2000 }) ?? []) {
        const target = String(row?.conversation ?? '');
        if (!target || target === key) continue;
        this.store?.recordProactive?.({
          conversation: target,
          kind: 'say',
          trigger: 'self-time',
          text: '',
          ref: `spine:${now}`,
          idemKey: `spine:${now}:${target}`,
          status: 'sent',
          // 用**她真正开口那一刻**，不是补记这一刻：结算要拿它比"谁在这之后说过话"。
          createdAt: Number(row?.at) || 0,
        });
      }
    } else this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
    this.stats.lastProactive = {
      at: now,
      action: spoke ? 'speak' : 'none',
      ok: true,
      target: key,
      mode: 'spine',
      text: spoke ? '她开口了' : '她没说话',
      acted: outcome?.toolNames?.length ? describeActions(outcome.toolNames
        .map((name) => String(name).replace(/^mcp__qq__/, ''))
        .filter((name) => !/^qq_windows$|^qq_send_(group|private)_msg$/.test(name))) : '',
      draft: this.stats.proactiveDraft ?? '',
    };
    return { ran: true, action: spoke ? 'speak' : 'none', target: key, mode: 'spine' };
  }

  #spineTask({ snapshot }) {
    return spineTaskText(snapshot);
  }

  /** 一个完整的"醒一次"：结算 → 排下一轮 → 候选 → 决定 → 执行。 */
  async tick({ signal = null, now = Date.now(), force = false } = {}) {
    if (!this.enabled) return { ran: false, reason: 'disabled' };
    if (!this.due(now, { force })) return { ran: false, reason: 'not-due' };
    this.stats.proactiveTicks = (this.stats.proactiveTicks ?? 0) + 1;
    this.runtime.nextAt = now + nextDelay(this.config);
    this.runtime.lastRunAt = now;
    this.persist();

    await this.settle({ now, signal });
    if (signal?.aborted || !this.enabled) return { ran: false, reason: 'aborted' };

    // 默认走"真回合"：她带着工具醒一次，自己决定做什么。
    // `proactiveMode: 'prompt'` 保留旧的选择题实现（下面那段），作回退与对照。
    if (this.config.proactiveMode !== 'prompt') {
      // 睡觉闸与每日额度对所有模式一致，先过一遍。
      const gate = this.#guard({ now });
      if (gate) return gate;
      // 脊柱：默认在她的"外面"醒，而不是借某个房间。房间退回"嘴"。
      if (this.config.proactiveSpine !== false) return this.#spineTick({ signal, now });
      return this.#turnTick({ signal, now });
    }

    const candidates = await this.candidates({ now, signal });
    if (!candidates.speak.length && !candidates.bili) {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'none', ok: true, why: '没有候选' };
      return { ran: true, action: 'none', reason: 'no-candidates' };
    }
    const decided = await this.#callModel(this.#ask({ ...candidates, now }), signal);
    if (!decided.ok) {
      this.stats.proactiveFailures = (this.stats.proactiveFailures ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'failed', reason: decided.reason };
      return { ran: true, reason: decided.reason };
    }
    const verdict = this.#validate(decided.verdict, candidates);
    if (verdict.action === 'none') {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'none', ok: true, why: verdict.why };
      return { ran: true, action: 'none', why: verdict.why };
    }
    const sent = await this.deliver({ verdict, signal, now });
    if (sent.sent && verdict.action === 'bili_share' && verdict.item?.bvid) {
      this.runtime.shared = [...new Set([...(this.runtime.shared ?? []), verdict.item.bvid])].slice(-200);
      this.persist();
    }
    return { ran: true, action: verdict.action, ...sent };
  }
}
