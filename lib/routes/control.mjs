import { isCrossSite } from '../transport/guard.mjs';
import { header, HttpError, respond, readBody } from '../transport/http.mjs';

/**
 * 托管开关。跨站闸与 token 逻辑都收在 `transport/guard.mjs`——
 * 后台接口（`routes/admin.mjs`）用的是同一套，免得两处各写一份、日后只改了一处。
 */
function createControlHandler(ctx, config, state) {
  /**
   * 正在跑的手动激活。
   *
   * 她醒一次要几十秒（真回合：读世界快照、想、可能伸手拿工具、说话），
   * 所以接口立刻回 202、在后台跑完；同一个进程里只允许一次，避免连点把她
   * 叫醒三次（那三次会各发一句话，看起来像刷屏）。重载后自然清零。
   */
  let manual = null;

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
      // 手动叫醒一次：`{"proactive": true}`。
      //
      // 用 `force` 跳过"到点没到点"的判断，但**不跳过**睡觉时段与每日额度——
      // 那是世界的物理边界，不是调度细节；绕过它们等于给自己开一个"半夜也能骚扰"的后门。
      if (payload.proactive !== undefined) {
        if (payload.proactive !== true) throw new HttpError(400, 'proactive 只接受 true');
        const host = state.proactive;
        if (!host?.tick) throw new HttpError(409, '主动层没挂上（proactive 未启用或这个版本还没有它）');
        if (manual) throw new HttpError(409, '上一次手动激活还在跑，等它醒完');
        manual = Promise.resolve()
          .then(() => host.tick({ force: true, now: Date.now() }))
          .then((result) => {
            ctx.logger.info(`qq-bridge: 手动激活完成 ${JSON.stringify(result)}`);
            return result;
          })
          .catch((error) => {
            const message = String(error?.message ?? error).slice(0, 200);
            ctx.logger.warn?.(`qq-bridge: 手动激活失败 ${message}`);
          })
          .finally(() => { manual = null; });
        respond(response, 202, { started: true });
        return;
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
