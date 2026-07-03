/**
 * SillyTavern 核心 API 垫片（唯一一处触碰 ST 的深层相对路径）。
 *
 * 本扩展被 ST 以 ES module 方式从 third-party/<ext>/index.js 加载，其余 src/ 里的模块
 * 一律只 import 本文件（`./st.js` 或 `../st.js`），不再各自去数 `../../../../` 的层级——
 * 路径算错就整包挂掉，集中在这里只需维护一处。
 *
 * 路径基准：本文件位于 public/scripts/extensions/third-party/<ext>/src/st.js
 *   ../../../../../script.js      → public/script.js
 *   ../../../../events.js         → public/scripts/events.js
 *   ../../../../extensions.js     → public/scripts/extensions.js
 *   ../../../../st-context.js     → public/scripts/st-context.js
 *   ../../../regex/engine.js      → public/scripts/extensions/regex/engine.js（ST 内置扩展）
 *
 * re-export 保持 live binding：ST 换聊天时会重新赋值 `chat`、原地改 `extension_settings`，
 * 这里 `export { chat } from ...` 会随之更新，与直接 import 语义一致。
 */
export { chat, getRequestHeaders, saveSettingsDebounced } from "../../../../../script.js";
export { eventSource, event_types } from "../../../../events.js";
export { extension_settings, writeExtensionField } from "../../../../extensions.js";
export { getContext } from "../../../../st-context.js";

// 预热时对流式文本套一遍 ST 的 AI_OUTPUT 显示正则，使其与最终存下的 mes 一致（缓存才命中）。
// 引擎是内置扩展、异步到位；拿不到就退回原文（guarded）。
let _getRegexed = null;
import("../../../regex/engine.js").then((m) => { if (typeof m.getRegexedString === "function") _getRegexed = m.getRegexedString; }).catch(() => { });
const REGEX_AI_OUTPUT = 2;   // regex_placement.AI_OUTPUT

/** 套一遍 AI_OUTPUT 显示正则；引擎未就绪/抛错则原样返回。流式清理与整条清理都调它 → 两条路径一致（缓存对齐）。 */
export function regexAiOutput(raw) {
    if (_getRegexed) { try { return _getRegexed(String(raw), REGEX_AI_OUTPUT); } catch { /* noop */ } }
    return raw;
}
