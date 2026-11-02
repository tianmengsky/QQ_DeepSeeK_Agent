/**
 * QQ 空间 web CGI 的最小直调层：读说说详情与评论（commentlist）。
 *
 * 为什么存在：SnowLuma 的 OneBot action 层目前只暴露了"发说说/评论/点赞/改权限"，
 * 没有读评论的 action；但它有 `get_cookies`（domain=qzone.qq.com）这个标准 action。
 * 于是这里拿登录态直调 taotao 的 emotion_cgi_msgdetail_v6 —— 它的响应里原生带
 * commentlist（评论人 uin/昵称/内容/时间 + 楼中楼 reply_list）。
 *
 * 算法与 URL **全部照抄 SnowLuma 源码**，不另发明：
 *  · g_tk：packages/protocol/src/web/request-util.ts 的 getBknFromCookie
 *    （djb2(p_skey || skey) & 0x7fffffff）
 *  · 详情请求：runtime 内 getQzoneMsgDetail（emotion_cgi_msgdetail_v6，
 *    tid/uin/t1_source/not_trunc_con/need_right/not_adapt_outpic/g_tk）
 *  · 响应解析：runtime 内 parseQzoneJson（Qzone 的 `_Callback({...});` 包裹）
 *
 * 一旦上游把 get_qzone_msg_detail 暴露成 OneBot action，工具层不动、
 * 只把这个模块换成一行 onebot() 调用即可。
 */

/** Qzone web 代理基地址。测试时指向 mock 服务器。 */
const H5_BASE = (process.env.QQ_QZONE_H5_BASE ?? 'https://h5.qzone.qq.com').replace(/\/+$/, '');

/**
 * 从 "k=v; k=v" 形式的 Cookie 串算 g_tk（bkn）。
 * p_skey 优先、skey 兜底，与 SnowLuma getBknFromCookie 同源。
 */
export function gtkFromCookieStr(cookieStr) {
  const jar = {};
  for (const part of String(cookieStr ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const skey = jar.p_skey || jar.skey || '';
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) {
    hash += (hash << 5) + skey.charCodeAt(i);
  }
  return String(hash & 2147483647);
}

/** Qzone CGI 的响应是 JSONP 包裹（`_Callback({...});`），剥壳取 JSON。 */
export function parseQzoneJson(text) {
  const s = String(text ?? '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      /* 落到下面的兜底 */
    }
  }
  throw new Error('invalid response from qzone api');
}

/**
 * 拉一条说说的完整详情（含 commentlist）。
 *
 * @param {object} opts
 * @param {string} opts.cookieStr  "k=v; k=v" 形式的 qzone.qq.com Cookie
 * @param {string|number} opts.uin 空间主人 QQ 号（自己的空间=机器人自己）
 * @param {string} opts.tid        说说 tid
 * @param {number} [opts.timeoutMs] 默认 10s
 * @returns {Promise<object>} msgdetail_v6 的完整 data（含 commentlist 原始结构）
 */
export async function fetchQzoneMsgDetail({ cookieStr, uin, tid, timeoutMs = 10_000 }) {
  if (!cookieStr) throw new Error('qzone cookie 为空，没法直调空间 web 接口');
  if (!tid) throw new Error('tid 不能为空');
  const url =
    `${H5_BASE}/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?` +
    new URLSearchParams({
      tid: String(tid),
      uin: String(uin),
      t1_source: '1',
      not_trunc_con: '1',
      need_right: '1',
      not_adapt_outpic: '1',
      g_tk: gtkFromCookieStr(cookieStr),
    }).toString();
  const res = await fetch(url, {
    headers: { cookie: String(cookieStr) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`qzone msgdetail HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = parseQzoneJson(text);
  const code = data.subcode ?? data.code ?? -1;
  if (code !== 0) {
    throw new Error(`qzone msgdetail failed: code=${code} ${data.message ?? data.msg ?? ''}`.trim());
  }
  return data;
}

/**
 * 把 msgdetail 的 commentlist 原始结构收敛成干净形状。
 *
 * Qzone 字段名不完全稳定（昵称有时 name 有时 nickname），全部防御性取值；
 * 楼中楼 reply_list 最多带 3 条，评论内容截 200 字 —— 输出是给模型读的，
 * 不是存档。
 *
 * @returns {Array<{uin: string, nick: string, content: string, time: number, replies: Array}>}
 */
export function extractQzoneComments(detail) {
  const list = Array.isArray(detail?.commentlist) ? detail.commentlist : [];
  const pickText = (v) => String(v ?? '').slice(0, 200);
  const mapReply = (r) => ({
    id: String(r?.id ?? ''),
    uin: String(r?.uin ?? ''),
    nick: String(r?.nickname ?? r?.name ?? ''),
    content: pickText(r?.content),
    time: Number(r?.create_time ?? 0),
  });
  return list.map((c) => ({
    uin: String(c?.uin ?? ''),
    nick: String(c?.nickname ?? c?.name ?? ''),
    content: pickText(c?.content),
    time: Number(c?.create_time ?? 0),
    replies: Array.isArray(c?.reply_list) ? c.reply_list.slice(0, 3).map(mapReply) : [],
  }));
}
