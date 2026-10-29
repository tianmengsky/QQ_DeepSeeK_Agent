import fs from 'node:fs';
import path from 'node:path';

/**
 * 人设 / 规矩 / 示例这三个 markdown 的读写。
 *
 * 为什么不把这些内容塞进 `panel-settings.json` 当普通配置项：
 * `personaFile` 指向的是一份能直接编辑、能进 git、能在别处复用的文本，
 * 它的正文变化 `text-sources.mjs` 会按 mtime 自动重新读（`resolveTextField`），
 * 所以面板只要老老实实写文件，下一轮就生效 —— 不需要通知任何人。
 *
 * 客户端只能传名字（persona/behavior/examples），路径一律由配置决定，
 * 这样就没有"面板顺便能写任意文件"的口子。
 */

const TEXTS = [
  { name: 'persona', key: 'personaFile', label: '人设', max: 200_000 },
  { name: 'behavior', key: 'behaviorFile', label: '规矩', max: 200_000 },
  { name: 'examples', key: 'examplesFile', label: '示例', max: 200_000 },
];

const BY_NAME = new Map(TEXTS.map((item) => [item.name, item]));

function stamp(clock) {
  const iso = new Date(clock()).toISOString();
  return iso.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

class AdminTexts {
  constructor(config, dataDir, clock = Date.now) {
    this.config = config;
    this.dataDir = dataDir;
    this.clock = clock;
    this.backupDir = path.join(dataDir, 'panel-backups');
    this.cwd = String(config.cwd ?? '').trim() || process.cwd();
  }

  /** 配置文件键 → 绝对路径；空值返回 ''（表示没配）。 */
  resolve(name) {
    const item = BY_NAME.get(name);
    if (!item) return '';
    const raw = String(this.config[item.key] ?? '').trim();
    if (!raw) return '';
    return path.isAbsolute(raw) ? raw : path.resolve(this.cwd, raw);
  }

  meta(name) {
    const item = BY_NAME.get(name);
    if (!item) return null;
    const file = this.resolve(name);
    const out = {
      name,
      label: item.label,
      key: item.key,
      file: file || null,
      exists: false,
      bytes: 0,
      chars: 0,
      mtimeMs: 0,
      max: item.max,
    };
    if (!file) return out;
    try {
      const stat = fs.statSync(file);
      out.exists = true;
      out.bytes = stat.size;
      out.mtimeMs = stat.mtimeMs;
    } catch {
      return out;
    }
    try {
      out.chars = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').length;
    } catch {
      /* 读不出字数不影响其它字段 */
    }
    return out;
  }

  list() {
    return TEXTS.map((item) => this.meta(item.name));
  }

  read(name) {
    const file = this.resolve(name);
    if (!file) return { ok: false, error: '这一项还没配置文件路径（settings 里的 ' + (BY_NAME.get(name)?.key ?? '?') + '）' };
    try {
      const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
      return { ok: true, text, meta: this.meta(name) };
    } catch (error) {
      return { ok: false, error: '读取失败: ' + error.message };
    }
  }

  /**
   * 整份覆盖写。
   *
   * 写前先备份到 `panel-backups/` —— 人设是"改坏了就没了"的东西，
   * 而面板一个手滑就能把整份文件替换掉，没有备份会很难看。
   */
  write(name, text) {
    const item = BY_NAME.get(name);
    if (!item) return { ok: false, error: '未知文本' };
    if (typeof text !== 'string') return { ok: false, error: '正文必须是字符串' };
    if (text.length > item.max) return { ok: false, error: `不能超过 ${item.max} 字` };
    const file = this.resolve(name);
    if (!file) return { ok: false, error: `settings 里的 ${item.key} 是空的` };

    const body = text.replace(/\r\n?/g, '\n');
    let backup = null;
    try {
      if (fs.existsSync(file)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
        const base = path.basename(file).replace(/\.md$/i, '');
        backup = path.join(this.backupDir, `${base}-${stamp(this.clock)}.md`);
        fs.copyFileSync(file, backup);
      }
    } catch (error) {
      return { ok: false, error: '备份失败，已放弃写入: ' + error.message };
    }

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.tmp-' + process.pid;
      fs.writeFileSync(temp, body, 'utf8');
      fs.renameSync(temp, file);
      return { ok: true, backup, meta: this.meta(name) };
    } catch (error) {
      return { ok: false, error: '写入失败: ' + error.message };
    }
  }
}

function createAdminTexts(config, dataDir, clock = Date.now) {
  return new AdminTexts(config, dataDir, clock);
}

export { AdminTexts, createAdminTexts, TEXTS };
