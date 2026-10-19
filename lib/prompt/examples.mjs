import { createHash } from 'node:crypto';
import { resolveExamples } from './text-sources.mjs';

const hints = [
  ['认真', /累|难受|难过|绷不住|伤心|两分|挂科|失眠/u],
  ['认栽', /说错|不对|看错|我问的是|拆穿|露馅/u],
  ['哈气', /逗|胖|欺负|嘴硬/u],
  ['屑', /耍赖|装傻|狡猾/u],
  ['等待', /(?:我跟你说|但是|还有|等下|然后)[，。\s]*$/u],
  ['得意', /这么快|靠谱|厉害|好强|夸|这么强/u],
  ['打趣', /胖|偷懒|摸鱼|白饭/u],
  ['关心', /陪我|陪聊|无聊|想聊|聊会/u],
];

/** Plan without mutation. Hashes are committed with successful prompt admission. */
export function planExamples(config, text, entry = {}, { includeStatic = true, poke = false,
  heartbeat = false, taskText = '' } = {}) {
  const source = resolveExamples(config);
  const known = includeStatic ? {} : entry.exampleHashes ?? {};
  const hashes = { ...known };
  if (!source) return { text: '', hashes, scenes: [] };
  const sections = [...source.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)]
    .map((m) => ({ title: m[1].trim(), text: m[0].trim() }));
  // Custom examples retain their original semantics; only the bundled scene format is routed.
  if (!source.startsWith('# 人类接话参考') || !sections.length) {
    const hash = createHash('sha256').update(source).digest('hex');
    if (hashes.custom === hash) return { text: '', hashes, scenes: [] };
    hashes.custom = hash;
    return { text: source, hashes, scenes: ['custom'] };
  }
  const wanted = [];
  if (poke) wanted.push('哈气');
  for (const [title, pattern] of hints) if (pattern.test(text)) wanted.push(title);
  if (taskText) wanted.push('日常');
  if (heartbeat) wanted.push('旁听');
  if (includeStatic) wanted.push('日常', '打趣');
  const selected = [];
  for (const title of [...new Set(wanted)]) {
    const section = sections.find((s) => s.title === title);
    if (!section) continue;
    const hash = createHash('sha256').update(section.text).digest('hex');
    if (hashes[title] === hash) continue;
    selected.push(section);
    hashes[title] = hash;
    if (selected.length === 2) break;
  }
  return { text: selected.map((s) => s.text).join('\n\n'), hashes, scenes: selected.map((s) => s.title) };
}
