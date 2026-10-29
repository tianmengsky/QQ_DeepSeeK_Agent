import { isCrossSite } from '../transport/guard.mjs';
import { header, HttpError, respond, readBody } from '../transport/http.mjs';

/**
 * 托管开关。跨站闸与 token 逻辑都收在 `transport/guard.mjs`——
 * 后台接口（`routes/admin.mjs`）用的是同一套，免得两处各写一份、日后只改了一处。
 */
function createControlHandler(ctx, config, state) {
  return async (request, response) => {
    try {
      if (config.token) {
        const provided = header(request, 'authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (provided !== config.token) throw new HttpError(401, 'invalid token');
      }

      if (request.method === 'GET') {
        respond(response, 200, { agentEnabled: state.enabled, since: state.since });
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('allow', 'GET, POST');
        throw new HttpError(405, 'method not allowed');
      }
      if (isCrossSite(request)) throw new HttpError(403, '拒绝跨站请求');

      const body = await readBody(request, 8192);
      let payload;
      try {
        payload = body.trim() ? JSON.parse(body) : {};
      } catch {
        throw new HttpError(400, 'body is not valid JSON');
      }
      if (typeof payload.enabled !== 'boolean') {
        throw new HttpError(400, 'enabled 必须是 boolean');
      }

      state.persistEnabled(payload.enabled);
      ctx.logger.info(
        `qq-bridge: 托管已${state.enabled ? '开启' : '关闭'}（已持久化，重载后保持）`,
      );
      respond(response, 200, { agentEnabled: state.enabled, since: state.since });
    } catch (error) {
      if (error instanceof HttpError) {
        respond(response, error.status, { error: error.message });
        return;
      }
      respond(response, 500, { error: 'internal error' });
    }
  };
}

export { createControlHandler };
