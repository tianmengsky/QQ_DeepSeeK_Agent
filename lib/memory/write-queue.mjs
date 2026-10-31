/**
 * 记忆写锁——把"她自己那本账"的写入排成一列。
 *
 * 为什么需要：这本账现在有三个写者（收尾 flush、日结、周反思），将来还有脊柱。
 * `agent-memory.write()` 自己已经有两道硬保险：`BEGIN IMMEDIATE` 事务 + 版本闸
 * （拿旧版本写会直接抛"记忆版本已变化"）。问题是**没人在事务外面排队**：
 * 两个写者同时在事务外读到 v1、都想写 v2，靠版本闸只能有一个成功，另一个拿到
 * 异常。数据不会丢，但那个写者刚花掉的一次模型调用白费了，而且它写的是一整天的
 * 事——丢了就得等下一轮补账。
 *
 * 所以补这一把锁：拿到锁之后再读版本、再写。锁是进程内的（同一插件实例），
 * 不跨进程；跨进程靠上面的 SQLite 事务兜底。
 *
 * 刻意不做成按 subject/slot 的细粒度锁：她自己那本账本来就该串行——一个人
 * 在同一秒里不能同时想两件事。粗锁反而省掉了死锁。
 */

let tail = Promise.resolve();

/**
 * 串行执行一段写账的逻辑。
 *
 * 前一段失败不影响后一段（`then(ok, ok)`），否则一次模型超时会把队列永久卡死。
 */
export function withMemoryWrite(task) {
  if (typeof task !== 'function') throw new Error('withMemoryWrite 需要一个函数');
  const run = tail.then(task, task);
  // 只用来排下一棒，不把异常带进队列本身。
  tail = run.then(() => {}, () => {});
  return run;
}

/** 测试用：等当前队列清空（不新增任务）。 */
export function memoryWriteIdle() {
  return tail;
}
