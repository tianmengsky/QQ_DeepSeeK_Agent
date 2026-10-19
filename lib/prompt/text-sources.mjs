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
      .map((e) => ({
        n: Number(e.n),
        desc: e.desc.replace(/\s+/g, ' ').trim(),
        /** 身份键：编号只是目录里的名字，真正要发哪张图靠它（见 domain/stickers.mjs）。 */
        key: typeof e.key === 'string' ? e.key.trim() : '',
      }))
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

  /**
   * 配图的默认倾向必须写清楚。
   *
   * 历史数据：这段改成"本轮候选仅供选择…不需要时只发文字"之后，表情占比
   * 从 20.7%（10-11）一路掉到 1.6%（10-19）。原来那句"仅供选择"把决定权
   * 全推给模型，而模型在"可选 + 不需要时只发文字"的措辞下几乎总是选文字。
   * 现在给一张默认票：带情绪的闲聊默认配一张，并明确列出**不配**的情形。
   */
  const lines = [
    '配图的默认：这条回复只要带着情绪（吐槽、得意、被戳穿、无语、摆烂、震惊、委屈、撒娇、认输），就挑最贴题的一张配在最后。',
    '只有纯事实答复、工具回执、任务交付，或者下面这些候选都不贴题时，才只发文字；一轮最多一张，不要硬凑。',
    '候选是每轮随机抽的一部分，没有贴题的可以按主题用 qq_list_custom_faces 查全部编号。',
  ];

  if (shown.length) {
    lines.push(...shown.map((e) => `#${e.n} ${e.desc}`));
    /**
     * 这里**故意不放一个真实编号**当示例。
     *
     * 原来写的是 `[表情:${shown[0].n}]`，于是模型有相当比例直接照抄那个号
     * （config.mjs 里记着"实测 11 次里 2 次照抄示例编号"），等于替它挑了一张
     * 它没选过的图 —— 表现就是"发出去的表情和想的不一样"。
     * 占位符逼它自己去候选里挑一个号。
     */
    lines.push('要配的那张，最后单独一行写 [表情:编号]（把"编号"换成你挑中那条 # 后面的数字，不要照抄占位）。');
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
