/**
 * window-index.mjs —— 窗口的"名册"：名字、白名单、最近动静、别名编号。
 *
 * 为什么单独一个模块（2026-11-01）：窗口别名 `w1/w2…` 原来是 `qq_windows`
 * 的私有账本，`qq_dispatch` 上线后也按 `w?` 指代窗口，却读不到那份映射——
 * 线上她按提示词传 `w?`，两次都被拒，只能退回自己动手。编号既然在两个工具
 * 之间通用，账本就必须是**同一份**（按 Session 记，同一个窗口永远是同一个
 * 编号，重载后重新 list 即可）。
 *
 * 名字、白名单、最近窗口的查询同理：`qq_windows` 和 `qq_dispatch` 都要问
 * "她有哪些窗口、都叫什么、哪个能碰"，抄两份一定会烂（加白名单忘一处、
 * 改名字来源忘一处）。这里只放"窗口是什么"的事实，不放任何策略。
 */
import { isAllowed } from '../domain/admission.mjs';

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/** `conversation` 拆成 {kind, id}；认不出来返回 null。 */
export function splitConversation(key) {
  const m = /^(group|user):([1-9]\d*)$/u.exec(String(key ?? ''));
  return m ? { kind: m[1], id: m[2] } : null;
}

/**
 * 窗口名。群名来自 `self_group`，好友备注来自 `self_friend`；
 * 都查不到时退回"某个群/某个人"——宁可她不知道是谁，也不把号码交出去。
 */
export function windowNames(store) {
  const map = new Map();
  if (!store?.available) return map;
  try {
    for (const row of store.db.prepare('SELECT group_id, name FROM self_group').all())
      if (row?.group_id) map.set('group:' + row.group_id, clip(row.name, 24) || '某个群');
  } catch {}
  try {
    for (const row of store.db.prepare('SELECT user_id, nickname, remark FROM self_friend').all()) {
      if (!row?.user_id) continue;
      map.set('user:' + row.user_id, clip(row.remark || row.nickname, 24) || '某个人');
    }
  } catch {}
  return map;
}

/** 这个窗口在不在她的集合里：开关 + 白名单，白名单之外的一律不出现。 */
export function permittedConversation(config, key) {
  const parts = splitConversation(key);
  if (!parts) return false;
  return parts.kind === 'group'
    ? Boolean(config.groupEnabled) && isAllowed(config.groups, parts.id)
    : Boolean(config.privateEnabled) && isAllowed(config.users, parts.id);
}

/** 最近有动静的窗口（白名单内），按最后一条消息的时间倒序。 */
export function listRecentWindows(store, config, { limit = 20 } = {}) {
  if (!store?.available) return [];
  const rows = store.db
    .prepare(`SELECT conversation, last_message_at, last_spoke_at FROM conversations
              WHERE last_message_at > 0 ORDER BY last_message_at DESC LIMIT ?`)
    .all(Math.max(1, Math.min(50, limit)));
  return rows.filter((row) => permittedConversation(config, row.conversation));
}

/** 「群「名字」」/「私聊「备注」」；认不出来原样返回。 */
export function conversationLabel(key, map) {
  const parts = splitConversation(key);
  if (!parts) return String(key ?? '某个窗口');
  const name = map.get(key);
  return `${parts.kind === 'group' ? '群' : '私聊'}「${name || (parts.kind === 'group' ? '某个群' : '某个人')}」`;
}

/**
 * 窗口别名：工具的输出里只给 `w1/w2…`，不给群号。
 *
 * 号码在她嘴里没有任何用处，写进消息却是实打实的泄露；而指代目标又必须有
 * 个说法。别名按会话固定（同一个窗口一直是 w3）。
 *
 * 账本为什么落 SQLite（2026-11-01 线上教训）：编号的"记录"留在她的 DSH 会话
 * 历史里（旧几轮的工具输出），账本原来却只在桥接内存——桥接一重载（HMR 很勤）
 * 账本清空，她按历史里的 w1/w2 调用全部落空，只能靠报错把她指回 list。现在
 * 账本跟着 Session 落库，重载后第一次用到时恢复，历史里的编号不再过期。
 * 所有认 `w?` 的工具共用这一份映射——现在有 `qq_windows` 和 `qq_dispatch`。
 */
const aliasMaps = new Map();

const aliasStateKey = (session) => 'qq-bridge:window-alias:' + session;

function aliasState(session, store = null) {
  let entry = aliasMaps.get(session);
  if (entry) return entry;
  entry = { byConv: new Map(), byAlias: new Map(), next: 0 };
  if (store?.available) {
    try {
      const saved = JSON.parse(store.getState(aliasStateKey(session)) ?? 'null');
      if (saved) {
        for (const [alias, key] of Object.entries(saved.byAlias ?? {})) {
          entry.byAlias.set(alias, key);
          entry.byConv.set(key, alias);
        }
        entry.next = Math.max(0, Number(saved.next) || 0);
      }
    } catch { /* 账本读不出来就从零开始：大不了她重新 list 一次 */ }
  }
  aliasMaps.set(session, entry);
  // 内存里的账本别无限长：轮换后旧 Session 的编号不再有人问，最旧的先出去。
  if (aliasMaps.size > 40) aliasMaps.delete(aliasMaps.keys().next().value);
  return entry;
}

function persistAliases(session, entry, store) {
  if (!store?.available) return;
  try {
    store.setState(aliasStateKey(session), JSON.stringify({
      next: entry.next,
      byAlias: Object.fromEntries(entry.byAlias),
    }));
  } catch { /* 存不下来只是重载后要重新 list，不影响本次 */ }
}

export function aliasOf(session, key, store = null) {
  const entry = aliasState(session, store);
  let alias = entry.byConv.get(key);
  if (!alias) {
    alias = 'w' + ++entry.next;
    entry.byConv.set(key, alias);
    entry.byAlias.set(alias, key);
    persistAliases(session, entry, store);
  }
  return alias;
}

/** 她给的指代 → 会话键：认 `w?`，也认原始 `group:<号>` / `user:<号>`。 */
export function conversationOf(session, token, store = null) {
  const value = String(token ?? '').trim();
  if (/^w\d+$/u.test(value)) return aliasState(session, store).byAlias.get(value) ?? null;
  return splitConversation(value) ? value : null;
}
