/** MCP 目录和 QQ 预设继承过滤共用工具名，避免两端配置漂移。 */
export const CHAT_TOOLS = [
  'qq_status', 'qq_say', 'qq_send_group_msg', 'qq_send_private_msg',
  'qq_list_custom_faces', 'qq_send_custom_face', 'qq_send_mface',
  'qq_list_stickers', 'qq_send_sticker', 'qq_list_library_stickers',
  // QQ 内置 AI 语音：只发语音气泡，音色固定（不暴露挑选接口，不依赖本地 TTS）
  'qq_send_ai_voice',
  'qq_view_library_sticker', 'qq_send_library_sticker', 'qq_react',
  'qq_list_reactions', 'qq_poke', 'qq_group_info', 'qq_search_history',
  'qq_reliability_status', 'qq_workspace', 'qq_send_file', 'qq_read_forward', 'qq_read_image',
];

/**
 * 群管理 / 账号资料 / 申请处理这一档。
 *
 * 2026-10-12 用户决定**把这一档也给 QQ 会话**：群里有人让她改自己的昵称、
 * 改群名、发公告、禁言、踢人时，她手上必须有工具，否则只能回"我没权限"
 * （原本只给 chat 集，实际发生过：群友问"你可以改一个昵称吗"，她答"改不了啊"）。
 *
 * 代价是每轮多约 1.5k token 的 schema —— 用户明确接受这个取舍。
 *
 * ⚠️ 可见性 ≠ 权限：能不能执行仍由 `QQ_CAPABILITIES` 决定。
 * 例如 `qq_handle_add_request` 在预设里**故意不授** `handle_request`，
 * 所以它可见但调用会被拒（这也是 profile 那份实例的既有行为）。
 */
export const ADMIN_TOOLS = [
  'qq_delete_msg', 'qq_manage_group', 'qq_request_kick', 'qq_pending_actions',
  'qq_list_add_requests', 'qq_handle_add_request', 'qq_set_profile',
];

/** QQ 会话实际能看到的 QQ 工具 = 聊天 + 管理。 */
export const QQ_SESSION_TOOLS = [...CHAT_TOOLS, ...ADMIN_TOOLS];

/**
 * 允许 QQ 会话调用的 document-editor 工具（写文档/PDF 这一侧）。
 *
 * 为什么只放这两个：它们各自只要一个输出路径 + 内容。
 * 而 read_* / modify_* / edit_pdf / verify_document 都能打开**任意绝对路径**的
 * 文档 —— 那等于把群消息变成"读、改操作者机器上任何一份 docx/pdf"的入口，
 * 群里的人可以让她读完再贴进群里。create_excel_workbook / create_pptx_presentation
 * 是同样安全的写工具，只是当前没给（要加就在这个数组里加名字）。
 *
 * 这份名单被 tool-scope 和 tools/audit-prompt-cost.mjs 共用，改一处就够。
 */
export const DOCUMENT_TOOLS = ['create_word_document', 'create_pdf'];
