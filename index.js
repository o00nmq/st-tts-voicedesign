/**
 * TTS VoiceDesign —— SillyTavern 客户端扩展（入口 / 组合根）。
 *
 * 本文件只做三件事：接线 ST 事件、注入布局样式、启动挂载。具体逻辑都在 src/ 下分模块：
 *   src/st.js           ST 核心 API 垫片（唯一触碰深层相对路径处）
 *   src/settings.js     配置常量 / 默认值 / cfg / 后端判定
 *   src/text-extract.js 正文提取与分段（「正文正则处理」，适配不同回复格式改这里，见 docs/text-extraction.md）
 *   src/voice.js        角色卡音色读取
 *   src/audio.js        音频字节工具（格式嗅探 / base64）
 *   src/emote.js        自动加情绪标签（可选）
 *   src/backends/       MiMo / Fish 两个合成后端
 *   src/synth.js        合成调度：分派 + 重试 + 串行队列 + 缓存
 *   src/highlight.js    朗读高亮（CSS Custom Highlight API）
 *   src/playback.js     播放引擎 + 边生成边播的流式引擎
 *   src/message-ui.js   每条消息里的播放器 UI
 *   src/settings-ui.js  扩展设置面板 + Fish 音色设计流程
 */
import { eventSource, event_types } from "./src/st.js";
import { resetSynth } from "./src/synth.js";
import { clearEmoteCache } from "./src/emote.js";
import {
    stopPlayback, onStreamToken,
    notePendingAuto, consumePendingAuto, isStreamOn, finalizeStream, disarmStream, markStreamDone,
} from "./src/playback.js";
import { processMessage, sweepButtons, observeChat, updateShift } from "./src/message-ui.js";
import { mountSettings } from "./src/settings-ui.js";

// ── 事件接线 ──
eventSource.on(event_types.MESSAGE_RECEIVED, (id) => { notePendingAuto(id); });   // 记下新回复 id，只给它自动播
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
    const auto = consumePendingAuto(id);
    if (auto && isStreamOn()) {
        processMessage(id, false);   // 注入按钮；播放由正在跑的 streamPlay 接手
        finalizeStream(id);          // 用最终权威切分补齐尾部段、标记本轮生成完
    } else {
        processMessage(id, auto);    // 无流式自动播时的兜底：按钮 +（auto 则 speak）
    }
    disarmStream();                  // 本轮结束，下一轮首 token 再武装
});
eventSource.on(event_types.MESSAGE_SWIPED, (id) => { clearEmoteCache(); processMessage(id, true); });
eventSource.on(event_types.MESSAGE_UPDATED, (id) => { clearEmoteCache(); processMessage(id, false); });
eventSource.on(event_types.MESSAGE_EDITED, (id) => { clearEmoteCache(); processMessage(id, false); });
eventSource.on(event_types.MESSAGE_SENT, () => { disarmStream(); stopPlayback(); });
eventSource.on(event_types.GENERATION_STARTED, () => { disarmStream(); });  // 允许本轮首 token 重新武装（不在此停播/清缓存，免得干跑打断正在放的）
eventSource.on(event_types.GENERATION_STOPPED, () => { markStreamDone(); disarmStream(); stopPlayback(); });
eventSource.on(event_types.CHAT_CHANGED, () => { disarmStream(); stopPlayback(); resetSynth(); setTimeout(sweepButtons, 100); });
eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (full) => { onStreamToken(full); });

// ── 首次用户手势解锁音频（放一段静音），之后异步到达的回复也能自动播、不被 autoplay 策略拦 ──
let audioUnlocked = false;
function unlockAudio() {
    if (audioUnlocked) return; audioUnlocked = true;
    try { const a = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="); a.volume = 0; a.play().catch(() => { }); } catch { /* noop */ }
}
["pointerdown", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));

// ── 居中：!important 从 JS 注入，压过主题/高特异性/旧缓存。box 在 .mes_block 内会被头像挤偏，用 translateX(--vd-shift) 拉回整条消息中心 ──
(() => {
    const el = document.createElement("style");
    el.textContent = ".vd-tts-box{display:flex!important;justify-content:center!important;align-items:center!important;width:100%!important;box-sizing:border-box!important;transform:translateX(var(--vd-shift,0px))!important;pointer-events:none!important}.vd-tts-bar{pointer-events:auto!important;max-width:100%!important}";
    (document.head || document.documentElement).appendChild(el);
})();
let _shiftT;
window.addEventListener("resize", () => { clearTimeout(_shiftT); _shiftT = setTimeout(updateShift, 200); });

// ── 启动 ──
jQuery(() => {
    observeChat();                     // 新消息/切聊天自动补按钮（不依赖面板）
    setTimeout(() => { sweepButtons(); updateShift(); }, 800);     // 开局给历史消息补按钮 + 量居中偏移
    let n = 0;
    const tryMount = () => { if (!mountSettings() && ++n < 80) setTimeout(tryMount, 250); };  // 最多重试 ~20s
    tryMount();
    // 若 ST 之后重建了扩展设置区、把我们的面板冲掉，就补挂回去
    const hostEl = document.getElementById("extensions_settings");
    if (hostEl) new MutationObserver(() => { if (!document.querySelector(".vd-tts-settings")) mountSettings(); }).observe(hostEl, { childList: true });
    console.log("[tts-vd] loaded");
});
