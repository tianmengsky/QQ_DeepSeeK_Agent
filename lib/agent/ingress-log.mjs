/**
 * 消息准入账 —— "这条消息为什么没进回合"。
 *
 * 为什么需要（2026-11-01）：判断流记的是"进来了以后判不判接"，可线上最多的疑问是
 * **"她怎么没理我"**，而大多数消息根本没走到那一层：
 *   · 托管关着（disabled）
 *   · 不是她该理的（admitMessage：自己发的、白名单外、B站来源被过滤……）
 *   · 重复上报（dedupe）
 *   · 纯表情，只当上下文（passive）
 *   · 没 @ 也不在唤醒窗口 → 进缓冲 + 心跳（buffered）
 *   · 走了心跳（heartbeat）
 * 这些在 `stats.filtered / duplicatesDropped / passiveReactionsBuffered` 里只有一个总数，
 * 谁说的、说了什么、被哪道闸挡的，全都没有 —— 于是"没反应"永远只能猜。
 *
 * 和判断流同一套规矩：只放内存环形缓冲，随重载清零，不新增任何写库，
 * 也不保存完整正文（只留一小段摘要，够认出来是哪句）。
 */

const RING = 140;

/** 闸门代码 → 人话。面板与 `/status` 共用。 */
export const INGRESS_REASONS = {
  turn: '进了回合',
  batched: '合并窗口里攒着',
  heartbeat: '交给心跳判断',
  buffered: '没 @ 她，先攒着',
  passive: '纯表情，只当上下文',
  duplicate: '重复上报',
  'not-admitted': '不是她该理的',
  disabled: '托管关着',
  poke: '戳一戳（另一条路）',
  command: '指令消息',
  bili: 'B站私信',
};

/** 哪些算"没进回合"——面板默认只列这些，"她没理我"的答案通常在这几类里。 */
export const DROP_REASONS = new Set(['buffered', 'passive', 'duplicate', 'not-admitted', 'disabled']);

const rows = [];

/**
 * 记一条消息的去向。
 *
 * 高频路径（每条群消息都过一次），所以只做三件事：截摘要、推入、裁剪。
 * 不读库、不算哈希。
 *
 * @param {{conversation?: string, reason: string, who?: string, qq?: string|null,
 *   text?: string, at?: number}} input
 */
export function recordAdmission({ conversation = '', reason = 'turn', who = '', qq = null,
  text = '', at = Date.now() } = {}) {
  rows.push({
    conversation: String(conversation ?? '').slice(0, 60),
    reason: String(reason || 'unknown'),
    who: String(who ?? '').slice(0, 40),
    qq: qq == null ? null : String(qq),
    /** 摘要：够认出是哪句话就行；完整正文由 events 表负责。 */
    text: String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 80),
    dropped: DROP_REASONS.has(String(reason)),
    at,
  });
  if (rows.length > RING) rows.splice(0, rows.length - RING);
  return rows.length;
}

/**
 * 给 `/status` 与面板的那一份。
 *
 * 口径：`counts` 按闸门分（最近的环形窗口内，不是"开机以来"），
 * `rows` 新的在前，默认列 24 条 —— 和判断流一样的节奏。
 */
export function admissionSnapshot({ limit = 24, now = Date.now() } = {}) {
  const counts = {};
  for (const row of rows) counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  const recent = rows.slice(-limit).reverse().map((row) => ({
    ...row,
    label: INGRESS_REASONS[row.reason] ?? row.reason,
    ageMs: Math.max(0, now - row.at),
  }));
  const dropped = rows.filter((row) => row.dropped).length;
  return {
    total: rows.length,
    dropped,
    counts,
    reasons: Object.entries(counts)
      .map(([reason, count]) => ({ reason, count, label: INGRESS_REASONS[reason] ?? reason,
        dropped: DROP_REASONS.has(reason) }))
      .sort((a, b) => b.count - a.count),
    rows: recent,
    note: '内存环形缓冲（最近 140 条），重载后从零累计；只留摘要，完整正文在 events 表',
  };
}

export function resetAdmissionLog() { rows.length = 0; }
