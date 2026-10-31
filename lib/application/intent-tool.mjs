/**
 * `qq_intent`：她的"将来"。
 *
 * 为什么单独做一张表、而不塞进记忆：记忆回答"发生过什么"，这一层回答
 * "还欠着什么"。她翻本子是为了回想，翻这个是为了**接着做**。两者的寿命也不同——
 * 记忆越久越值钱，欠着的事做完就该消失。
 *
 * 三个动作：`add` 记一件（可以带"什么时候提"）、`list` 看她还欠着什么、
 * `done`/`drop` 了结。没有"提醒"：没人到点戳她，只是她下次醒来时这件事
 * 已经摆在视野里（见 `world-snapshot.mjs`）。
 */

const MAX_TEXT = 200;
const MAX_OPEN = 12;

function nl(rows, limit = 8) {
  return rows.slice(0, limit).map((row) => {
    const due = Number(row.due_at) || 0;
    const when = due ? `${stamp(due)} 之后提` : '什么时候都行';
    return `- #${row.id} ${row.text}（${when}）`;
  });
}

function stamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `now` / `today` / `tomorrow` / `3d` / `12h` → 时间戳；认不出来返回 0（什么时候都行）。 */
export function parseWhen(when, now = Date.now()) {
  const text = String(when ?? '').trim().toLowerCase();
  if (!text || text === 'now' || text === 'any') return 0;
  if (text === 'today') {
    const d = new Date(now);
    d.setHours(23, 59, 0, 0);
    return d.getTime();
  }
  if (text === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(20, 0, 0, 0);
    return d.getTime();
  }
  const m = /^(\d{1,3})\s*([dhm])$/.exec(text);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] === 'd' ? 86400000 : m[2] === 'h' ? 3600000 : 60000;
  return now + n * unit;
}

export function intentTool({ store, config = {}, state = {} }) {
  return {
    name: 'qq_intent',
    description: [
      '你欠着的事。记忆回答"发生过什么"，这里回答"还欠着什么"。',
      'action=add 记一件（text 一句话；when 可选：now / today / tomorrow / 3d / 12h，指"什么时候可以提起它"）；',
      'action=list 看你还没了结的事；action=done 做到了；action=drop 不想做了。',
      '它不会到点提醒你——只是下次你醒着的时候，欠着的事会出现在视野里。',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'done', 'drop'], description: '要做什么' },
        text: { type: 'string', description: 'add 时：一句话，最多 200 字' },
        when: { type: 'string', description: 'add 时可选：now / today / tomorrow / 3d / 12h' },
        id: { type: 'number', description: 'done/drop 时的编号（list 会给）' },
      },
      required: ['action'],
    },
    async execute(args = {}) {
      if (!store?.available) throw new Error('账本不在，这件事现在记不了');
      if (state.disposed) throw new Error('桥接已经停了');
      if (config.intentEnabled === false) throw new Error('这一层关着（intentEnabled=false）');
      const action = String(args.action ?? 'list');

      if (action === 'list') {
        const rows = store.openIntents({ before: Date.now(), limit: 20 });
        if (!rows.length) return { status: 'EMPTY', note: '没有欠着的事了' };
        return { status: 'LIST', count: rows.length, text: nl(rows, 20).join('\n') };
      }

      if (action === 'add') {
        const text = String(args.text ?? '').trim();
        if (!text) throw new Error('add 要给一句 text：欠着的是什么事');
        if (text.length > (Number(config.intentMaxChars) || MAX_TEXT)) {
          throw new Error(`一句话最多 ${Number(config.intentMaxChars) || MAX_TEXT} 字，长了就不像是在记事，是在写作文`);
        }
        const open = store.countOpenIntents();
        if (open >= (Number(config.intentMaxOpen) || MAX_OPEN)) {
          throw new Error(`已经欠着 ${open} 件了，先了结几件再记新的——欠太多等于没记`);
        }
        const dueAt = parseWhen(args.when);
        const id = store.addIntent({ text, dueAt, conversation: '', idemKey: `intent:${text}:${dueAt}` });
        if (!id) throw new Error('这条没记上');
        return { status: 'SAVED', id, text, when: dueAt ? stamp(dueAt) : '什么时候都行' };
      }

      if (action === 'done' || action === 'drop') {
        const id = Number(args.id);
        if (!Number.isInteger(id) || id <= 0) throw new Error('要了结哪一条？给 list 里的编号');
        const ok = store.closeIntent(id, action === 'done' ? 'done' : 'dropped');
        if (!ok) throw new Error(`没有这个编号，或者它已经了结了：#${id}`);
        return { status: action === 'done' ? 'DONE' : 'DROPPED', id };
      }

      throw new Error(`不认识的 action：${action}`);
    },
  };
}

export const __intentTest = { parseWhen, stamp, MAX_TEXT, MAX_OPEN };
