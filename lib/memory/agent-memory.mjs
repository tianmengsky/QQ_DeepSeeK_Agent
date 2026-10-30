import { randomUUID } from 'node:crypto';

/**
 * 记事本主体的三种取值。
 *
 * `qq` 这一列沿用旧名，但语义已经泛化成 **subject**：
 *   · `3667925015`（旧数据，纯 QQ 号）或 `user:3667925015` —— 某个人的本
 *   · `group:324089993` —— 某个群的本
 *   · `self` —— 通用本（关于自己、关于这个世界）
 *
 * 为什么不做一次数据迁移：UNIQUE(qq,slot,version) 本身对字符串没有任何假设，
 * 旧值 `3667925015` 与新值 `user:...` 可以并存；人物文档投影（syncDocument）
 * 仍按纯 QQ 号找行，所以旧数据一条都不用动。少一次迁移就少一次回滚风险。
 */
export const MEMORY_SCOPES = ['user', 'group', 'self'];

/** 可用的事件类别。`note` 是 2026-10-22 新增的自由笔记（可无原文，但必须有依据）。 */
export const MEMORY_KINDS = ['explicit', 'profile', 'impression', 'note', 'stance', 'want', 'open', 'relation'];

/**
 * 看法类条目：写的是"我怎么想"，不是"发生过什么"。
 *
 * 四类的分工是刻意的，缺一类就会退化成第二个提示词：
 *   stance   我对某件事的看法，可以改（改了要留旧版本，见 version）
 *   want     我想要什么 —— 主动性唯一的来源；没有这一类，她的所有话都只是回应
 *   open     我还没想通的事 —— 人会反复回到一个问题，这是"有内在生活"最硬的信号
 *   relation 我现在跟某人是什么关系（不是"他是谁"，那在人物本里）
 *
 * 只允许落在 `self` 本：人物本记事实，群本记这个群怎么运转，
 * 把自己的看法写进别人的本子会让"这是他说过的"和"这是我以为的"混成一团。
 */
export const MEMORY_SELF_KINDS = ['stance', 'want', 'open', 'relation'];

/** 会进日记（自我层）的类别：自由记事 + 看法类。 */
export const MEMORY_NOTE_KINDS = ['note', ...MEMORY_SELF_KINDS];

/**
 * 抽象自我槽前缀。
 *
 * `me.*` 的约定是：**已经脱敏、任何场合都能念**（不含群号、人名、别处发生的事）。
 * 因此它不受 visibility=public 的"只进群聊"限制，而是**无条件注入** ——
 * 私聊、群聊、账号会话都看得到。这正是她此前最缺的一块：
 * `memory/diary.md` 里 28 条只有 2 条可公开，等于她在群里几乎没有"自己"。
 *
 * 安全边界靠写入时强制：`me.*` 必须显式标 visibility=public（见 write()），
 * 让"这条能当众说"变成一次有意识的自审，而不是渲染时的猜测。
 */
export const SELF_MODEL_PREFIX = 'me.';

export function isSelfModelSlot(slot) {
  return String(slot ?? '').startsWith(SELF_MODEL_PREFIX);
}

/**
 * 通用本的可见范围。
 *
 * `private`（默认）：只进与 owner 的私聊和账号会话。
 * `public`：允许进群聊 —— 但仍必须自己保证"不含任何群号、人名、别处发生的事"。
 *
 * 为什么默认 private：群聊是多人场合，通用本记的是"我怎么想"，
 * 里面天然会带上具体的人和事。默认公开等于把 A 群的事带进 B 群，
 * 而这类泄露**发出去就收不回**。所以安全默认必须是 private，
 * 让 agent 显式选择"这条可以当众说"。
 *
 * 其他两本（人物 / 群聊）没有这个字段 —— 它们的可见范围由主体本身决定：
 * 人物本只注入给当前说话人，群本只进本群。
 */
export const MEMORY_VISIBILITY = ['private', 'public'];

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
    if (this.available) {
      /**
       * 幂等补列：`CREATE TABLE IF NOT EXISTS` 不会给已经存在的表加字段。
       *
       * 桥接与 qq-mcp 两个进程都会执行这段，所以必须能重复跑：
       * 先查 PRAGMA，缺了才 ALTER。不用 try/catch 吞异常 —— 那样磁盘满、
       * 库损坏这类真问题也会被静默吃掉，而这里恰恰是需要知道的时候。
       */
      try {
        const cols = store.db.prepare('PRAGMA table_info(bridge_agent_memories)').all().map((c) => c.name);
        if (!cols.includes('visibility'))
          store.db.exec("ALTER TABLE bridge_agent_memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
      } catch (error) {
        this.available = false;
        store.logger?.warn?.(`qq-bridge: 记忆表缺少 visibility 列且补列失败 —— ${error?.message ?? error}`);
      }
    }
  }
  /**
   * 某个主体的全部最新槽。
   *
   * 参数是 **subject**（`user:…` / 纯 QQ 号 / `group:…` / `self`），
   * 不是"QQ 号"。旧调用方传纯 QQ 号仍然成立 —— 人物本的 subject 就是纯 QQ 号。
   */
  latest(subject) {
    if (!this.available) return [];
    return this.store.db.prepare(`SELECT m.* FROM bridge_agent_memories m WHERE qq=? AND
      NOT EXISTS (SELECT 1 FROM bridge_agent_memories n WHERE n.qq=m.qq AND n.slot=m.slot AND n.version>m.version)
      ORDER BY updated_at DESC,id`).all(String(subject)).map((r) => ({ ...r, sources: JSON.parse(r.sources) }));
  }
  active(subject, withdrawn = () => false) {
    return this.latest(subject).filter((r) => !r.deleted && r.sources.some((s) => !withdrawn(s.conversation, s.messageId)));
  }
  /**
   * 所有写过条目的主体（`user` 的纯 QQ 号、`group:…`、`self`）。
   *
   * 供后台任务枚举用（目前是 L4 反思）。库不可用时返回空数组而不是抛 ——
   * 枚举只是"有没有活可干"，不该让它把调用方拖进异常路径。
   */
  subjects() {
    if (!this.available) return [];
    return this.store.db.prepare('SELECT DISTINCT qq FROM bridge_agent_memories').all().map((r) => String(r.qq));
  }
  history(subject, slot) {
    if (!this.available) throw new Error('持久记忆数据库不可用');
    return this.store.db.prepare('SELECT * FROM bridge_agent_memories WHERE qq=? AND slot=? ORDER BY version DESC LIMIT 30')
      .all(String(subject), slot).map((r) => ({ ...r, sources: JSON.parse(r.sources) }));
  }
  write({ subject, qq, slot, version, kind, text = '', period = '', visibility = 'private', sources, deleted = false }) {
    if (!this.available) throw new Error('持久记忆数据库不可用，未保存');
    // qq 是旧参数名；subject 明确时以它为准，避免调用方改写时漏掉一处。
    const owner = subject ?? qq;
    if (!/^[a-z][a-z0-9_.-]{0,79}$/u.test(slot) || !Number.isInteger(version) || version < 0)
      throw new Error('slot 或 version 无效；先 read 查询当前版本，新槽 version=0');
    if (!MEMORY_KINDS.includes(kind) || !MEMORY_VISIBILITY.includes(visibility) ||
      !Array.isArray(sources) || !sources.length ||
      typeof text !== 'string' || (!deleted && !text.trim()) || text.length > 600 ||
      typeof period !== 'string' || period.length > 160) throw new Error('记忆内容、类别、时期或来源无效');
    /**
     * 三条结构性约定，写在写入这一层而不是提示词里 —— 提示词会被遗忘，报错不会。
     *
     * 1. 看法类只能进自己的本子。写进人物本会让"他说过"与"我以为"混成一条，
     *    之后既没法引用、也没法改口。
     * 2. `me.*` 会无条件注入所有场合，所以必须显式标 public。要求一次自审，
     *    比在渲染时猜"这条会不会泄露"可靠：机器判断不了，她自己当时知道。
     * 3. 号码是最硬的那种泄露，而且机器判得出来，所以顺手拦掉。
     */
    if (MEMORY_SELF_KINDS.includes(kind) && owner !== 'self')
      throw new Error('看法类（stance/want/open/relation）只能写进 scope=self，人物本与群本只记事实');
    if (isSelfModelSlot(slot) && visibility !== 'public')
      throw new Error('me.* 槽会注入群聊等所有场合；请自审不含群号、人名、别处的事，并显式传 visibility=public');
    /**
     * 第三条是机器能判的那部分脱敏：长数字串几乎只可能是 QQ 号 / 群号。
     *
     * 不试图判断人名或"别处的事"——那交给上面那次自审。但号码是硬泄露，
     * 而它恰好能被一行正则拦住，值得拦：`me.*` 一旦注入，所有群都会看到。
     */
    if (isSelfModelSlot(slot) && /\d{5,}/u.test(text))
      throw new Error('me.* 里不要写群号或 QQ 号（它会进所有群）；用"某个人/那个群"代替');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.latest(owner).find((r) => r.slot === slot);
      // 同一来源的相同操作重放返回原回执，不生成新版本。
      if (current && current.version === version + 1 && current.kind === kind && current.text === text.trim() &&
        current.period === period.trim() && Boolean(current.deleted) === deleted &&
        (current.visibility ?? 'private') === visibility &&
        JSON.stringify(current.sources) === JSON.stringify(sources)) {
        this.store.db.exec('COMMIT');
        return { status: deleted ? 'FORGOTTEN' : 'SAVED', replay: true, slot, version: current.version, id: current.id };
      }
      if ((current?.version ?? 0) !== version) throw new Error('记忆版本已变化；重新 read 后再修订，未覆盖其他回合');
      const id = randomUUID(), at = Date.now();
      this.store.db.prepare(`INSERT INTO bridge_agent_memories
        (id,qq,slot,version,kind,text,period,deleted,sources,updated_at,visibility) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, String(owner), slot, version + 1, kind, text.trim(), period.trim(), Number(deleted), JSON.stringify(sources), at, visibility);
      this.store.db.exec('COMMIT');
      return { status: deleted ? 'FORGOTTEN' : 'SAVED', slot, version: version + 1, id, updatedAt: at };
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
}

export const AGENT_MEMORY_HEADING = '## 主模型记忆';
export const AGENT_MEMORY_START = '<!-- qq-bridge:agent-memory:start -->';
export const AGENT_MEMORY_END = '<!-- qq-bridge:agent-memory:end -->';
export function memoryLine(r) {
  const label = { explicit: '明确记忆', profile: '个人资料', impression: '主观印象，可修订', note: '记事',
    stance: '立场，可改', want: '想要的', open: '还没想通', relation: '关系（我这边）' }[r.kind];
  return `- [${label}] ${r.text.replace(/\s+/gu, ' ')}${r.period ? `（时期：${r.period.replace(/\s+/gu, ' ')}）` : ''}（${r.slot}；v${r.version}）`;
}

/**
 * scope → subject。
 *
 * 人物本用**纯 QQ 号**作 subject，因为 `syncDocument()` 要按 `memory/<qq>.md`
 * 投影，而那份投影按纯号找行。群本与通用本带前缀，互不冲突
 * —— 纯数字永远不会等于 `group:xxx` 或 `self`。
 */
export function memorySubject(scope, { qq = '', conversation = '' } = {}) {
  if (scope === 'self') return 'self';
  if (scope === 'group') {
    if (!/^group:[1-9]\d*$/.test(String(conversation))) throw new Error('群记事本只能写入当前群会话');
    return String(conversation);
  }
  const id = String(qq ?? '').trim();
  if (!/^[1-9]\d*$/.test(id)) throw new Error('人物记事本需要有效的 QQ 号');
  return id;
}
