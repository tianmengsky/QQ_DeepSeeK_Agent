import assert from 'node:assert/strict';
import { apply } from '../lib/agent/tool-scope.mjs';
import { QQ_SESSION_TOOLS, DOCUMENT_TOOLS } from '../lib/agent/tool-sets.mjs';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
};
function registryFixture(names) {
  let current = names, deny = [], restrictions = 0, listener;
  const rootTools = { schemas: () => current.map((name) => ({ name })) };
  const ctx = { root: { tools: rootTools }, tools: {
    restrict(filter) {
      assert.ok(filter.deny.every((name) => current.includes(name)));
      deny = filter.deny;
      restrictions++;
      listener?.();
      return () => { deny = []; listener?.(); };
    },
  }, on(event, fn, options) {
    assert.equal(event, 'tools/change'); assert.equal(options.global, true); listener = fn;
  } };
  apply(ctx);
  return { visible: () => current.filter((name) => !deny.includes(name)),
    global: () => current, restrictions: () => restrictions,
    change(names) { current = names; listener(); } };
}
test('QQ filter keeps chat tools, group-management tools and Word/PDF writers while removing RARS, Office readers and resource schemas', () => {
  const chat = QQ_SESSION_TOOLS.map((name) => 'mcp__qq__' + name);
  const docs = DOCUMENT_TOOLS.map((name) => 'mcp__document-editor__' + name);
  const unwanted = ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash',
    'run_code', 'mcp__qq__qq_collect_sticker', 'mcp__rars__rars_run',
    'mcp__document-editor__read_word_document', 'mcp__document-editor__modify_word_document',
    'mcp__document-editor__edit_pdf', 'mcp__document-editor__verify_document',
    'mcp__document-editor__create_excel_workbook', 'mcp__document-editor__create_pptx_presentation',
    'list_mcp_resources', 'load_workspace_dependencies'];
  const f = registryFixture([...chat, ...docs, ...unwanted, 'ask_user_question', 'web_search']);
  assert.deepEqual(f.visible(), [...chat, ...docs, 'ask_user_question', 'web_search']);
  assert.equal(f.global().length, chat.length + docs.length + unwanted.length + 2);
  assert.equal(f.restrictions(), 1);
});
test('group management and self-profile tools are inside the QQ scope', () => {
  // 2026-10-12：只给 chat 时她答"改不了啊 我又没权限"，所以 admin 一档也放进来。
  for (const name of ['qq_manage_group', 'qq_set_profile', 'qq_request_kick', 'qq_delete_msg'])
    assert.ok(QQ_SESSION_TOOLS.includes(name), name + ' 应该在 QQ 会话可见范围内');
});
test('bridge-owned delegation is visible, while unrestricted native delegation/control stays filtered', () => {
  const names=['qq_delegate','qq_delegate_status','qq_delegate_control','qq_job_progress'];
  const f=registryFixture([...names,'subagent','fork','send_message','interrupt_agent']);
  assert.deepEqual(f.visible(),names);
});
test('document tools stay write-only, so no tool can open an arbitrary path', () => {
  assert.deepEqual(DOCUMENT_TOOLS, ['create_word_document', 'create_pdf']);
  const f = registryFixture([
    'mcp__document-editor__read_pdf', 'mcp__document-editor__edit_pdf',
    'mcp__document-editor__verify_document', 'mcp__document-editor__create_pdf',
  ]);
  assert.deepEqual(f.visible(), ['mcp__document-editor__create_pdf']);
});
test('MCP reconnect and global tool registration refresh the filter without reentrant restriction growth', () => {
  const f = registryFixture(['web_search', 'mcp__rars__rars_run']);
  f.change(['web_search', 'mcp__rars__rars_run', 'new_unrelated_tool']);
  assert.deepEqual(f.visible(), ['web_search']);
  f.change(['web_search']);
  assert.deepEqual(f.visible(), ['web_search']);
  f.change(['web_search', 'new_unrelated_tool']);
  assert.deepEqual(f.visible(), ['web_search']);
  assert.equal(f.restrictions(), 3);
});
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
