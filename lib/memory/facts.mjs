import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const normalize = (text) => String(text ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const sourceKey = (conversation, id) => JSON.stringify([String(conversation), String(id)]);
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
      return value;
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
  commit({ subject, fact, key, operation = 'upsert', source, memoryKind = 'stable' }) {
    if (this.withdrawn(source.conversation, source.messageId)) return { added: false, recalled: true };
    const records = this.load(subject), stamp = Date.now();
    const canonical = normalize(fact);
    const duplicate = records.find((r) => r.active && r.key === key && normalize(r.fact) === canonical);
    if (operation !== 'forget' && duplicate) {
      if (!duplicate.sources.some((s) => sourceKey(s.conversation, s.messageId) === sourceKey(source.conversation, source.messageId))) {
        duplicate.sources = [...duplicate.sources, source].slice(-20);
        duplicate.sourceCount = duplicate.sources.length;
        this.save(subject, records);
      }
      return { added: false, duplicate: true };
    }
    for (const record of records) if (record.active && record.key === key) {
      record.active = false;
      record.invalidReason = operation === 'forget' ? 'explicit_correction' : 'superseded';
    }
    if (operation !== 'forget') records.push({
      subject, key, fact: String(fact).trim(), sources: [source], sourceCount: 1,
      createdAt: stamp, active: true, memoryKind,
    });
    this.save(subject, records.slice(-500));
    return { added: operation !== 'forget', corrected: operation === 'forget' };
  }
}

export { normalize, sourceKey };
