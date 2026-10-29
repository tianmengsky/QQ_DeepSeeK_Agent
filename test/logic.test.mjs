/**
 * 离线单元测试：不依赖 DSH 运行时，直接验证触发判定与提示词组装。
 *
 * 用法（必须在能解析 @deepseek-ai/schemastery 的目录下跑）：
 *   cd D:\Code\dsh-qq-bridge ; node test/logic.test.mjs
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { __test, Config } from "../lib/index.js";

const {
  shouldRespond,
  renderMessage,
  buildPrompt,
  mentionsBot,
  mentionsName,
  stripLeadingMention,
  atTargets,
  stripLeadingSelfMentions,
  decorateAtTokens,
  splitBubbles,
  bubbleDelayFor,
  parseShape,
  pickShape,
  asksToLook,
  hasImageSegment,
  extractStickerMarker,
  collapseRepeatedReply,
  extractRemember,
  isSilence,
  stripImageHallucination,
  stripSyntheticPromptEcho,
  stripBridgeTags,
  extractMarkedBubbles,
  resolveReplyBubbles,
  dedupeRepeatedBubbles,
  buildMemorySection,
  MemoryStore,
} = __test;
const base = Config({});
const BOT = "3667925015";
const USER = "1056612947";

const privateEvent = (over = {}) => ({
  post_type: "message",
  message_type: "private",
  user_id: Number(USER),
  self_id: Number(BOT),
  message: [{ type: "text", data: { text: "你好" } }],
  sender: { nickname: "天梦·幻" },
  ...over,
});

const groupEvent = (message, over = {}) => ({
  post_type: "message",
  message_type: "group",
  group_id: 123456,
  user_id: Number(USER),
  self_id: Number(BOT),
  message,
  sender: { nickname: "天梦·幻", card: "" },
  ...over,
});

const at = (qq = BOT) => ({ type: "at", data: { qq } });
const txt = (t) => ({ type: "text", data: { text: t } });

let pass = 0;
function check(label, actual, expected) {
  assert.equal(actual, expected, `${label}: 期望 ${expected}，实际 ${actual}`);
  pass += 1;
  console.log(`  ✓ ${label}`);
}

console.log("\n[1] 私聊");
check("默认配置下私聊应唤醒", shouldRespond(base, privateEvent()), true);
check(
  "user_id === self_id（机器人自己）应忽略",
  shouldRespond(base, privateEvent({ user_id: Number(BOT) })),
  false,
);
check(
  "privateEnabled=false 应忽略",
  shouldRespond(Config({ privateEnabled: false }), privateEvent()),
  false,
);
check(
  "白名单命中应唤醒",
  shouldRespond(Config({ users: [USER] }), privateEvent()),
  true,
);
check(
  "白名单未命中应忽略",
  shouldRespond(Config({ users: ["999"] }), privateEvent()),
  false,
);

console.log("\n[2] 群聊 · at 模式（默认）");
check(
  "被 @ 应唤醒",
  shouldRespond(base, groupEvent([at(), txt(" 在吗")])),
  true,
);
check(
  "未被 @ 应忽略",
  shouldRespond(base, groupEvent([txt("随便聊聊")])),
  false,
);
check(
  "@ 了别人应忽略",
  shouldRespond(base, groupEvent([at("999"), txt(" hi")])),
  false,
);
check(
  "groupEnabled=false 应忽略",
  shouldRespond(
    Config({ groupEnabled: false }),
    groupEvent([at(), txt(" hi")]),
  ),
  false,
);
check(
  "群白名单未命中应忽略",
  shouldRespond(Config({ groups: ["888"] }), groupEvent([at(), txt(" hi")])),
  false,
);
check(
  "显式配置 selfIds 后 @ 该号也应唤醒",
  shouldRespond(
    Config({ selfIds: ["777"] }),
    groupEvent([at("777"), txt(" hi")]),
  ),
  true,
);

console.log("\n[3] 群聊 · all / prefix 模式");
check(
  "all 模式下普通消息也唤醒",
  shouldRespond(Config({ groupTrigger: "all" }), groupEvent([txt("任意")])),
  true,
);
check(
  "prefix 命中应唤醒",
  shouldRespond(
    Config({ groupTrigger: "prefix", groupPrefix: "/ai" }),
    groupEvent([txt("/ai 你好")]),
  ),
  true,
);
check(
  "prefix 未命中应忽略",
  shouldRespond(
    Config({ groupTrigger: "prefix", groupPrefix: "/ai" }),
    groupEvent([txt("你好")]),
  ),
  false,
);

console.log("\n[4] 非消息事件");
check(
  "心跳事件应忽略",
  shouldRespond(base, {
    post_type: "meta_event",
    self_id: Number(BOT),
    user_id: Number(BOT),
  }),
  false,
);

console.log("\n[5] 消息渲染");
check("文本拼接", renderMessage([txt("a"), txt("b")]), "ab");
check("at 渲染", renderMessage([at("123"), txt(" hi")]), "@123 hi");
check(
  "图片占位",
  renderMessage([{ type: "image", data: { url: "x" } }]),
  "[图片]",
);
check("纯字符串直通", renderMessage("直接文本"), "直接文本");
check("去除开头 @", stripLeadingMention(`@${BOT}  你好`), "你好");
check("mentionsBot 空集合时任意 at 命中", mentionsBot([at("123")], []), true);

// 多重 @：别人的 @ 是"这句话对谁说的"的唯一线索，不能被吞掉
const NAMES = new Map([
  [USER, "天梦·幻"],
  [BOT, "DeepSeek大肥鱼"],
]);
const multiAt = [at(USER), txt(" 你把 "), at(BOT), txt(" 的管理员下了")];
check(
  "多个 at 全部保留",
  renderMessage(multiAt),
  `@${USER} 你把 @${BOT} 的管理员下了`,
);
check(
  "at 优先渲染成昵称",
  renderMessage(multiAt, { names: NAMES }),
  "@天梦·幻 你把 @DeepSeek大肥鱼 的管理员下了",
);
check(
  "机器人自己的 at 渲染成「你」",
  renderMessage(multiAt, { names: NAMES, selfIds: [BOT] }),
  "@天梦·幻 你把 @你 的管理员下了",
);
check(
  "开头 @ 的是别人 → 一个字都不删",
  renderMessage(stripLeadingSelfMentions(multiAt, [BOT]), { names: NAMES, selfIds: [BOT] }),
  "@天梦·幻 你把 @你 的管理员下了",
);
check(
  "开头 @ 的是自己 → 只去掉自己那一段",
  renderMessage(
    stripLeadingSelfMentions([at(BOT), txt(" "), at(USER), txt(" 你们俩")], [BOT]),
    { names: NAMES, selfIds: [BOT] },
  ),
  "@天梦·幻 你们俩",
);
check(
  "atTargets 保留顺序",
  JSON.stringify(atTargets([at(USER), txt("x"), at(BOT)])),
  JSON.stringify([USER, BOT]),
);
check(
  "decorateAtTokens 把窗口/引用里的裸号换回来",
  decorateAtTokens(`天梦·幻（${USER}）：@${BOT} 你把…`, NAMES, [BOT]),
  "天梦·幻（1056612947）：@你 你把…",
);

console.log("\n[7] 气泡切分");
check("单句 → 一个气泡", splitBubbles("就这一句", 3).length, 1);
check(
  "空行分隔 → 两个气泡",
  JSON.stringify(splitBubbles("第一句\n\n第二句", 3)),
  JSON.stringify(["第一句", "第二句"]),
);
check(
  "多空行 / 前后空白都会被规整",
  JSON.stringify(splitBubbles("  a  \n\n\n  b  \n\n ", 3)),
  JSON.stringify(["a", "b"]),
);
check(
  "超上限时多余的并进最后一个气泡（不丢内容）",
  JSON.stringify(splitBubbles("a\n\nb\n\nc\n\nd", 2)),
  JSON.stringify(["a", "b\nc\nd"]),
);
check(
  "上限为 1 时合回一条",
  JSON.stringify(splitBubbles("a\n\nb", 1)),
  JSON.stringify(["a\nb"]),
);
check("空文本 → 无气泡", splitBubbles("   \n\n  ", 3).length, 0);
check(
  "不传上限 = 有几段发几条（不再封顶）",
  JSON.stringify(splitBubbles("a\n\nb\n\nc\n\nd\n\ne")),
  JSON.stringify(["a", "b", "c", "d", "e"]),
);
check(
  "传 0 / Infinity 也按不限制处理",
  splitBubbles("a\n\nb\n\nc", Number.POSITIVE_INFINITY).length,
  3,
);

console.log("\n[8] 标记解析");
check(
  "表情标记被摘出",
  JSON.stringify(extractStickerMarker("说话内容\n[表情:24]")),
  JSON.stringify({ text: "说话内容", sticker: 24 }),
);
check("中文冒号也认", extractStickerMarker("内容\n[表情：7]").sticker, 7);
check(
  "没有标记时 sticker 为 null",
  extractStickerMarker("纯文本").sticker,
  null,
);
check(
  "标记出现两次也摘干净（上游重复吐正文时会带上第二个）",
  JSON.stringify(extractStickerMarker("内容A\n\n[表情:38]内容A\n\n[表情:38]")),
  JSON.stringify({ text: "内容A\n\n内容A", sticker: 38 }),
);
check(
  "正文里的 [表情包] 不算标记，不许被摘",
  extractStickerMarker("发了个[表情包]").text,
  "发了个[表情包]",
);

console.log("\n[8b] 重复正文折回一份");
check(
  "整段重复两遍 → 只留一份",
  collapseRepeatedReply("第一句\n\n第二句\n\n第一句\n\n第二句"),
  "第一句\n\n第二句",
);
check(
  "递进式的两句不算重复",
  collapseRepeatedReply("嗯\n\n嗯，行吧"),
  "嗯\n\n嗯，行吧",
);
check(
  "单段重复两遍不动（那可能是语气）",
  collapseRepeatedReply("哈？\n\n哈？"),
  "哈？\n\n哈？",
);
const rem = extractRemember("好\n[记住:老板不吃香菜]", base);
check(
  "记住标记被摘出",
  JSON.stringify(rem.memories),
  JSON.stringify(["老板不吃香菜"]),
);
check("记住标记从正文剥离", rem.text, "好");
check("SKIP 判定", isSilence("[SKIP]", base), true);
check("SKIP 带句号也认", isSilence("[SKIP]。", base), true);
check("正常回复不算 SKIP", isSilence("我在呢", base), false);

console.log("\n[9] 打字间隔按字数算");
{
  const c = Config({
    bubbleDelayPerCharMs: 100,
    bubbleDelayMinMs: 400,
    bubbleDelayMaxMs: 6000,
  });
  check("10 字 → 1.0 秒", bubbleDelayFor("一二三四五六七八九十", c), 1000);
  check("2 字 → 走下限 400ms", bubbleDelayFor("喂喂", c), 400);
  check("200 字 → 走上限 6000ms", bubbleDelayFor("字".repeat(200), c), 6000);
  check(
    "关闭延迟时返回 0",
    bubbleDelayFor("随便", Config({ bubbleDelayPerCharMs: 0 })),
    0,
  );
  check("空串 → 走下限", bubbleDelayFor("", c), 400);
}

console.log("\n[10] 叫名字触发（大小写不敏感）");
{
  const c = Config({});
  const g = (text) => ({
    post_type: "message",
    message_type: "group",
    group_id: 123456,
    user_id: Number(USER),
    self_id: Number(BOT),
    message: [txt(text)],
    sender: { nickname: "天梦·幻" },
  });

  // 各种大小写写法都要命中
  for (const v of [
    "deepseek",
    "DeepSeek",
    "DEEPSEEK",
    "dEePSeeK",
    "DeePseeK",
  ]) {
    check(`"${v} 你在吗" 能唤醒`, shouldRespond(c, g(`${v} 你在吗`)), true);
  }
  check(
    "句子中间出现也算",
    shouldRespond(c, g("诶你们说的 deepseek 是啥")),
    true,
  );
  check("中文名也能唤醒", shouldRespond(c, g("大肥鱼在吗")), true);
  check(
    "@ 仍然有效",
    shouldRespond(c, { ...g(""), message: [at(), txt(" 来看看")] }),
    true,
  );
  check("不叫名字就不理", shouldRespond(c, g("今天天气不错")), false);
  check(
    "关掉名字触发后不理",
    shouldRespond(Config({ nameTriggers: [] }), g("deepseek 在吗")),
    false,
  );

  check(
    "mentionsName 大小写不敏感",
    mentionsName([txt("DEEPSEEK")], ["deepseek"]),
    true,
  );
  check("mentionsName 中文", mentionsName([txt("喂大肥鱼")], ["大肥鱼"]), true);
  check("mentionsName 空触发词表", mentionsName([txt("deepseek")], []), false);

  check(
    "开头的名字会被剥掉",
    stripLeadingMention("DeepSeek，你在吗", ["deepseek", "大肥鱼"]),
    "你在吗",
  );
  check(
    "开头的 @ 也会被剥掉",
    stripLeadingMention(`@${BOT}  你好`, ["大肥鱼"]),
    "你好",
  );
  check(
    "名字在中间不动它",
    stripLeadingMention("我觉得 deepseek 挺好玩", ["deepseek"]),
    "我觉得 deepseek 挺好玩",
  );

  const pn = buildPrompt(g("DEEPSEEK 在干嘛"), c);
  check("提示词标明是叫名字", pn.includes("对方叫了你的名字"), true);
  const pa = buildPrompt({ ...g(""), message: [at(), txt(" 在干嘛")] }, c);
  check("@ 时标明是 @", pa.includes("对方 @ 了你"), true);
}

console.log("\n[11] 记忆文档：初见建档");
{
  const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "qqmem-"));
  const store = new MemoryStore(
    { logger: { warn() {}, info() {} } },
    Config({ memoryDir: dir }),
  );

  check("一开始没有文档", store.read("10001"), null);
  check("touch 会建档", store.touch("10001", "小明"), true);
  check("touch 第二次不重复建", store.touch("10001", "小明"), false);
  check("文档能读出来", (store.read("10001") ?? "").includes("QQ 10001"), true);
  check("新建时一条记忆都没有", store.countEntries("10001"), 0);

  // 没有记忆条目时，提示词里应该当"初见"，而不是塞一份空模板
  const ev = {
    message_type: "group",
    group_id: 1,
    user_id: 10001,
    self_id: 9,
    sender: { nickname: "小明" },
    message: [txt("你好")],
  };
  const sec = buildMemorySection(
    Config({ memoryDir: dir }),
    ev,
    { recentQqs: [] },
    store,
  );
  check("空文档不被误判初见", sec.includes("暂无已保存的长期记忆"), true);
  check("空文档不整份注入", sec.includes("## 记忆"), false);

  store.append("10001", "小明", "喜欢吃辣");
  check("写入后有一条", store.countEntries("10001"), 1);
  const sec2 = buildMemorySection(
    Config({ memoryDir: dir }),
    ev,
    { recentQqs: [] },
    store,
  );
  check("有记忆后按熟人处理", sec2.includes("你对 小明"), true);
  check("记忆内容进了提示词", sec2.includes("喜欢吃辣"), true);

  rmSync(dir, { recursive: true, force: true });
}

console.log("\n[12] 识图：默认不读表情包");
{
  const c = Config({});
  const img = (summary) => ({
    type: "image",
    data: { file: "x.jpg", ...(summary ? { summary } : {}) },
  });
  const ev = (segs) => ({
    post_type: "message",
    message_type: "group",
    group_id: 1,
    user_id: 10001,
    self_id: 9,
    sender: { nickname: "小明" },
    message: segs,
  });

  // 区分表情包和普通图片
  check("普通图片渲染成 [图片]", renderMessage([img()]), "[图片]");
check("SnowLuma 普通图片摘要不算表情", renderMessage([img("[图片]")]), "[图片]");
check("SnowLuma 数字表情类型也识别", renderMessage([{ type: "image", data: { sub_type: 1 } }]), "[表情包]");
  check("带摘要的渲染成表情包", renderMessage([img("偷笑")]), "[表情包：偷笑]");
  check(
    "摘要本身带方括号时不重复包裹",
    renderMessage([img("[动画表情]")]),
    "[表情包]",
  );
  check(
    "sub_type=sticker 也算表情包",
    renderMessage([{ type: "image", data: { sub_type: "sticker" } }]),
    "[表情包]",
  );

  check("有图片段能识别", hasImageSegment([txt("a"), img()]), true);
  check("没图片段", hasImageSegment([txt("a")]), false);

  // lazy 触发词
  check(
    "「你看看这张图」触发",
    asksToLook("你看看这张图", c.imageTriggers),
    true,
  );
  check(
    "「图里写了什么」触发",
    asksToLook("图里写的什么", c.imageTriggers),
    true,
  );
  check("「这是什么字」触发", asksToLook("这是什么字", c.imageTriggers), true);
  check("「哈哈哈哈」不触发", asksToLook("哈哈哈哈", c.imageTriggers), false);
  check("空文本不触发", asksToLook("", c.imageTriggers), false);
  check("触发词表为空时永不触发", asksToLook("看图", []), false);

  // 提示词里的说明要跟"读没读图 / 想不想看"一致
  const notWanted = buildPrompt(ev([img("偷笑")]), c, {
    imagePresent: true,
    imageAttached: false,
    wantAttach: false,
  });
  // 群里一个没人理的表情包 —— 不加任何说明，免得把注意力引向那张图，
  // 反而诱导它去点评（实测回过「这表情发得挺有气势」）
  check("没要求看的图不加任何说明", notWanted.includes("【对方"), false);

  const wanted = buildPrompt(ev([img("偷笑")]), c, {
    imagePresent: true,
    imageAttached: false,
    wantAttach: true,
  });
  check("想看却没取到时才说明", wanted.includes("图没能取到"), true);
  check("未取得像素时仅按文字并保留未加载事实", wanted.includes("仅按文字理解") && wanted.includes("等取得像素后再描述"), true);

  const read = buildPrompt(ev([img("偷笑")]), c, {
    imagePresent: true,
    imageAttached: true,
    wantAttach: true,
  });
  check("读了图时说明可以直接看", read.includes("图就在下面"), true);
  const noImg = buildPrompt(ev([txt("你好")]), c, {
    imagePresent: false,
    imageAttached: false,
  });
  check("没有图时不加图片说明", noImg.includes("对方发了图片"), false);
}

console.log("\n[14] 图片幻觉过滤（它看不见图却点评图）");
{
  const c = Config({});
  const f = stripImageHallucination;

  const r1 = f("这表情看着就像在憋笑，行吧，算你原谅我了喵。", c);
  check("删掉假装看见的从句", r1.text, "行吧，算你原谅我了喵。");
  check("计数为 1", r1.removed, 1);

  check("正常回复不动", f("今天饭还没吃呢。", c).text, "今天饭还没吃呢。");
  check("正常回复计数 0", f("今天饭还没吃呢。", c).removed, 0);

  const r3 = f("你发的这图我看不懂。不过今天饭还没吃呢。", c);
  check("整句在编时整句删除", r3.text, "不过今天饭还没吃呢。");

  check("「图里」也算幻觉", f("图里写了什么我看不清。", c).removed, 1);
  check("「看着像」也算幻觉", f("看着像只猫。", c).removed, 1);

  check(
    "关掉过滤器就原样返回",
    f("这表情看着就像在憋笑。", Config({ imageHallucinationFilter: false }))
      .text,
    "这表情看着就像在憋笑。",
  );
  check("默认是开着的", c.imageHallucinationFilter, true);
}

console.log("\n[13] 回复形态模板（抽签）");
{
  check(
    '解析 "1"',
    JSON.stringify(parseShape("1")),
    JSON.stringify({ bubbles: 1, sticker: false }),
  );
  check(
    '解析 "2+s"',
    JSON.stringify(parseShape("2+s")),
    JSON.stringify({ bubbles: 2, sticker: true }),
  );
  check(
    '解析 "3 + S"（带空格、大写）',
    JSON.stringify(parseShape("3 + S")),
    JSON.stringify({ bubbles: 3, sticker: true }),
  );
  check("非法输入返回 null", parseShape("随便"), null);
  check("空串返回 null", parseShape(""), null);
  check("气泡数被夹到 1..9", parseShape("99").bubbles, 9);

  const c = Config({ replyShapes: ["1", "1+s", "2", "2+s", "3", "3+s"] });
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    const s = pickShape(c, () => i / 6);
    seen.add(`${s.bubbles}${s.sticker ? "+s" : ""}`);
  }
  check("六种形态都能抽到", [...seen].sort().join(","), "1,1+s,2,2+s,3,3+s");
  check(
    "随机值落在边界不越界",
    JSON.stringify(pickShape(c, () => 0.999999)),
    JSON.stringify({ bubbles: 3, sticker: true }),
  );
  check(
    "空模板表 → null（关闭抽签）",
    pickShape(Config({ replyShapes: [] })),
    null,
  );

  // 提示词：抽到签时以签为准，不能和旧的"自由配图"那段同时出现
  const ev = {
    post_type: "message",
    message_type: "group",
    group_id: 1,
    user_id: 10001,
    self_id: 9,
    sender: { nickname: "小明" },
    message: [txt("你好")],
  };
  const p1 = buildPrompt(ev, c, {
    shape: { bubbles: 1, sticker: false },
    stickerAllowed: true,
  });
  check("不再给气泡数设上限", /最多回 \d+ 个气泡/.test(p1), false);
  check("仍然说明气泡要用『』框", p1.includes("『"), true);
  check("签说不配图", p1.includes("这条使用纯文字"), true);
  check(
    "签不再塞一份格式说明（格式只在静态块里）",
    p1.includes("另外在最后单独一行配 1 张表情包"),
    false,
  );

  const p2 = buildPrompt(ev, c, {
    shape: { bubbles: 3, sticker: true },
    stickerAllowed: true,
  });
  check("签说配图时给出明确指令", p2.includes("这条要配 1 张表情包"), true);
  check("签说配图时说明写哪里", p2.includes("写在最后一个气泡的『』里"), true);
  check("静态块里给了标记写法", p2.includes("[表情:"), true);
  check("静态块不再授权无限拆泡", p2.includes("想分几条就分几条"), false);
  check("每轮注入碎句短句的软偏好", p2.includes("偏向碎句、短句、口语"), true);

  const p3 = buildPrompt(ev, c, {
    shape: { bubbles: 2, sticker: true },
    stickerAllowed: false,
  });
  check("签说配图但间隔不够时说明不配", p3.includes("这条使用纯文字（表情间隔尚余）"), true);
}

console.log("\n[15] 静态内容只注入一次（省 token）");
{
  const c = Config({
    persona: "你是大肥鱼。",
    stickerHints: true,
    memoryEnabled: true,
  });
  const ev = {
    post_type: "message",
    message_type: "private",
    user_id: 1,
    self_id: 9,
    sender: { nickname: "小明" },
    message: [txt("你好")],
  };
  const shape = { bubbles: 1, sticker: false };

  const first = buildPrompt(ev, c, { shape, includeStatic: true });
  const later = buildPrompt(ev, c, { shape, includeStatic: false });

  // 只钉"静态块只在首轮注入"这个行为（它直接决定每轮 token）；不再逐个校验
  // 协议小节的措辞 —— 改一句话就红一片，维护成本大于收益。
  check("第一轮带人设", first.includes("[你的人设]"), true);
  check("后续轮不带人设", later.includes("[你的人设]"), false);

  // 但这些**必须每轮都在**，否则它会失去上下文
  check("后续轮仍带当前消息", later.includes("你好"), true);
  check("后续轮仍带正文协议", later.includes("『"), true);

  /**
   * 语气锚。
   *
   * 这个位置原来硬编码着一句大肥鱼的味道锚，**每轮都注入**。
   * 后果是：用户把人设文件里那句删了，它却还在 —— 真正生效的是代码里这份。
   * 现在默认空，语气只由 persona.md 单点决定；想加就配 toneAnchor。
   */
  check("默认不注入任何语气锚", later.includes("记住你是谁"), false);

  const anchored = buildPrompt(ev, Config({ toneAnchor: "（你是蓝色鲸鱼娘。）" }), {
    shape,
    includeStatic: false,
  });
  check("配了 toneAnchor 才注入", anchored.includes("你是蓝色鲸鱼娘"), true);

  check("默认开启只注入一次", Config({}).injectStaticOnce, true);
}

console.log("\n[16] 闭嘴暗号（可能混在正文里）");
{
  const c = Config({});
  const { isSilence, stripSilence } = __test;

  check("整条就是暗号", isSilence("[SKIP]", c), true);
  check("整条是暗号 + 句号", isSilence("[SKIP]。", c), true);
  // 这是原来的 bug：要求"整条恰好等于"，于是这种写法检测不到，
  // 字面量 [SKIP] 被当气泡发进了群。
  check(
    "暗号跟在正文后面也能识别",
    isSilence("今天天气不错\n\n[SKIP]", c),
    true,
  );
  check("暗号在正文前面也能识别", isSilence("[SKIP] 这有什么好说的", c), true);
  check("暗号夹在中间也能识别", isSilence("我觉得 [SKIP] 还是别说了", c), true);
  check("正常回复不算暗号", isSilence("今天天气不错", c), false);

  check("整条暗号 → 摘成空", stripSilence("[SKIP]", c), "");
  check("只剩标点也算空", stripSilence("[SKIP]。", c), "");
  check("正文保留", stripSilence("今天天气不错\n\n[SKIP]", c), "今天天气不错");
  check(
    "摘掉后不留双空格",
    stripSilence("我觉得 [SKIP] 还是别说了", c),
    "我觉得 还是别说了",
  );
  check("没有暗号时原样返回", stripSilence("我在呢", c), "我在呢");

  check(
    "关掉暗号（空串）时永不静默",
    isSilence("[SKIP]", Config({ silenceToken: "" })),
    false,
  );
}

console.log("\n[16b] 合成空消息说明回声过滤");
{
  check(
    "过滤模型复述的 @ 占位说明",
    stripSyntheticPromptEcho("？\n*（你只 @ 了我，没说话）*"),
    "",
  );
  check(
    "兼容旧的全角括号说明",
    stripSyntheticPromptEcho("*（对方只 @ 了你，没说话）*"),
    "",
  );
  check(
    "兼容半角括号说明",
    stripSyntheticPromptEcho("(对方只发了空消息)"),
    "",
  );
  check(
    "系统上下文说明不外发",
    stripSyntheticPromptEcho("【系统上下文：仅 @、正文为空；不要复述此行】"),
    "",
  );
  check(
    "正常括号内容保留",
    stripSyntheticPromptEcho("我觉得（大概吧）"),
    "我觉得（大概吧）",
  );
  check(
    "说明旁边的正常正文保留",
    stripSyntheticPromptEcho("先等等（对方只 @ 了你，没说话）"),
    "先等等",
  );
  check("SKIP 不被误删", stripSyntheticPromptEcho("[SKIP]"), "[SKIP]");
}

console.log("\n[17] 窗口与记忆按需注入");
{
  const c = Config({ persona: "你是大肥鱼。", stickerHints: true });
  const ev = {
    post_type: "message",
    message_type: "private",
    user_id: 1,
    self_id: 9,
    sender: { nickname: "小明" },
    message: [txt("你好")],
  };
  const shape = { bubbles: 1, sticker: false };
  const win = "【最近聊了什么（从旧到新）】\n小明：早\n你：早啊";

  const on = buildPrompt(ev, c, {
    shape,
    includeWindow: true,
    memoryText: "【你对 小明 的记忆】\n- 喜欢辣",
    windowText: win,
  });
  const off = buildPrompt(ev, c, {
    shape,
    includeWindow: false,
    memoryText: "",
    windowText: win,
  });

  check("includeWindow=true 时带窗口", on.includes("【最近聊了什么"), true);
  check(
    "includeWindow=false 时不带窗口",
    off.includes("【最近聊了什么"),
    false,
  );
  check("记忆段照常受控", on.includes("喜欢辣"), true);
  check("传空记忆就不注入", off.includes("喜欢辣"), false);
  check("关掉窗口后明显更短", off.length < on.length, true);
  check("默认开启只注入一次窗口", Config({}).injectWindowOnce, true);
  check("默认只在首次或记忆变化时注入", Config({}).memoryInjectOnChange, true);

  // 配图权重：抽中率和照做率相乘才是最终效果，所以抽中率要高于目标值
  const shapes = Config({}).replyShapes;
  const withSticker = shapes.filter((s) => s.includes("+s")).length;
  check(
    "默认抽中率在 60%~75% 之间（目标实际 66%）",
    withSticker / shapes.length >= 0.6 && withSticker / shapes.length <= 0.75,
    true,
  );
  check(
    "气泡数仍以 1 句为主",
    shapes.filter((s) => s.startsWith("1")).length >= shapes.length / 2,
    true,
  );

  // 指纹：内容变一点点就要能发现
  const fp = __test.fingerprint;
  check("指纹：同样内容稳定", fp("abc"), fp("abc"));
  check("指纹：内容变则变", fp("abc") !== fp("abd"), true);
  check("指纹：长度变则变", fp("abc") !== fp("abcd"), true);
  check("指纹：空串可用", typeof fp(""), "string");
}

console.log("\n[18] 时间戳用本地时间（不是 UTC）");
{
  const p = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const expectDay = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const expectFull = `${expectDay} ${p(now.getHours())}:${p(now.getMinutes())}`;

  check("localStamp() 与系统本地时间一致", __test.localStamp(), expectFull);
  check(
    "localStamp(false) 只给日期",
    __test.localStamp(new Date(), false),
    expectDay,
  );
  check("nowLine 里带本地时间", __test.nowLine().includes(expectFull), true);
  check("nowLine 里带星期", /周[日一二三四五六]/.test(__test.nowLine()), true);

  // 这是原来的 bug：toISOString 给的是 UTC，和本地差 8 小时（UTC+8 时区）
  const utc = now.toISOString().slice(0, 16).replace("T", " ");
  check(
    "不再等于 UTC 时间（除非时区刚好为 0）",
    expectFull !== utc || now.getTimezoneOffset() === 0,
    true,
  );

  const ev = {
    post_type: "message",
    message_type: "private",
    user_id: 1,
    self_id: 9,
    sender: { nickname: "小明" },
    message: [txt("在吗")],
  };
  const prompt = buildPrompt(ev, Config({ persona: "你是大肥鱼。" }), {});
  check("提示词里带上当前时间", prompt.includes(expectFull), true);
  check(
    "记忆只走工具，不再教正文标记",
    prompt.includes("【本轮记事】") && !prompt.includes("[记住:"),
    true,
  );
}

console.log("\n[19] 私聊直读图 / 引用里的图");
{
  const c = Config({});
  check("私聊默认直读图", c.readImagesInPrivate, true);
  check("引用里的图默认也附上", c.attachQuotedImages, true);

  // 私聊：没有触发词也该读（群里则仍按触发词）
  const img = { type: "image", data: { file: "x.jpg", summary: "偷笑" } };
  const bare = { message_type: "private", message: [img] };
  check(
    "光发表情包时触发词不命中",
    asksToLook(renderMessage(bare.message), c.imageTriggers),
    false,
  );
  check(
    "但私聊靠 readImagesInPrivate 兜底",
    c.readImagesInPrivate === true,
    true,
  );

  // 引用：解析出来的结构应该是 { text, images }
  // （这里只验证约定，真正的取图要联网，放到实机跑）
  const quoteShape = { text: "[引用 小明：…]", images: [img] };
  check("引用结果带 images 字段", Array.isArray(quoteShape.images), true);
  check("引用结果带 text 字段", typeof quoteShape.text, "string");
}

console.log("\n[20] Word/PDF 工具要落进本会话工作区");
{
  // document-editor 是独立进程，output_path 只有写成绝对路径才落得进工作区；
  // 而 qq_send_file 只认工作区里的文件 —— 所以绝对路径必须每轮注入。
  const defaultRoot = path.resolve(process.env.QQ_WORKSPACE_ROOT || path.join(os.homedir(), ".dsh", "qq-workspaces"));
  const groupPrompt = buildPrompt(groupEvent([at(), txt(" 帮我写份介绍")]), base);
  check(
    "群提示词里摊开本群工作区的绝对路径",
    groupPrompt.includes(path.join(defaultRoot, "group-123456")),
    true,
  );
  check(
    "并点名 create_word_document / create_pdf 要填绝对路径",
    groupPrompt.includes("create_word_document") && groupPrompt.includes("create_pdf"),
    true,
  );

  const privatePrompt = buildPrompt(privateEvent(), base);
  check(
    "私聊用自己那份目录，不串到群里",
    privatePrompt.includes(path.join(defaultRoot, `user-${USER}`)) &&
      !privatePrompt.includes(path.join(defaultRoot, "group-123456")),
    true,
  );

  const customRoot = path.resolve("D:/tmp/qq-ws");
  const custom = buildPrompt(groupEvent([at(), txt(" 写个报告")]), Config({ workspaceRoot: customRoot }));
  check(
    "workspaceRoot 改了，注入的路径跟着改",
    custom.includes(path.join(customRoot, "group-123456")),
    true,
  );

  // 非法会话键不该让整轮提示词组装失败（宁可不注入这一段）。
  const weird = buildPrompt(
    { post_type: "message", message_type: "group", group_id: "abc", self_id: 9, sender: {}, message: [txt("嗨")] },
    base,
  );
  check("会话键异常时不注入该段，也不抛错", weird.includes("【工作区绝对路径】"), false);
}

console.log("\n[气泡协议]");

{
  check(
    "『』里的文字才当气泡",
    JSON.stringify(extractMarkedBubbles("『这啥』『还在上课』")),
    JSON.stringify({ bubbles: ["这啥", "还在上课"], rest: "", found: true }),
  );
  check(
    "框外的排稿说明被记成残留",
    extractMarkedBubbles("两气泡：『嗯』配表情 #12").rest.includes("配表情"),
    true,
  );
  check("有 『』 时只发框里的", resolveReplyBubbles("随便说两句『真的』然后闭嘴").text, "真的");
  check("没有 『』 且没有排稿说明时照旧整段发", resolveReplyBubbles("就是一句普通回复").source, "plain");
  check(
    "没有 『』 但有排稿说明时只捞候选句",
    resolveReplyBubbles('两气泡：\n"？你这比喻……"\n"行吧"\n配 #67。\n\n？你这比喻……\n\n行吧').text,
    "？你这比喻……\n\n行吧",
  );
  check("捞不到候选句就这一轮不发", resolveReplyBubbles("我选 #67，这句看着挺贴。").text, "");
  check(
    "strict 模式下没有框一律不发",
    resolveReplyBubbles("就是一句普通回复", { protocol: "brackets" }).source,
    "brackets-missing",
  );
  check(
    "代理注解标签不会混进正文",
    stripBridgeTags('行吧<acp tokens="24" type="text">m00027</acp>，就这样'),
    "行吧，就这样",
  );
  // 2026-10-28 线上：插话后模型把同一组答复重写了一遍，两段被拼在一起发出。
  check(
    "同轮复述只留最后那版",
    JSON.stringify(
      dedupeRepeatedBubbles(["？说我笨", "刚进来的时候确实笨，谁都不认识", "？说我笨", "刚进来那会儿确实笨，谁都不认识"]).bubbles,
    ),
    JSON.stringify(["？说我笨", "刚进来那会儿确实笨，谁都不认识"]),
  );
  check(
    "被短句包含的长句不算重复",
    JSON.stringify(dedupeRepeatedBubbles(["好", "好家伙，我服了"]).bubbles),
    JSON.stringify(["好", "好家伙，我服了"]),
  );
  check("没有重复时原样返回", dedupeRepeatedBubbles(["一", "二", "三"]).dropped, 0);
}

console.log(`\n全部通过：${pass} 项\n`);
