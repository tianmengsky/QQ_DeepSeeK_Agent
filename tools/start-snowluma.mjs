import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const [runtimeArg, uin] = process.argv.slice(2);
if (!runtimeArg || !/^[1-9][0-9]{4,19}$/.test(uin ?? '')) throw new Error('Runtime and account are required');
const runtime = path.resolve(runtimeArg);
if (process.argv[4] === '--detach') {
  const logRoot = path.dirname(runtime);
  const stdout = fs.openSync(path.join(logRoot, 'startup.stdout.log'), 'a');
  const stderr = fs.openSync(path.join(logRoot, 'startup.stderr.log'), 'a');
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), runtime, uin], {
      cwd: runtime, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    console.log(`SnowLuma PID=${child.pid}`);
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  process.exit(0);
}
const official = fs.readFileSync(path.join(runtime, 'index.mjs'), 'utf8');
const digest = createHash('sha256').update(official).digest('hex');
// Generated entry must be reviewed again for a different release. Original stays untouched.
if (digest !== '80a7e35fbdfb02f4e78c48ab66e44c004ea67d7495af3cf3050bdd4e8eba1992') throw new Error('Unsupported SnowLuma build; do not generate an entry for an unreviewed release');
const marker = '\toneBotManager.bind(bridgeManager);';
if (official.split(marker).length !== 2) throw new Error('SnowLuma integration point changed');
// The upstream login probe uses exec(netstat/tasklist). The new periodic
// account loader exposed its console window on Windows; hide those shells.
const probeOptions = 'var EXEC_OPTIONS = {\n\ttimeout: COMMAND_TIMEOUT_MS,\n\tkillSignal: "SIGKILL"\n};';
if (official.split(probeOptions).length !== 2) throw new Error('SnowLuma login probe options changed');
const hiddenProbeOptions = probeOptions.replace('killSignal: "SIGKILL"', 'killSignal: "SIGKILL",\n\twindowsHide: true');
const adapter = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'snowluma-account-loader.mjs')).href;
const integration = `
  {
    const { attach } = await import(${JSON.stringify(adapter)});
    const { execFile: launcherExecFile } = await import('node:child_process');
    const { promisify: launcherPromisify } = await import('node:util');
    const launcherExec = launcherPromisify(launcherExecFile);
    const launcherFs = await import('node:fs');
    const launcherStateFile = ${JSON.stringify(path.join(runtime, 'data/dsh-launcher-state.json'))};
    const writeLauncherState = (s) => {
      launcherFs.mkdirSync(${JSON.stringify(path.join(runtime, 'data'))}, { recursive: true });
      const tmp = launcherStateFile + '.tmp';
      launcherFs.writeFileSync(tmp, JSON.stringify({ ...s, pid: process.pid, runtime: ${JSON.stringify(runtime)}, at: Date.now() }));
      launcherFs.renameSync(tmp, launcherStateFile);
    };
    writeLauncherState({ account: ${JSON.stringify(uin)}, state: 'starting' });
    attach({ hookManager, uin: ${JSON.stringify(uin)}, writeState: writeLauncherState,
      enumerateOsProcesses: async () => {
        const helper = ${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-processes.ps1'))};
        const script = "$ErrorActionPreference='Stop'; . '" + helper.replace(/'/g, "''") + "'; @(Get-BridgeProcesses -Names @('QQ','NapCat*')) | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parentPid';e={$_.ParentProcessId}},@{n='name';e={$_.Name}},@{n='commandLine';e={$_.CommandLine}} | ConvertTo-Json -Compress";
        const { stdout } = await launcherExec('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 10000 });
        const value = JSON.parse(stdout.trim() || '[]');
        return Array.isArray(value) ? value : [value];
      }
    });
  }
`;
const generated = path.join(runtime, 'dsh-launcher.generated.mjs');
fs.writeFileSync(generated, official.replace(probeOptions, hiddenProbeOptions).replace(marker, marker + integration));
process.env.SNOWLUMA_HOOK_AUTOLOAD = '0';
process.chdir(runtime);
// SnowLuma migration workers re-enter process.argv[1]; they must run the
// generated official entry, rather than this small preparation wrapper.
process.argv = [process.execPath, generated];
await import(pathToFileURL(generated).href);
