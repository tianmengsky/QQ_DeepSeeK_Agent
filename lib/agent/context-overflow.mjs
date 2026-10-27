/**
 * 识别"上下文超出模型窗口"这一类上游拒绝。
 *
 * 为什么单独成一个模块：这类失败和普通网络/限流错误处置完全不同 —— 重试同一个
 * Session 一定还是同一个错（a6api 的 preflight 直接判 futile、`retryable: false`，
 * payload 根本没转发），唯一出路是丢掉这个 Session 再发一次。靠一句话去猜容易漂，
 * 所以把匹配规则钉在一处，改也只改这一处。
 *
 * 线上原文（2026-10-24，deepseek-v4.1-flash-1017）：
 *   a6api API error (413): {"type":"server_error","code":"preflight_compress_failed",
 *   "message":"context ~411065.95 tokens exceeds the model window 262144 ..."}
 */
const CODES = new Set([
  'preflight_compress_failed',
  'context_length_exceeded',
  'context_window_exceeded',
  'model_context_window_exceeded',
  'string_above_max_length',
  'prompt_too_long',
]);

/** 窗口/长度类措辞。命中的都是"payload 太大"，不是"上游抖了一下"。 */
const WINDOW_TEXT =
  /(?:exceed(?:s|ed)?\s.{0,32}(?:context\s)?window|context[_ ](?:length|window)|maximum\s+context|prompt\s+(?:is\s+)?too\s+long|input\s+(?:is\s+)?too\s+long|too\s+many\s+(?:input\s+)?tokens)/iu;

function rawText(value, depth = 0) {
  if (!value || depth > 3) return '';
  if (typeof value === 'string') return value;
  const parts = [value.code, value.status, value.statusCode, value.name, value.message, value.detail];
  // 适配器常把上游 body 嵌在 error/cause 里，只读顶层会漏。
  for (const nested of [value.error, value.cause, value.body]) {
    if (nested && nested !== value) parts.push(rawText(nested, depth + 1));
  }
  return parts.filter((part) => part != null && part !== '').map(String).join(' ');
}

/** true = 这个错误是"payload 超出窗口"，重发同一个会话没有意义。 */
export function isContextOverflow(value) {
  if (!value) return false;
  const text = rawText(value);
  if (!text) return false;
  const code = String(value.code ?? '').toLowerCase();
  if (CODES.has(code)) return true;
  const lower = text.toLowerCase();
  for (const known of CODES) if (lower.includes(known)) return true;
  return WINDOW_TEXT.test(text);
}
