import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const WORKSPACE_STATE_KEY = 'qq-bridge:workspace-root';
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 50 * 1024 * 1024;
export function workspaceRoot(config = {}) {
  return path.resolve(config.workspaceRoot?.trim() || process.env.QQ_WORKSPACE_ROOT || path.join(os.homedir(), '.dsh', 'qq-workspaces'));
}
export function workspaceDirectory(root, conversation) {
  if (!/^(group|user|bili):[1-9]\d*$/.test(conversation)) throw new Error('非法会话');
  return path.join(root, conversation.replace(':', '-'));
}

function parts(relative, allowEmpty = false) {
  if (typeof relative !== 'string') throw new Error('path 必须是工作区内的相对路径');
  if (allowEmpty && (relative === '' || relative === '.')) return [];
  const segments = relative.replaceAll('\\', '/').split('/');
  if (segments.some((s) => !s || s === '.' || s === '..' || /[<>:"|?*\x00-\x1f]/.test(s)
    || s.toLowerCase() === '.outgoing'
    || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)))
    throw new Error('只接受工作区内的相对路径，禁止上级目录、绝对路径和特殊文件名');
  return segments;
}
export function fileName(name) {
  const segments = parts(name);
  if (segments.length !== 1 || Buffer.byteLength(name) > 180) throw new Error('name 必须是普通文件名');
  return name;
}
function checkedStat(full) {
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1))
    throw new Error('工作区禁止符号链接、目录联接、硬链接及特殊文件');
  return stat;
}
function ensureDirectory(full) {
  // Check each existing component, including ancestors of the configured root.
  const parsed = path.parse(path.resolve(full));
  let cur = parsed.root;
  for (const part of path.relative(parsed.root, full).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    try { fs.mkdirSync(cur); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (!checkedStat(cur).isDirectory()) throw new Error('工作区路径不是目录');
  }
}
function target(base, relative, createParents = false, allowEmpty = false) {
  const segments = parts(relative, allowEmpty);
  let cur = base;
  for (let i = 0; i < segments.length; i++) {
    cur = path.join(cur, segments[i]);
    const last = i === segments.length - 1;
    if (createParents && !last) {
      try { fs.mkdirSync(cur); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (fs.existsSync(cur) || (() => { try { fs.lstatSync(cur); return true; } catch { return false; } })()) {
      const stat = checkedStat(cur);
      if (!last && !stat.isDirectory()) throw new Error('上级路径不是目录');
    } else if (!last || !createParents) throw new Error('工作区文件不存在');
  }
  return cur;
}
function scan(base, relative = '', includeInternal = false) {
  const start = target(base, relative, false, true), files = [];
  function walk(full, depth) {
    if (depth > 20) throw new Error('目录层级超过 20');
    const stat = checkedStat(full);
    if (stat.isFile()) {
      if (files.length >= 200) throw new Error('工作区最多 200 个文件');
      files.push({ path: path.relative(base, full).replaceAll('\\', '/'), bytes: stat.size });
    } else for (const name of fs.readdirSync(full).sort()) {
      if (!includeInternal && name === '.outgoing') continue;
      walk(path.join(full, name), depth + 1);
    }
  }
  walk(start, 0);
  return files;
}
function writeBuffer(base, relative, bytes) {
  if (bytes.length > MAX_FILE_BYTES) throw new Error('文件超过 20 MiB');
  const full = target(base, relative, true);
  const files = scan(base, '', true);
  const prior = files.find((f) => f.path === relative.replaceAll('\\', '/'));
  if ((!prior && files.length >= 200) || files.reduce((n, f) => n + f.bytes, 0) - (prior?.bytes ?? 0) + bytes.length > MAX_WORKSPACE_BYTES)
    throw new Error('工作区超过 200 个文件或 50 MiB 配额');
  fs.writeFileSync(full, bytes);
  return { path: relative.replaceAll('\\', '/'), bytes: bytes.length };
}
export function readWorkspaceFile(root, conversation, relative, limit = MAX_FILE_BYTES) {
  const base = workspaceDirectory(root, conversation);
  ensureDirectory(base);
  const full = target(base, relative);
  const stat = checkedStat(full);
  if (!stat.isFile() || stat.size > limit) throw new Error('目标不是普通文件或超过大小限制');
  const bytes = fs.readFileSync(full);
  if (bytes.length > limit) throw new Error('文件超过大小限制');
  return bytes;
}

/** Validate document-writer absolute paths inside the current conversation workspace. */
export function validateWorkspaceOutput(root, scope, absolute) {
  if (typeof absolute !== 'string' || !path.isAbsolute(absolute)) throw new Error('output_path 必须是当前 QQ 会话工作区内的绝对路径');
  const base = workspaceDirectory(root, scope);
  ensureDirectory(base);
  const relative = path.relative(base, path.resolve(absolute));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('output_path 不属于当前 QQ 会话工作区');
  return target(base, relative.replaceAll('\\', '/'), true);
}

// ZIP store format: portable UTF-8 names, no external executable or dependency.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name), crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(33, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(bytes.length, 20);
    c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, filename); offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function workspaceAction(root, conversation, args) {
  const base = workspaceDirectory(root, conversation);
  ensureDirectory(base);
  if (args.action === 'list') return scan(base, args.path ?? '');
  if (args.action === 'read') return readWorkspaceFile(root, conversation, args.path, MAX_TEXT_BYTES).toString('utf8');
  if (args.action === 'write') {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_TEXT_BYTES) throw new Error('content 必须是 UTF-8 文本，最多 1 MiB');
    return writeBuffer(base, args.path, Buffer.from(args.content));
  }
  if (args.action === 'pack') {
    fileName(args.output);
    if (!args.output.endsWith('.zip')) throw new Error('output 必须是 .zip 文件名');
    const prefix = parts(args.path ?? '', true).join('/');
    const files = scan(base, args.path ?? '').filter((f) => f.path !== args.output);
    if (!files.length) throw new Error('没有可打包的文件');
    if (files.reduce((n, f) => n + f.bytes, 0) > MAX_FILE_BYTES - 128000) throw new Error('打包内容超过 20 MiB');
    const entries = files.map((f) => ({ name: prefix && f.path.startsWith(prefix + '/') ? f.path.slice(prefix.length + 1) : f.path,
      bytes: readWorkspaceFile(root, conversation, f.path) }));
    return writeBuffer(base, args.output, zip(entries));
  }
  throw new Error('action 必须是 list/read/write/pack');
}
export function snapshotFile(root, conversation, bytes) {
  if (bytes.length > MAX_FILE_BYTES) throw new Error('文件超过 20 MiB');
  const base = workspaceDirectory(root, conversation);
  ensureDirectory(base);
  const dir = path.join(base, '.outgoing');
  ensureDirectory(dir);
  const full = path.join(dir, createHash('sha256').update(bytes).digest('hex') + '.bin');
  if (fs.existsSync(full)) {
    checkedStat(full);
    if (!fs.readFileSync(full).equals(bytes)) throw new Error('发送快照校验失败');
  } else {
    const files = scan(base, '', true);
    if (files.length >= 200 || files.reduce((n, f) => n + f.bytes, 0) + bytes.length > MAX_WORKSPACE_BYTES)
      throw new Error('工作区超过 200 个文件或 50 MiB 配额，无法创建发送快照');
    fs.writeFileSync(full, bytes, { flag: 'wx' });
  }
  return full;
}
