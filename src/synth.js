/**
 * 合成调度：按后端分派 + 统一重试/超时；串行队列 + 结果缓存（后端+音色+文本）；
 * emote 开时在合成前逐段先加情绪标签（见 emote.js）。
 */
import { cfg, activeBackend } from "./settings.js";
import { sleep } from "./util.js";
import { prepSeg, clearEmoteCache } from "./emote.js";
import { synthMimoOnce } from "./backends/mimo.js";
import { synthFishOnce } from "./backends/fish.js";

// ── 合成：按后端分派，外层统一重试 3 次 + 150s 超时 ──
async function synth(voice, text) {
    const s = cfg();
    const backend = activeBackend();
    if (!text) throw new Error("没有可朗读的文本");
    if (backend === "fish") {
        if (!(s.fishApiKey || "").trim()) throw new Error("未填 Fish API Key（在扩展设置里填自己的 key）");
        // reference_id 可选：留空则用 Fish 默认音色
    } else {
        if (!voice) throw new Error("角色卡没写音色：在角色卡描述里加 <voice>…</voice>，或在设置里填/生成 base");
        if (!(s.endpoint || "").trim()) throw new Error("未配置 endpoint");
        if (!(s.apiKey || "").trim()) throw new Error("未填 API Key（在扩展设置里填自己的 key）");
    }
    const attempt = backend === "fish" ? synthFishOnce : synthMimoOnce;
    // 任何失败(审核/429/5xx/超时/无音频…)自动重试 3 次；仍失败则抛 synthFailed，speak 提示并中断。150s 超时防卡死堵住串行队列
    let lastErr = "";
    for (let i = 1; i <= 3; i++) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 150000);
            try { return await attempt(s, voice, text, ctrl.signal); }
            finally { clearTimeout(timer); }
        } catch (e) {
            lastErr = (e && e.name === "AbortError") ? "请求超时(150s)" : String(e?.message || e);
            console.warn(`[tts-vd] 合成失败(${backend})，重试 ${i}/3：`, lastErr.slice(0, 140));
            if (i < 3) await sleep(600);
        }
    }
    const err = new Error("TTS 合成失败（已重试 3 次）：" + lastErr);
    err.synthFailed = true;   // speak 据此中断
    throw err;
}

// 串行合成队列 + 缓存：全局同时只 1 条（并发互拖慢、且流式期间会挤断回复流），结果按 后端+音色+文本 缓存
const synthCache = new Map();
let synthChain = Promise.resolve();
const SEP = String.fromCharCode(1);   // 缓存 key 分隔符（，不会出现在 backend/音色/文本里，避免拼接歧义）
function enqueueSynth(voice, text) {
    const backend = activeBackend();
    const key = backend + SEP + voice + SEP + text;
    const hit = synthCache.get(key);
    if (hit) return hit;
    const p = synthChain.then(() => synth(voice, text));
    synthChain = p.catch(() => { });
    p.catch(() => synthCache.delete(key));    // 失败不留缓存，可重试
    synthCache.set(key, p);
    return p;
}

/** 清缓存 + 回收 objectURL（换轮生成/切聊天/换后端）。URL 由缓存统一管理；连带清空 emote 标注缓存。 */
export function resetSynth() {
    for (const p of synthCache.values()) Promise.resolve(p).then((u) => { if (u) { try { URL.revokeObjectURL(u); } catch { /* noop */ } } }).catch(() => { });
    synthCache.clear();
    synthChain = Promise.resolve();
    clearEmoteCache();
}

/** 送合成队列（流式预热/播放共用）：先按需逐段加情绪标签(emote)，再串行合成。
 *  预热与播放都走这里 → 同段共享 segTagCache(标注) + synthCache(合成)，每段只标注一次、只合成一次。 */
export async function synthSeg(voice, seg) {
    return enqueueSynth(voice, await prepSeg(seg));
}
