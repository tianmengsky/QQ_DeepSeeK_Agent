/**
 * 脊柱演练：只读线上库，打印她"在外面醒来"时看到的整段场景文本。
 *
 * 为什么要有这个脚本：脊柱（self:account）的核心主张是"决策不发生在任何一间屋子里"，
 * 那就必须能单独看见"外面"长什么样。线上重载之前，先用真数据读一遍——
 * 不改库、不发消息、不起回合，只是把她那一轮的输入面打印出来。
 *
 * 用法：
 *   node tools/preview-self-time.mjs            # 用线上库
 *   node tools/preview-self-time.mjs --db <path> --memory <dir>
 */
import { DatabaseSync } from 'node:sqlite';
import { bridgeBlock, resolveBridgeDb } from './db-path.mjs';
import { buildWorldSnapshot } from '../lib/application/world-snapshot.mjs';
import { spineTaskText } from '../lib/application/proactive.mjs';

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
};

const dbPath = argOf('--db') || resolveBridgeDb();
if (!dbPath) {
  console.error('找不到桥接库；用 --db 指一个。');
  process.exit(2);
}
const memoryDir = argOf('--memory') || (String(bridgeBlock()).match(/memoryDir:\s*'([^']+)'/)?.[1] ?? '');

const db = new DatabaseSync(dbPath, { readOnly: true });

/** 只读的 store 替身：世界快照只用到这几个查询，不必为一个演练脚本起整套 Store。 */
const store = {
  available: true,
  listConversations({ since = 0, limit = 40 } = {}) {
    return db
      .prepare(
        'SELECT conversation, last_message_at, last_spoke_at FROM conversations WHERE last_message_at >= ? ORDER BY last_message_at DESC LIMIT ?',
      )
      .all(Number(since) || 0, Number(limit) || 40);
  },
  proactiveRecent({ limit = 10, since = 0 } = {}) {
    return db
      .prepare('SELECT * FROM proactive WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?')
      .all(Number(since) || 0, Number(limit) || 10);
  },
  openIntents({ before = 0, limit = 8 } = {}) {
    return db
      .prepare("SELECT * FROM intents WHERE status = 'open' AND (due_at = 0 OR due_at <= ?) ORDER BY due_at DESC, id DESC LIMIT ?")
      .all(Number(before) || 0, Number(limit) || 8);
  },
  /** 从事件表回推"她最后一次在那儿说话"——库列是死的，事件才是真记录。 */
  lastSelfMessageAt(conversation) {
    const row = db
      .prepare("SELECT MAX(created_at) AS at FROM events WHERE conversation = ? AND kind IN ('self_message', 'action')")
      .get(String(conversation));
    return Number(row?.at) || 0;
  },
  getState(key) {
    const row = db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(String(key));
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  },
  setState() {
    throw new Error('演练脚本只读');
  },
};

const memory = {
  store,
  agent: {
    /** 与 AgentMemory.latest 同形，只读投影。sources 存的是 JSON 文本。 */
    latest(subject) {
      const rows = db
        .prepare('SELECT * FROM bridge_agent_memories WHERE qq = ? AND deleted = 0 ORDER BY updated_at DESC')
        .all(String(subject));
      return rows.map((row) => {
        let sources = [];
        try {
          sources = JSON.parse(row.sources || '[]');
        } catch {
          sources = [];
        }
        return { ...row, sources };
      });
    },
  },
};

const now = Date.now();

// 她"最后一次在那儿说话"只存在于会话表的内存态里，落盘键是 qq-bridge:conversation:<会话>。
// 演练脚本把这一层还原成一个只读的 byKey，否则每次都显示"你还没在那边说过话"。
const PREFIX = 'qq-bridge:conversation:';
const byKey = new Map();
for (const row of db.prepare("SELECT key, value FROM runtime_state WHERE key LIKE 'qq-bridge:conversation:%'").all()) {
  try {
    const entry = JSON.parse(row.value);
    const spokeAt = Number(entry?.lastSpokeAt) || 0;
    if (spokeAt > 0) byKey.set(String(row.key).slice(PREFIX.length), { lastSpokeAt: spokeAt });
  } catch {
    /* 坏的一条不影响别的窗口 */
  }
}
const registry = { byKey };

const snapshot = buildWorldSnapshot({ store, memory, registry, now, maxChars: 9000 });
const task = spineTaskText(snapshot);

console.log(`库：${dbPath}`);
console.log(`记忆目录：${memoryDir || '（未配置）'}`);
console.log(`现在：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`);
console.log(`世快照 ${snapshot.length} 字 / 任务文本 ${task.length} 字`);
console.log('='.repeat(60));
console.log(task);
