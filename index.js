/**
 * MiMo TTS (voicedesign) —— SillyTavern 客户端扩展
 *
 */
import { chat, getRequestHeaders, saveSettingsDebounced } from "../../../../script.js";
import { eventSource, event_types } from "../../../events.js";
import { extension_settings, writeExtensionField } from "../../../extensions.js";
import { getContext } from "../../../st-context.js";

const NAME = "mimo-tts";

const DEFAULTS = {
    enabled: true,
    autoplay: true,
    rate: 1,        // 播放速度 0.5~2
    gap: 350,       // 段间停顿(ms)，让句子之间有停顿
    window: 2,      // 伪流式滑动窗口：同时并行合成/预取的段数
    maxSeg: 300,    // 分段上限(字)：贪心把句子攒到接近这个上限、在句号处断；越大=合成次数越少但首段越慢
    bodyTag: "scenario",    // 正文标签：留空=读整条可见正文；填如 "scenario" 则只读 <scenario>…</scenario> 里的内容
    endpoint: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-tts-voicedesign",
    apiKey: "",     // 必填
    temperature: "",
    topP: "",
};

function cfg() {
    // 原地补默认值、**保持同一个对象引用**（换引用会导致设置面板改到废弃对象上、存不住）
    if (!extension_settings[NAME] || typeof extension_settings[NAME] !== "object") extension_settings[NAME] = {};
    const s = extension_settings[NAME];
    for (const k in DEFAULTS) if (s[k] === undefined) s[k] = DEFAULTS[k];
    return s;
}

let pendingAutoId = -1;      // MESSAGE_RECEIVED 记下新回复的 id，只给它自动播（精确匹配，避免被别的渲染吃掉）
let audioUnlocked = false;   // 首次用户手势时解锁音频自动播放（避免长时间生成后 autoplay 被浏览器拦）
const ctx = () => getContext();

// 预热时对流式文本套一遍 ST 的 AI_OUTPUT 正则，使其与最终存下的 mes 一致（缓存才命中）。guarded：拿不到就退回原文。
let _getRegexed = null;
import("../../regex/engine.js").then((m) => { if (typeof m.getRegexedString === "function") _getRegexed = m.getRegexedString; }).catch(() => { });
const REGEX_AI_OUTPUT = 2;   // regex_placement.AI_OUTPUT

// 自动管理隐藏 <tts> 的正则：启用时加进 ST 全局 regex（Only Format Display），停用时移除——用户不用手配。
const REGEX_ID = "mimo-tts-cue-auto";
function syncRegex(on) {
    try {
        if (!Array.isArray(extension_settings.regex)) extension_settings.regex = [];
        const arr = extension_settings.regex;
        const idx = arr.findIndex((r) => r && r.id === REGEX_ID);
        if (on) {
            const rule = {
                id: REGEX_ID,
                scriptName: "MiMo TTS 隐藏 <tts>（自动，勿手改）",
                findRegex: "/<tts>([\\s\\S]*?)<\\/tts>/g",
                replaceString: '<span class="mimo-cue">$1</span>',
                trimStrings: [],
                substituteRegex: 0,
                disabled: false,
                promptOnly: false,      // 不动发给模型的提示词
                markdownOnly: true,     // 只改显示（Only Format Display），原文保留给朗读
                runOnEdit: true,
                minDepth: null,
                maxDepth: null,
                placement: [2],         // regex_placement.AI_OUTPUT
            };
            if (idx === -1) arr.push(rule); else arr[idx] = rule;
        } else if (idx !== -1) {
            arr.splice(idx, 1);
        }
        saveSettingsDebounced();
    } catch (e) { console.warn("[mimo-tts] syncRegex", e); }
}

/** 按字节魔数嗅探音频格式（自带 key 的路子拿不到 format，直接从返回字节判） */
function sniffMime(b) {
    if (b.length >= 4 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "audio/wav";   // RIFF
    if (b.length >= 4 && b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "audio/ogg";   // OggS
    if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg";                   // ID3
    if (b.length >= 2 && b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return "audio/mpeg";                            // mp3 frame
    if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return "audio/flac";  // fLaC
    return "audio/wav";
}

/** base 音色由角色卡自己写：优先 data.extensions.mimo_voice_base，否则 描述/creator_notes 里的 <voice>…</voice> */
function readBase() {
    try {
        const c = ctx();
        const ch = c?.characters?.[c?.characterId];
        if (!ch) return "";
        const ext = ch?.data?.extensions?.mimo_voice_base;
        if (ext && String(ext).trim()) return String(ext).trim();
        const src = [ch.description, ch?.data?.description, ch?.data?.creator_notes, ch.creatorcomment]
            .filter(Boolean).join("\n");
        const m = src.match(/<voice>([\s\S]*?)<\/voice>/i);
        return m ? m[1].trim() : "";
    } catch { return ""; }
}

/** 把「已限定到正文范围」的文本清成可朗读：图片/链接去掉、标签去壳（<tts> 里的 cue 保留内联给 MiMo 当音频标签）、
 *  去 markdown 标记（**粗* _斜_ `码`）——对齐渲染后的 DOM 文本（缓存命中）、也不让 TTS 念出星号。正文标签模式只需要这一层。 */
function speakClean(s) {
    return String(s || "")
        // 先剔除「看不见的块」——注意 CoT 注释/折叠块也可能出现在正文标签(如 <scenario>)内部，必须在去标签壳之前先删
        .replace(/<!--[\s\S]*?-->/g, " ")                       // CoT 注释（含 <!--muse--> 之类）
        .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")          // 代码块
        .replace(/<details[\s\S]*?<\/details>/gi, " ")          // 折叠块（状态栏/小剧场/变量更新）
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")                  // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")                // 链接 → 只留链接文字
        .replace(/<[^>]+>/g, " ")                               // 其余标签去壳（含 <tts>，留里面的 cue 文本）
        .replace(/[*_~`]+/g, "")                                // 强调/行内代码 标记
        .replace(/\s+/g, " ").trim();
}
const stripHidden = speakClean;   // 现在一套清理，两条路径共用（正文标签内/整条都要剔 CoT/折叠）

/** 流式期间：砍掉结尾「未闭合」的构造（注释/代码块/details/半个标签），避免把没写完的内容当成稳定句子去合成 */
function dropUnclosedTail(s) {
    let t = String(s || "");
    const c = t.lastIndexOf("<!--");
    if (c !== -1 && t.indexOf("-->", c) === -1) t = t.slice(0, c);
    const fences = t.match(/```/g);
    if (fences && fences.length % 2 === 1) t = t.slice(0, t.lastIndexOf("```"));
    const low = t.toLowerCase();
    const d = low.lastIndexOf("<details");
    if (d !== -1 && low.indexOf("</details>", d) === -1) t = t.slice(0, d);
    const lt = t.lastIndexOf("<");
    if (lt !== -1 && t.indexOf(">", lt) === -1) t = t.slice(0, lt);  // 结尾半个标签 <sce…
    return t;
}

/** 流式累积原文 → 已稳定的可朗读文本（与 getSpeakText 同一套清理，保证缓存对齐；砍掉未闭合结尾） */
function streamStableText(rawFull) {
    let raw = String(rawFull || "");
    if (_getRegexed) { try { raw = _getRegexed(raw, REGEX_AI_OUTPUT); } catch { /* noop */ } }
    const bt = (cfg().bodyTag || "").trim();
    if (bt) {
        const om = raw.match(new RegExp("<" + bt + "\\b[^>]*>", "i"));
        if (!om) return "";
        raw = raw.slice(om.index + om[0].length);
        const close = raw.search(new RegExp("</" + bt + ">", "i"));
        if (close !== -1) raw = raw.slice(0, close);
        return speakClean(dropUnclosedTail(raw));
    }
    return stripHidden(dropUnclosedTail(raw));
}

/** 已封口的段（总是丢最后一段：贪心打包下它还可能变长，等下一段起来才定型）。最后一段留给 speak 现合成 */
function stableSegments(rawFull) {
    const parts = splitSentences(streamStableText(rawFull));
    return parts.length > 1 ? parts.slice(0, -1) : [];
}

/** 要朗读的文本（从原文 chat[id].mes 清，与 streamStableText 同一套 → 缓存对齐）：有正文标签只取标签内，否则整条剔隐藏块 */
function getSpeakText(messageId) {
    const raw = String((chat[messageId] && chat[messageId].mes) || "");
    const bt = (cfg().bodyTag || "").trim();
    if (bt) {
        const m = raw.match(new RegExp("<" + bt + "\\b[^>]*>([\\s\\S]*?)</" + bt + ">", "i"));
        if (m) return speakClean(m[1]);   // 有标签只念标签内；没这个标签就退回整条
    }
    return stripHidden(raw);
}

/** 分段：切句 → 贪心攒到「分段上限」CAP、在句号断，各段大小一致。兜底：单句超 CAP→逗号切→硬切。CAP=设置 maxSeg */
function splitSentences(text, maxLen) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) return [];
    const CAP = Math.max(20, Math.min(2000, Number(maxLen ?? cfg().maxSeg) || 300));
    const sents = raw.match(/[^。！？!?…\n]*[。！？!?…]+|[^。！？!?…\n]+/g) || [raw]; // 句子（保留句末标点）
    // 过长的句子先拆成 ≤CAP 的小单元（逗号→硬切），保证后面打包每个单元都不超上限
    const units = [];
    for (let s of sents) {
        s = s.trim(); if (!s) continue;
        if (s.length <= CAP) { units.push(s); continue; }
        for (let p of (s.match(/[^，,、；;]+[，,、；;]?/g) || [s])) {
            p = p.trim(); if (!p) continue;
            while (p.length > CAP) { units.push(p.slice(0, CAP)); p = p.slice(CAP); }
            if (p) units.push(p);
        }
    }
    const out = [];
    let buf = "";
    for (const u of units) {
        if (buf && (buf + u).length > CAP) { out.push(buf); buf = u; }   // 攒到接近上限再断，各段大小一致
        else buf += u;
    }
    if (buf) out.push(buf);
    return out;
}

async function synth(voice, text) {
    const s = cfg();
    const url = (s.endpoint || "").replace(/\/+$/, "");
    const key = (s.apiKey || "").trim();
    if (!url) throw new Error("未配置 endpoint");
    if (!key) throw new Error("未填 API Key（在扩展设置里填自己的 key）");
    if (!voice) throw new Error("角色卡没写音色：在角色卡描述里加 <voice>…</voice>，或在设置里填/生成 base");
    if (!text) throw new Error("没有可朗读的文本");
    // openai 源 + reverse_proxy：ST 只透传，用填的 key
    const body = {
        chat_completion_source: "openai",
        reverse_proxy: url,
        proxy_password: key,
        model: s.model,
        messages: [{ role: "user", content: voice }, { role: "assistant", content: text }],
        stream: false, max_tokens: 64,
    };
    // 填了才带（白名单透传）；留空=服务端默认
    if (s.temperature !== "" && s.temperature != null && !Number.isNaN(Number(s.temperature))) body.temperature = Number(s.temperature);
    if (s.topP !== "" && s.topP != null && !Number.isNaN(Number(s.topP))) body.top_p = Number(s.topP);
    // 任何失败(审核/429/5xx/超时/无音频…)自动重试 3 次；仍失败则抛 synthFailed，speak 提示并中断。150s 超时防卡死堵住串行队列
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 150000);
            let resp;
            try {
                resp = await fetch("/api/backends/chat-completions/generate", {
                    method: "POST", headers: getRequestHeaders(), body: JSON.stringify(body), signal: ctrl.signal,
                });
            } finally { clearTimeout(timer); }
            if (!resp.ok) throw new Error("HTTP " + resp.status + "：" + (await resp.text().catch(() => "")).slice(0, 160));
            const json = await resp.json();
            const choice = json?.choices?.[0];
            const b64 = choice?.message?.audio?.data;
            if (b64) {
                const bin = atob(b64); const arr = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                return URL.createObjectURL(new Blob([arr], { type: sniffMime(arr) }));   // 成功
            }
            const reason = choice?.finish_reason || "";
            const note = String(choice?.message?.content || "");
            if (reason === "content_filter" || /rejected|high[\s_-]?risk|风险|审核|content[\s_-]?filter/i.test(note)) {
                throw new Error("内容被安全审核拦截：" + (note || "content_filter"));
            }
            throw new Error("响应无音频：" + JSON.stringify(json).slice(0, 140));
        } catch (e) {
            lastErr = (e && e.name === "AbortError") ? "请求超时(150s)" : String(e?.message || e);
            console.warn(`[mimo-tts] 合成失败，重试 ${attempt}/3：`, lastErr.slice(0, 140));
            if (attempt < 3) await new Promise((r) => setTimeout(r, 600));
        }
    }
    const err = new Error("TTS 合成失败（已重试 3 次）：" + lastErr);
    err.synthFailed = true;   // speak 据此中断
    throw err;
}

// 串行合成队列 + 缓存：全局同时只 1 条（并发互拖慢、且流式期间会挤断回复流），结果按 音色+文本 缓存
const synthCache = new Map();
let synthChain = Promise.resolve();
function enqueueSynth(voice, text) {
    const key = voice + "\u0001" + text;
    const hit = synthCache.get(key);
    if (hit) return hit;
    const p = synthChain.then(() => synth(voice, text));
    synthChain = p.catch(() => { });
    p.catch(() => synthCache.delete(key));    // 失败不留缓存，可重试
    synthCache.set(key, p);
    return p;
}
/** 清缓存 + 回收 objectURL（换轮生成/切聊天）。URL 由缓存统一管理 */
function resetSynth() {
    for (const p of synthCache.values()) Promise.resolve(p).then((u) => { if (u) { try { URL.revokeObjectURL(u); } catch { /* noop */ } } }).catch(() => { });
    synthCache.clear();
    synthChain = Promise.resolve();
}
// ── 播放引擎（可打断）──
let sessionToken = 0;      // 开播/打断自增，旧会话据此作废
let currentAudio = null;
let curResolve = null;
let playingMesId = null;

const boxOf = (mesId) => $(`#chat .mes[mesid="${mesId}"] .mimo-tts-box`);
function fmtRate(r) { return (Math.round(r * 100) / 100).toString().replace(/(\.\d)0$/, "$1") + "×"; }
/** 缓冲/进度显示 */
function setStatus(mesId, text) { boxOf(mesId).find(".mimo-status").text(text || ""); }
/** 实时改倍速：立刻作用到正在放的音频，同步所有倍速控件+设置面板，并持久化 */
function applyRate(r) {
    r = Math.max(0.5, Math.min(2, Number(r) || 1));
    cfg().rate = r;
    if (currentAudio) { try { currentAudio.playbackRate = r; } catch { /* noop */ } }
    $(".mimo-tts-box .mimo-rate").val(r);
    $(".mimo-tts-box .mimo-rate-val").text(fmtRate(r));
    $("#mimo_rate").val(r); $("#mimo_rate_val").text(r.toFixed(2) + "×");
    saveSettingsDebounced();
}

/** 开关「新回复自动播放」：同步所有消息上的按钮 + 设置面板，并持久化 */
function setAutoplay(on) {
    cfg().autoplay = !!on;
    $(".mimo-tts-box .mimo-auto-btn").toggleClass("on", !!on);
    $("#mimo_autoplay").prop("checked", !!on);
    saveSettingsDebounced();
    if (window.toastr) toastr.info("新回复自动播放：" + (on ? "开" : "关"), "MiMo TTS", { timeOut: 1200 });
}

let playbackPaused = false;
function markBtn(mesId, playing) {
    const $box = boxOf(mesId); if (!$box.length) return;
    $box.toggleClass("playing", !!playing);              // 播放时 CSS 展开倍速滑条+进度
    const $b = $box.find("button.mimo-tts-btn");
    $b.find("i").attr("class", playing ? "fa-solid fa-pause" : "fa-solid fa-volume-high");
    $b.attr("title", playing ? "暂停" : "朗读本条");
    if (!playing) $box.find(".mimo-status").text("");
}
/** 暂停/继续（不终止）：暂停正在放的音频 + 卡住播放循环，图标切换 ⏸/▶ */
function togglePause(mesId) {
    playbackPaused = !playbackPaused;
    if (currentAudio) { try { playbackPaused ? currentAudio.pause() : currentAudio.play().catch(() => { }); } catch { /* noop */ } }
    const $b = boxOf(mesId).find("button.mimo-tts-btn");
    $b.find("i").attr("class", playbackPaused ? "fa-solid fa-play" : "fa-solid fa-pause");
    $b.attr("title", playbackPaused ? "继续" : "暂停");
}
const waitWhilePaused = async (my) => { while (playbackPaused && my === sessionToken) await sleep(100); };

/** 打断当前播放：作废会话、停掉在放的音频、解开等待 */
function stopPlayback() {
    sessionToken++; playbackPaused = false;
    if (currentAudio) { try { currentAudio.pause(); } catch { /* noop */ } currentAudio = null; }
    if (curResolve) { const r = curResolve; curResolve = null; r(); }
    if (playingMesId != null) { markBtn(playingMesId, false); playingMesId = null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 按序播放；合成走串行队列(enqueueSynth)——同时只 1 条在飞，播前面时把后面 W 段先塞进队列排队(流水线) */
async function speak(mesId, voice, text) {
    stopPlayback();
    const parts = splitSentences(text);
    if (!voice || !parts.length) return;
    const s = cfg();
    const W = Math.max(1, Math.min(8, Number(s.window) || 3));      // 预取深度：提前排队的段数（队列仍串行）
    const gap = Math.max(0, Math.min(3000, Number(s.gap) || 0));    // 段间停顿
    const my = ++sessionToken;
    playingMesId = mesId; markBtn(mesId, true);
    const N = parts.length;
    const start = (i) => { if (i < N) enqueueSynth(voice, parts[i]).catch(() => { }); };   // 入队（缓存去重，流式已预热的直接命中）
    for (let i = 0; i < W; i++) start(i);      // 预取窗口
    for (let i = 0; i < N; i++) {
        if (my !== sessionToken) break;
        let url;
        try {
            setStatus(mesId, `缓冲 ${i + 1}/${N}`);          // 合成/缓冲中（命中缓存的话一闪而过）
            url = await enqueueSynth(voice, parts[i]);       // 命中缓存则秒回（0 等待）
        } catch (e) {                                        // 合成连试 3 次仍失败（审核/429/超时…）→ 如实提示 + 中断本条
            if (my === sessionToken) { if (window.toastr) toastr.error(String(e?.message || e), "MiMo TTS"); stopPlayback(); }
            return;
        }
        start(i + W);                          // 播第 i 段时，把 i+W 也排上队 → 始终有若干段在排队
        await waitWhilePaused(my);
        if (my !== sessionToken) break;
        if (url) { setStatus(mesId, `播放 ${i + 1}/${N}`); await playUrl(url, my); }
        if (my === sessionToken && gap && i < N - 1) await sleep(gap);  // 段间停顿（否则句子连着念、没停顿）
    }
    if (my === sessionToken) { playingMesId = null; markBtn(mesId, false); }
}

async function processMessage(messageId, allowAutoplay) {
    const s = cfg();
    if (!s.enabled) return;
    const msg = chat[messageId];
    if (!msg || msg.is_user || msg.is_system) return;
    const $block = $(`#chat .mes[mesid="${messageId}"] .mes_block`);
    if (!$block.length) return;

    // 每条消息注入一个播放器（播放/停止 + 自动播放开关 + 实时倍速 + 缓冲进度）（幂等）
    if (!$block.children(".mimo-tts-box").length) {
        const r0 = Math.max(0.5, Math.min(2, Number(cfg().rate) || 1));
        const $box = $(`<div class="mimo-tts-box"><div class="mimo-tts-bar">
            <button class="mimo-tts-btn menu_button" title="朗读本条"><i class="fa-solid fa-volume-high"></i></button>
            <button class="mimo-auto-btn menu_button" title="新回复自动播放（点击开/关）"><i class="fa-solid fa-wand-sparkles"></i></button>
            <span class="mimo-player">
                <i class="fa-solid fa-gauge-high mimo-rate-ico" title="播放速度"></i>
                <input type="range" class="mimo-rate" min="0.5" max="2" step="0.05" value="${r0}" title="播放速度（实时）">
                <span class="mimo-rate-val">${fmtRate(r0)}</span>
                <span class="mimo-status"></span>
            </span>
        </div></div>`);
        $block.append($box);
        $box.find(".mimo-tts-btn").on("click", () => {
            if (playingMesId === messageId) { togglePause(messageId); return; }   // 再点 = 暂停/继续
            const voice = readBase();
            if (!voice) { if (window.toastr) toastr.warning("角色卡未设音色（加 <voice> 或用扩展里“让角色生成音色”）", "MiMo TTS"); return; }
            speak(messageId, voice, getSpeakText(messageId));
        });
        $box.find(".mimo-auto-btn").on("click", () => setAutoplay(!cfg().autoplay));
        $box.find(".mimo-rate").on("input", function () { applyRate(this.value); });
        updateShift();   // 量并写入居中偏移
    }
    // 自动播放按钮高亮跟随当前设置（可能在别处被改）
    $block.children(".mimo-tts-box").find(".mimo-auto-btn").toggleClass("on", !!s.autoplay);

    if (allowAutoplay && s.autoplay) {
        const voice = readBase();
        if (!voice) { console.warn("[mimo-tts] 角色卡未设音色，跳过自动播放"); return; }
        speak(messageId, voice, getSpeakText(messageId));
    }
}

/** 给「已经渲染出来的」消息补按钮：开局/切聊天/翻页时那几个「新消息」事件不覆盖旧消息，旧消息会没按钮 */
function sweepButtons() {
    document.querySelectorAll("#chat .mes[mesid]").forEach((el) => {
        const id = Number(el.getAttribute("mesid"));
        if (!Number.isNaN(id)) processMessage(id, false);
    });
}
/** 监听 #chat 直接子节点新增（新消息 / 切聊天重铸 / 翻页加载）自动补按钮；只看 childList、不看子树，流式打字不会触发 */
let chatObserverOn = false;
function observeChat() {
    const el = document.getElementById("chat");
    if (!el || chatObserverOn) return;
    chatObserverOn = true;
    new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.classList && n.classList.contains("mes")) {
                const id = Number(n.getAttribute("mesid"));
                if (!Number.isNaN(id)) processMessage(id, false);
            }
        }
    }).observe(el, { childList: true });
}

// 0 等待流式播放：生成中就边合边播——第一段合好立刻响，不必等整段生成完
let streamVoice = "";
let streamOn = false;           // 本轮是否边生成边播
const streamSeen = new Set();   // 已发现的段（去重）
let streamSegs = [];            // 有序段列表（生成中不断追加）
let streamDone = false;         // 本轮文本是否生成完
let streamMesId = null;         // 本轮回复的消息 id（结束时确定）

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
        let url; try { url = await enqueueSynth(streamVoice, seg); } catch (e) { console.warn("[mimo-tts]", e?.message || e); url = null; }
        await waitWhilePaused(my);
        if (my !== sessionToken) break;
        if (url) { if (uiId != null) setStatus(uiId, "播放 " + idx + tail); await playUrl(url, my); }
        const gap = Math.max(0, Math.min(3000, Number(cfg().gap) || 0));
        if (my === sessionToken && gap && (idx < streamSegs.length || !streamDone)) await sleep(gap);
    }
    if (my === sessionToken && uiId != null) { playingMesId = null; markBtn(uiId, false); }
}

// 用「首个 STREAM_TOKEN」判定真·生成开始——dryRun 不可靠（本机真回复的 GENERATION_STARTED 也是 dryRun:true），
// 而干跑不产 token。首个 token 才停旧播放、清缓存、武装流式播放；生成结束后重置，等下一轮。
let streamArmed = false;
function armStream() {
    stopPlayback(); resetSynth();
    streamSeen.clear(); streamSegs = []; streamDone = false; streamMesId = null;
    streamOn = false; streamVoice = "";
    const s = cfg();
    if (s.enabled && s.autoplay) { const v = readBase(); if (v) { streamVoice = v; streamOn = true; streamPlay(++sessionToken); } }
}
eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (full) => {
    if (!streamArmed) { streamArmed = true; armStream(); }   // 本轮首个 token = 真生成
    if (!streamOn) return;
    for (const seg of stableSegments(String(full || ""))) {
        if (streamSeen.has(seg)) continue;
        streamSeen.add(seg); streamSegs.push(seg);
        enqueueSynth(streamVoice, seg).catch(() => { });   // 预热（串行）
    }
});

// ── 事件 ──
eventSource.on(event_types.MESSAGE_RECEIVED, (id) => { pendingAutoId = id; });
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
    const auto = (id === pendingAutoId); if (auto) pendingAutoId = -1;
    if (auto && streamOn) {
        processMessage(id, false);   // 注入按钮；播放由正在跑的 streamPlay 接手
        streamMesId = id;
        for (const seg of splitSentences(getSpeakText(id))) {   // 补齐流式期间被丢的末段，继续播
            if (!streamSeen.has(seg)) { streamSeen.add(seg); streamSegs.push(seg); enqueueSynth(streamVoice, seg).catch(() => { }); }
        }
        streamDone = true;
    } else {
        processMessage(id, auto);    // 无流式自动播时的兜底：按钮 +（auto 则 speak）
    }
    streamArmed = false;             // 本轮结束，下一轮首 token 再武装
});
eventSource.on(event_types.MESSAGE_SWIPED, (id) => processMessage(id, true));
eventSource.on(event_types.MESSAGE_UPDATED, (id) => processMessage(id, false));
eventSource.on(event_types.MESSAGE_EDITED, (id) => processMessage(id, false));
eventSource.on(event_types.MESSAGE_SENT, () => { streamArmed = false; stopPlayback(); });
eventSource.on(event_types.GENERATION_STARTED, () => { streamArmed = false; });  // 允许本轮首 token 重新武装（不在此停播/清缓存，免得干跑打断正在放的）
eventSource.on(event_types.GENERATION_STOPPED, () => { streamDone = true; streamArmed = false; stopPlayback(); });
eventSource.on(event_types.CHAT_CHANGED, () => { streamArmed = false; stopPlayback(); resetSynth(); setTimeout(sweepButtons, 100); });

// ── 设置 UI ──
function buildSettings(host) {
    const s = cfg();
    const html = `
    <div class="mimo-tts-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-wave-square"></i> MiMo TTS</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content mimo-body">

          <div class="mimo-toggles">
            <label class="checkbox_label"><input type="checkbox" id="mimo_enabled"><span>启用语音输出</span></label>
          </div>

          <div class="mimo-sec">
            <div class="mimo-sec-head"><i class="fa-solid fa-play"></i><span>播放</span></div>
            <label class="checkbox_label"><input type="checkbox" id="mimo_autoplay"><span>新回复自动播放</span></label>
            <label class="mimo-field"><span>播放速度 <b id="mimo_rate_val"></b></span><input type="range" id="mimo_rate" min="0.5" max="2" step="0.05"></label>
            <div class="mimo-btnrow">
              <label class="mimo-num" title="每段之间的停顿(毫秒)，让句子有停顿"><span>段间停顿(ms)</span><input class="text_pole" id="mimo_gap" type="number" min="0" max="3000" step="50"></label>
              <label class="mimo-num" title="伪流式：同时并行合成/预取的段数"><span>预取窗口</span><input class="text_pole" id="mimo_window" type="number" min="1" max="8" step="1"></label>
              <label class="mimo-num" title="每段最多多少字，在最近的句号处断；越大=合成次数越少但首段越慢"><span>分段上限(字)</span><input class="text_pole" id="mimo_maxseg" type="number" min="20" max="2000" step="20"></label>
            </div>
          </div>

          <div class="mimo-sec">
            <div class="mimo-sec-head"><i class="fa-solid fa-user-tag"></i><span>音色 base</span><i class="mimo-dot fa-solid fa-circle" id="mimo_base_dot"></i></div>
            <textarea class="text_pole mimo-base-edit" id="mimo_base_edit" rows="3" placeholder="这张角色卡的嗓音描述；可手动改，或点“生成”让角色自己写"></textarea>
            <div class="mimo-btnrow">
              <button id="mimo_gen_base" class="menu_button" title="用当前文本模型、以角色口吻生成一段（别在语音连接下点）"><i class="fa-solid fa-wand-magic-sparkles"></i><span class="lbl">生成</span></button>
              <button id="mimo_save_base" class="menu_button" title="把音色存进角色卡"><i class="fa-solid fa-floppy-disk"></i><span class="lbl">保存</span></button>
              <button id="mimo_reload_base" class="menu_button" title="从角色卡重新读取"><i class="fa-solid fa-rotate"></i><span class="lbl">读取</span></button>
            </div>
            <div class="mimo-hint">存进<b>角色卡</b>（<code>data.extensions.mimo_voice_base</code>，随卡走、优先级最高）；也可在角色卡描述写 <code>&lt;voice&gt;…&lt;/voice&gt;</code>。</div>
          </div>

          <div class="mimo-sec">
            <div class="mimo-sec-head"><i class="fa-solid fa-plug"></i><span>连接</span></div>
            <label class="mimo-field"><span>Endpoint</span><input class="text_pole" id="mimo_endpoint" type="text" placeholder="https://api.xiaomimimo.com/v1"></label>
            <label class="mimo-field"><span>API Key（必填，用你自己的）</span><input class="text_pole" id="mimo_apikey" type="password" autocomplete="off" placeholder="sk-…"></label>
            <label class="mimo-field"><span>Model</span><input class="text_pole" id="mimo_model" type="text"></label>
            <div class="mimo-btnrow">
              <label class="mimo-num" title="采样温度；留空=用服务端默认"><span>温度</span><input class="text_pole" id="mimo_temp" type="number" min="0" max="2" step="0.05" placeholder="默认"></label>
              <label class="mimo-num" title="top_p；留空=用服务端默认"><span>top_p</span><input class="text_pole" id="mimo_topp" type="number" min="0" max="1" step="0.05" placeholder="默认"></label>
            </div>
            <label class="mimo-field"><span>正文标签（可选）</span><input class="text_pole" id="mimo_bodytag" type="text" placeholder="留空=读整条可见正文；填 scenario 则只读 &lt;scenario&gt;…&lt;/scenario&gt;"></label>
          </div>

        </div>
      </div>
    </div>`;
    (host ? $(host) : $("#extensions_settings")).append(html);

    const setDot = (v) => $("#mimo_base_dot").toggleClass("on", !!(v && String(v).trim()));
    const reloadBase = () => { const b = readBase(); $("#mimo_base_edit").val(b); setDot(b); };
    async function writeBase(v) {
        const c = ctx();
        if (c.characterId === undefined || c.characterId === null || c.characterId === "") throw new Error("先选一个角色卡");
        await writeExtensionField(c.characterId, "mimo_voice_base", String(v || "").trim());
    }

    const showRate = () => $("#mimo_rate_val").text((Number(s.rate) || 1).toFixed(2) + "×");
    $("#mimo_enabled").prop("checked", s.enabled);
    $("#mimo_autoplay").prop("checked", s.autoplay);
    $("#mimo_rate").val(s.rate); showRate();
    $("#mimo_gap").val(s.gap);
    $("#mimo_window").val(s.window);
    $("#mimo_maxseg").val(s.maxSeg);
    $("#mimo_bodytag").val(s.bodyTag);
    $("#mimo_endpoint").val(s.endpoint);
    $("#mimo_apikey").val(s.apiKey);
    $("#mimo_model").val(s.model);
    $("#mimo_temp").val(s.temperature);
    $("#mimo_topp").val(s.topP);
    reloadBase();

    const save = () => saveSettingsDebounced();
    $("#mimo_enabled").on("change", function () { s.enabled = this.checked; syncRegex(this.checked); save(); });
    $("#mimo_autoplay").on("change", function () { setAutoplay(this.checked); });   // 同步消息上的自动播放按钮
    $("#mimo_rate").on("input", function () { applyRate(this.value); showRate(); });  // 实时倍速 + 同步消息上的滑条
    $("#mimo_gap").on("input", function () { s.gap = Math.max(0, Math.min(3000, Number(this.value) || 0)); save(); });
    $("#mimo_window").on("input", function () { s.window = Math.max(1, Math.min(8, Number(this.value) || 3)); save(); });
    $("#mimo_maxseg").on("input", function () { s.maxSeg = Math.max(20, Math.min(2000, Number(this.value) || 300)); save(); });
    $("#mimo_bodytag").on("input", function () { s.bodyTag = this.value.trim().replace(/[<>/]/g, ""); save(); });
    $("#mimo_endpoint").on("input", function () { s.endpoint = this.value.trim(); save(); });
    $("#mimo_apikey").on("input", function () { s.apiKey = this.value.trim(); save(); });
    $("#mimo_model").on("input", function () { s.model = this.value.trim(); save(); });
    // 温度/top_p：留空=用服务端默认；填了就 clamp
    $("#mimo_temp").on("input", function () { const v = this.value.trim(); s.temperature = v === "" ? "" : Math.max(0, Math.min(2, Number(v) || 0)); save(); });
    $("#mimo_topp").on("input", function () { const v = this.value.trim(); s.topP = v === "" ? "" : Math.max(0, Math.min(1, Number(v) || 0)); save(); });
    $("#mimo_base_edit").on("input", function () { setDot(this.value); });
    $("#mimo_reload_base").on("click", reloadBase);
    $("#mimo_save_base").on("click", async () => {
        try { await writeBase($("#mimo_base_edit").val()); if (window.toastr) toastr.success("已存进角色卡", "MiMo TTS"); }
        catch (e) { if (window.toastr) toastr.error(String(e.message || e), "MiMo TTS"); }
    });
    $("#mimo_gen_base").on("click", async function () {
        const c = ctx();
        if (c.characterId === undefined || c.characterId === null || c.characterId === "") { if (window.toastr) toastr.warning("先选一个角色卡", "MiMo TTS"); return; }
        const $b = $(this); $b.prop("disabled", true).find(".lbl").text("生成中…");
        try {
            const ch = c.characters?.[c.characterId] || {};
            const nm = ch?.name || ch?.data?.name || "该角色";
            const persona = String(ch?.description || ch?.data?.description || ch?.data?.personality || "")
                .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1200);
            // generateRaw：只走 system+prompt、绕开当前预设的越狱/旁白/格式（用当前文本模型，不是本扩展的 key）
            const sys = "你是一个语音设计(TTS voice design)助手。只输出一段中文音色描述，用来给 TTS 定制音色。"
                + "禁止角色扮演、禁止旁白、禁止场景、禁止任何标签或前后缀。";
            const prompt = "根据下面的角色设定，用 1~4 句中文描述这个角色说话时的嗓音："
                + "音高、性别感、语速、语气与情绪基调；具体生动、适合作为 TTS 音色描述；"
                + "不要写混响/EQ 等音效词；只输出这段描述本身。\n\n"
                + "角色名：" + nm + "\n角色设定：" + (persona || "（无）") + "\n\n音色描述：";
            // glm 等推理模型会先消耗大量 token 思考，responseLength 要给足，否则 content 为空
            let desc = String(await getContext().generateRaw({ prompt, systemPrompt: sys, responseLength: 2048 }) || "").trim();
            desc = desc.replace(/<[^>]+>/g, "").replace(/^["'「『（(]+|["'」』）)]+$/g, "").replace(/^音色描述[:：]\s*/, "").trim();
            if (!desc) throw new Error("生成结果为空（确认当前是文本模型连接）");
            $("#mimo_base_edit").val(desc);
            await writeBase(desc);
            setDot(desc);
            if (window.toastr) toastr.success("已生成并存进角色卡", "MiMo TTS");
        } catch (e) { if (window.toastr) toastr.error(String(e.message || e), "MiMo TTS"); }
        finally { $b.prop("disabled", false).find(".lbl").text("生成"); }
    });
    eventSource.on(event_types.CHAT_CHANGED, reloadBase);
}

// 首次用户手势解锁音频（放一段静音），之后异步到达的回复也能自动播、不被 autoplay 策略拦
function unlockAudio() {
    if (audioUnlocked) return; audioUnlocked = true;
    try { const a = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="); a.volume = 0; a.play().catch(() => {}); } catch { /* noop */ }
}
["pointerdown", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));

// 挂设置面板：容器可能还没就绪 → 重试；buildSettings 若抛错则记一次、不再无限重试；被 ST 冲掉了会补挂回来
let _panelFailed = false;
function mountSettings() {
    if (_panelFailed) return true;
    if (document.querySelector(".mimo-tts-settings")) return true;         // 已挂
    const hostEl = document.getElementById("extensions_settings") || document.getElementById("extensions_settings2");
    if (!hostEl) return false;                                              // 容器还没出来，稍后重试
    try { buildSettings(hostEl); return true; }
    catch (e) { _panelFailed = true; console.error("[mimo-tts] buildSettings FAILED:", e); return true; }
}

// 居中：!important 从 JS 注入，压过主题/高特异性/旧缓存。box 在 .mes_block 内会被头像挤偏，用 translateX(--mimo-shift) 拉回整条消息中心
(() => {
    const el = document.createElement("style");
    el.textContent = ".mimo-tts-box{display:flex!important;justify-content:center!important;align-items:center!important;width:100%!important;box-sizing:border-box!important;transform:translateX(var(--mimo-shift,0px))!important;pointer-events:none!important}.mimo-tts-bar{pointer-events:auto!important;max-width:100%!important}";
    (document.head || document.documentElement).appendChild(el);
})();
// 量一次「消息中心 - 内容列中心」的偏移（头像宽度所致，布局内恒定），写进 CSS 变量给所有播放器用
function updateShift() {
    const box = document.querySelector("#chat .mes .mimo-tts-box");
    const mes = box && box.closest(".mes");
    if (!box || !mes) return;
    const prev = box.style.transform; box.style.transform = "none";
    const mr = mes.getBoundingClientRect(), br = box.getBoundingClientRect();
    box.style.transform = prev;
    if (br.width) document.documentElement.style.setProperty("--mimo-shift", Math.round((mr.left + mr.width / 2) - (br.left + br.width / 2)) + "px");
}
let _shiftT;
window.addEventListener("resize", () => { clearTimeout(_shiftT); _shiftT = setTimeout(updateShift, 200); });

jQuery(() => {
    try { syncRegex(cfg().enabled); } catch (e) { console.error("[mimo-tts] syncRegex", e); }
    observeChat();                     // 新消息/切聊天自动补按钮（不依赖面板）
    setTimeout(() => { sweepButtons(); updateShift(); }, 800);     // 开局给历史消息补按钮 + 量居中偏移
    let n = 0;
    const tryMount = () => { if (!mountSettings() && ++n < 80) setTimeout(tryMount, 250); };  // 最多重试 ~20s
    tryMount();
    // 若 ST 之后重建了扩展设置区、把我们的面板冲掉，就补挂回去
    const hostEl = document.getElementById("extensions_settings");
    if (hostEl) new MutationObserver(() => { if (!document.querySelector(".mimo-tts-settings")) mountSettings(); }).observe(hostEl, { childList: true });
    console.log("[mimo-tts] loaded");
});
