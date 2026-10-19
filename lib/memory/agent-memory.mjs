import { randomUUID } from 'node:crypto';

/** 主模型拥有语义决定权；SQLite 保存逐槽版本，后台提炼不能覆盖这里。 */
export class AgentMemory {
  constructor(store) {
    this.store = store;
    this.available = Boolean(store?.available && store.db);
    if (this.available) store.db.exec(`CREATE TABLE IF NOT EXISTS bridge_agent_memories (
      id TEXT PRIMARY KEY, qq TEXT NOT NULL, slot TEXT NOT NULL, version INTEGER NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL, period TEXT NOT NULL, deleted INTEGER NOT NULL,
      sources TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(qq,slot,version));
      CREATE INDEX IF NOT EXISTS bridge_agent_memory_person ON bridge_agent_memories(qq,slot,version);`);
  }
  latest(qq) {
    if (!this.available) return [];
    return this.store.db.prepare(`SELECT m.* FROM bridge_agent_memories m WHERE qq=? AND
      NOT EXISTS (SELECT 1 FROM bridge_agent_memories n WHERE n.qq=m.qq AND n.slot=m.slot AND n.version>m.version)
      ORDER BY updated_at DESC,id`).all(String(qq)).map((r) => ({ ...r, sources: JSON.parse(r.sources) }));
  }
  active(qq, withdrawn = () => false) {
    return this.latest(qq).filter((r) => !r.deleted && r.sources.some((s) => !withdrawn(s.conversation, s.messageId)));
  }
  history(qq, slot) {
    if (!this.available) throw new Error('持久记忆数据库不可用');
    return this.store.db.prepare('SELECT * FROM bridge_agent_memories WHERE qq=? AND slot=? ORDER BY version DESC LIMIT 30')
      .all(String(qq), slot).map((r) => ({ ...r, sources: JSON.parse(r.sources) }));
  }
  write({ qq, slot, version, kind, text = '', period = '', sources, deleted = false }) {
    if (!this.available) throw new Error('持久记忆数据库不可用，未保存');
    if (!/^[a-z][a-z0-9_.-]{0,79}$/u.test(slot) || !Number.isInteger(version) || version < 0)
      throw new Error('slot 或 version 无效；先 read 查询当前版本，新槽 version=0');
    if (!['explicit', 'profile', 'impression'].includes(kind) || !Array.isArray(sources) || !sources.length ||
      typeof text !== 'string' || (!deleted && !text.trim()) || text.length > 600 ||
      typeof period !== 'string' || period.length > 160) throw new Error('记忆内容、类别、时期或来源无效');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.latest(qq).find((r) => r.slot === slot);
      // 同一来源的相同操作重放返回原回执，不生成新版本。
      if (current && current.version === version + 1 && current.kind === kind && current.text === text.trim() &&
        current.period === period.trim() && Boolean(current.deleted) === deleted &&
        JSON.stringify(current.sources) === JSON.stringify(sources)) {
        this.store.db.exec('COMMIT');
        return { status: deleted ? 'FORGOTTEN' : 'SAVED', replay: true, slot, version: current.version, id: current.id };
      }
      if ((current?.version ?? 0) !== version) throw new Error('记忆版本已变化；重新 read 后再修订，未覆盖其他回合');
      const id = randomUUID(), at = Date.now();
      this.store.db.prepare(`INSERT INTO bridge_agent_memories
        (id,qq,slot,version,kind,text,period,deleted,sources,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, String(qq), slot, version + 1, kind, text.trim(), period.trim(), Number(deleted), JSON.stringify(sources), at);
      this.store.db.exec('COMMIT');
      return { status: deleted ? 'FORGOTTEN' : 'SAVED', slot, version: version + 1, id, updatedAt: at };
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
}

export const AGENT_MEMORY_HEADING = '## 主模型记忆';
export const AGENT_MEMORY_START = '<!-- qq-bridge:agent-memory:start -->';
export const AGENT_MEMORY_END = '<!-- qq-bridge:agent-memory:end -->';
export function memoryLine(r) {
  const label = { explicit: '明确记忆', profile: '个人资料', impression: '主观印象，可修订' }[r.kind];
  return `- [${label}] ${r.text.replace(/\s+/gu, ' ')}${r.period ? `（时期：${r.period.replace(/\s+/gu, ' ')}）` : ''}（${r.slot}；v${r.version}）`;
}
