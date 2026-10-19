import { header, HttpError, respond, readBody } from '../transport/http.mjs';

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
