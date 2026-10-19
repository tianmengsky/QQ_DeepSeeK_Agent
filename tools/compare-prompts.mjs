/** Offline character comparison with a pre-change backup; never contacts QQ or reads credentials. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Config } from '../lib/config.mjs';
import { buildPrompt } from '../lib/prompt/render.mjs';
import { resolvePersona, resolveBehavior, resolveExamples } from '../lib/prompt/text-sources.mjs';
import { QQ_SESSION_TOOLS } from '../lib/agent/tool-sets.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const backup = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(path.join(backup, 'lib/prompt/render.mjs')))
  throw Error('Usage: node tools/compare-prompts.mjs <pre-change backup directory>');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-prompt-compare-'));
const cardConfig = root => Config({ personaFile: path.join(root, 'persona.md'),
  behaviorFile: path.join(root, 'behavior.md'), examplesFile: path.join(root, 'examples.md'),
  stickerHints: true, stickerCatalogPath: '', memoryEnabled: true,
  workspaceRoot: path.join(temp, 'workspaces'), replyShapes: [] });
const event = { message_type: 'group', group_id: 10, user_id: 200, self_id: 100,
  message_id: 1, sender: { nickname: '群友' }, message: [{ type: 'text', data: { text: '在吗' } }] };
const extras = { sourceRef: 'offline-source', floorManagement: true, awake: true,
  attention: { kind: 'consider' } };
function schemas(file) {
  const source = fs.readFileSync(file, 'utf8');
  // Evaluate only literal schema declarations, isolated from the server and its environment.
  const literals = source.slice(source.indexOf('const MESSAGE_PARAM_DESC'), source.indexOf('// ---------------------------------------------------------------- 工具实现'));
  return JSON.parse(vm.runInNewContext(literals + '; JSON.stringify(TOOLS)', {}, { timeout: 1000 }));
}
function suffix(file) {
  const s = fs.readFileSync(file, 'utf8');
  return s.match(/^\s+suffix: >-\r?\n((?: {16}[^\r\n]*\r?\n)+)/m)?.[1].trim().length ?? null;
}
try {
  fs.cpSync(path.join(project, 'lib'), path.join(temp, 'lib'), { recursive: true });
  for (const relative of ['lib/prompt/render.mjs', 'lib/prompt/text-sources.mjs'])
    fs.copyFileSync(path.join(backup, relative), path.join(temp, relative));
  fs.symlinkSync(path.join(project, 'node_modules'), path.join(temp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const old = await import(pathToFileURL(path.join(temp, 'lib/prompt/render.mjs')).href);
  const oldCfg = cardConfig(backup), newCfg = cardConfig(project);
  const sourceChars = cfg => ({ persona: resolvePersona(cfg).length, behavior: resolveBehavior(cfg).length,
    examples: resolveExamples(cfg).length });
  const oldTools = schemas(path.join(backup, 'mcp-index.js')), newTools = schemas(path.join(project, 'qq-mcp/src/index.js'));
  const scope = rows => rows.filter(t => QQ_SESSION_TOOLS.includes(t.name));
  const schemaShape = rows => JSON.stringify(rows, (key, value) => key === 'description' ? undefined : value);
  const metrics = { method: '同一离线普通群聊输入、空表情目录、相同配置与绝对工作区路径；字符数，非模型 token/费用',
    sourceChars: { before: sourceChars(oldCfg), after: sourceChars(newCfg) },
    bridgePromptChars: {
      first: { before: old.buildPrompt(event, oldCfg, extras).length, after: buildPrompt(event, newCfg, extras).length },
      later: { before: old.buildPrompt(event, oldCfg, { ...extras, includeStatic: false }).length,
        after: buildPrompt(event, newCfg, { ...extras, includeStatic: false }).length } },
    qqSchemaChars: { all: { count: oldTools.length, before: JSON.stringify(oldTools).length, after: JSON.stringify(newTools).length },
      visible: { count: scope(oldTools).length, before: JSON.stringify(scope(oldTools)).length, after: JSON.stringify(scope(newTools)).length },
      parametersUnchanged: schemaShape(oldTools) === schemaShape(newTools) },
    presetSuffixChars: { before: suffix(path.join(backup, 'cordis.patch.yml')), after: suffix(path.resolve(project, '../dsh-qq-preset/cordis.patch.yml')) } };
  console.log(JSON.stringify(metrics, null, 2));
} finally {
  if (fs.existsSync(path.join(temp, 'node_modules'))) fs.unlinkSync(path.join(temp, 'node_modules'));
  fs.rmSync(temp, { recursive: true, force: true });
}
