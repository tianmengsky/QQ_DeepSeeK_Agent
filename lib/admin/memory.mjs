import fs from 'node:fs';
import path from 'node:path';

/**
 * 记忆目录的浏览与编辑。
 *
 * 目录形状（见 lib/memory/memory-store.mjs）：`diary.md`、每个 QQ 号一份
 * `<uin>.md`、`groups/<群号>.md`；`.facts/`、`.attic/` 这类点开头的是结构化
 * 资料与归档，面板只读它们的文件数，不展开 —— 里面是 JSON 中间产物，手改会坏。
 *
 * 所有写操作都限制在 memoryDir 之内，且只认 `.md`：面板拿的是相对路径，
 * 一旦出现 `..` 或绝对路径就拒。这不是防御性编程，而是"面板默认监听
 * 0.0.0.0 之外的任何地址都可能被代理转发"时唯一说得清边界的做法。
 */

const MAX_READ_BYTES = 400_000;
const MAX_WRITE_CHARS = 200_000;

/**
 * 列表里显示的名字：记忆文件第一行通常是 `# 昵称（QQ 123）` 或 `# 日记`，
 * 比裸 uin 好认得多。读不到就退回文件名。
 */
function headline(full, fallback) {
  try {
    const fd = fs.openSync(full, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, read).toString('utf8');
      for (const line of head.split('\n')) {
        const text = line.replace(/^[#>\-*\s]+/, '').trim();
        if (!text) continue;
        return text.length > 40 ? text.slice(0, 40) + '…' : text;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* 读不到就用文件名 */
  }
  return fallback.replace(/\.md$/i, '');
}

function stamp(clock) {
  return new Date(clock()).toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

class AdminMemory {
  constructor(memoryDir, dataDir, clock = Date.now) {
    this.dir = memoryDir;
    this.clock = clock;
    this.backupDir = path.join(dataDir, 'panel-backups');
  }

  /**
   * 把客户端给的相对路径收敛成 memoryDir 里的绝对路径。
   * 出界或非 .md 一律返回 null，由调用方回 400。
   */
  resolveSafe(relative) {
    const raw = String(relative ?? '').trim();
    if (!raw) return null;
    if (raw.includes('\0')) return null;
    if (path.isAbsolute(raw)) return null;
    const full = path.resolve(this.dir, raw);
    const base = path.resolve(this.dir);
    const inside = full === base || full.startsWith(base + path.sep);
    if (!inside) return null;
    if (!/\.md$/i.test(full)) return null;
    return full;
  }

  list() {
    const files = [];
    const walk = (dir, prefix) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relative = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (prefix) continue; // 只展开一层（groups/），再深就是归档了
          walk(path.join(dir, entry.name), relative);
          continue;
        }
        if (!/\.md$/i.test(entry.name)) continue;
        try {
          const full = path.join(dir, entry.name);
          const stat = fs.statSync(full);
          files.push({
            path: relative,
            label: headline(full, entry.name),
            bytes: stat.size,
            mtimeMs: stat.mtimeMs,
            kind: entry.name === 'diary.md' ? 'diary' : relative.includes('/') ? 'group' : 'person',
          });
        } catch {
          /* 读不到就跳过 */
        }
      }
    };
    walk(this.dir, '');
    files.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'diary' ? -1 : b.kind === 'diary' ? 1 : 0;
      return b.mtimeMs - a.mtimeMs;
    });
    return {
      dir: this.dir,
      counts: {
        diary: files.filter((file) => file.kind === 'diary').length,
        person: files.filter((file) => file.kind === 'person').length,
        group: files.filter((file) => file.kind === 'group').length,
      },
      files,
    };
  }

  read(relative) {
    const full = this.resolveSafe(relative);
    if (!full) return { ok: false, error: '路径不合法' };
    try {
      const stat = fs.statSync(full);
      if (stat.size > MAX_READ_BYTES) return { ok: false, error: '文件太大（超过 400KB），请直接改磁盘上的文件' };
      const text = fs.readFileSync(full, 'utf8').replace(/\r\n?/g, '\n');
      return { ok: true, text, bytes: stat.size, mtimeMs: stat.mtimeMs };
    } catch (error) {
      return { ok: false, error: '读取失败: ' + error.message };
    }
  }

  write(relative, text) {
    const full = this.resolveSafe(relative);
    if (!full) return { ok: false, error: '路径不合法' };
    if (typeof text !== 'string') return { ok: false, error: '正文必须是字符串' };
    if (text.length > MAX_WRITE_CHARS) return { ok: false, error: `不能超过 ${MAX_WRITE_CHARS} 字` };

    const body = text.replace(/\r\n?/g, '\n');
    let backup = null;
    try {
      if (fs.existsSync(full)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
        const base = path.basename(full).replace(/\.md$/i, '');
        backup = path.join(this.backupDir, `memory-${base}-${stamp(this.clock)}.md`);
        fs.copyFileSync(full, backup);
      }
    } catch (error) {
      return { ok: false, error: '备份失败，已放弃写入: ' + error.message };
    }

    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const temp = full + '.tmp-' + process.pid;
      fs.writeFileSync(temp, body, 'utf8');
      fs.renameSync(temp, full);
      const stat = fs.statSync(full);
      return { ok: true, backup, bytes: stat.size, mtimeMs: stat.mtimeMs };
    } catch (error) {
      return { ok: false, error: '写入失败: ' + error.message };
    }
  }
}

function createAdminMemory(memoryDir, dataDir, clock = Date.now) {
  return new AdminMemory(memoryDir, dataDir, clock);
}

export { AdminMemory, createAdminMemory, MAX_READ_BYTES, MAX_WRITE_CHARS };
