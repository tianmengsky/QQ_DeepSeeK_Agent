export function enqueue(registry, key, task, { lane = 'execution', taskId } = {}) {
  const entry = registry.entry(key);
  if (lane === 'task-execution') {
    if (!taskId) throw new Error('task lane requires identity');
    entry.taskChains ??= new Map();
    const next = (entry.taskChains.get(taskId) ?? Promise.resolve()).then(task, task);
    const settled = next.catch(() => {});
    entry.taskChains.set(taskId, settled);
    settled.finally(() => { if (entry.taskChains.get(taskId) === settled) entry.taskChains.delete(taskId); });
    return next;
  }
  const fields = { execution: 'chain', 'task-progress': 'progressChain',
    'task-ingress': 'ingressChain',
    'reply-recovery': 'recoveryChain', 'reply-output': 'outputChain' };
  const field = fields[lane];
  if (!field) throw new Error('invalid conversation lane');
  const next = (entry[field] ?? Promise.resolve()).then(task, task);
  entry[field] = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
