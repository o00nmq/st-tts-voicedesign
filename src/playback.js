/**
 * 播放引擎（可打断）：按序合成→播放，串行队列 + 预取窗口（伪流式）；以及「边生成边播」的流式引擎。
 *
 * 基础播放(speak)与流式播放(streamPlay)共享同一套会话状态（sessionToken/currentAudio/暂停/高亮），
 * 二者耦合很紧、且流式本质上就是播放的一种模式，故放在同一模块。合成/标注见 synth.js、emote.js。
 */
import { cfg, UI, activeBackend } from "./settings.js";
import { saveSettingsDebounced } from "./st.js";
import { sleep } from "./util.js";
import { splitSentences, stableSegments, getSpeakText } from "./text-extract.js";
import { synthSeg, resetSynth } from "./synth.js";
import { highlightSegment, clearHighlight } from "./highlight.js";
import { readBase } from "./voice.js";

// ── 会话状态 ──
let sessionToken = 0;      // 开播/打断自增，旧会话据此作废
let currentAudio = null;
let curResolve = null;
let playingMesId = null;
let playbackPaused = false;
let _streamCoalesce = null;   // 流式分段合并定时器：把每-token 的全量重切降频到 ~200ms（见 onStreamToken）
let _streamLastFull = "";     // 最近一次 STREAM_TOKEN 的全量文本（合并处理时读）

export const getPlayingMesId = () => playingMesId;

const boxOf = (mesId) => $(`#chat .mes[mesid="${mesId}"] .vd-tts-box`);
export function fmtRate(r) { return (Math.round(r * 100) / 100).toString().replace(/(\.\d)0$/, "$1") + "×"; }
/** 缓冲/进度显示 */
function setStatus(mesId, text) { boxOf(mesId).find(".vd-status").text(text || ""); }

/** 实时改倍速：立刻作用到正在放的音频，同步所有倍速控件+设置面板，并持久化 */
export function applyRate(r) {
    r = Math.max(0.5, Math.min(2, Number(r) || 1));
    cfg().rate = r;
    if (currentAudio) { try { currentAudio.playbackRate = r; } catch { /* noop */ } }
    $(".vd-tts-box .vd-rate").val(r);
    $(".vd-tts-box .vd-rate-val").text(fmtRate(r));
    $("#vd_rate").val(r); $("#vd_rate_val").text(r.toFixed(2) + "×");
    saveSettingsDebounced();
}

function markBtn(mesId, playing) {
    const $box = boxOf(mesId); if (!$box.length) return;
    $box.toggleClass("playing", !!playing);              // 播放时 CSS 展开倍速滑条+进度
    const $b = $box.find("button.vd-tts-btn");
    $b.find("i").attr("class", playing ? "fa-solid fa-pause" : "fa-solid fa-volume-high");
    $b.attr("title", playing ? "暂停" : "朗读本条");
    if (!playing) $box.find(".vd-status").text("");
}

/** 暂停/继续（不终止）：暂停正在放的音频 + 卡住播放循环，图标切换 ⏸/▶ */
export function togglePause(mesId) {
    playbackPaused = !playbackPaused;
    if (currentAudio) { try { playbackPaused ? currentAudio.pause() : currentAudio.play().catch(() => { }); } catch { /* noop */ } }
    const $b = boxOf(mesId).find("button.vd-tts-btn");
    $b.find("i").attr("class", playbackPaused ? "fa-solid fa-play" : "fa-solid fa-pause");
    $b.attr("title", playbackPaused ? "继续" : "暂停");
}
const waitWhilePaused = async (my) => { while (playbackPaused && my === sessionToken) await sleep(100); };

/** 打断当前播放：作废会话、停掉在放的音频、解开等待 */
export function stopPlayback() {
    sessionToken++; playbackPaused = false;
    if (_streamCoalesce) { clearTimeout(_streamCoalesce); _streamCoalesce = null; }   // 取消待处理的流式分段合并（打断/换轮/停生成）
    if (currentAudio) { try { currentAudio.pause(); } catch { /* noop */ } currentAudio = null; }
    if (curResolve) { const r = curResolve; curResolve = null; r(); }
    if (playingMesId != null) { markBtn(playingMesId, false); playingMesId = null; }
    clearHighlight();
}

function playUrl(url, my) {
    return new Promise((resolve) => {
        if (my !== sessionToken) { resolve(); return; }   // URL 由缓存统一回收，这里不 revoke（否则重播时是死链）
        const a = new Audio(url);
        a.playbackRate = Math.max(0.5, Math.min(2, Number(cfg().rate) || 1)); // 播放速度
        currentAudio = a; curResolve = resolve;
        const done = () => { if (curResolve === resolve) curResolve = null; resolve(); };
        a.onended = done; a.onerror = done;
        a.play().catch(done);
    });
}

/** 试听一段音频（设计预览用）：当作 currentAudio，之后 stopPlayback 能停掉。 */
export function previewUrl(url) {
    if (!url) return;
    try { stopPlayback(); const a = new Audio(url); currentAudio = a; a.play().catch(() => { }); } catch { /* noop */ }
}

/** 按序播放；合成走串行队列(synthSeg→enqueueSynth)——同时只 1 条在飞，播前面时把后面 W 段先塞进队列排队(流水线)。
 *  emote 开：synthSeg 会逐段先加情绪标签再合成（标签只供合成、不占字数、不改显示、不去 CoT）。 */
export async function speak(mesId, voice, text) {
    stopPlayback();
    if (!text || (activeBackend() === "mimo" && !voice)) return;   // Fish：voice 可空（默认音色）
    const my = ++sessionToken;
    playingMesId = mesId; markBtn(mesId, true);
    const parts = splitSentences(text);   // text 已是干净正文（getSpeakText 清过）；emote 的加标签在 synthSeg 里逐段做
    if (!parts.length) { if (my === sessionToken) { playingMesId = null; markBtn(mesId, false); } return; }
    const s = cfg();
    const W = Math.max(1, Math.min(8, Number(s.window) || 3));      // 预取深度：提前排队的段数（队列仍串行）
    const gap = Math.max(0, Math.min(3000, Number(s.gap) || 0));    // 段间停顿
    const N = parts.length;
    const start = (i) => { if (i < N) synthSeg(voice, parts[i]).catch(() => { }); };   // 入队：加标签(若开)+合成；缓存去重
    for (let i = 0; i < W; i++) start(i);      // 预取窗口
    for (let i = 0; i < N; i++) {
        if (my !== sessionToken) break;
        let url;
        try {
            setStatus(mesId, `缓冲 ${i + 1}/${N}`);          // 合成/缓冲中（命中缓存的话一闪而过）
            url = await synthSeg(voice, parts[i]);          // 命中缓存则秒回（0 等待）
        } catch (e) {                                        // 合成连试 3 次仍失败（审核/429/超时…）→ 如实提示 + 中断本条
            if (my === sessionToken) { if (window.toastr) toastr.error(String(e?.message || e), UI); stopPlayback(); }
            return;
        }
        start(i + W);                          // 播第 i 段时，把 i+W 也排上队 → 始终有若干段在排队
        await waitWhilePaused(my);
        if (my !== sessionToken) break;
        if (url) { setStatus(mesId, `播放 ${i + 1}/${N}`); highlightSegment(mesId, parts[i]); await playUrl(url, my); }   // 高亮用干净段（不含标签）→ 对齐 DOM
        if (my === sessionToken && gap && i < N - 1) await sleep(gap);  // 段间停顿（否则句子连着念、没停顿）
    }
    if (my === sessionToken) { playingMesId = null; markBtn(mesId, false); clearHighlight(); }
}

// ── 0 等待流式播放：生成中就边合边播——第一段合好立刻响，不必等整段生成完 ──
let pendingAutoId = -1;         // MESSAGE_RECEIVED 记下新回复的 id，只给它自动播（精确匹配，避免被别的渲染吃掉）
let streamVoice = "";
let streamOn = false;           // 本轮是否边生成边播（MiMo/Fish 皆可；emote 开也流式：逐段加标签）
let streamSegs = [];            // 有序段列表（生成中不断追加）
let streamDone = false;         // 本轮文本是否生成完
let streamMesId = null;         // 本轮回复的消息 id（结束时确定）
let streamErrShown = false;     // 本轮流式已弹过一次错误提示（避免每段刷屏，但持续失败不再全程静默）
// 用「首个 STREAM_TOKEN」判定真·生成开始——dryRun 不可靠（本机真回复的 GENERATION_STARTED 也是 dryRun:true），
// 而干跑不产 token。首个 token 才停旧播放、清缓存、武装流式播放；生成结束后重置，等下一轮。
let streamArmed = false;

export const isStreamOn = () => streamOn;
export const notePendingAuto = (id) => { pendingAutoId = id; };
export const consumePendingAuto = (id) => { const auto = (id === pendingAutoId); if (auto) pendingAutoId = -1; return auto; };
export const disarmStream = () => { streamArmed = false; };   // 本轮结束，下一轮首 token 再武装
export const markStreamDone = () => { streamDone = true; };

// 当前正在流式的那条回复（最后一条非用户消息），给播放器 UI 定位
function resolveStreamMesId() {
    if (streamMesId != null) return streamMesId;
    const el = [...document.querySelectorAll("#chat .mes[mesid]")].filter((m) => m.getAttribute("is_user") !== "true").pop();
    const id = el ? Number(el.getAttribute("mesid")) : NaN;
    return Number.isNaN(id) ? null : id;
}

// 消费 streamSegs、按序边合边播；生成完且都播完才收尾
async function streamPlay(my) {
    let idx = 0, uiId = null;
    while (my === sessionToken) {
        if (idx >= streamSegs.length) {
            if (streamDone) break;              // 生成完 + 段都放完
            await sleep(80); continue;           // 等下一段就绪
        }
        if (uiId == null) { uiId = resolveStreamMesId(); if (uiId != null) { playingMesId = uiId; markBtn(uiId, true); } }
        const seg = streamSegs[idx++];
        const tail = (streamDone ? "/" + streamSegs.length : "");
        if (uiId != null) setStatus(uiId, "缓冲 " + idx + tail);   // 合成中（不是播放）
        let url;
        try { url = await synthSeg(streamVoice, seg); }   // emote 开则先逐段加情绪标签再合成（与预热共享 segTagCache/synthCache）
        catch (e) {   // 流式下持续失败（Fish 插件未装/审核/超时…）本会静默跳过整条 → 至少弹一次错误，别让用户毫无反馈
            console.warn("[tts-vd]", e?.message || e); url = null;
            if (!streamErrShown) { streamErrShown = true; if (window.toastr) toastr.error(String(e?.message || e), UI); }
        }
        await waitWhilePaused(my);
        if (my !== sessionToken) break;
        if (url) { if (uiId != null) { setStatus(uiId, "播放 " + idx + tail); highlightSegment(uiId, seg); } await playUrl(url, my); }
        const gap = Math.max(0, Math.min(3000, Number(cfg().gap) || 0));
        if (my === sessionToken && gap && (idx < streamSegs.length || !streamDone)) await sleep(gap);
    }
    if (my === sessionToken && uiId != null) { playingMesId = null; markBtn(uiId, false); clearHighlight(); }
}

// 首个 token 时武装本轮流式播放：停旧播放、清缓存、按需开边生成边播。
function armStream() {
    stopPlayback(); resetSynth();
    streamSegs = []; streamDone = false; streamMesId = null;
    streamOn = false; streamVoice = ""; streamErrShown = false;
    const s = cfg();
    // 边生成边分段播：首句最早出声。Fish 用固定 reference_id → 段间音色一致、无漂移。
    // emote 开【也流式】：每个封口段先逐段加情绪标签(synthSeg→prepSeg)再合成（CoT 已由清理剔除，emote 只加 voice tag）。
    // 注意：emote 用「继承主模型」(generateRaw) 时，标注可能排在主回复生成之后 → 首段出声被拖慢；想真·边生成边播建议配独立的自定义连接。
    if (s.enabled && s.autoplay) {
        const v = readBase();
        if (activeBackend() === "fish" || v) { streamVoice = v; streamOn = true; streamPlay(++sessionToken); }   // Fish：voice 可空（默认音色）
    }
}

// 把「已封口段」入队预热。封口段 = 全量切分去掉最后一段（贪心打包前缀稳定：前 N 段不再变）。
// 按【下标】发新封口段，不做字符串去重——字符串去重会误吞重复句/错位丢内容（分段错位 bug 的根因）。
function pumpStreamSegments() {
    if (!streamOn) return;
    const sealed = stableSegments(_streamLastFull);
    for (let i = streamSegs.length; i < sealed.length; i++) {
        streamSegs.push(sealed[i]);
        synthSeg(streamVoice, sealed[i]).catch(() => { });   // 预热：加标签(若开)+合成，串行
    }
}

/** STREAM_TOKEN_RECEIVED：首 token 武装本轮流式；之后把每-token 全量重切降频到 ~200ms 一次。 */
export function onStreamToken(full) {
    if (!streamArmed) { streamArmed = true; armStream(); }   // 本轮首个 token = 真生成
    if (!streamOn) return;
    _streamLastFull = String(full || "");
    // 每-token 都全量重切是 O(n) → 整条 O(n²)（长回复卡顿、挤占流式渲染）。合并到最多每 ~200ms 一次：
    // 只影响封口段「何时入队」（最多晚 ~200ms ≪ 合成耗时），且结束时 finalizeStream 会按权威切分补齐、绝不丢段。
    if (!_streamCoalesce) _streamCoalesce = setTimeout(() => { _streamCoalesce = null; pumpStreamSegments(); }, 200);
}

/** CHARACTER_MESSAGE_RENDERED（auto 且流式时）：用最终权威切分补齐尾部段，标记本轮生成完。 */
export function finalizeStream(id) {
    streamMesId = id;
    // 按【字符游标】把还没入队的「尾部」段追加，保证整条正文都被朗读（不漏中间/末段）
    const finalParts = splitSentences(getSpeakText(id));
    const emittedLen = streamSegs.reduce((n, seg) => n + seg.length, 0);
    let cum = 0;
    for (const seg of finalParts) {
        const end = cum + seg.length;
        if (end > emittedLen) { streamSegs.push(seg); synthSeg(streamVoice, seg).catch(() => { }); }
        cum = end;
    }
    streamDone = true;
}
