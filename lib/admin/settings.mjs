import fs from 'node:fs';
import path from 'node:path';
import { BY_KEY, ENTRIES, coerce } from './spec.mjs';

/**
 * 面板改配置的落盘层：基线 + 覆盖 + 审计。
 *
 * 为什么不在面板里直接改写 DSH 的 `cordis.patch.yml`：
 * 那个文件是宿主的配置真相源，格式是带注释的补丁 YAML，宿主自己也在写它
 * （`~/.dsh/settings.yaml` 旁边就留着一堆 undo 快照）。面板去改它，等于两个
 * 写者抢同一份文件，写坏一次就是"插件起不来"，而收益只是"设置页也能看到"。
 *
 * 所以这里做的是**覆盖层**：
 * - 插件启动时先把面板认的那几个键的原始值记成基线（baseline）；
 * - 再把 `panel-settings.json` 里的覆盖值写回同一个 config 对象 ——
 *   业务代码读的仍是对 config 的属性访问，改完下一轮就生效，不用重载插件；
 * - 「恢复默认」= 把基线值写回并删掉覆盖项。
 * 代价是 DSH 设置页看不到覆盖后的值，所以面板必须把"已覆盖"标出来。
 */

const FILE_NAME = 'panel-settings.json';
const HISTORY_LIMIT = 100;

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

/** 只把清单内的键当覆盖值，别的键即使文件里有人手写也不认。 */
function pickKnown(values) {
  const kept = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (BY_KEY.has(key)) kept[key] = value;
  }
  return kept;
}

class AdminSettings {
  /**
   * @param {object} config 插件拿到的配置对象（会被就地修改）
   * @param {string} dataDir 数据目录（覆盖文件落在它下面）
   * @param {() => number} clock 便于测试注入时间
   */
  constructor(config, dataDir, clock = Date.now) {
    this.config = config;
    this.clock = clock;
    this.file = path.join(dataDir, FILE_NAME);
    this.values = {};
    this.history = [];
    /** 基线必须在应用覆盖之前拍下来，否则"恢复默认"会恢复成覆盖值本身。 */
    this.baseline = {};
    for (const entry of ENTRIES) this.baseline[entry.key] = config[entry.key];
    this.loaded = false;
    this.frozen = Object.isFrozen(config);
  }

  /** 读盘并用覆盖值初始化 config。文件坏了只记一笔，不影响插件启动。 */
  load() {
    this.loaded = true;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') this.lastError = `读取 ${FILE_NAME} 失败: ${error.message}`;
      return this;
    }
    this.values = pickKnown(raw?.values);
    this.history = Array.isArray(raw?.history) ? raw.history.slice(-HISTORY_LIMIT) : [];
    const applied = {};
    for (const [key, value] of Object.entries(this.values)) {
      const checked = coerce(BY_KEY.get(key), value);
      if (!checked.ok) {
        // 校验规则改过之后旧值可能不再合法：跳过它，但保住其它项。
        this.values[key] = undefined;
        delete this.values[key];
        continue;
      }
      try {
        this.config[key] = checked.value;
        applied[key] = checked.value;
      } catch {
        this.frozen = true;
      }
    }
    this.appliedOnLoad = applied;
    return this;
  }

  snapshot() {
    return {
      frozen: this.frozen,
      file: this.file,
      loaded: this.loaded,
      lastError: this.lastError ?? null,
      entries: ENTRIES.map((entry) => ({
        key: entry.key,
        group: entry.group,
        label: entry.label,
        help: entry.help,
        kind: entry.kind,
        min: entry.min ?? null,
        max: entry.max ?? null,
        unit: entry.unit ?? null,
        placeholder: entry.placeholder ?? null,
        options: entry.options ?? null,
        value: this.config[entry.key] ?? (entry.kind === 'text' ? '' : null),
        baseline: this.baseline[entry.key] ?? null,
        overridden: Object.prototype.hasOwnProperty.call(this.values, entry.key),
      })),
      history: this.history.slice(-20).reverse(),
    };
  }

  /**
   * 应用一批改动。
   *
   * 先整体校验再落地：只要有任意一项不合法就整批拒绝 —— 半批成功会让
   * "我到底改成了什么"变模糊，而面板的确认框写的是一批。
   */
  patch(raw, note = '') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, rejected: [{ key: '*', error: 'patch 必须是对象' }] };
    }
    const checked = {};
    const rejected = [];
    for (const [key, value] of Object.entries(raw)) {
      const entry = BY_KEY.get(key);
      if (!entry) {
        rejected.push({ key, error: '不在可改清单里' });
        continue;
      }
      const result = coerce(entry, value);
      if (!result.ok) {
        rejected.push({ key, error: result.error });
        continue;
      }
      checked[key] = result.value;
    }
    if (rejected.length) return { ok: false, rejected };

    const at = nowIso(this.clock);
    const changes = [];
    for (const [key, value] of Object.entries(checked)) {
      const from = this.config[key];
      if (from === value && Object.prototype.hasOwnProperty.call(this.values, key)) continue;
      try {
        this.config[key] = value;
      } catch (error) {
        this.frozen = true;
        return { ok: false, rejected: [{ key, error: `config 只读: ${error.message}` }] };
      }
      this.values[key] = value;
      changes.push({ at, key, from: from ?? null, to: value, note: String(note ?? '').slice(0, 200) });
    }
    if (changes.length) {
      this.history.push(...changes);
      if (this.history.length > HISTORY_LIMIT) this.history = this.history.slice(-HISTORY_LIMIT);
      this.save();
    }
    return { ok: true, changed: changes.map((change) => change.key), snapshot: this.snapshot() };
  }

  /** 恢复默认：把基线写回 config，并删掉这些键的覆盖。 */
  reset(keys = null) {
    const targets = (Array.isArray(keys) && keys.length ? keys : Object.keys(this.values))
      .filter((key) => BY_KEY.has(key));
    if (!targets.length) return { ok: true, changed: [], snapshot: this.snapshot() };
    const at = nowIso(this.clock);
    const changed = [];
    for (const key of targets) {
      const from = this.config[key];
      const to = this.baseline[key] ?? null;
      try {
        this.config[key] = to;
      } catch {
        this.frozen = true;
        continue;
      }
      delete this.values[key];
      changed.push({ at, key, from: from ?? null, to, note: '恢复默认' });
    }
    if (changed.length) {
      this.history.push(...changed);
      if (this.history.length > HISTORY_LIMIT) this.history = this.history.slice(-HISTORY_LIMIT);
      this.save();
    }
    return { ok: true, changed: changed.map((change) => change.key), snapshot: this.snapshot() };
  }

  /** 原子写：先写临时文件再 rename，避免断电留下半截 JSON。 */
  save() {
    const body = JSON.stringify({
      version: 1,
      updatedAt: nowIso(this.clock),
      values: this.values,
      history: this.history.slice(-HISTORY_LIMIT),
    }, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = this.file + '.tmp-' + process.pid;
      fs.writeFileSync(temp, body, 'utf8');
      fs.renameSync(temp, this.file);
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = `写入 ${FILE_NAME} 失败: ${error.message}`;
      return false;
    }
  }
}

function createAdminSettings(config, dataDir, clock = Date.now) {
  return new AdminSettings(config, dataDir, clock);
}

export { AdminSettings, createAdminSettings, FILE_NAME };
