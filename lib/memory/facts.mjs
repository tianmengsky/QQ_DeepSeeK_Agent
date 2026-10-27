import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const normalize = (text) => String(text ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const sourceKey = (conversation, id) => JSON.stringify([String(conversation), String(id)]);

/**
 * 印证与权重的默认值。
 *
 * 为什么要在 facts 这一层加：提炼器每看到一次同一件事，原来只会"覆盖"或"当成重复丢掉"，
 * 于是「说过一次」和「反复确认过十次」在数据里长得一模一样 —— 反思层要按重要程度
 * 取事实，没有这个区分就只能按文件顺序，等于随机。
 *
 * 三个字段的语义：
 *   · confirmations —— 这条事实被独立证据印证过几次（首次写入就是 1）；
 *   · confidence    —— 0~1 的置信度，印证一次加一档、纠正时从头开始；
 *   · lastSeen      —— 最后一次看到它的毫秒时间戳，反思层用它做时间衰减。
 */
export const FACT_DEFAULT_CONFIDENCE = 0.5;
/** 每次印证加多少置信度。0.1 × 几次就能到"很确定"，又不会一次跳到 1。 */
export const FACT_CONFIRM_STEP = 0.1;
/** 上限不到 1：模型说的话永远可能被下一句推翻，不给"绝对确定"。 */
export const FACT_MAX_CONFIDENCE = 0.95;

/**
 * 补齐旧记录缺的字段。
 *
 * 线上 `.facts` 里已经有几千条旧记录，它们没有这三个字段。这里只做**读时补齐**，
 * 不写回、不迁移 —— 旧档照常能读，下一次 commit 落盘时自然带上新字段。
 */
export function normalizeFactRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const confirmations = Number.isInteger(record.confirmations) && record.confirmations > 0
    ? record.confirmations
    : 1;
  const confidence = Number.isFinite(record.confidence)
    ? Math.min(1, Math.max(0, record.confidence))
    : FACT_DEFAULT_CONFIDENCE;
  // 旧记录只有 createdAt。缺时间时退 0（而不是 now），否则旧档会被当成"刚刚看过"。
  const lastSeen = Number.isFinite(record.lastSeen) && record.lastSeen > 0
    ? record.lastSeen
    : Number(record.createdAt) || 0;
  return { ...record, confirmations, confidence, lastSeen };
}
/** Conservative legacy handling: unknown slots are retained, explicitly transient slots stay out of prompts. */
export function isTransientConversationFact(record) {
  return ['task', 'topic', 'progress', 'transient'].includes(record?.memoryKind) ||
    /^(?:task|todo|topic|progress|pending|waiting)(?:[._-]|$)/u.test(record?.key ?? '');
}

/**
 * 会话「长期约定」这个面是否启用。
 *
 * `conversationMemoryMaxChars: 0` 表示整面关掉：既不注入，也不再让提炼器产出会话事实
 * （省掉注定被丢弃或过期的那部分候选）。已保存的记录保留为存档，不删除、不迁移。
 */
export function conversationFactsEnabled(config) {
  return (config?.conversationMemoryMaxChars ?? 450) > 0;
}

/** Structured, source-attributed facts live beside human editable legacy documents. */
export class FactStore {
  constructor(dir) {
    this.dir = path.join(dir, '.facts');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  file(subject) {
    return path.join(this.dir, createHash('sha256').update(String(subject)).digest('hex') + '.json');
  }
  load(subject) {
    try {
      const value = JSON.parse(fs.readFileSync(this.file(subject), 'utf8'));
      if (!Array.isArray(value) || (subject === '_withdrawn'
        ? value.some((v) => typeof v !== 'string')
        : value.some((r) => !r || r.subject !== subject || typeof r.fact !== 'string' ||
          typeof r.key !== 'string' || !Array.isArray(r.sources) ||
          r.sources.some((s) => !s || s.conversation == null || s.messageId == null))))
        throw new Error('invalid memory records: ' + subject);
      // 旧记录缺 confirmations/confidence/lastSeen 时在这里补默认值，调用方无需关心版本。
      return subject === '_withdrawn' ? value : value.map(normalizeFactRecord);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  save(subject, records) {
    const file = this.file(subject), temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(temp, file);
  }
  withdrawn(conversation, id) {
    return this.load('_withdrawn').includes(sourceKey(conversation, id));
  }
  /**
   * 列出所有存过事实的主体。
   *
   * 文件名是 subject 的 sha256（避免 QQ 号直接出现在路径里），所以只能反读：
   * 每个文件里的记录都带 `subject`，取第一条即可。坏文件跳过 —— 枚举是后台任务
   * 的入口，不该因为一个损坏的档把整轮反思拖死。
   */
  subjects() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json')); }
    catch { return []; }
    const out = new Set();
    for (const name of names) {
      let records;
      try { records = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); }
      catch { continue; }
      if (!Array.isArray(records)) continue;
      const subject = records.find((r) => r && typeof r.subject === 'string')?.subject;
      // `_withdrawn` 存的是字符串数组，取不到 subject，天然被排除。
      if (subject && subject !== '_withdrawn') out.add(subject);
    }
    return [...out];
  }
  retract(conversation, id) {
    const key = sourceKey(conversation, id), withdrawn = this.load('_withdrawn');
    if (!withdrawn.includes(key)) this.save('_withdrawn', [...withdrawn, key]);
    let removed = 0;
    for (const file of fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      let records;
      try { records = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')); }
      catch { continue; }
      if (!Array.isArray(records)) continue;
      let changed = false;
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        if (!Array.isArray(record.sources)) continue;
        const count = record.sources.length;
        record.sources = record.sources.filter((s) => s && sourceKey(s.conversation, s.messageId) !== key);
        if (record.active && !record.sources.length) {
          record.active = false;
          record.invalidReason = 'source_recalled';
          removed++;
          changed = true;
        } else if (record.sources.length !== count) changed = true;
        record.sourceCount = record.sources.length;
      }
      if (changed && records[0]?.subject) this.save(records[0].subject, records);
    }
    return removed;
  }
  active(subject) {
    const withdrawn = new Set(this.load('_withdrawn'));
    return this.load(subject).filter((r) => r.active).map((r) => ({ ...r,
      sources: r.sources.filter((s) => !withdrawn.has(sourceKey(s.conversation, s.messageId))),
    })).filter((r) => r.sources.length);
  }
  /**
   * 写入一条事实。
   *
   * `relation` 是提炼器给的判定（"这次是印证还是纠正"）：
   *   · `'confirm'` —— 命中同一个 key 时**只加证据**：confirmations +1、置信度升一档、
   *     刷新 lastSeen，但**不改写事实原文**。同一件事换个说法再说一次是常态，
   *     让它每次都被"改写"会丢信息、也会把 key 的正确措辞冲掉。
   *   · `'correct'`（默认）—— 原来的覆盖语义：旧记录置 superseded，新记录 active。
   *     缺省用它是为了兼容旧调用方与模型漏吐 relation 的情况。
   *
   * 原文与已存事实逐字相同时也按印证处理（即便 relation 标成 correct）：
   * 那不是纠正，是同一句话又出现了一次。
   */
  commit({ subject, fact, key, operation = 'upsert', source, memoryKind = 'stable',
    relation = 'correct' }) {
    if (this.withdrawn(source.conversation, source.messageId)) return { added: false, recalled: true };
    const records = this.load(subject), stamp = Date.now();
    const canonical = normalize(fact);
    const current = records.find((r) => r.active && r.key === key);

    if (operation !== 'forget' && current && (relation === 'confirm' || normalize(current.fact) === canonical)) {
      /**
       * 同一条消息重放不算印证。
       *
       * 提炼失败重试、批次重放都会把同一条原文再 commit 一次；如果每次都 +1，
       * 权重反映的就是"重试了几次"而不是"被印证了几次"。
       */
      const dedupe = sourceKey(source.conversation, source.messageId);
      if (current.sources.some((s) => sourceKey(s.conversation, s.messageId) === dedupe))
        return { added: false, duplicate: true, confirmed: true };
      current.sources = [...current.sources, source].slice(-20);
      current.sourceCount = current.sources.length;
      current.confirmations = (current.confirmations ?? 1) + 1;
      current.confidence = Math.min(FACT_MAX_CONFIDENCE,
        Math.round(((current.confidence ?? FACT_DEFAULT_CONFIDENCE) + FACT_CONFIRM_STEP) * 100) / 100);
      current.lastSeen = stamp;
      this.save(subject, records);
      return { added: false, duplicate: true, confirmed: true };
    }

    for (const record of records) if (record.active && record.key === key) {
      record.active = false;
      record.invalidReason = operation === 'forget' ? 'explicit_correction' : 'superseded';
    }
    if (operation !== 'forget') records.push({
      subject, key, fact: String(fact).trim(), sources: [source], sourceCount: 1,
      createdAt: stamp, active: true, memoryKind,
      // 新记录从 1 次印证、0.5 置信度开始；纠正不会继承旧置信度 —— 那是另一件事了。
      confirmations: 1, confidence: FACT_DEFAULT_CONFIDENCE, lastSeen: stamp,
    });
    this.save(subject, records.slice(-500));
    return { added: operation !== 'forget', corrected: operation === 'forget' };
  }
}

export { normalize, sourceKey };
