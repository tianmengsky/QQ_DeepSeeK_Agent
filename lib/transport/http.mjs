class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

function header(request, key) {
  const value = request.headers[key];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request, maxBodyBytes) {
  const declared = header(request, 'content-length');
  if (declared !== undefined && !/^(0|[1-9]\d*)$/.test(declared)) {
    throw new HttpError(400, 'invalid Content-Length');
  }
  if (declared !== undefined && Number(declared) > maxBodyBytes) {
    request.resume();
    throw new HttpError(413, 'body too large');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.byteLength;
      if (size > maxBodyBytes) {
        request.resume();
        throw new HttpError(413, 'body too large');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'body aborted');
  }
  if (!request.complete) throw new HttpError(400, 'body aborted');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch {
    throw new HttpError(400, 'body is not valid UTF-8');
  }
}

function respond(response, status, payload) {
  if (payload === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(text);
}

export { HttpError, header, readBody, respond };
