import { header } from './http.mjs';

/**
 * 写请求的跨站闸。
 *
 * 只拦"带了 Origin 且不同源"。Origin 缺失必须放行：面板以外的调用方是命令行
 * 脚本（`tools/start-qq-mcp.ps1` 里的 `Invoke-RestMethod` 不带 Origin），
 * 而浏览器发起的跨站写请求一定会带 Origin —— 拦"有 Origin 且不同源"就够了，
 * 拦"没有 Origin"会把启动脚本一起拦掉。
 */
function isCrossSite(request) {
  if (header(request, 'sec-fetch-site') === 'cross-site') return true;
  const origin = header(request, 'origin');
  if (!origin) return false;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    // `Origin: null`（沙箱 iframe / file://）解析会抛，直接当跨站。
    return true;
  }
  return host !== header(request, 'host');
}

/** 请求里带过来的 token：优先 Authorization: Bearer，其次 ?token=。 */
function presentedToken(request) {
  const bearer = header(request, 'authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (bearer) return bearer;
  try {
    const url = new URL(String(request.url ?? ''), 'http://127.0.0.1');
    return url.searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

/** 配置了 token 就必须对上；空 token 表示这台机器上谁都能开。 */
function tokenOk(request, config) {
  if (!config?.token) return true;
  return presentedToken(request) === config.token;
}

export { isCrossSite, presentedToken, tokenOk };
