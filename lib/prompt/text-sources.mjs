import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableProtocol } from './protocol.mjs';

const personaCache = new Map();

const catalogCache = new Map();

function loadStickerCatalog(config) {
  const file = String(config.stickerCatalogPath ?? '').trim();
  if (!file) return [];
  try {
    const stat = fs.statSync(file);
    const hit = catalogCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.list;

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = (Array.isArray(raw) ? raw : [])
      .filter((e) => e && Number.isFinite(Number(e.n)) && typeof e.desc === 'string')
      .map((e) => ({ n: Number(e.n), desc: e.desc.replace(/\s+/g, ' ').trim() }))
      .filter((e) => e.desc)
      .sort((a, b) => a.n - b.n);

    catalogCache.set(file, { mtimeMs: stat.mtimeMs, list });
    return list;
  } catch {
    return [];
  }
}

function randomCatalogEntry(list, random = Math.random) {
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

function resolveTextField(file) {
  const path = String(file ?? '').trim();
  if (!path) return '';
  try {
    const stat = fs.statSync(path);
    const cached = personaCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = fs
      .readFileSync(path, 'utf8')
      .replace(/\r\n?/g, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    personaCache.set(path, { mtimeMs: stat.mtimeMs, text });
    return text;
  } catch {
    return '';
  }
}

function resolvePersona(config) {
  const text = resolveTextField(config.personaFile);
  return text || config.persona || '';
}

function resolveBehavior(config) {
  return resolveTextField(config.behaviorFile);
}

function resolveExamples(config) {
  return resolveTextField(config.examplesFile);
}

export function promptSourceVersion(config) {
  return createHash('sha256').update(JSON.stringify([
    resolvePersona(config), resolveBehavior(config), resolveExamples(config),
    config.toneAnchor ?? '',
    stableProtocol(config, true), stableProtocol(config, false),
  ])).digest('hex').slice(0, 16);
}

function stickerInstructionLines(config, text = '', random = Math.random) {
  const catalog = loadStickerCatalog(config);
  const limit = Math.max(0, Number(config.stickerCatalogLimit) || 0);

  let shown = catalog;
  if (limit > 0 && catalog.length > limit) {
    // Sample without replacement on every prompt, including later Session turns.
    const pool = [...catalog];
    shown = [];
    while (shown.length < limit) {
      const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
      shown.push(pool.splice(index, 1)[0]);
    }
  }

  const lines = ['本轮候选仅供选择：贴题时可单发表情或配一句短话，不需要时只发文字。'];

  if (shown.length) {
    lines.push(...shown.map((e) => `#${e.n} ${e.desc}`));
    lines.push(`贴合时末行写 [表情:${shown[0].n}]，由桥接转为真实表情。`);
  } else {
    lines.push('当前目录为空；需要收藏表情时先 qq_list_custom_faces 取得真实编号。示范：返回 index=7 后可在末行写 [表情:7]。');
  }
  return lines;
}

export {
  personaCache,
  catalogCache,
  loadStickerCatalog,
  randomCatalogEntry,
  resolveTextField,
  resolvePersona,
  resolveBehavior,
  resolveExamples,
  stickerInstructionLines,
};
