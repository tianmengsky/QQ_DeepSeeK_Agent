/** Abort a wait even when a provider ignores its AbortSignal. */
export function waitWithSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', abort);
      });
    if (signal.aborted) abort();
  });
}
