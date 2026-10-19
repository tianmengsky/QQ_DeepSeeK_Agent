import { ensureSession } from './sessions.mjs';

/** Session cursors belong to tasks; QQ speech and shared timeline remain conversation-owned. */
export function taskRegistry(registry, routing, taskId) {
  const task = routing.get(taskId);
  if (!task) throw new Error('missing stable task');
  // Old captured executions retain their task Session for recovery. New dialogue
  // tasks use the ordinary conversation cursor and its existing heartbeat lane.
  if (task.data.sessionMode === 'conversation') return registry;
  registry.taskEntries ??= new Map();
  let entry = registry.taskEntries.get(taskId);
  const shared = registry.entry(task.conversation), stateKey = 'qq-bridge:task-session:' + taskId;
  if (!entry) {
    let saved; try { saved = JSON.parse(registry.store.getState(stateKey) ?? 'null'); } catch {}
    entry = { sessionId: undefined, turns: 0, staticDone: false, contextTurn: 0,
      windowHashes: {}, memoryHashes: {}, window: [], recentQqs: [], pending: [], pendingContext: [],
      contextChars: 0, ...saved, stableTaskId: taskId,
      // Files belong to the QQ conversation. Task sessions still keep their
      // own model cursor and history, but they must see the same group/private
      // workspace so a later turn can read, edit, pack, and send an earlier file.
      workspaceScope: task.conversation };
    // A task has its own Session cursor, but its prompt still needs the shared
    // QQ chronology. Routing is evidence based and may be incomplete; dropping
    // the surrounding conversation makes references, corrections and QQ history
    // disappear. Keep the bounded shared window and mark the task sources first.
    if (!entry.window.length) entry.window = shared.window.slice();
    for (const field of ['awakeUntil', 'lastSpokeAt', 'lastMessageAt', 'turnsSinceSticker', 'recalledIds', 'floor'])
      Object.defineProperty(entry, field, { configurable: true, enumerable: false,
        get: () => shared[field], set: (value) => { shared[field] = value; } });
    registry.taskEntries.set(taskId, entry);
  }
  // Existing in-memory entries may have been created before task workspace
  // isolation was removed. Normalize them on every lookup so HMR/recovery
  // cannot keep using the old task directory.
  entry.workspaceScope = task.conversation;
  const scoped = Object.create(registry);
  scoped.entry = (key) => key === task.conversation ? entry : registry.entry(key);
  scoped.ensureSession = (key) => ensureSession(scoped, key);
  scoped.persist = (key) => {
    registry.persist(task.conversation);
    if (key !== task.conversation) return registry.persist(key);
    const { pending, pendingContext, ...saved } = entry;
    registry.store.setState(stateKey, JSON.stringify(saved)); return true;
  };
  scoped.record = (target, message) => {
    registry.record(target, message);
    if (target === entry) registry.record(shared, message);
  };
  scoped.seedContextFromBuffer = () => 0;
  scoped.baseRegistry = registry;
  return scoped;
}
