import { createHash } from 'node:crypto';
import { resolveExamples } from './text-sources.mjs';

/**
 * 接话节奏的注入：整份文本，一个会话只带一次。
 *
 * 2026-11-01 用户否掉了「示例对话」这一层（"你真好""那你就说说"那种成套台词
 * 就别留了，我照着念出来，那也不是我"）。原来这里是按场景切段、按消息内容
 * 路由的 27 组完整对话：有了台词，模型学的是"这句话怎么答"，而不是"这一轮
 * 怎么接"，而台词越完整越容易被照抄。现在文件里只剩几条只讲先后和时机的
 * 节奏条目，没有可切的场景，也不需要按消息挑——整份带一次就够。
 */
export function planExamples(config, entry = {}, { includeStatic = true } = {}) {
  const source = resolveExamples(config);
  const known = includeStatic ? {} : entry.exampleHashes ?? {};
  const hashes = { ...known };
  if (!source) return { text: '', hashes, scenes: [] };

  const hash = createHash('sha256').update(source).digest('hex');
  if (hashes.custom === hash) return { text: '', hashes, scenes: [] };
  hashes.custom = hash;
  return { text: source, hashes, scenes: ['custom'] };
}
