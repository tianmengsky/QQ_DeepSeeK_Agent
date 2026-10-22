/**
 * 识别"要我出声"的请求。
 *
 * 只做**提示**，不决定发送：命中时往本轮提示词里加一句"对方在要语音"，
 * 由模型自己判断要不要用 `qq_send_ai_voice`、念什么、内容是否越界。
 *
 * 依据（2026-10-19 检索 9.5 天、1390 条入站消息）：字面里的"念/读/唱/语音"
 * 大半不是要语音 —— "五条悟的吟唱""说句话比戳管用""读一下这个文件"都出现过。
 * 所以这里刻意走高精度、低召回：宁可漏掉一次，也不要把"吟唱"当成点歌。
 * 也就是说，命中只代表"值得提醒模型看一眼"，不代表"必须发语音"。
 */

/** 否定说法：说了"别发语音"就不该再提醒它发语音。 */
const NEGATIVE = /(别|不要|不用|不想|不许|甭)(再)?(发|来|用|整)?(语音|声音|说话)/u;

const PATTERNS = [
  // 发条语音 / 来一个语音 / 录一段声音
  /(?:发|来|整|录)(?:一?条|一?个|一?段)?(?:语音|声音|音频)/u,
  // 语音说 / 语音念 / 语音回复
  /语音(?:说|回|答|念|消息|回复)/u,
  // 念给我听 / 念一遍 / 读出来 / 背一遍
  /(?:念|读|背|朗读|朗诵)(?:给|一)?(?:我)?(?:听|遍|出来)/u,
  // 用声音说 / 用语音念
  /用(?:语音|声音)(?:说|念|读|讲)/u,
];

/**
 * @returns {{requested: boolean, reason: string}}
 *   `reason` 只用于排查（是否被否定句拦下、命中了哪条），不参与决策。
 */
export function detectVoiceIntent(text) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim();
  // 超长文本多半是转贴的文章，不是在点它说话。
  if (!source || source.length > 200) return { requested: false, reason: '' };
  if (NEGATIVE.test(source)) return { requested: false, reason: 'negated' };
  const hit = PATTERNS.find((re) => re.test(source));
  return hit ? { requested: true, reason: hit.source } : { requested: false, reason: '' };
}
