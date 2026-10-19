import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../SnowLuma-validation');
const configPath = path.join(root, 'runtime/config/onebot_3667925015.json');
const sources = ['startup.stdout.log', 'startup.stderr.log'].map((name) => ({
  name, file: path.join(root, name), offset: 0, decoder: new StringDecoder('utf8'), pending: '',
}));
const sensitive = /password|passwd|access[_-]?token|authorization|密码|初始口令/i;
function print(line) {
  if (line && !sensitive.test(line)) console.log(line);
}

console.log('SnowLuma 实时日志：接收 / 发送 / 登录 / 错误');
console.log('关闭本窗口或 Ctrl+C 只停止查看，QQ 和 SnowLuma 会继续运行。');
for (const source of sources) {
  if (!fs.existsSync(source.file)) continue;
  const fd = fs.openSync(source.file, 'r');
  try {
    source.offset = fs.fstatSync(fd).size;
    const start = Math.max(0, source.offset - 32 * 1024);
    const data = Buffer.alloc(source.offset - start);
    fs.readSync(fd, data, 0, data.length, start);
    let lines = data.toString('utf8').split(/\r?\n/);
    source.pending = lines.pop() ?? '';
    if (start > 0) lines.shift();
    console.log(`\n--- ${source.name} 最近记录 ---`);
    lines.slice(-20).forEach(print);
  } finally { fs.closeSync(fd); }
}

function poll() {
  for (const source of sources) {
    if (!fs.existsSync(source.file)) continue;
    const fd = fs.openSync(source.file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size < source.offset) {
        source.offset = 0; source.pending = ''; source.decoder = new StringDecoder('utf8');
      }
      if (size === source.offset) continue;
      const data = Buffer.alloc(Math.min(size - source.offset, 256 * 1024));
      const read = fs.readSync(fd, data, 0, data.length, source.offset);
      source.offset += read;
      const lines = (source.pending + source.decoder.write(data.subarray(0, read))).split(/\r?\n/);
      source.pending = lines.pop() ?? '';
      lines.forEach(print);
    } finally { fs.closeSync(fd); }
  }
}

async function status() {
  const at = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const server = config.networks.httpServers.find((s) => s.name === 'http-default');
    async function probe(action) {
      const response = await fetch(`http://127.0.0.1:${server.port}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.accessToken}` },
        body: '{}', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('接口不可用');
      const value = await response.json();
      if (value.status !== 'ok' || (value.retcode != null && value.retcode !== 0)) throw new Error('接口未返回成功');
      return value.data;
    }
    const [login, health] = await Promise.all([probe('get_login_info'), probe('get_status')]);
    console.log(`${at} [登录状态] QQ=${login.user_id} 在线=${health.online} 收发健康=${health.good}`);
  } catch { console.log(`${at} [登录状态] 接口不可用，请检查 SnowLuma 及 QQ。`); }
}
await status();
setInterval(() => { try { poll(); } catch { console.log('[日志] 暂时无法读取，稍后重试。'); } }, 500);
setInterval(status, 60_000);
