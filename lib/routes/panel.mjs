import { readFileSync, statSync } from 'node:fs';

import { header, respond, respondHtml } from '../transport/http.mjs';

const SOURCES = [
  new URL('../panel/shell.html', import.meta.url),
  new URL('../panel/app.js', import.meta.url),
  new URL('../panel/verdicts.mjs', import.meta.url),
];

const HEADERS = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
};

// 内联进 <script type="module"> 的代码不能有 export：判定逻辑在 node 单测里和浏览器里必须是同一份源码。
function buildPage() {
  const [shell, app, verdicts] = SOURCES.map((url) => readFileSync(url, 'utf8'));
  return shell
    .replace('/*__VERDICTS__*/', () => verdicts.replace(/^export\s+/gm, ''))
    .replace('/*__APP__*/', () => app);
}

// 面板三个文件不是模块依赖，改了它们 HMR 不会重载插件；按 mtime 缓存一次，编辑后刷新页面就见效。
let cached = null;
function page() {
  const key = SOURCES.map((url) => {
    try {
      const info = statSync(url);
      return info.mtimeMs + ':' + info.size;
    } catch {
      return 'missing';
    }
  }).join('|');
  if (cached?.key !== key) cached = { key, html: buildPage() };
  return cached.html;
}

// 页面本身只是外壳：数据由浏览器去 GET config.path 拿，所以这里不需要 registry/stats。
function presentedToken(request, url) {
  const bearer = (header(request, 'authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (bearer) return bearer;
  return url.searchParams.get('token') ?? '';
}

function createPanelHandler(config) {
  return function panel(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (config.token !== '' && presentedToken(request, url) !== config.token) {
      response.setHeader('www-authenticate', 'Bearer');
      respond(response, 401, { error: '需要 token' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      respond(response, 405, { error: '面板只读' });
      return;
    }
    respondHtml(response, 200, page(), HEADERS);
  };
}

export { buildPage, createPanelHandler };
export const PAGE = buildPage();
