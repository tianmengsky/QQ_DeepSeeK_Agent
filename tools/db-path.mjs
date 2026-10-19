/**
 * 解析桥接 SQLite 的位置 —— 所有 tools 共用，避免各自硬编码路径。
 *
 * 为什么要共用：桥接的库放在 `<stateDir>/qq-bridge.sqlite3`，而 stateDir 留空时
 * 回退到 `<profile 里 qq-bridge 的 cwd>/data/`。这两处都在 profile 配置里，
 * 一旦改动（比如把数据目录挪出私人路径），散落各处的硬编码就全部失准。
 *
 * 优先级：
 *   1. 显式传参
 *   2. 环境变量 QQ_BRIDGE_DB
 *   3. 本仓库的 data/qq-bridge.sqlite3（.gitignore 已含 data/，是设计上的落点）
 *   4. profile 里 qq-bridge 段配的 stateDir
 *   5. profile 里 qq-bridge 段配的 cwd 下的 data/
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DSH_HOME = process.env.DSH_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');

/** profile 里 qq-bridge 插件段（从 `- id: qq-bridge` 到下一个顶层条目）。 */
export function bridgeBlock() {
  const profile = path.join(DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop', 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(profile, 'utf8'); } catch { return ''; }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^-\s*id:\s*qq-bridge\s*$/.test(l));
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** 所有可能放着桥接库的目录，按优先级排列。 */
export function bridgeDataDirs() {
  const dirs = [path.join(REPO_ROOT, 'data')];
  const block = bridgeBlock();
  const stateDirs = [...block.matchAll(/^\s*stateDir:\s*'([^']+)'/gm)].map((m) => m[1]);
  const cwds = [...block.matchAll(/^\s*cwd:\s*'([^']+)'/gm)].map((m) => m[1]);
  for (const d of stateDirs) if (d.trim()) dirs.push(d.replaceAll('\\', path.sep));
  for (const d of cwds) dirs.push(path.join(d.replaceAll('\\', path.sep), 'data'));
  return [...new Set(dirs)];
}

/** 候选库文件，按优先级排列。 */
export function bridgeDbCandidates(explicit) {
  return [
    explicit,
    process.env.QQ_BRIDGE_DB,
    ...bridgeDataDirs().map((dir) => path.join(dir, 'qq-bridge.sqlite3')),
  ].filter(Boolean);
}

/** 返回第一个存在的库文件；都没有则返回 undefined。 */
export function resolveBridgeDb(explicit) {
  return bridgeDbCandidates(explicit).find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
}
