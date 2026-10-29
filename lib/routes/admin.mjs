import { ACTION_BY_ID, ACTIONS, createAdminActions } from '../admin/actions.mjs';
import { createAdminConversation } from '../admin/conversation.mjs';
import { createAdminMemory } from '../admin/memory.mjs';
import { createAdminSettings } from '../admin/settings.mjs';
import { GROUPS } from '../admin/spec.mjs';
import { createAdminTexts } from '../admin/texts.mjs';
import { isCrossSite, tokenOk } from '../transport/guard.mjs';
import { HttpError, readBody, respond } from '../transport/http.mjs';

/**
 * 面板的后台接口（唯一会写东西的地方）。
 *
 * 路由表：
 *   GET  {base}/admin/settings        读可改项（含覆盖状态与最近改动）
 *   POST {base}/admin/settings        { patch: {key: value}, note } 应用
 *   POST {base}/admin/settings/reset  { keys?: string[] } 恢复默认
 *   GET  {base}/admin/texts           人设/规矩/示例的文件状态
 *   GET  {base}/admin/text?name=…     读一份正文
 *   POST {base}/admin/text            { name, text } 整份覆盖（写前自动备份）
 *   GET  {base}/admin/memory          记忆目录树
 *   GET  {base}/admin/memory/file?path=…  读一份记忆
 *   POST {base}/admin/memory/file     { path, text } 写一份记忆
 *   GET  {base}/admin/actions         可执行动作清单（面板拿它渲染按钮）
 *   POST {base}/admin/action          { id, args, idemKey } 处置一个具体问题
 *   GET  {base}/admin/conversation?key=group:123  一个会话的窗口/缓冲/事件流
 *
 * 所有写操作都过同一道闸：token（配了就要）+ 跨站拒绝。读操作同样要 token，
 * 因为记忆和日记里有群友隐私 —— 默认不带鉴权的读接口，一旦被反代出去就漏了。
 */
function createAdminHandler(ctx, config, admin) {
  const { settings, texts, memory, actions, conversation } = admin;

  /** 面板里每个入口都是 `${base}/admin/...`，切掉前缀只留动作名。 */
  const action = (request) => {
    let pathname = String(request.url ?? '');
    try {
      pathname = new URL(pathname, 'http://127.0.0.1').pathname;
    } catch {
      /* 保持原样 */
    }
    const index = pathname.indexOf('/admin');
    if (index < 0) return '';
    return pathname.slice(index + '/admin'.length).replace(/\/+$/, '') || '/';
  };

  const query = (request, key) => {
    try {
      return new URL(String(request.url ?? ''), 'http://127.0.0.1').searchParams.get(key) ?? '';
    } catch {
      return '';
    }
  };

  const readJson = async (request, limit = 16384) => {
    const body = await readBody(request, limit);
    if (!body.trim()) return {};
    try {
      return JSON.parse(body);
    } catch {
      throw new HttpError(400, 'body 不是合法 JSON');
    }
  };

  const writeOk = (request) => {
    if (isCrossSite(request)) throw new HttpError(403, '拒绝跨站请求');
  };

  return async (request, response) => {
    try {
      if (!tokenOk(request, config)) {
        response.setHeader('www-authenticate', 'Bearer');
        throw new HttpError(401, 'invalid token');
      }

      const route = action(request);
      const method = String(request.method ?? 'GET').toUpperCase();

      if (route === '/settings') {
        if (method === 'GET') {
          respond(response, 200, { ok: true, groups: GROUPS, ...settings.snapshot() });
          return;
        }
        if (method !== 'POST') {
          response.setHeader('allow', 'GET, POST');
          throw new HttpError(405, 'method not allowed');
        }
        writeOk(request);
        const payload = await readJson(request);
        const result = settings.patch(payload.patch, payload.note);
        if (!result.ok) {
          respond(response, 400, { ok: false, rejected: result.rejected });
          return;
        }
        if (result.changed.length) {
          ctx.logger.info(
            `qq-bridge: 面板改了 ${result.changed.join('、')}（已落盘 panel-settings.json）`,
          );
        }
        respond(response, 200, { ok: true, groups: GROUPS, changed: result.changed, ...result.snapshot });
        return;
      }

      if (route === '/settings/reset') {
        if (method !== 'POST') {
          response.setHeader('allow', 'POST');
          throw new HttpError(405, 'method not allowed');
        }
        writeOk(request);
        const payload = await readJson(request);
        const result = settings.reset(payload.keys);
        if (result.changed.length) {
          ctx.logger.info(`qq-bridge: 面板把 ${result.changed.join('、')} 恢复成配置文件里的值`);
        }
        respond(response, 200, { ok: true, groups: GROUPS, changed: result.changed, ...result.snapshot });
        return;
      }

      if (route === '/texts') {
        if (method !== 'GET') {
          response.setHeader('allow', 'GET');
          throw new HttpError(405, 'method not allowed');
        }
        respond(response, 200, { ok: true, texts: texts.list() });
        return;
      }

      if (route === '/text') {
        if (method === 'GET') {
          const name = query(request, 'name');
          const result = texts.read(name);
          if (!result.ok) throw new HttpError(404, result.error);
          respond(response, 200, { ok: true, name, text: result.text, meta: result.meta });
          return;
        }
        if (method !== 'POST') {
          response.setHeader('allow', 'GET, POST');
          throw new HttpError(405, 'method not allowed');
        }
        writeOk(request);
        const payload = await readJson(request, 512_000);
        const result = texts.write(payload.name, payload.text);
        if (!result.ok) throw new HttpError(400, result.error);
        ctx.logger.info(
          `qq-bridge: 面板重写了 ${payload.name}（${result.meta?.chars ?? '?'} 字，备份 ${result.backup ? '已留' : '无' }）`,
        );
        respond(response, 200, { ok: true, name: payload.name, backup: result.backup, meta: result.meta });
        return;
      }

      if (route === '/memory') {
        if (method !== 'GET') {
          response.setHeader('allow', 'GET');
          throw new HttpError(405, 'method not allowed');
        }
        respond(response, 200, { ok: true, ...memory.list() });
        return;
      }

      if (route === '/memory/file') {
        if (method === 'GET') {
          const result = memory.read(query(request, 'path'));
          if (!result.ok) throw new HttpError(404, result.error);
          respond(response, 200, { ok: true, path: query(request, 'path'), ...result });
          return;
        }
        if (method !== 'POST') {
          response.setHeader('allow', 'GET, POST');
          throw new HttpError(405, 'method not allowed');
        }
        writeOk(request);
        const payload = await readJson(request, 512_000);
        const result = memory.write(payload.path, payload.text);
        if (!result.ok) throw new HttpError(400, result.error);
        ctx.logger.info(`qq-bridge: 面板改了记忆 ${payload.path}（备份 ${result.backup ? '已留' : '无'}）`);
        respond(response, 200, { ok: true, path: payload.path, ...result });
        return;
      }

      if (route === '/actions') {
        if (method !== 'GET') {
          response.setHeader('allow', 'GET');
          throw new HttpError(405, 'method not allowed');
        }
        respond(response, 200, { ok: true, actions: ACTIONS, ...actions.snapshot() });
        return;
      }

      if (route === '/action') {
        if (method !== 'POST') {
          response.setHeader('allow', 'POST');
          throw new HttpError(405, 'method not allowed');
        }
        writeOk(request);
        const payload = await readJson(request);
        const spec = ACTION_BY_ID.get(payload.id);
        if (!spec) throw new HttpError(404, `没有这个动作：${payload.id}`);
        /**
         * 危险动作必须显式确认。
         *
         * 面板那边弹过 confirm 还不够 —— 一个脚本、一个误发的 curl 也能打进来。
         * 让服务端也要求 `confirm: true`，至少不会「手滑 POST 一下就把别人
         * 15 天的任务收掉」。
         */
        if (spec.danger && payload.confirm !== true) {
          throw new HttpError(400, `「${spec.label}」是危险动作，需要 confirm: true`);
        }
        const result = await actions.run(payload.id, payload.args, {
          idemKey: String(payload.idemKey ?? ''),
          memo: String(payload.memo ?? ''),
        });
        if (!result.ok) throw new HttpError(400, result.error);
        ctx.logger.info(
          `qq-bridge: 面板执行了「${spec.label}」` + (result.replay ? '（幂等重放）' : ''),
        );
        respond(response, 200, { ok: true, ...result });
        return;
      }

      if (route === '/conversation') {
        if (method !== 'GET') {
          response.setHeader('allow', 'GET');
          throw new HttpError(405, 'method not allowed');
        }
        const detail = conversation.detail(query(request, 'key'));
        if (!detail.ok) throw new HttpError(400, detail.error);
        respond(response, 200, detail);
        return;
      }

      throw new HttpError(404, '未知接口');
    } catch (error) {
      if (error instanceof HttpError) {
        respond(response, error.status, { ok: false, error: error.message });
        return;
      }
      ctx.logger.warn(`qq-bridge: admin 接口出错 —— ${error?.stack ?? error}`);
      respond(response, 500, { ok: false, error: 'internal error' });
    }
  };
}

/** 一次性把后台对象建好，bootstrap 只管注入。 */
function createAdmin(config, dataDir, memoryDir, clock = Date.now, deps = {}) {
  const settings = createAdminSettings(config, dataDir, clock).load();
  const texts = createAdminTexts(config, dataDir, clock);
  const memory = createAdminMemory(memoryDir, dataDir, clock);
  const actions = createAdminActions({ config, dataDir, clock });
  // 会话详情要读内存里的窗口和数据库里的事件流；两样都可能不存在（未启持久化），
  // 所以传进来而不是自己去拿。
  const conversation = createAdminConversation({
    store: deps.store ?? null,
    registry: deps.registry ?? null,
    clock,
  });
  return { settings, texts, memory, actions, conversation };
}

export { createAdmin, createAdminHandler };
