/** OneBot transport shared by the bridge and MCP. */
export async function onebotCall(config, action, payload, timeoutMs = 15000, signal) {
  const url = config.onebotHttp.replace(/\/+$/, '') + '/' + action;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.onebotToken ? { authorization: 'Bearer ' + config.onebotToken } : {}),
    },
    body: JSON.stringify(payload),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error('OneBot ' + action + ' HTTP ' + response.status + ': ' + text.slice(0, 200));
  let json;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new Error('OneBot response unknown: invalid JSON', { cause });
  }
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new Error('OneBot response unknown: invalid envelope');
  if (json.status === 'failed' || (typeof json.retcode === 'number' && json.retcode !== 0))
    throw new Error(
      'OneBot ' +
        action +
        ' 失败: retcode=' +
        json.retcode +
        ' ' +
        (json.message ?? json.wording ?? ''),
    );
  if (json.status !== 'ok' || (json.retcode != null && json.retcode !== 0))
    throw new Error('OneBot response unknown: missing success receipt');
  if (/^send_(group|private)_msg$/.test(action) && json.data?.message_id == null)
    throw new Error('OneBot response unknown: missing message_id');
  return json.data;
}
