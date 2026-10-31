import fs from 'node:fs';
import path from 'node:path';
import { localStamp } from '../domain/time.mjs';
import { FactStore } from './facts.mjs';
import { normalize } from './facts.mjs';
import { EpisodeLedger } from './episodes.mjs';
import { isAllowed } from '../domain/admission.mjs';
import { AgentMemory, AGENT_MEMORY_HEADING, AGENT_MEMORY_START, AGENT_MEMORY_END, memoryLine } from './agent-memory.mjs';

const AUTO_FACTS_HEADING = '## 自动记忆（桥接维护）';
const AUTO_FACTS_START = '<!-- qq-bridge:auto-facts:start -->';
const AUTO_FACTS_END = '<!-- qq-bridge:auto-facts:end -->';

/**
 * 记忆目录：留空就跟随数据目录（stateDir，未配则 cwd/data）下的 memory/。
 *
 * 为什么不给固定绝对路径做默认：默认值一旦和 stateDir 脱钩，profile 少写一行，
 * 记忆就会写到另一个地方去，最后"两个库都像真的"。显式配置仍然优先，
 * 方便把记忆放到数据目录之外（例如单独备份的盘）。
 */
export function resolveMemoryDir(config, dataDir) {
  const explicit = String(config?.memoryDir ?? '').trim();
  return explicit || path.join(dataDir, 'memory');
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class MemoryStore {
  constructor(ctx, config, store = null) {
    this.ctx = ctx;
    this.config = config;
    this.dir = config.memoryDir;
    /**
     * 共享 SQLite。渲染层读天气槽（`mood.mjs`）要走这里——天气不是"记忆条目"，
     * 它是一行运行时状态，不该塞进 `me.*` 的版本体系里。
     */
    this.store = store;
    this.agent = new AgentMemory(store);
    this.episodes = config.episodicMemoryEnabled === false ? null : new EpisodeLedger(store, ctx.logger);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.facts = new FactStore(this.dir);
    } catch {
      /* 目录建不出来时后续读写会各自兜底 */
    }
  }

  pathFor(qq) {
    const safe = String(qq ?? '').replace(/[^\dA-Za-z_-]/g, '') || 'unknown';
    return path.join(this.dir, `${safe}.md`);
  }

  /** 读整个文档；没写过就返回 null（不建空文件）。 */
  read(qq) {
    const text = this.syncDocument(qq);
    return text || null;
  }

  activeFacts(subject) {
    try { return this.facts?.active(subject) ?? []; }
    catch (error) {
      this.ctx.logger.warn(`qq-bridge: 读取结构化记忆失败 (${subject}) —— ${error?.message ?? error}`);
      return [];
    }
  }

  recallEpisodes(event, entry = {}) {
    const qq = String(event.user_id ?? '');
    return this.episodes?.recall({
      conversation: event.message_type === 'group' ? 'group:' + event.group_id : 'user:' + qq,
      qq, query: Array.isArray(event.message) ? event.message.filter((p) => p.type === 'text')
        .map((p) => p.data?.text ?? '').join(' ') : String(event.message ?? ''),
      limit: this.config.episodeInjectLimit ?? 4, maxChars: this.config.episodeInjectMaxChars ?? 900,
      windowIds: (entry.window ?? []).filter((m) => m.bot).map((m) => m.messageId).filter((id) => id != null),
      allowed: (key) => { const [kind, id] = key.split(':'); return kind === 'group'
        ? this.config.groupEnabled && isAllowed(this.config.groups, id)
        : kind === 'user' && this.config.privateEnabled && isAllowed(this.config.users, id); },
    }) ?? '';
  }

  ensure(qq, nickname) {
    const file = this.pathFor(qq);
    if (fs.existsSync(file)) return file;
    // 本地日期。toISOString 给的是 UTC，会差 8 小时。
    const today = localStamp(new Date(), false);
    fs.writeFileSync(
      file,
      `# ${nickname || '未知'}（QQ ${qq}）\n\n首次接触：${today}\n\n## 手工记忆\n\n${AUTO_FACTS_HEADING}\n${AUTO_FACTS_START}\n${AUTO_FACTS_END}\n\n## 早期（已摘要）\n\n`,
      'utf8',
    );
    return file;
  }

  /**
   * 将结构化事实同步到同一个人可直接维护的 Markdown 文件。
   * `.facts` 只保存来源元数据；Markdown 是唯一的人类可读入口。
   */
  syncDocument(qq, nickname = '') {
    const file = this.pathFor(qq);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { /* 首次有结构化事实时下面会创建文档。 */ }
    const managed = this.agent.latest(qq);
    const owned = new Set(managed.map((r) => r.slot));
    const agent = this.agent.active(qq, (conversation, id) => this.facts?.withdrawn(conversation, id));
    const facts = this.activeFacts('user:' + qq).filter((r) => !owned.has(r.key)).slice(-this.config.memoryMaxEntries);
    if (!text.trim() && !facts.length && !agent.length) return '';
    if (!text.trim()) {
      this.ensure(qq, nickname);
      text = fs.readFileSync(file, 'utf8');
    }
    text = text.replace(/\r\n/gu, '\n').trimEnd() + '\n';
    const agentBlock = `${AGENT_MEMORY_START}\n${agent.map(memoryLine).join('\n') || '（暂无主模型记忆）'}\n${AGENT_MEMORY_END}`;
    const agentRe = new RegExp(`${escapeRegExp(AGENT_MEMORY_START)}[\\s\\S]*?${escapeRegExp(AGENT_MEMORY_END)}`, 'u');
    if (agentRe.test(text)) text = text.replace(agentRe, () => agentBlock);
    else if (managed.length) {
      const at = text.indexOf('## 手工记忆');
      const section = `${AGENT_MEMORY_HEADING}\n${agentBlock}\n\n`;
      text = at >= 0 ? text.slice(0, at) + section + text.slice(at) : text + '\n' + section;
    }
    if (!text.includes('## 手工记忆')) text = text.replace(/^## 记忆\s*$/mu, '## 手工记忆');
    const structured = facts.length
      ? facts.map((r) => `- ${r.fact}（属性 ${r.key}；来源 ${r.sources.map((s) => `${s.conversation} 消息 ${s.messageId}`).join('、')}）`).join('\n')
      : '（暂无自动提炼事实）';
    const block = `${AUTO_FACTS_START}\n${structured}\n${AUTO_FACTS_END}`;
    const blockRe = new RegExp(`${escapeRegExp(AUTO_FACTS_START)}[\\s\\S]*?${escapeRegExp(AUTO_FACTS_END)}`, 'mu');
    if (blockRe.test(text)) {
      text = text.replace(blockRe, () => block);
    } else {
      const heading = text.indexOf(AUTO_FACTS_HEADING);
      if (heading >= 0) {
        const afterHeading = text.indexOf('\n', heading) + 1;
        text = text.slice(0, afterHeading) + block + '\n' + text.slice(afterHeading);
      } else {
        const archive = text.search(/^## 早期(?:（已摘要）)?\s*$/mu);
        const insertion = `\n${AUTO_FACTS_HEADING}\n${block}\n`;
        text = archive >= 0 ? text.slice(0, archive) + insertion + text.slice(archive) : text + insertion;
      }
    }
    text = text.replace(/\n{3,}/gu, '\n\n').trimEnd() + '\n';
    const current = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } })();
    if (current !== text) {
      const temp = file + '.tmp';
      fs.writeFileSync(temp, text, 'utf8');
      fs.renameSync(temp, file);
    }
    return text.trim();
  }

  /**
   * 群记事 / 日记本的 Markdown 投影。
   *
   * 为什么需要：人物本有 `memory/<qq>.md`，而群本和日记本此前**没有任何人类可读文件**
   * —— 想看"她在那个群都记了什么"只能查 SQLite 或翻 #debug。投影是给人看的，
   * 不参与注入（注入走 SQLite），所以它坏了不影响她说话。
   *
   * ⚠️ 单向：SQLite 是源，md 是投影。手改 md 会在下一次同步被覆盖 ——
   * 文件头必须写清这一点，否则会有人把它当成可编辑的配置。
   */
  notebookPath(subject) {
    const key = String(subject ?? '');
    if (key === 'self') return path.join(this.dir, 'diary.md');
    if (/^group:\d+$/.test(key)) return path.join(this.dir, 'groups', key.slice(6) + '.md');
    return null;
  }

  #notebookLines(subject) {
    let rows = [];
    try { rows = this.agent.latest(subject); } catch { return []; }
    return rows.filter((r) => !r.deleted).map((r) => {
      const source = (r.sources ?? []).slice(-1)[0];
      const from = source ? `${source.conversation}${source.messageId ? ' 消息 ' + source.messageId : ''}` : '';
      const tags = [`${r.slot}；v${r.version}`];
      if (subject === 'self' && r.visibility === 'public') tags.push('可公开');
      return `- ${String(r.text ?? '').replace(/\s+/gu, ' ').trim()}（${tags.join('；')}）${from ? `｜依据 ${from}` : ''}`;
    });
  }

  syncNotebook(subject) {
    const key = String(subject ?? '');
    // 人物本沿用既有文档（那里还有"手工记忆 / 早期"这些人工段落，不能覆盖）。
    if (!this.notebookPath(key)) return this.syncDocument(key);
    const file = this.notebookPath(key);
    const lines = this.#notebookLines(key);
    const title = key === 'self' ? '# 日记' : `# 群 ${key.slice(6)} · 记事`;
    const hint = key === 'self'
      ? '> 由桥接从 SQLite 投影生成，**手改会被下一次同步覆盖**。写入让 agent 调 `qq_memory`（scope=self）。'
      : '> 由桥接从 SQLite 投影生成，**手改会被下一次同步覆盖**。写入让 agent 调 `qq_memory`（scope=group）。';
    const stamp = localStamp();
    const body = [
      title, '', hint,
      key === 'self' ? '> 标了「可公开」的条目才会进群聊；其余只在与 owner 的私聊里出现。' : '',
      '', '## 记事', '', lines.length ? lines.join('\n') : '（暂无）',
      '', `共 ${lines.length} 条 · 更新于 ${stamp}`, '',
    ].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.tmp';
      fs.writeFileSync(temp, body, 'utf8');
      fs.renameSync(temp, file);
      return body.trim();
    } catch (error) {
      this.ctx.logger.warn(`qq-bridge: 写记事本投影失败 (${key}) —— ${error?.message ?? error}`);
      return '';
    }
  }

  /**
   * 全量重建投影。
   *
   * 启动时跑一次：迁移、手工修库、或文件被删之后，投影能自愈 ——
   * 否则要等到"下次有人写入那个本"才会重新生成。
   */
  syncAllNotebooks() {
    let subjects = [];
    try {
      subjects = this.agent.store?.db?.prepare('SELECT DISTINCT qq FROM bridge_agent_memories')
        .all().map((r) => String(r.qq)) ?? [];
    } catch { return 0; }
    let n = 0;
    for (const subject of subjects) if (this.syncNotebook(subject)) n++;
    return n;
  }

  /** Refresh all visible person documents after a recall invalidates facts. */
  syncDocuments() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((name) => /^\d+[A-Za-z_-]*\.md$/u.test(name)); }
    catch { return; }
    for (const name of names) this.syncDocument(name.slice(0, -3));
  }

  /** 追加一条记忆，返回是否触发了裁剪。 */
  append(qq, nickname, text) {
    const line = text.replace(/\s+/g, ' ').trim();
    if (!line) return { added: false };
    try {
      const file = this.ensure(qq, nickname);
      let content = this.syncDocument(qq, nickname);
      if (content.split('\n').some((l) => normalize(l.replace(/^-\s*\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?\s*/, '')) === normalize(line)))
        return { added: false, duplicate: true };
      // 本地时间。之前用 toISOString 写的是 UTC，全都偏了 8 小时。
      const stamp = localStamp();
      const entry = `- ${stamp} ${line}\n`;

      const marker = content.indexOf(AUTO_FACTS_HEADING);
      content =
        marker >= 0
          ? `${content.slice(0, marker)}${entry}${content.slice(marker)}`
          : `${content}${entry}`;

      fs.writeFileSync(file, content, 'utf8');
      return { added: true, file };
    } catch (error) {
      this.ctx.logger.warn(`qq-bridge: 写记忆失败 (${qq}) —— ${error?.message ?? error}`);
      return { added: false };
    }
  }

  /**
   * 首次接触就建一份文档；已经有的不动。返回是否新建。
   *
   * 为什么要在"第一次说话"就建，而不是等它写 [记住:]：
   * 否则没被记住的人根本不存在——你想看某个人有没有进记忆系统时，
   * 会分不清"它觉得不值得记"和"压根没建档"。
   */
  touch(qq, nickname) {
    const file = this.pathFor(qq);
    if (fs.existsSync(file)) return false;
    try {
      this.ensure(qq, nickname);
      return true;
    } catch (error) {
      this.ctx.logger.warn(`qq-bridge: 建记忆文档失败 (${qq}) —— ${error?.message ?? error}`);
      return false;
    }
  }

  /** 数一下「## 记忆」段里有多少条。 */
  countEntries(qq) {
    let content;
    try { content = fs.readFileSync(this.pathFor(qq), 'utf8'); } catch { return 0; }
    if (!content) return 0;
    const start = content.indexOf('## 手工记忆') >= 0 ? content.indexOf('## 手工记忆') : content.indexOf('## 记忆');
    if (start < 0) return 0;
    const auto = content.indexOf(AUTO_FACTS_HEADING, start + 1);
    const archive = content.indexOf('## 早期', start + 1);
    const end = auto >= 0 && archive >= 0 ? Math.min(auto, archive) : Math.max(auto, archive);
    const body = content.slice(start, end < 0 ? undefined : end);
    return (body.match(/^- /gm) ?? []).length;
  }

  /**
   * 超过上限时，把最旧的若干条搬进「早期（已摘要）」。
   * summarize 为 null 时退化为直接搬运（不调模型）。
   */
  async trim(qq, nickname, summarize) {
    const max = Math.max(4, this.config.memoryMaxEntries);
    let count = this.countEntries(qq);
    let moved = 0;

    while (count > max) {
      const content = fs.readFileSync(this.pathFor(qq), 'utf8').trim();
      if (!content) break;
      const s = content.indexOf('## 手工记忆') >= 0 ? content.indexOf('## 手工记忆') : content.indexOf('## 记忆');
      const auto = content.indexOf(AUTO_FACTS_HEADING, s + 1);
      const archive = content.indexOf('## 早期', s + 1);
      const e = auto >= 0 && archive >= 0 ? Math.min(auto, archive) : Math.max(auto, archive);
      if (s < 0 || e < 0) break;

      const headingLength = content.startsWith('## 手工记忆', s) ? '## 手工记忆'.length : '## 记忆'.length;
      const body = content.slice(s + headingLength, e);
      const lines = body.split('\n').filter((l) => l.trim().startsWith('- '));
      const take = Math.min(5, count - max, lines.length);
      if (take <= 0) break;
      const oldest = lines.slice(0, take);
      const rest = lines.slice(take);

      let digest = oldest.map((l) => l.replace(/^- /, '')).join('；');
      if (summarize) {
        try {
          const out = await summarize(digest);
          if (out) digest = out;
        } catch (error) {
          this.ctx.logger.warn(`qq-bridge: 记忆摘要失败 —— ${error?.message ?? error}`);
        }
      }

      if (fs.readFileSync(this.pathFor(qq), 'utf8').trim() !== content) continue;
      const stamp = localStamp(new Date(), false);
      const archiveLine = `- ${stamp}（早期）${digest}\n`;

      const rebuilt =
        content.slice(0, s + headingLength) +
        '\n' +
        rest.join('\n') +
        '\n\n' +
        content.slice(e, e + '## 早期'.length) +
        '\n' +
        archiveLine +
        content.slice(e + '## 早期'.length);
      fs.writeFileSync(this.pathFor(qq), rebuilt, 'utf8');

      moved += take;
      count = this.countEntries(qq);
    }
    return moved;
  }
}

async function llmText(ctx, selection, system, user, signal) {
  if (!selection?.provider || !selection?.model) {
    throw new Error('拿不到默认模型，无法摘要');
  }
  let out = '';
  const stream = ctx.llm.stream({
    provider: selection.provider,
    model: selection.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens: 400,
    signal,
  });
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') out += chunk.text;
  }
  return out.trim();
}

export { MemoryStore, llmText };
