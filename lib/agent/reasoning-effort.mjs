/**
 * 主对话的思考档位：**配了就发**，发不出去就说清楚。
 *
 * 历史语义（v97 之前）是「`off` = 不发送该字段」。那是错的：
 * 不发送并不等于关闭思考 —— 供应商默认开思考时，用户明明选了 off，模型
 * 却照旧在想。反过来，盲发也不行：pi-ai 在请求路径上会拿模型的
 * `reasoningEfforts` 校验，遇到不认的档位直接在**网络 I/O 之前**抛
 * `UNSUPPORTED_REASONING_EFFORT`，这个回合就白费了（我们自己踩过：
 * a6api 的路由只认默认档，`off`/`max` 都会被拒）。
 *
 * 所以这里的策略是「先问再发」：
 *   1. 配了档位 → 先问适配器这个模型认哪些（`llm.resolveModelInfo` 的
 *      `reasoning.efforts`，和 DSH 校验用的是同一份元数据）；
 *   2. 认 → 原样发（包括 `off`：DeepSeek Messages 适配器把它翻成
 *      `thinking.type: disabled`，是真的关）；
 *   3. 不认 → 不发，但记下「为什么不发」，面板和 `/qq/onebot` 都能看见；
 *   4. 问不到（没有 llm 服务 / 探测失败 / 超时）→ 照发。宁可信用户：
 *      万一能传呢。真被拒了，回合失败那里会把档位摘掉并重选模型。
 */

/** 探测结果缓存时长：适配器元数据是静态配置，不该每建一个会话就问一次。 */
const EFFORT_CACHE_MS = 5 * 60 * 1000;

const cache = new Map();

/** 测试用：清空探测缓存。 */
export function clearEffortCache() {
  cache.clear();
}

function cacheKey(provider, model) {
  return `${provider ?? ''}\u0000${model ?? ''}`;
}

/**
 * 这个模型认哪些思考档位；问不到返回 null（调用方据此决定「照发」）。
 *
 * @param ctx 宿主上下文，`ctx.get('llm')` 取模型服务。
 * @param provider 路由名。
 * @param model 模型 id。
 * @returns 档位 id 数组，或 null。
 */
export async function supportedEfforts(ctx, provider, model) {
  if (!provider || !model) return null;
  const key = cacheKey(provider, model);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < EFFORT_CACHE_MS) return hit.ids;
  let ids = null;
  const llm = ctx?.get?.('llm');
  if (llm?.resolveModelInfo) {
    try {
      const info = await llm.resolveModelInfo(provider, model);
      const efforts = info?.reasoning?.efforts;
      if (Array.isArray(efforts)) {
        ids = efforts.map((entry) => String(entry?.id ?? '')).filter(Boolean);
      }
    } catch {
      ids = null;
    }
  }
  cache.set(key, { at: Date.now(), ids });
  return ids;
}

/**
 * 这一轮该不该发档位、发什么、不发的话为什么。
 *
 * @returns `{effort, note}`；`effort` 为 undefined 表示选择时不带这个字段，
 *   `note` 为 `{kind:'unsupported'|'rejected', effort, message, supported?}`。
 */
export async function planEffort(ctx, config, registry = null) {
  const wanted = String(config?.llmReasoningEffort ?? '').trim();
  if (!wanted) return { effort: undefined, note: null };
  const rejected = registry?.effortRejected;
  if (rejected && rejected.effort === wanted) {
    return {
      effort: undefined,
      note: {
        kind: 'rejected',
        effort: wanted,
        message: rejected.message ?? '',
        supported: rejected.supported ?? null,
      },
    };
  }
  const ids = await supportedEfforts(ctx, config.llmProvider, config.llmModel);
  if (ids && !ids.includes(wanted)) {
    return {
      effort: undefined,
      note: {
        kind: 'unsupported',
        effort: wanted,
        supported: ids,
        message: `provider "${config.llmProvider ?? ''}" model "${config.llmModel ?? ''}" 不支持思考档位 "${wanted}"`,
      },
    };
  }
  return { effort: wanted, note: null };
}

/**
 * 回合因为档位被拒而失败时记一笔：之后这个进程不再发它，并尝试把当前会话
 * 重选回「不带档位」，省得整个会话一直撞同一堵墙。
 *
 * @returns 记下来的记录，config 没配档位时返回 null。
 */
export function markEffortRejected(registry, stats, failure, config) {
  const effort = String(config?.llmReasoningEffort ?? '').trim();
  if (!effort || !registry) return null;
  const record = {
    at: Date.now(),
    effort,
    provider: config.llmProvider ?? '',
    model: config.llmModel ?? '',
    message: String(failure?.message ?? '').slice(0, 300),
    supported: null,
  };
  registry.effortRejected = record;
  if (stats) stats.effortRejected = record;
  // 缓存里可能是「问不到」（null），下一轮别再问一遍同样的东西。
  cache.set(cacheKey(config.llmProvider, config.llmModel), {
    at: Date.now(),
    ids: Array.isArray(record.supported) ? record.supported : null,
  });
  return record;
}

/**
 * 把已经挑错的会话重选成「不带档位」。失败就交给下一轮的轮换。
 */
export async function repairSessionEffort(registry, entry, config) {
  if (!entry?.sessionId || !config?.llmProvider || !config?.llmModel) return false;
  const selectModel = registry?.ctx?.sessionController?.selectModel;
  if (!selectModel) return false;
  try {
    await selectModel.call(registry.ctx.sessionController, {
      sessionId: entry.sessionId,
      provider: config.llmProvider,
      model: config.llmModel,
    });
    registry.ctx?.logger?.info(
      `qq-bridge: 会话 ${entry.sessionId} 已退回不带思考档位的选择（provider 不认 ` +
        `"${config.llmReasoningEffort}"）`,
    );
    return true;
  } catch (error) {
    registry.ctx?.logger?.warn(
      `qq-bridge: 退回不带思考档位的选择失败 —— ${error?.message ?? error}`,
    );
    return false;
  }
}
