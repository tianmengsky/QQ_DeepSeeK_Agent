// Runs inside the existing SnowLuma application, using its own HookManager.
// No WebUI authentication changes and no blanket automatic injection.
export function selectTarget(processes, identities, blockedPids, uin) {
  return processes.filter((p) => !blockedPids.has(p.pid) &&
    identities.get(p.pid)?.identityKnown === true && String(identities.get(p.pid)?.uin) === String(uin));
}

export function attach({ hookManager, uin, enumerateOsProcesses, report = console.log, writeState = () => {}, intervalMs = 5000 }) {
  const attempted = new Set();
  let busy = false;
  let lastState = '';
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      // The native session already provides authoritative identity. Once
      // connected, avoid PowerShell and shell-based login probes entirely.
      const allProcesses = await hookManager.listProcesses();
      const connected = allProcesses.filter((p) => p.loggedIn && String(p.uin) === String(uin));
      if (connected.length === 1) {
        writeState({ account: String(uin), state: 'connected', targetPid: connected[0].pid });
        if (lastState !== 'connected') report('[启动器] connected');
        lastState = 'connected';
        return;
      }
      const osProcesses = await enumerateOsProcesses();
      const blocked = new Set(osProcesses.filter((p) => /NapCat/i.test(p.name)).map((p) => p.pid));
      let added;
      do {
        added = false;
        for (const p of osProcesses) if (blocked.has(p.parentPid) && !blocked.has(p.pid)) { blocked.add(p.pid); added = true; }
      } while (added);
      const main = new Set(osProcesses.filter((p) => /^QQ\.exe$/i.test(p.name) && !/--type=/.test(p.commandLine ?? '')).map((p) => p.pid));
      const processes = allProcesses.filter((p) => main.has(p.pid));
      const live = new Set(processes.map((p) => p.pid));
      for (const pid of attempted) if (!live.has(pid)) attempted.delete(pid);
      const identities = new Map();
      for (const p of processes) {
        if (blocked.has(p.pid)) continue;
        const identity = await hookManager.probeProcessLoginInfo(p.pid);
        identities.set(p.pid, identity);
      }
      const target = selectTarget(processes, identities, blocked, uin);
      let state = 'waiting-login';
      if (processes.length && !processes.some((p) => identities.get(p.pid)?.identityKnown)) state = 'identity-unavailable';
      if (target.length > 1) state = 'ambiguous-account';
      else if (target.length === 1) {
        const p = target[0];
        if (p.loggedIn && String(p.uin) === String(uin)) state = 'connected';
        else if (!attempted.has(p.pid)) {
          attempted.add(p.pid);
          report(`[启动器] 已识别机器人账号 ${uin}，接入 QQ PID ${p.pid}`);
          await hookManager.loadProcess(p.pid);
          state = 'connecting';
        } else state = p.status === 'error' ? 'load-error' : 'connecting';
      }
      writeState({ account: String(uin), state, targetPid: target.length === 1 ? target[0].pid : null,
        candidates: processes.filter((p) => !blocked.has(p.pid)).map((p) => ({ pid: p.pid,
          identityKnown: identities.get(p.pid)?.identityKnown === true, status: p.status })) });
      if (state !== lastState) {
        report(`[启动器] ${state === 'waiting-login' ? `等待普通 QQ 登录机器人账号 ${uin}` : state === 'identity-unavailable' ? 'QQ 进程已存在，但登录探测无法识别账号；请在进程注入页确认机器人 PID 后手动加载，不会自动注入未知账号' : state === 'ambiguous-account' ? '同一账号出现多个 QQ 进程，请保留一个机器人客户端' : state}`);
        lastState = state;
      }
    } catch {
      // Never print config/credentials or guess the identity after a failed probe.
      report('[启动器] 账号探测或接入失败，请查看 SnowLuma 日志/进程注入页面');
    } finally { busy = false; }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return { tick, stop: () => clearInterval(timer) };
}
