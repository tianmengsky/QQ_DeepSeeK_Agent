/**
 * bili-feed.mjs —— 她"自己在刷的B站"这一侧的取数。
 *
 * 为什么不用 bilibili-mcp 的 bili_search：
 *   · 那是另一个插件进程里的 MCP，桥接没有调用链（唯一的通路是 ctx.emit，
 *     而 dsh-bili-scroll 只监听 `qq-bridge:send-bili-message` 与出站事件）；
 *   · 给宿主套一个完整 agent 回合只为搜一次视频，成本和延迟都不划算。
 *
 * 所以这里直接打B站**公开的排行榜接口**（不需要登录、不需要 wbi 签名）：
 * 它给的是"此刻全站/分区热门 100 条"，正好是"刷"的语义 —— 不是搜索，是逛。
 * 她挑哪一条仍然由模型决定（见 proactive.mjs 的短名单）。
 */

// 2026-10-31 实测：排行榜接口对 UA 做风控校验。写成
// `... AppleWebKit/537.36 Chrome/126 Safari/537.36`（少了 "(KHTML, like Gecko)"
// 和完整版本号）会被判 code=-352（风控校验失败）且 100% 复现；换成下面这条
// 完整的 Chrome UA 就正常返回 100 条。不要"顺手简化"它。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const BILI_RANKING_URL = 'https://api.bilibili.com/x/web-interface/ranking/v2';

/** 分区：0=全站，其余是B站自己的 rid。 */
export const BILI_RIDS = { all: 0, anime: 1, game: 4, knowledge: 36, tech: 188, animal: 75, food: 211 };

/** 这些片子不适合"分享给群里看"：广告、课程、直播预告、纯剪辑搬运的最短片段。 */
const OFF_LIMIT = /(?:广告|恰饭|商务合作|带货|优惠券|课程|网课|直播|回放|预告片?|完整版搬运)/u;

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 排行榜原始条目 → 只留她挑得动的那几个字段（附件大小也是成本）。 */
export function normalizeRankingItem(raw) {
  const bvid = String(raw?.bvid ?? '').trim();
  if (!/^BV[0-9A-Za-z]{8,14}$/u.test(bvid)) return null;
  const title = decodeEntities(raw?.title).trim();
  if (!title) return null;
  return {
    bvid,
    title: title.slice(0, 120),
    owner: decodeEntities(raw?.owner?.name).trim().slice(0, 40),
    desc: decodeEntities(raw?.desc).replace(/\s+/g, ' ').trim().slice(0, 160),
    view: Number(raw?.stat?.view) || 0,
    danmaku: Number(raw?.stat?.danmaku) || 0,
    duration: Number(raw?.duration) || 0,
    tname: String(raw?.tname ?? '').trim().slice(0, 20),
    pubdate: Number(raw?.pubdate) || 0,
  };
}

/**
 * 取一次热门。
 *
 * 失败一律返回 `{ items: [], reason }`，不抛：主动开口是"有就有、没有就算了"，
 * 一次接口抖动不该在日志里变成红色错误。
 */
export async function fetchBiliRanking({
  config = {},
  signal = null,
  rid = 0,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  attempts = 2,
} = {}) {
  if (typeof fetchImpl !== 'function') return { items: [], reason: 'no-fetch' };
  const url = `${BILI_RANKING_URL}?rid=${Number(rid) || 0}&type=all`;
  // -352 是概率性的：同一份 UA 连发几次，也会偶尔全被拦（2026-10-31 实测）。
  // 所以撞上就退一步再试一次，别让"想分享视频"变成一次看运气的赌博。
  const rounds = Math.max(1, Math.min(3, Number(attempts) || 2));
  let reason = 'no-fetch';
  for (let round = 1; round <= rounds; round += 1) {
    const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 8000));
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', accept: 'application/json, text/plain, */*' },
        signal: merged,
      });
      if (!res?.ok) {
        reason = `http-${res?.status ?? '?'}`;
      } else {
        const json = await res.json();
        if (Number(json?.code) !== 0) {
          reason = `code-${json?.code}`;
        } else {
          const list = Array.isArray(json?.data?.list) ? json.data.list : [];
          const items = list.map(normalizeRankingItem).filter(Boolean);
          return { items, reason: items.length ? 'ok' : 'empty' };
        }
      }
    } catch (error) {
      reason = signal?.aborted ? 'aborted' : String(error?.name ?? error?.message ?? error);
    }
    if (signal?.aborted) return { items: [], reason: 'aborted' };
    if (round < rounds) await new Promise((resolve) => setTimeout(resolve, 900 * round));
  }
  return { items: [], reason };
}

/**
 * 从热门里挑一份**短名单**交给模型。
 *
 * 规则刻意简单（可测、可解释）：
 *   1. 去掉看过/分享过的 bvid、时长过短过长、播放太低、标题像广告的；
 *   2. 关键词命中一次加 12 分，播放量取对数加 0~10 分；
 *   3. 取前 `count` 条，再用 `pick`（默认随机）打散 —— 不总是最热的那几条，
 *      否则她每次分享的都是同一个"全站第一"。
 */
export function biliShortlist(
  items,
  {
    shared = [],
    keywords = [],
    count = 8,
    minView = 20000,
    minDuration = 45,
    maxDuration = 5400,
    pick = Math.random,
  } = {},
) {
  const seen = new Set((shared ?? []).map((x) => String(x)));
  const words = (keywords ?? []).map((w) => String(w).trim()).filter(Boolean);
  const scored = [];
  for (const item of items ?? []) {
    if (!item || seen.has(item.bvid)) continue;
    if (item.duration > 0 && (item.duration < minDuration || item.duration > maxDuration)) continue;
    if (item.view < minView) continue;
    if (OFF_LIMIT.test(item.title)) continue;
    const hay = `${item.title} ${item.tname} ${item.desc}`;
    let score = Math.log10(Math.max(1, item.view)) - 4;
    for (const word of words) if (hay.includes(word)) score += 12;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const head = scored.slice(0, Math.max(1, Number(count) || 8)).map((x) => x.item);
  // Fisher–Yates：短名单内部打散，模型看到的是"一堆候选"，不是"排名"。
  for (let i = head.length - 1; i > 0; i -= 1) {
    const j = Math.floor(pick() * (i + 1));
    [head[i], head[j]] = [head[j], head[i]];
  }
  return head;
}

/** 分享出去的形状：她的一句话 + 标题 + 完整链接（QQ 里点得开，也不会只留一个 BV 号）。 */
export function biliShareText({ line = '', title = '', bvid = '' } = {}) {
  const url = `https://www.bilibili.com/video/${String(bvid).trim()}`;
  const head = String(line ?? '').trim();
 	// B站标题里偶尔带书名号，这里不再加一层，避免「《《xx》》」。
  const titleLine = String(title ?? '').trim();
  return [head, titleLine, url].filter(Boolean).join('\n');
}
