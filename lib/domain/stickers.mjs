/**
 * stickers.mjs —— 收藏表情的**身份**，而不是它的**位置**。
 *
 * 事故背景：`#73 得意指着人` 发出去却成了 `#22 我死我死…`（2026-10-19）。
 * 原因是 QQ 收藏表情的返回**顺序会翻**：`fetch_custom_face` 当时给出的列表正好是
 * 文字目录那一份的倒序（94 张、同一批 URL、逐字节相同，只是顺序反了）。
 * 编号 22 与 73 正是彼此的镜像位置，于是"按编号取第 N 个"这件事本身失效了。
 *
 * 所以编号只能当**目录里的名字**用：目录每一行都带上这张图自己的身份键
 * （qpic URL 里那串 32 位十六进制就是表情哈希），发送时先拿身份键去当前列表里
 * 找 URL，再发 URL。收藏顺序以后再翻多少次，都不会发错图。
 *
 * 这个文件被桥接（lib/）和 qq-mcp（qq-mcp/src/index.js）同时引用，
 * 两边的算法只能有一份 —— 否则一边按 A 算、一边按 B 算，等于没修。
 */

/** qpic 收藏表情 URL 里的 32 位十六进制段。 */
const FACE_TOKEN_RE = /_([0-9A-Fa-f]{32})_/;

/**
 * 收藏表情的身份键。
 *
 * 优先取 qpic URL 里的哈希段（链接上的其它部分以后可能要变）；
 * 认不出来就退回完整 URL —— 稳定但只在 URL 不变时成立，够用。
 */
export function faceKeyOf(url) {
  const text = String(url ?? '').trim();
  if (!text) return '';
  const m = FACE_TOKEN_RE.exec(text);
  return m ? m[1].toUpperCase() : text;
}

/** 在当前收藏列表里按身份键找 URL；找不到返回空串（不要退回按位置猜）。 */
export function findFaceUrlByKey(urls, key) {
  const wanted = String(key ?? '').trim().toUpperCase();
  if (!wanted || !Array.isArray(urls)) return '';
  for (const url of urls) {
    if (typeof url === 'string' && faceKeyOf(url).toUpperCase() === wanted) return url;
  }
  return '';
}
