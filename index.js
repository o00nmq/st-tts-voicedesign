/**
 * TTS VoiceDesign —— SillyTavern 客户端扩展
 * 让角色回复整段带上语音。多后端：
 *   - MiMo voicedesign：自然语言描述音色，走 ST 自带 chat-completions 代理（服务端转发，无 CORS）。
 *   - Fish Audio：reference_id 音色，走配套服务端插件 /api/plugins/tts-vd-fish/tts 转发（绕开浏览器 CORS，Fish 是二进制端点、且无 CORS 头）。
 */
import { chat, getRequestHeaders, saveSettingsDebounced } from "../../../../script.js";
import { eventSource, event_types } from "../../../events.js";
import { extension_settings, writeExtensionField } from "../../../extensions.js";
import { getContext } from "../../../st-context.js";

const NAME = "tts-voicedesign";
const OLD_NAME = "mimo-tts";                          // 旧版设置键，一次性迁移
const UI = "语音输出";                                 // toastr 标题
const FISH_PLUGIN_BASE = "/api/plugins/tts-vd-fish";  // 配套服务端插件路由（同源、无 CORS）
const FISH_PLUGIN = FISH_PLUGIN_BASE + "/tts";
// 设计取样句：让 MiMo 用「音色描述」念这段 → 拿到高质量样本音频 → 交给 Fish create-model 克隆成可复用 reference_id。
// MiMo 较慢（时长∝字数），~15s 足够（Fish 建模要 ≥10s 音频）。
const DESIGN_SAMPLE = "你好呀，很高兴认识你。今天天气真不错，我们要不要一起去公园走走，顺便聊聊最近发生的那些有趣又难忘的小事情呢？我觉得这样会很放松。";

const DEFAULTS = {
    enabled: true,
    autoplay: true,
    highlight: true,   // 朗读时高亮当前段
    emote: false,      // 自动加语气：朗读前给正文插情绪标签（仅朗读用，不改显示）
    emoteConn: "inherit",   // 加语气用哪个模型：inherit=继承主模型(generateRaw) | custom=自定义连接
    emoteEndpoint: "",
    emoteApiKey: "",
    emoteModel: "",
    emoteReasoning: "default",   // 推理强度：default(不传) | minimal | low | medium | high（仅自定义连接）
    rate: 1,        // 播放速度 0.5~2
    gap: 350,       // 段间停顿(ms)，让句子之间有停顿
    window: 2,      // 伪流式滑动窗口：同时并行合成/预取的段数
    maxSeg: 300,    // 分段上限(字)：贪心把句子攒到接近这个上限、在句号处断；越大=合成次数越少但首段越慢
    firstSeg: 0,    // 首段上限(字)：0=跟随 maxSeg；调小=首段更短、更快出第一句
    bodyTag: "scenario",    // 正文标签：留空=读整条可见正文；填如 "scenario" 则只读 <scenario>…</scenario> 里的内容
    backend: "mimo",        // TTS 后端：mimo | fish
    // 采样（两后端共用；留空=各后端服务端默认）
    temperature: "",
    topP: "",
    // MiMo 连接
    endpoint: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-tts-voicedesign",
    apiKey: "",     // 必填
    // Fish 连接
    fishEndpoint: "https://api.fish.audio",
    fishModel: "s2.1-pro-free", // 例：s2.1-pro-free | s2-pro | s1
    fishApiKey: "",             // 必填
    fishFormat: "opus",         // opus|mp3|wav（pcm 无头不便播放，不列）
    fishMp3Bitrate: "128",      // 64|128|192（仅 mp3）
    fishLatency: "normal",      // low|normal|balanced
    fishSeed: "",               // 固定音色的 seed（仅 Fish）；留空=自动生成并固定；换 seed=换音色
};

const ctx = () => getContext();

function cfg() {
    // 原地补默认值、**保持同一个对象引用**（换引用会导致设置面板改到废弃对象上、存不住）
    if (!extension_settings[NAME] || typeof extension_settings[NAME] !== "object") extension_settings[NAME] = {};
    const s = extension_settings[NAME];
    // 从旧版 mimo-tts 键一次性迁移：只补「还没设过」的键（幂等；即便新对象已被半初始化/从别处同步过来，也能补齐、且绝不覆盖用户新值）
    const old = extension_settings[OLD_NAME];
    if (old && typeof old === "object") {
        for (const k of ["enabled", "autoplay", "rate", "gap", "window", "maxSeg", "bodyTag", "endpoint", "model", "apiKey", "temperature", "topP"]) {
            if (s[k] === undefined && old[k] !== undefined) s[k] = old[k];
        }
    }
    for (const k in DEFAULTS) if (s[k] === undefined) s[k] = DEFAULTS[k];
    return s;
}

const activeBackend = () => (cfg().backend === "fish" ? "fish" : "mimo");

/** 转义正则元字符：bodyTag 是用户自由文本，直接拼进 new RegExp 会因 ( [ + 等抛 SyntaxError 卡死 TTS */
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let pendingAutoId = -1;      // MESSAGE_RECEIVED 记下新回复的 id，只给它自动播（精确匹配，避免被别的渲染吃掉）
let audioUnlocked = false;   // 首次用户手势时解锁音频自动播放（避免长时间生成后 autoplay 被浏览器拦）

// 预热时对流式文本套一遍 ST 的 AI_OUTPUT 正则，使其与最终存下的 mes 一致（缓存才命中）。guarded：拿不到就退回原文。
let _getRegexed = null;
import("../../regex/engine.js").then((m) => { if (typeof m.getRegexedString === "function") _getRegexed = m.getRegexedString; }).catch(() => { });
const REGEX_AI_OUTPUT = 2;   // regex_placement.AI_OUTPUT

// 自动管理隐藏 <tts> 的正则：启用时加进 ST 全局 regex（Only Format Display），停用时移除——用户不用手配。
const REGEX_ID = "tts-vd-cue-auto";
const OLD_REGEX_IDS = ["mimo-tts-cue-auto"];   // 迁移：清掉旧 id 的规则
function syncRegex(on) {
    try {
        if (!Array.isArray(extension_settings.regex)) extension_settings.regex = [];
        const arr = extension_settings.regex;
        for (const oldId of OLD_REGEX_IDS) { const i = arr.findIndex((r) => r && r.id === oldId); if (i !== -1) arr.splice(i, 1); }
        const idx = arr.findIndex((r) => r && r.id === REGEX_ID);
        if (on) {
            const rule = {
                id: REGEX_ID,
                scriptName: "TTS VoiceDesign 隐藏 <tts>（自动，勿手改）",
                findRegex: "/<tts>([\\s\\S]*?)<\\/tts>/g",
                replaceString: '<span class="vd-cue">$1</span>',
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
    } catch (e) { console.warn("[tts-vd] syncRegex", e); }
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

/** 读角色卡里的「音色」：MiMo=自然语言描述(data.extensions.mimo_voice_base / <voice>)；
 *  Fish=reference_id(data.extensions.fish_voice_id / <voice_id>)。data.extensions 优先，其次描述里的标签。 */
function readVoiceField(backend) {
    try {
        const c = ctx();
        const ch = c?.characters?.[c?.characterId];
        if (!ch) return "";
        const src = [ch.description, ch?.data?.description, ch?.data?.creator_notes, ch.creatorcomment].filter(Boolean).join("\n");
        if (backend === "fish") {
            const ext = ch?.data?.extensions?.fish_voice_id;
            if (ext && String(ext).trim()) return String(ext).trim();
            const m = src.match(/<voice_id>([\s\S]*?)<\/voice_id>/i);
            return m ? m[1].trim() : "";
        }
        const ext = ch?.data?.extensions?.mimo_voice_base;
        if (ext && String(ext).trim()) return String(ext).trim();
        const m = src.match(/<voice>([\s\S]*?)<\/voice>/i);
        return m ? m[1].trim() : "";
    } catch { return ""; }
}
const readBase = () => readVoiceField(activeBackend());

/** 把「已限定到正文范围」的文本清成可朗读：图片/链接去掉、标签去壳（<tts> 里的 cue 保留内联给后端当音频标签）、
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
        const om = raw.match(new RegExp("<" + reEsc(bt) + "\\b[^>]*>", "i"));
        if (!om) return "";
        raw = raw.slice(om.index + om[0].length);
        const close = raw.search(new RegExp("</" + reEsc(bt) + ">", "i"));
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
    let raw = String((chat[messageId] && chat[messageId].mes) || "");
    // 与 streamStableText 对齐：先套一遍 AI_OUTPUT 显示正则。否则流式清理(套了)与整条清理(没套)不一致 →
    // ① 补末段/整条时按字符游标切分错位（重复/漏读）；② 会念出被用户显示正则隐藏的内容（如 <think>）。
    if (_getRegexed) { try { raw = _getRegexed(raw, REGEX_AI_OUTPUT); } catch { /* noop */ } }
    const bt = (cfg().bodyTag || "").trim();
    if (bt) {
        const m = raw.match(new RegExp("<" + reEsc(bt) + "\\b[^>]*>([\\s\\S]*?)</" + reEsc(bt) + ">", "i"));
        if (m) return speakClean(m[1]);   // 有标签只念标签内；没这个标签就退回整条
    }
    return stripHidden(raw);
}

/** 分段：切句 → 贪心攒到「分段上限」CAP、在句号断，各段大小一致。兜底：单句超 CAP→逗号切→硬切。CAP=设置 maxSeg */
function splitSentences(text, maxLen, firstLen) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) return [];
    const CAP = Math.max(20, Math.min(2000, Number(maxLen ?? cfg().maxSeg) || 300));
    const F = Number(firstLen ?? cfg().firstSeg) || 0;
    const FIRST = F > 0 ? Math.max(20, F) : CAP;   // 首段上限（独立于分段上限）；0=跟随分段上限。注意：仍在句子边界处断，不会超过上限，也可能因下一句放不下而不足上限
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
    let buf = "", cap = FIRST;   // 首段用 FIRST，出第一段后切回 CAP（前缀仍稳定，流式下标发段不受影响）
    for (const u of units) {
        if (buf && (buf + u).length > cap) { out.push(buf); buf = u; cap = CAP; }   // 攒到接近上限再断
        else buf += u;
    }
    if (buf) out.push(buf);
    return out;
}

// ── 合成：按后端分派，外层统一重试 3 次 + 150s 超时 ──
async function synth(voice, text) {
    const s = cfg();
    const backend = activeBackend();
    if (!text) throw new Error("没有可朗读的文本");
    if (backend === "fish") {
        if (!(s.fishApiKey || "").trim()) throw new Error("未填 Fish API Key（在扩展设置里填自己的 key）");
        // reference_id 可选：留空则用 Fish 默认音色（由 seed 固定）
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

/** base64 编码字节（分块，避免大数组 spread 爆栈） */
function bytesToBase64(arr) {
    let bin = ""; const CH = 0x8000;
    for (let i = 0; i < arr.length; i += CH) bin += String.fromCharCode.apply(null, arr.subarray(i, i + CH));
    return btoa(bin);
}

/** 调 MiMo（ST chat-completions 代理，openai 源 + reverse_proxy + 填的 key）合成音频，返回原始字节 Uint8Array。
 *  MiMo 播放 & Fish「设计」取样共用；voicedesign 从 voice 描述现捏音色，音频在 message.audio.data。 */
async function mimoAudioBytes(s, voice, text, signal) {
    const url = (s.endpoint || "").replace(/\/+$/, "");
    const key = (s.apiKey || "").trim();
    if (!url) throw new Error("未配置 MiMo endpoint");
    if (!key) throw new Error("未填 MiMo API Key");
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
    const resp = await fetch("/api/backends/chat-completions/generate", {
        method: "POST", headers: getRequestHeaders(), body: JSON.stringify(body), signal,
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status + "：" + (await resp.text().catch(() => "")).slice(0, 160));
    const json = await resp.json();
    const choice = json?.choices?.[0];
    const b64 = choice?.message?.audio?.data;
    if (b64) {
        const bin = atob(b64); const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
    }
    const reason = choice?.finish_reason || "";
    const note = String(choice?.message?.content || "");
    if (reason === "content_filter" || /rejected|high[\s_-]?risk|风险|审核|content[\s_-]?filter/i.test(note)) {
        throw new Error("内容被安全审核拦截：" + (note || "content_filter"));
    }
    throw new Error("响应无音频：" + JSON.stringify(json).slice(0, 140));
}

/** MiMo 合成 → objectURL（播放用） */
async function synthMimoOnce(s, voice, text, signal) {
    const arr = await mimoAudioBytes(s, voice, text, signal);
    return URL.createObjectURL(new Blob([arr], { type: sniffMime(arr) }));
}

/** Fish seed：可选。留空=不发送（用 Fish 默认）。音色由 reference_id 固定，故不再自动生成。 */
function fishSeedOrEmpty() {
    const seed = String(cfg().fishSeed ?? "").trim();
    return (seed && !Number.isNaN(Number(seed))) ? seed : "";
}

/** Fish：POST 配套服务端插件（同源，绕 CORS），插件用 Bearer key 转发到 api.fish.audio/v1/tts，回传二进制音频。
 *  分段合成（每段一次调用，reference_id 固定 → 段间音色一致，边生成边播）；reference_id 可选（留空=默认音色）；seed 可选。 */
async function synthFishOnce(s, voice, text, signal) {
    const fmt = s.fishFormat || "opus";
    const body = {
        endpoint: (s.fishEndpoint || "https://api.fish.audio").trim(),
        apiKey: (s.fishApiKey || "").trim(),
        model: s.fishModel || "s2.1-pro-free",
        text,
        format: fmt,
        latency: s.fishLatency || "normal",
    };
    if (voice) body.reference_id = voice;                        // 可选：留空用 Fish 默认音色
    if (fmt === "mp3") body.mp3_bitrate = Number(s.fishMp3Bitrate || 128);
    // 采样：Fish 值域 0~1；填了才带
    if (s.temperature !== "" && s.temperature != null && !Number.isNaN(Number(s.temperature))) body.temperature = Math.max(0, Math.min(1, Number(s.temperature)));
    if (s.topP !== "" && s.topP != null && !Number.isNaN(Number(s.topP))) body.top_p = Math.max(0, Math.min(1, Number(s.topP)));
    const seed = fishSeedOrEmpty();
    if (seed) body.seed = Number(seed);   // 可选；留空=不发送（Fish 默认）
    let resp;
    try {
        resp = await fetch(FISH_PLUGIN, { method: "POST", headers: getRequestHeaders(), body: JSON.stringify(body), signal });
    } catch (e) {
        if (e && e.name === "AbortError") throw e;
        throw new Error("连不上 Fish 服务端插件：" + String(e?.message || e));
    }
    if (resp.status === 404) throw new Error("Fish 服务端插件未装/未启用：把仓库 plugin/ 放到 ST 的 plugins/tts-vd-fish/，config.yaml 开 enableServerPlugins，重启 ST");
    if (!resp.ok) {
        let detail = "";
        try { const j = await resp.clone().json(); detail = j?.error || JSON.stringify(j); }
        catch { detail = await resp.text().catch(() => ""); }
        throw new Error("Fish HTTP " + resp.status + "：" + String(detail).slice(0, 200));
    }
    const arr = new Uint8Array(await resp.arrayBuffer());
    if (!arr.length) throw new Error("Fish 返回空音频");
    return URL.createObjectURL(new Blob([arr], { type: sniffMime(arr) }));
}

/** POST 一个 JSON 到 Fish 插件的某路由（create-model），解析 JSON 返回；错误抛可读信息 */
async function fishPluginJson(path, payload) {
    const resp = await fetch(FISH_PLUGIN_BASE + "/" + path, { method: "POST", headers: getRequestHeaders(), body: JSON.stringify(payload) });
    if (resp.status === 404) throw new Error("Fish 服务端插件未装/未启用（把 plugin/ 装到 ST 的 plugins/tts-vd-fish/、开 enableServerPlugins、重启）");
    const txt = await resp.text();
    let json = null; try { json = txt ? JSON.parse(txt) : null; } catch { /* noop */ }
    if (!resp.ok) throw new Error(String((json && (json.error || json.message)) || txt || ("HTTP " + resp.status)).slice(0, 200));
    return json;
}

// ── 自动加语气（可选，非流式）：朗读前先在【整条正文】上做一次标注 ──
// ① keep 切出真正要读的正文，剔掉主模型夹带进来的 CoT/状态栏等（避免被读出来）；② inserts 拿到情绪标签。
// 顺序：整条正文 → 标注(切正文+拿标签) → 按分段上限切段 → 每段就地插标签（标签不占字数额度）。
// 必须整条一起看才能可靠区分正文/CoT，所以 emote 下不边生成边播（等整段生成完，与设置里的说明一致）。
const emoteCache = new Map();   // 干净正文全文 → {body, inserts}（同一条不重复标注；改 emote 设置时清）
let tagChain = Promise.resolve();   // 标注串行化，避免瞬间并发打爆情绪模型
// 情绪标注 system 提示：静态常量（可命中缓存）；变量正文只进 user prompt。
// 模型返回的是「插入指令」而非重述全文——扩展把标签插进逐字原文，模型碰不到正文本身（不会被改写），也省 token。
const EMOTE_SYS = `你是 TTS 语音表演标注助手。你会收到一段从角色扮演回复里粗取的文本（可能夹带非正文，如泄漏进来的思考/CoT）。你【绝不改动、绝不重述原文】，只返回一份 JSON 指令，由外部程序在【逐字原文】上执行：① keep 圈出真正要朗读的正文范围（把夹带的 CoT/非正文排除在外）；② inserts 在正文里插入情绪/语气/演绎标签。

严格只输出一个 JSON，无解释、无 Markdown、无代码块、无多余字符，格式为：
{"keep":[{"from":"…","to":"…"}],"inserts":[{"quote":"…","tag":"[中文]"}]}
不要输出正文本身，不要写任何对标注无意义的内容。

【定位铁律（最重要）】
所有 from / to / quote 都必须是原文里【一字不差、能原样搜到】的连续片段——程序用 indexOf 在逐字原文中定位，找不到就整条丢弃。因此：
· 逐字照抄，包括其中的标点、空格、省略号、特殊符号；不要补字、改字、改标点、加省略号。
· 片段必须【唯一可定位】：不要选在全文中会重复出现的太短或太通用的片段（如单独的"她""是的""好的""嗯"或常见短语）。若某处措辞短或会重复，就向左右多带几个字，直到这一小段在全文中只出现一次。各片段一般 4~10 字为宜。
· quote 要精确落在它所标注的那句/那处上，不要跨句、不要过长。

【keep —— 用 from/to 圈出正文"从哪到哪"（最关键：别把 CoT 读出来，也别丢正文）】
正文 = 叙述 + 对白（含引号内台词）。用若干范围圈定：每个范围给 from（该段正文开头处的原文）与 to（该段正文结尾处的原文），程序会保留 from 到 to（含两端）之间的全部原文。
排除在 keep 之外的非正文：思考/CoT（如"让我想想""接下来我要…""分析：…"这类作者自述）、状态栏、面板、数值/属性/变量、分析与总结、<!--注释-->、系统标记、HTML/XML 标签、选项菜单、给玩家的操作提示或旁白指令。
铁则：keep 只做"排除夹带的非正文"，【绝不】把真正的叙述/对白也切掉——凡是拿不准是不是正文的，一律【当正文保留】。宁可多读一点，也不要漏读正文。
拆分规则：只有当正文被非正文从中间【实际打断】时，才拆成多个范围，跳过夹在中间的非正文。若两段正文之间没有任何非正文夹隔（即使换行、空行、话题转换），它们是连续可读正文，必须合并为一个范围，不要拆分。整段都是正文时用一个"从开头到结尾"的范围。若通篇没有可朗读正文，keep 返回空数组。

【inserts —— 加情绪/语气/演绎，重放置、更克制】
每条：quote = 正文里一字不差、唯一可定位的一小段；tag = 一个【方括号 + 中文】标签（复合含义用中文逗号分隔、同一处 ≤3 个词）。程序会把 tag 插到 quote 正前面，所以 quote 要精确落在你想让标签生效的位置。

放置规则（按标签类型选 quote 落点）：
· [情绪]（委屈/无奈/愤怒/紧张/讽刺/欣喜/冷淡…）：quote 取该句开头几字，让整句带上这种情绪。
· [语气]（小声/耳语/急促/喊叫/撒娇/命令…）与 [声音/音效]（叹气/冷笑/哽咽/颤抖/气声/轻笑…）：quote 精确取其实际作用处的字（叹气声出现处、语气转变处），不要笼统放句首。
· [停顿]（[短停顿]/[停顿]/[长停顿]）：quote 取停顿后紧接的那几字，使停顿落在其之前。
以上示例词非穷举，可按语境换用更贴切的中文；只标情绪/语气/演绎，不标音色/性别/方言/唱腔。

密度与克制（务必遵守）：
· 一处发声只标一次：叙述引出紧随其后的台词时，情绪/语气只标一次，放在台词前——【绝不】在描写句和台词上各标一遍。若叙述已含表达方式的说明（如"柔声道""冷笑着说""声音发颤"），说明该词已交代语气，就不要在它上面再加语气/音效标签，把标签只落到它引出的台词上。
· 不要给"描写角色说话状态"的叙述句（如"她的声音有点抖""语气很冷"）单独打语音标签——那会让旁白声线跟着变；把该演绎交给相邻的台词，标在台词上。
· 只在真有情绪或演绎的地方标；纯客观叙述、过场、环境描写、事务性对白一律不标。
· 一句通常至多 1 个整句情绪标签；连续多句不要句句都标，不要在相邻位置重复同一类标签；单条正文标签总数宜克制（≤3 处）。
· 拿不准、或该处并无明显演绎价值时，就不标。宁少勿滥。

示例1（整段正文，一段 keep；语气落在台词、不双标）：
输入：她攥紧了衣角，声音发颤："你……真的要走吗？别丢下我。"
输出：{"keep":[{"from":"她攥紧了衣角","to":"别丢下我。"}],"inserts":[{"quote":"你……真的","tag":"[委屈]"},{"quote":"别丢下我","tag":"[哽咽，颤抖]"}]}

示例2（夹带 CoT/非正文，keep 跳过、拆多段）：
输入：<!--先描写环境再进对话-->好，我先渲染月光。月光洒进屋子。【好感度+5】【HP:80/100】"你终于回来了！"她猛地站起来。
输出：{"keep":[{"from":"月光洒进屋子","to":"月光洒进屋子。"},{"from":"你终于回来了","to":"她猛地站起来。"}],"inserts":[{"quote":"你终于回来","tag":"[惊喜，急促]"}]}

示例3（客观叙述，克制不滥标）：
输入：清晨的市场很热闹。他停下脚步，低声嘟囔："又涨价了。"
输出：{"keep":[{"from":"清晨的市场","to":"又涨价了。"}],"inserts":[{"quote":"又涨价了","tag":"[无奈，小声]"}]}`;

/** 加语气的一次补全：自定义连接走 ST chat 代理（可设 endpoint/model/推理强度），否则继承主模型 generateRaw。
 *  两条路都用固定 EMOTE_SYS 作 system（利于缓存）、变量正文放 user 侧。 */
async function emoteComplete(user, respLen) {
    const s = cfg();
    if (s.emoteConn === "custom" && (s.emoteEndpoint || "").trim() && (s.emoteModel || "").trim()) {
        const body = {
            chat_completion_source: "openai",
            reverse_proxy: (s.emoteEndpoint || "").trim().replace(/\/+$/, ""),
            proxy_password: (s.emoteApiKey || "").trim(),
            model: (s.emoteModel || "").trim(),
            messages: [{ role: "system", content: EMOTE_SYS }, { role: "user", content: user }],
            stream: false, max_tokens: respLen,
        };
        if (s.emoteReasoning && s.emoteReasoning !== "default") body.reasoning_effort = s.emoteReasoning;
        // 120s 超时：自定义 endpoint 若无响应会让本次标注永不 settle → 卡死 tagChain → 之后所有加语气都排队等死
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120000);
        let resp;
        try { resp = await fetch("/api/backends/chat-completions/generate", { method: "POST", headers: getRequestHeaders(), body: JSON.stringify(body), signal: ctrl.signal }); }
        finally { clearTimeout(timer); }
        if (!resp.ok) throw new Error("加语气模型 HTTP " + resp.status + "：" + (await resp.text().catch(() => "")).slice(0, 160));
        const json = await resp.json();
        return String(json?.choices?.[0]?.message?.content || "");
    }
    return String(await getContext().generateRaw({ prompt: user, systemPrompt: EMOTE_SYS, responseLength: respLen }) || "");
}

/** 把模型给的插入指令 [{quote,tag}] 应用到逐字原文 canvas：按原文顺序定位 quote，在其前插入 tag。
 *  只插入、绝不改字；定位不到就跳过；只接受 [中文] 形式的标签。 */
function applyInserts(canvas, inserts) {
    const points = []; let scan = 0;
    for (const ins of (Array.isArray(inserts) ? inserts : [])) {
        if (!ins || typeof ins.quote !== "string" || typeof ins.tag !== "string") continue;
        const tag = ins.tag.trim();
        if (!/^\[[^\]\n]{1,40}\]$/.test(tag)) continue;
        const q = ins.quote.trim();
        if (!q) continue;
        let pos = canvas.indexOf(q, scan);
        if (pos === -1) pos = canvas.indexOf(q);
        if (pos === -1) continue;
        points.push({ pos, tag });
        scan = pos + q.length;
    }
    points.sort((a, b) => a.pos - b.pos);
    let res = canvas;
    for (let i = points.length - 1; i >= 0; i--) res = res.slice(0, points[i].pos) + points[i].tag + res.slice(points[i].pos);
    return res;
}

/** 生成「取第 i 段的可合成文本」的函数：把每个 insert 按其 quote 落在哪一段，分配到【唯一一段】（按正文顺序、每个用一次），
 *  段内再用 applyInserts 插标签——避免同一 quote 在多段各命中一次（跨段重复插标签）。inserts 为空则原样返回干净段。 */
function buildSpeakOf(parts, inserts) {
    if (!Array.isArray(inserts) || !inserts.length) return (i) => parts[i];
    const segIns = parts.map(() => []);
    let segCursor = 0;   // 按正文顺序分配，避免靠前的段抢走靠后段里重复出现的 quote
    for (const ins of inserts) {
        if (!ins || typeof ins.quote !== "string") continue;
        const q = ins.quote.trim(); if (!q) continue;
        let si = -1;
        for (let i = segCursor; i < parts.length; i++) if (parts[i].indexOf(q) !== -1) { si = i; break; }
        if (si === -1) for (let i = 0; i < segCursor; i++) if (parts[i].indexOf(q) !== -1) { si = i; break; }
        if (si === -1) continue;
        segIns[si].push(ins); segCursor = si;
    }
    return (i) => (segIns[i].length ? applyInserts(parts[i], segIns[i]) : parts[i]);
}

/** 按 keep 范围 [{from,to}] 从整条正文切出真正要读的正文（多段用换行拼接，跳过夹在中间的 CoT/非正文）；圈不出返回空串（上层兜底整段） */
function sliceKeep(canvas, keep) {
    if (!Array.isArray(keep) || !keep.length) return "";
    const spans = []; let scan = 0;
    for (const k of keep) {
        if (!k || typeof k.from !== "string" || typeof k.to !== "string") continue;
        const f = k.from.trim(), t = k.to.trim();
        if (!f || !t) continue;
        let a = canvas.indexOf(f, scan); if (a === -1) a = canvas.indexOf(f); if (a === -1) continue;
        const b = canvas.indexOf(t, a); if (b === -1) continue;
        spans.push(canvas.slice(a, b + t.length));
        scan = b + t.length;
    }
    return spans.join("\n");
}

/** 在【整条正文】上标注一次：keep 切出正文(剔除夹带的 CoT/非正文)、inserts 拿情绪标签指令。
 *  ⚠️ 只在整条上做、不逐段做：整条一起看才能可靠区分正文 vs CoT，也保证之后分段的字数上限准确。
 *  返回 {body, inserts}：body=要朗读的正文（keep 圈不出/解析失败 → 整段兜底，绝不丢内容），inserts=标签指令数组。 */
/** 从模型输出里抠出第一个「花括号配平」的 JSON 对象（跳过夹带的解释/多个块、正确处理字符串内的括号）。
 *  比贪婪 /\{[\s\S]*\}/ 稳：贪婪版从第一个 { 吃到最后一个 } → 混进散文里的花括号或第二个块 → 整体解析失败、静默丢标注。 */
function extractJsonObject(str) {
    const start = str.indexOf("{");
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < str.length; i++) {
        const c = str[i];
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") { if (--depth === 0) return str.slice(start, i + 1); }
    }
    return null;
}

async function annotateEmotion(canvas) {
    const user = "文本如下。按 system 规则返回 {keep, inserts} JSON（from/to/quote 都必须是文本里一字不差的片段）：\n\n" + canvas;
    const respLen = Math.min(4096, Math.max(512, Math.ceil(canvas.length / 2) + 256));
    let raw = (await emoteComplete(user, respLen)).trim();
    raw = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
    let obj;
    try { obj = JSON.parse(raw); }
    catch { const m = extractJsonObject(raw); try { obj = m ? JSON.parse(m) : null; } catch { obj = null; } }
    if (!obj || typeof obj !== "object") return { body: canvas, inserts: [] };
    const body = sliceKeep(canvas, obj.keep) || canvas;   // 圈不出正文 → 整段兜底（绝不空、绝不丢内容）
    return { body, inserts: Array.isArray(obj.inserts) ? obj.inserts : [] };
}

/** 朗读一条：把干净正文交给 speak（分段在干净文本上做→字数准确；emote 开则逐段加标签） */
function playMessage(mesId, voice) {
    speak(mesId, voice, getSpeakText(mesId));
}

// 串行合成队列 + 缓存：全局同时只 1 条（并发互拖慢、且流式期间会挤断回复流），结果按 后端+音色+文本 缓存
const synthCache = new Map();
let synthChain = Promise.resolve();
function enqueueSynth(voice, text) {
    const backend = activeBackend();
    const seedPart = backend === "fish" ? fishSeedOrEmpty() : "";   // Fish: seed 进 key（留空也算一种）
    const key = backend + "\u0001" + voice + "\u0001" + text + "\u0001" + seedPart;
    const hit = synthCache.get(key);
    if (hit) return hit;
    const p = synthChain.then(() => synth(voice, text));
    synthChain = p.catch(() => { });
    p.catch(() => synthCache.delete(key));    // 失败不留缓存，可重试
    synthCache.set(key, p);
    return p;
}
/** 清缓存 + 回收 objectURL（换轮生成/切聊天/换后端）。URL 由缓存统一管理 */
function resetSynth() {
    for (const p of synthCache.values()) Promise.resolve(p).then((u) => { if (u) { try { URL.revokeObjectURL(u); } catch { /* noop */ } } }).catch(() => { });
    synthCache.clear();
    synthChain = Promise.resolve();
    emoteCache.clear();
    tagChain = Promise.resolve();
}
/** emote 开时：在【整条正文】上标注一次，返回 {body, inserts}；串行 + 按整条缓存；失败退回整段（绝不丢内容）。
 *  emote 关：直接返回 {body: 原文, inserts: []}。 */
function emoteBody(clean) {
    if (!cfg().emote || !clean) return Promise.resolve({ body: clean, inserts: [] });
    let p = emoteCache.get(clean);
    if (!p) {
        p = tagChain.then(() => annotateEmotion(clean)).catch(() => ({ body: clean, inserts: [] }));
        tagChain = p.catch(() => { });
        emoteCache.set(clean, p);
    }
    return p;
}
/** 送合成队列（流式预热/播放共用）。流式仅非 emote → 段是干净文本，无需加标签 */
function synthSeg(voice, seg) {
    return enqueueSynth(voice, seg);
}
// ── 播放引擎（可打断）──
let sessionToken = 0;      // 开播/打断自增，旧会话据此作废
let currentAudio = null;
let curResolve = null;
let playingMesId = null;
let _streamCoalesce = null;   // 流式分段合并定时器：把每-token 的全量重切降频到 ~200ms（见 STREAM_TOKEN_RECEIVED）
let _streamLastFull = "";     // 最近一次 STREAM_TOKEN 的全量文本（合并处理时读）

const boxOf = (mesId) => $(`#chat .mes[mesid="${mesId}"] .vd-tts-box`);
function fmtRate(r) { return (Math.round(r * 100) / 100).toString().replace(/(\.\d)0$/, "$1") + "×"; }
/** 缓冲/进度显示 */
function setStatus(mesId, text) { boxOf(mesId).find(".vd-status").text(text || ""); }
/** 实时改倍速：立刻作用到正在放的音频，同步所有倍速控件+设置面板，并持久化 */
function applyRate(r) {
    r = Math.max(0.5, Math.min(2, Number(r) || 1));
    cfg().rate = r;
    if (currentAudio) { try { currentAudio.playbackRate = r; } catch { /* noop */ } }
    $(".vd-tts-box .vd-rate").val(r);
    $(".vd-tts-box .vd-rate-val").text(fmtRate(r));
    $("#vd_rate").val(r); $("#vd_rate_val").text(r.toFixed(2) + "×");
    saveSettingsDebounced();
}

/** 开关「新回复自动播放」：同步所有消息上的按钮 + 设置面板，并持久化 */
function setAutoplay(on) {
    cfg().autoplay = !!on;
    $(".vd-tts-box .vd-auto-btn").toggleClass("on", !!on);
    $("#vd_autoplay").prop("checked", !!on);
    saveSettingsDebounced();
    if (window.toastr) toastr.info("新回复自动播放：" + (on ? "开" : "关"), UI, { timeOut: 1200 });
}

/** 开关「高亮当前朗读段」：同步所有消息上的按钮 + 设置面板，并持久化；关时清掉现有高亮 */
function setHighlight(on) {
    cfg().highlight = !!on;
    $(".vd-tts-box .vd-hl-btn").toggleClass("on", !!on);
    $("#vd_highlight").prop("checked", !!on);
    if (!on) clearHighlight();
    saveSettingsDebounced();
    if (window.toastr) toastr.info("高亮当前朗读段：" + (on ? "开" : "关"), UI, { timeOut: 1200 });
}

let playbackPaused = false;
function markBtn(mesId, playing) {
    const $box = boxOf(mesId); if (!$box.length) return;
    $box.toggleClass("playing", !!playing);              // 播放时 CSS 展开倍速滑条+进度
    const $b = $box.find("button.vd-tts-btn");
    $b.find("i").attr("class", playing ? "fa-solid fa-pause" : "fa-solid fa-volume-high");
    $b.attr("title", playing ? "暂停" : "朗读本条");
    if (!playing) $box.find(".vd-status").text("");
}
/** 暂停/继续（不终止）：暂停正在放的音频 + 卡住播放循环，图标切换 ⏸/▶ */
function togglePause(mesId) {
    playbackPaused = !playbackPaused;
    if (currentAudio) { try { playbackPaused ? currentAudio.pause() : currentAudio.play().catch(() => { }); } catch { /* noop */ } }
    const $b = boxOf(mesId).find("button.vd-tts-btn");
    $b.find("i").attr("class", playbackPaused ? "fa-solid fa-play" : "fa-solid fa-pause");
    $b.attr("title", playbackPaused ? "继续" : "暂停");
}
const waitWhilePaused = async (my) => { while (playbackPaused && my === sessionToken) await sleep(100); };

/** 打断当前播放：作废会话、停掉在放的音频、解开等待 */
function stopPlayback() {
    sessionToken++; playbackPaused = false;
    if (_streamCoalesce) { clearTimeout(_streamCoalesce); _streamCoalesce = null; }   // 取消待处理的流式分段合并（打断/换轮/停生成）
    if (currentAudio) { try { currentAudio.pause(); } catch { /* noop */ } currentAudio = null; }
    if (curResolve) { const r = curResolve; curResolve = null; r(); }
    if (playingMesId != null) { markBtn(playingMesId, false); playingMesId = null; }
    clearHighlight();
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

// ── 朗读高亮：CSS Custom Highlight API（非侵入，不改 DOM，避免和 ST 重渲染打架）；不支持则静默降级 ──
const HL_NAME = "vd-reading";
const hlSupported = (typeof Highlight !== "undefined") && (typeof CSS !== "undefined") && !!CSS.highlights;
let hlMesId = null, hlCursor = 0;   // 当前高亮所在消息 + 该消息内匹配游标（处理重复段）
function clearHighlight() {
    if (hlSupported) { try { CSS.highlights.delete(HL_NAME); } catch { /* noop */ } }
    hlMesId = null; hlCursor = 0;
}
/** 在消息正文 DOM 里定位 segText 并高亮当前朗读段；找不到/不支持就跳过（不影响播放）。
 *  规范化只保留「字母/数字/汉字」，丢掉空白+所有标点——因为段文本来自【原文】清理，而 DOM 是【渲染后】文本，
 *  markdown 排版会做印刷体替换（... → …、直引号 → 弯引号、-- → — 等），只去空白仍会匹配不到；按字骨架比对才稳。 */
const HL_KEEP = /[\p{L}\p{N}]/u;   // 参与匹配的字符：字母/数字/汉字（丢标点，避开印刷体差异）
function highlightSegment(mesId, segText) {
    if (!hlSupported || !cfg().highlight) return;
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_text`);
    if (!el) return;
    if (mesId !== hlMesId) { hlMesId = mesId; hlCursor = 0; }   // 换消息 → 游标归零
    const nodes = []; let full = "";
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { nodes.push({ node: n, start: full.length }); full += n.nodeValue; }
    if (!full) return;
    // 字骨架规范串 + 规范index→原始index 映射（对齐「原文清理」的段文本 vs「渲染后」的 DOM 文本）
    const map = []; let norm = "";
    for (let i = 0; i < full.length; i++) if (HL_KEEP.test(full[i])) { norm += full[i]; map.push(i); }
    const segNorm = String(segText || "").replace(/[^\p{L}\p{N}]/gu, "");   // 取字骨架：丢空白+标点（避开印刷体差异）。高亮拿到的是干净段、本就不含 emote 标签，故不再剥 [..]（否则会误删正文里的 ASCII 方括号→匹配不上）
    if (!segNorm) return;
    let at = norm.indexOf(segNorm, hlCursor);
    if (at === -1) at = norm.indexOf(segNorm);      // 游标之后找不到 → 从头找
    if (at === -1) { try { CSS.highlights.delete(HL_NAME); } catch { /* noop */ } return; }   // 匹配不到（cue/隐藏块夹断等）→ 清掉旧高亮
    hlCursor = at + segNorm.length;
    const oStart = map[at], oEnd = map[at + segNorm.length - 1] + 1;
    const locate = (pos) => {
        for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].start <= pos) return { node: nodes[i].node, offset: pos - nodes[i].start };
        return { node: nodes[0].node, offset: 0 };
    };
    try {
        const a = locate(oStart), b = locate(oEnd);
        const r = document.createRange();
        r.setStart(a.node, Math.min(a.offset, a.node.nodeValue.length));
        r.setEnd(b.node, Math.min(b.offset, b.node.nodeValue.length));
        CSS.highlights.set(HL_NAME, new Highlight(r));
    } catch { /* noop */ }
}

/** 按序播放；合成走串行队列(enqueueSynth)——同时只 1 条在飞，播前面时把后面 W 段先塞进队列排队(流水线)。
 *  emote 开：先在整条正文上标注一次 → 切出正文(去 CoT)、拿标签 → 再分段（字数上限准确）→ 每段就地插标签。 */
async function speak(mesId, voice, text) {
    stopPlayback();
    if (!text || (activeBackend() === "mimo" && !voice)) return;   // Fish：voice 可空（默认音色）
    const my = ++sessionToken;
    playingMesId = mesId; markBtn(mesId, true);
    // emote：整条正文标注一次（切正文去 CoT + 拿标签）。会阻塞到模型返回——emote 本就不流式。
    let body = text, inserts = [];
    if (cfg().emote) {
        setStatus(mesId, "正文分析…");
        try { const a = await emoteBody(text); body = a.body; inserts = a.inserts; } catch { /* 兜底整段 */ }
        if (my !== sessionToken) return;                    // 分析期间被打断/换轮
    }
    const parts = splitSentences(body);   // 在「去 CoT 后的正文」上分段（Fish 用固定 reference_id → 段间音色一致）
    if (!parts.length) { if (my === sessionToken) { playingMesId = null; markBtn(mesId, false); } return; }
    const s = cfg();
    const W = Math.max(1, Math.min(8, Number(s.window) || 3));      // 预取深度：提前排队的段数（队列仍串行）
    const gap = Math.max(0, Math.min(3000, Number(s.gap) || 0));    // 段间停顿
    const N = parts.length;
    const speakOf = buildSpeakOf(parts, inserts);   // 就地插标签（不占字数额度、只供合成）：每个标签只落到它所属的那一段
    const start = (i) => { if (i < N) enqueueSynth(voice, speakOf(i)).catch(() => { }); };   // 入队；缓存去重
    for (let i = 0; i < W; i++) start(i);      // 预取窗口
    for (let i = 0; i < N; i++) {
        if (my !== sessionToken) break;
        let url;
        try {
            setStatus(mesId, `缓冲 ${i + 1}/${N}`);          // 合成/缓冲中（命中缓存的话一闪而过）
            url = await enqueueSynth(voice, speakOf(i));   // 命中缓存则秒回（0 等待）
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

async function processMessage(messageId, allowAutoplay) {
    const s = cfg();
    if (!s.enabled) return;
    const msg = chat[messageId];
    if (!msg || msg.is_user || msg.is_system) return;
    const $block = $(`#chat .mes[mesid="${messageId}"] .mes_block`);
    if (!$block.length) return;

    // 每条消息注入一个播放器（播放/停止 + 自动播放开关 + 实时倍速 + 缓冲进度）（幂等）
    if (!$block.children(".vd-tts-box").length) {
        const r0 = Math.max(0.5, Math.min(2, Number(cfg().rate) || 1));
        const $box = $(`<div class="vd-tts-box"><div class="vd-tts-bar">
            <button class="vd-tts-btn menu_button" title="朗读本条"><i class="fa-solid fa-volume-high"></i></button>
            <button class="vd-auto-btn menu_button" title="新回复自动播放（点击开/关）"><i class="fa-solid fa-wand-sparkles"></i></button>
            <button class="vd-hl-btn menu_button" title="高亮当前朗读段（点击开/关）"><i class="fa-solid fa-highlighter"></i></button>
            <span class="vd-player">
                <i class="fa-solid fa-gauge-high vd-rate-ico" title="播放速度"></i>
                <input type="range" class="vd-rate" min="0.5" max="2" step="0.05" value="${r0}" title="播放速度（实时）">
                <span class="vd-rate-val">${fmtRate(r0)}</span>
                <span class="vd-status"></span>
            </span>
        </div></div>`);
        $block.append($box);
        $box.find(".vd-tts-btn").on("click", () => {
            if (playingMesId === messageId) { togglePause(messageId); return; }   // 再点 = 暂停/继续
            const voice = readBase();
            if (!voice && activeBackend() === "mimo") {
                if (window.toastr) toastr.warning("角色卡未设音色（加 <voice> 或用扩展里“让角色生成音色”）", UI);
                return;
            }
            playMessage(messageId, voice);   // emote 开则先加语气再播；Fish：voice 可空（默认音色）
        });
        $box.find(".vd-auto-btn").on("click", () => setAutoplay(!cfg().autoplay));
        $box.find(".vd-hl-btn").on("click", () => setHighlight(!cfg().highlight));
        $box.find(".vd-rate").on("input", function () { applyRate(this.value); });
        updateShift();   // 量并写入居中偏移
    }
    // 自动播放/高亮按钮状态跟随当前设置（可能在别处被改）
    $block.children(".vd-tts-box").find(".vd-auto-btn").toggleClass("on", !!s.autoplay);
    $block.children(".vd-tts-box").find(".vd-hl-btn").toggleClass("on", !!s.highlight);

    if (allowAutoplay && s.autoplay) {
        const voice = readBase();
        if (!voice && activeBackend() === "mimo") { console.warn("[tts-vd] 角色卡未设音色，跳过自动播放"); return; }
        playMessage(messageId, voice);   // emote 开则先加语气再播；Fish：voice 可空（默认音色）
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
let streamOn = false;           // 本轮是否边生成边播（仅 MiMo）
let streamSegs = [];            // 有序段列表（生成中不断追加）
let streamDone = false;         // 本轮文本是否生成完
let streamMesId = null;         // 本轮回复的消息 id（结束时确定）
let streamErrShown = false;     // 本轮流式已弹过一次错误提示（避免每段刷屏，但持续失败不再全程静默）

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
        try { url = await enqueueSynth(streamVoice, seg); }
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

// 用「首个 STREAM_TOKEN」判定真·生成开始——dryRun 不可靠（本机真回复的 GENERATION_STARTED 也是 dryRun:true），
// 而干跑不产 token。首个 token 才停旧播放、清缓存、武装流式播放；生成结束后重置，等下一轮。
let streamArmed = false;
function armStream() {
    stopPlayback(); resetSynth();
    streamSegs = []; streamDone = false; streamMesId = null;
    streamOn = false; streamVoice = ""; streamErrShown = false;
    const s = cfg();
    // 边生成边分段播：首句最早出声。Fish 用固定 reference_id → 段间音色一致、无漂移。
    // emote 开【不流式】：要整条一起看才能切正文/去 CoT，改由 CHARACTER_MESSAGE_RENDERED 走 speak 整条处理。
    if (s.enabled && s.autoplay && !s.emote) {
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
eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (full) => {
    if (!streamArmed) { streamArmed = true; armStream(); }   // 本轮首个 token = 真生成
    if (!streamOn) return;
    _streamLastFull = String(full || "");
    // 每-token 都全量重切是 O(n) → 整条 O(n²)（长回复卡顿、挤占流式渲染）。合并到最多每 ~200ms 一次：
    // 只影响封口段「何时入队」（最多晚 ~200ms ≪ 合成耗时），且结束时 CHARACTER_MESSAGE_RENDERED 会按权威切分补齐、绝不丢段。
    if (!_streamCoalesce) _streamCoalesce = setTimeout(() => { _streamCoalesce = null; pumpStreamSegments(); }, 200);
});

// ── 事件 ──
eventSource.on(event_types.MESSAGE_RECEIVED, (id) => { pendingAutoId = id; });
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
    const auto = (id === pendingAutoId); if (auto) pendingAutoId = -1;
    if (auto && streamOn) {
        processMessage(id, false);   // 注入按钮；播放由正在跑的 streamPlay 接手
        streamMesId = id;
        // 用最终权威切分补齐：按【字符游标】把还没入队的「尾部」段追加，保证整条正文都被朗读（不漏中间/末段）
        const finalParts = splitSentences(getSpeakText(id));
        const emittedLen = streamSegs.reduce((n, seg) => n + seg.length, 0);
        let cum = 0;
        for (const seg of finalParts) {
            const end = cum + seg.length;
            if (end > emittedLen) { streamSegs.push(seg); synthSeg(streamVoice, seg).catch(() => { }); }
            cum = end;
        }
        streamDone = true;
    } else {
        processMessage(id, auto);    // 无流式自动播时的兜底：按钮 +（auto 则 speak）
    }
    streamArmed = false;             // 本轮结束，下一轮首 token 再武装
});
eventSource.on(event_types.MESSAGE_SWIPED, (id) => { emoteCache.clear(); processMessage(id, true); });
eventSource.on(event_types.MESSAGE_UPDATED, (id) => { emoteCache.clear(); processMessage(id, false); });
eventSource.on(event_types.MESSAGE_EDITED, (id) => { emoteCache.clear(); processMessage(id, false); });
eventSource.on(event_types.MESSAGE_SENT, () => { streamArmed = false; stopPlayback(); });
eventSource.on(event_types.GENERATION_STARTED, () => { streamArmed = false; });  // 允许本轮首 token 重新武装（不在此停播/清缓存，免得干跑打断正在放的）
eventSource.on(event_types.GENERATION_STOPPED, () => { streamDone = true; streamArmed = false; stopPlayback(); });
eventSource.on(event_types.CHAT_CHANGED, () => { streamArmed = false; stopPlayback(); resetSynth(); emoteCache.clear(); setTimeout(sweepButtons, 100); });

// ── 设置 UI ──
// 面板可能被 ST 重建/重挂 → buildSettings 会重跑；把 CHAT_CHANGED→reloadBase 只绑一次、始终调最新的 reloadBase，避免监听器无限累积。
let _reloadBaseFn = null, _reloadBaseBound = false;
function buildSettings(host) {
    const s = cfg();
    const html = `
    <div class="vd-tts-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-wave-square"></i> 语音输出 (VoiceDesign)</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content vd-body">

          <div class="vd-toggles">
            <label class="checkbox_label"><input type="checkbox" id="vd_enabled"><span>启用语音输出</span></label>
          </div>

          <div class="vd-sec">
            <div class="vd-sec-head"><i class="fa-solid fa-server"></i><span>后端</span></div>
            <label class="vd-field"><span>TTS 后端</span>
              <select class="text_pole" id="vd_backend">
                <option value="mimo">MiMo voicedesign（自然语言描述音色）</option>
                <option value="fish">Fish Audio（reference_id 音色，需服务端插件）</option>
              </select>
            </label>
          </div>

          <div class="vd-sec">
            <div class="vd-sec-head"><i class="fa-solid fa-play"></i><span>播放</span></div>
            <label class="checkbox_label"><input type="checkbox" id="vd_autoplay"><span>新回复自动播放</span></label>
            <label class="checkbox_label"><input type="checkbox" id="vd_highlight"><span>高亮当前朗读段</span></label>
            <label class="checkbox_label"><input type="checkbox" id="vd_emote"><span>自动加语气（调用模型，仅朗读用）</span></label>
            <div class="vd-hint">开启后：每条回复朗读前，用一个文本模型返回「哪段是正文 + 情绪标签插到哪」的指令，由扩展在<b>逐字原文</b>上切出正文、插入 <code>[中文情绪]</code> 标签（如 <code>[委屈]</code>、<code>[小声，叹气]</code>；MiMo 与 Fish-S2 都吃）——<b>原文不会被改写</b>，只用于朗读、不改显示。会等整段生成完才出声（不边生成边播）。</div>
            <div class="vd-btnrow">
              <label class="vd-num" title="加语气用哪个模型：继承主模型(generateRaw) 或 自定义连接"><span>加语气用</span><select class="text_pole" id="vd_emote_conn"><option value="inherit">继承主模型</option><option value="custom">自定义连接</option></select></label>
              <label class="vd-num vd-emote-custom" title="推理强度（仅支持的模型有效；不确定用默认）"><span>推理强度</span><select class="text_pole" id="vd_emote_reasoning"><option value="default">默认</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
            </div>
            <div class="vd-emote-custom">
              <label class="vd-field"><span>加语气 Endpoint</span><input class="text_pole" id="vd_emote_endpoint" type="text" placeholder="https://…/v1"></label>
              <label class="vd-field"><span>加语气 API Key</span><input class="text_pole" id="vd_emote_apikey" type="password" autocomplete="off" placeholder="key"></label>
              <label class="vd-field"><span>加语气 Model</span><input class="text_pole" id="vd_emote_model" type="text" placeholder="模型名"></label>
            </div>
            <label class="vd-field"><span>播放速度 <b id="vd_rate_val"></b></span><input type="range" id="vd_rate" min="0.5" max="2" step="0.05"></label>
            <div class="vd-btnrow">
              <label class="vd-num" title="每段之间的停顿(毫秒)，让句子有停顿"><span>段间停顿(ms)</span><input class="text_pole" id="vd_gap" type="number" min="0" max="3000" step="50"></label>
              <label class="vd-num" title="伪流式：同时并行合成/预取的段数"><span>预取窗口</span><input class="text_pole" id="vd_window" type="number" min="1" max="8" step="1"></label>
              <label class="vd-num" title="每段最多多少字，在最近的句号处断；越大=合成次数越少但首段越慢"><span>分段上限(字)</span><input class="text_pole" id="vd_maxseg" type="number" min="20" max="2000" step="20"></label>
              <label class="vd-num" title="首段最多多少字（0=跟随分段上限，独立于分段上限）；在句子边界处断，不会超过上限、也可能因下一句放不下而不足上限。调小=更快出第一句"><span>首段上限(字)</span><input class="text_pole" id="vd_firstseg" type="number" min="0" max="2000" step="10"></label>
            </div>
          </div>

          <div class="vd-sec vd-mimo-only">
            <div class="vd-sec-head"><i class="fa-solid fa-user-tag"></i><span>音色 base（MiMo）</span><i class="vd-dot fa-solid fa-circle" id="vd_base_dot"></i></div>
            <textarea class="text_pole vd-base-edit" id="vd_base_edit" rows="3" placeholder="这张角色卡的嗓音描述；可手动改，或点“生成”让角色自己写"></textarea>
            <div class="vd-btnrow">
              <button id="vd_gen_base" class="menu_button" title="用当前文本模型、以角色口吻生成一段（别在语音连接下点）"><i class="fa-solid fa-wand-magic-sparkles"></i><span class="lbl">生成</span></button>
              <button id="vd_save_base" class="menu_button" title="把音色存进角色卡"><i class="fa-solid fa-floppy-disk"></i><span class="lbl">保存</span></button>
              <button id="vd_reload_base" class="menu_button" title="从角色卡重新读取"><i class="fa-solid fa-rotate"></i><span class="lbl">读取</span></button>
            </div>
            <div class="vd-hint">存进<b>角色卡</b>（<code>data.extensions.mimo_voice_base</code>，随卡走、优先级最高）；也可在角色卡描述写 <code>&lt;voice&gt;…&lt;/voice&gt;</code>。</div>
          </div>

          <div class="vd-sec vd-fish-only">
            <div class="vd-sec-head"><i class="fa-solid fa-fish"></i><span>音色（Fish reference_id）</span><i class="vd-dot fa-solid fa-circle" id="vd_fish_dot"></i></div>
            <input class="text_pole" id="vd_fish_voice" type="text" placeholder="reference_id：Fish 上可复用的音色 ID（手填，或用下面『设计音色』生成）">
            <div class="vd-btnrow">
              <button id="vd_fish_save" class="menu_button" title="把 reference_id 存进角色卡"><i class="fa-solid fa-floppy-disk"></i><span class="lbl">保存</span></button>
              <button id="vd_fish_reload" class="menu_button" title="从角色卡重新读取"><i class="fa-solid fa-rotate"></i><span class="lbl">读取</span></button>
            </div>

            <div class="vd-design">
              <div class="vd-design-head"><i class="fa-solid fa-wand-magic-sparkles"></i> 用描述设计音色（MiMo 合成样本 → 试听 → 建模回填 reference_id）</div>
              <textarea class="text_pole vd-base-edit" id="vd_fish_desc" rows="3" placeholder="音色的自然语言描述（复用 MiMo 那段）；可点『生成描述』让当前文本模型以角色口吻写一段"></textarea>
              <div class="vd-btnrow">
                <button id="vd_fish_desc_gen" class="menu_button" title="用当前文本模型以角色口吻生成一段音色描述"><i class="fa-solid fa-pen-fancy"></i><span class="lbl">生成描述</span></button>
                <button id="vd_fish_design" class="menu_button" title="用描述让 MiMo 合成一段高质量参考样本"><i class="fa-solid fa-flask"></i><span class="lbl">设计</span></button>
                <button id="vd_fish_preview" class="menu_button" title="试听设计出来的样本" disabled><i class="fa-solid fa-play"></i><span class="lbl">试听</span></button>
                <button id="vd_fish_adopt" class="menu_button" title="把这段样本建成 Fish 可复用音色并回填 reference_id" disabled><i class="fa-solid fa-check"></i><span class="lbl">采用</span></button>
              </div>
              <div class="vd-hint">『设计』借用 <b>MiMo</b> 按描述合成一段高质量样本（需先配好 MiMo 连接），再由 Fish 建成可复用音色。</div>
              <div class="vd-hint" id="vd_fish_design_status"></div>
            </div>

            <div class="vd-field"><span>Seed（可选；留空=Fish 默认）</span><input class="text_pole" id="vd_fish_seed" type="number" min="1" step="1" placeholder="留空=默认"></div>
            <div class="vd-hint">reference_id = Fish 上<b>可复用</b>的音色 ID（自己克隆 / 他人公开 / 上面设计生成）。存进角色卡 <code>data.extensions.fish_voice_id</code> / 描述里 <code>&lt;voice_id&gt;…&lt;/voice_id&gt;</code>。</div>
          </div>

          <div class="vd-sec vd-mimo-only">
            <div class="vd-sec-head"><i class="fa-solid fa-plug"></i><span>连接（MiMo）</span></div>
            <label class="vd-field"><span>Endpoint</span><input class="text_pole" id="vd_endpoint" type="text" placeholder="https://api.xiaomimimo.com/v1"></label>
            <label class="vd-field"><span>API Key（必填，用你自己的）</span><input class="text_pole" id="vd_apikey" type="password" autocomplete="off" placeholder="sk-…"></label>
            <label class="vd-field"><span>Model</span><input class="text_pole" id="vd_model" type="text"></label>
          </div>

          <div class="vd-sec vd-fish-only">
            <div class="vd-sec-head"><i class="fa-solid fa-plug"></i><span>连接（Fish）</span></div>
            <label class="vd-field"><span>Endpoint</span><input class="text_pole" id="vd_fish_endpoint" type="text" placeholder="https://api.fish.audio"></label>
            <label class="vd-field"><span>API Key（必填，用你自己的）</span><input class="text_pole" id="vd_fish_apikey" type="password" autocomplete="off" placeholder="fish key…"></label>
            <label class="vd-field"><span>Model</span><input class="text_pole" id="vd_fish_model" type="text" placeholder="s2.1-pro-free / s2-pro / s1"></label>
            <div class="vd-btnrow">
              <label class="vd-num" title="音频格式（pcm 无头不便播放，未列）"><span>格式</span><select class="text_pole" id="vd_fish_format"><option value="mp3">mp3</option><option value="wav">wav</option><option value="opus">opus</option></select></label>
              <label class="vd-num" title="mp3 码率（仅 mp3）"><span>mp3 码率</span><select class="text_pole" id="vd_fish_bitrate"><option value="64">64</option><option value="128">128</option><option value="192">192</option></select></label>
              <label class="vd-num" title="延迟/质量权衡"><span>延迟</span><select class="text_pole" id="vd_fish_latency"><option value="normal">normal</option><option value="balanced">balanced</option><option value="low">low</option></select></label>
            </div>
            <div class="vd-hint">Fish 走<b>服务端插件</b>转发（浏览器直连会被 CORS 挡）：把仓库 <code>plugin/</code> 放到 ST 的 <code>plugins/tts-vd-fish/</code>，<code>config.yaml</code> 里开 <code>enableServerPlugins: true</code>，重启 ST。</div>
          </div>

          <div class="vd-sec">
            <div class="vd-sec-head"><i class="fa-solid fa-sliders"></i><span>通用</span></div>
            <div class="vd-btnrow">
              <label class="vd-num" title="采样温度；留空=用服务端默认"><span>温度</span><input class="text_pole" id="vd_temp" type="number" min="0" max="2" step="0.05" placeholder="默认"></label>
              <label class="vd-num" title="top_p；留空=用服务端默认"><span>top_p</span><input class="text_pole" id="vd_topp" type="number" min="0" max="1" step="0.05" placeholder="默认"></label>
            </div>
            <label class="vd-field"><span>正文标签（可选）</span><input class="text_pole" id="vd_bodytag" type="text" placeholder="留空=读整条可见正文；填 scenario 则只读 &lt;scenario&gt;…&lt;/scenario&gt;"></label>
          </div>

        </div>
      </div>
    </div>`;
    (host ? $(host) : $("#extensions_settings")).append(html);

    const setMimoDot = (v) => $("#vd_base_dot").toggleClass("on", !!(v && String(v).trim()));
    const setFishDot = (v) => $("#vd_fish_dot").toggleClass("on", !!(v && String(v).trim()));
    const reloadBase = () => {
        const mv = readVoiceField("mimo"); $("#vd_base_edit").val(mv); $("#vd_fish_desc").val(mv); setMimoDot(mv);   // 描述复用给 Fish 设计
        const fv = readVoiceField("fish"); $("#vd_fish_voice").val(fv); setFishDot(fv);
    };
    async function writeVoice(backend, v) {
        const c = ctx();
        if (c.characterId === undefined || c.characterId === null || c.characterId === "") throw new Error("先选一个角色卡");
        await writeExtensionField(c.characterId, backend === "fish" ? "fish_voice_id" : "mimo_voice_base", String(v || "").trim());
    }
    const applyBackendUI = (b) => {
        const fish = b === "fish";
        $(".vd-tts-settings .vd-fish-only").toggle(fish);
        $(".vd-tts-settings .vd-mimo-only").toggle(!fish);
    };
    const applyEmoteConnUI = (v) => { $(".vd-tts-settings .vd-emote-custom").toggle(v === "custom"); };

    // ── 音色描述生成（MiMo/Fish 共用）+ Fish 设计的临时状态 ──
    let designB64 = "", designText = "", designUrl = "", designMime = "audio/wav";
    async function generateDesc() {
        const c = ctx();
        if (c.characterId === undefined || c.characterId === null || c.characterId === "") throw new Error("先选一个角色卡");
        const ch = c.characters?.[c.characterId] || {};
        const nm = ch?.name || ch?.data?.name || "该角色";
        const persona = String(ch?.description || ch?.data?.description || ch?.data?.personality || "")
            .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1200);
        // generateRaw：只走 system+prompt、绕开当前预设（用当前文本模型，不是本扩展的 key）；推理模型要给足 responseLength
        const sys = "你是一个语音设计(TTS voice design)助手。只输出一段中文音色描述，用来给 TTS 定制音色。"
            + "禁止角色扮演、禁止旁白、禁止场景、禁止任何标签或前后缀。";
        const prompt = "根据下面的角色设定，用 1~4 句中文描述这个角色说话时的嗓音："
            + "音高、性别感、语速、语气与情绪基调；具体生动、适合作为 TTS 音色描述；"
            + "不要写混响/EQ 等音效词；只输出这段描述本身。\n\n"
            + "角色名：" + nm + "\n角色设定：" + (persona || "（无）") + "\n\n音色描述：";
        let desc = String(await getContext().generateRaw({ prompt, systemPrompt: sys, responseLength: 2048 }) || "").trim();
        desc = desc.replace(/<[^>]+>/g, "").replace(/^["'「『（(]+|["'」』）)]+$/g, "").replace(/^音色描述[:：]\s*/, "").trim();
        if (!desc) throw new Error("生成结果为空（确认当前是文本模型连接）");
        return desc;
    }

    const showRate = () => $("#vd_rate_val").text((Number(s.rate) || 1).toFixed(2) + "×");
    $("#vd_enabled").prop("checked", s.enabled);
    $("#vd_backend").val(s.backend);
    $("#vd_autoplay").prop("checked", s.autoplay);
    $("#vd_highlight").prop("checked", s.highlight);
    $("#vd_emote").prop("checked", s.emote);
    $("#vd_emote_conn").val(s.emoteConn);
    $("#vd_emote_endpoint").val(s.emoteEndpoint);
    $("#vd_emote_apikey").val(s.emoteApiKey);
    $("#vd_emote_model").val(s.emoteModel);
    $("#vd_emote_reasoning").val(s.emoteReasoning);
    applyEmoteConnUI(s.emoteConn);
    $("#vd_rate").val(s.rate); showRate();
    $("#vd_gap").val(s.gap);
    $("#vd_window").val(s.window);
    $("#vd_maxseg").val(s.maxSeg);
    $("#vd_firstseg").val(s.firstSeg);
    $("#vd_bodytag").val(s.bodyTag);
    $("#vd_endpoint").val(s.endpoint);
    $("#vd_apikey").val(s.apiKey);
    $("#vd_model").val(s.model);
    $("#vd_fish_endpoint").val(s.fishEndpoint);
    $("#vd_fish_apikey").val(s.fishApiKey);
    $("#vd_fish_model").val(s.fishModel);
    $("#vd_fish_format").val(s.fishFormat);
    $("#vd_fish_bitrate").val(s.fishMp3Bitrate);
    $("#vd_fish_latency").val(s.fishLatency);
    $("#vd_fish_seed").val(s.fishSeed);
    $("#vd_temp").val(s.temperature);
    $("#vd_topp").val(s.topP);
    applyBackendUI(s.backend);
    reloadBase();

    const save = () => saveSettingsDebounced();
    $("#vd_enabled").on("change", function () { s.enabled = this.checked; syncRegex(this.checked); save(); });
    $("#vd_backend").on("change", function () {
        s.backend = this.value === "fish" ? "fish" : "mimo";
        applyBackendUI(s.backend);
        stopPlayback(); resetSynth();   // 换后端：音色语义不同，停播 + 清缓存
        save();
    });
    $("#vd_autoplay").on("change", function () { setAutoplay(this.checked); });   // 同步消息上的自动播放按钮
    $("#vd_highlight").on("change", function () { setHighlight(this.checked); });
    $("#vd_emote").on("change", function () { s.emote = this.checked; emoteCache.clear(); stopPlayback(); save(); });
    $("#vd_emote_conn").on("change", function () { s.emoteConn = this.value; applyEmoteConnUI(this.value); emoteCache.clear(); save(); });
    $("#vd_emote_endpoint").on("input", function () { s.emoteEndpoint = this.value.trim(); emoteCache.clear(); save(); });
    $("#vd_emote_apikey").on("input", function () { s.emoteApiKey = this.value.trim(); save(); });
    $("#vd_emote_model").on("input", function () { s.emoteModel = this.value.trim(); emoteCache.clear(); save(); });
    $("#vd_emote_reasoning").on("change", function () { s.emoteReasoning = this.value; emoteCache.clear(); save(); });
    $("#vd_rate").on("input", function () { applyRate(this.value); showRate(); });  // 实时倍速 + 同步消息上的滑条
    $("#vd_gap").on("input", function () { s.gap = Math.max(0, Math.min(3000, Number(this.value) || 0)); save(); });
    $("#vd_window").on("input", function () { s.window = Math.max(1, Math.min(8, Number(this.value) || 3)); save(); });
    $("#vd_maxseg").on("input", function () { s.maxSeg = Math.max(20, Math.min(2000, Number(this.value) || 300)); save(); });
    $("#vd_firstseg").on("input", function () { s.firstSeg = Math.max(0, Math.min(2000, Number(this.value) || 0)); save(); });
    $("#vd_bodytag").on("input", function () { s.bodyTag = this.value.trim().replace(/[<>/]/g, ""); save(); });
    $("#vd_endpoint").on("input", function () { s.endpoint = this.value.trim(); save(); });
    $("#vd_apikey").on("input", function () { s.apiKey = this.value.trim(); save(); });
    $("#vd_model").on("input", function () { s.model = this.value.trim(); save(); });
    $("#vd_fish_endpoint").on("input", function () { s.fishEndpoint = this.value.trim(); save(); });
    $("#vd_fish_apikey").on("input", function () { s.fishApiKey = this.value.trim(); save(); });
    $("#vd_fish_model").on("input", function () { s.fishModel = this.value.trim(); save(); });
    $("#vd_fish_format").on("change", function () { s.fishFormat = this.value; save(); });
    $("#vd_fish_bitrate").on("change", function () { s.fishMp3Bitrate = this.value; save(); });
    $("#vd_fish_latency").on("change", function () { s.fishLatency = this.value; save(); });
    $("#vd_fish_seed").on("input", function () { s.fishSeed = this.value.trim(); resetSynth(); save(); });   // 可选；留空=Fish 默认。缓存 key 含 seed，换值即清缓存
    // 温度/top_p：留空=用服务端默认；填了就 clamp
    $("#vd_temp").on("input", function () { const v = this.value.trim(); s.temperature = v === "" ? "" : Math.max(0, Math.min(2, Number(v) || 0)); save(); });
    $("#vd_topp").on("input", function () { const v = this.value.trim(); s.topP = v === "" ? "" : Math.max(0, Math.min(1, Number(v) || 0)); save(); });
    $("#vd_base_edit").on("input", function () { setMimoDot(this.value); });
    $("#vd_fish_voice").on("input", function () { setFishDot(this.value); });
    $("#vd_reload_base").on("click", reloadBase);
    $("#vd_fish_reload").on("click", reloadBase);
    $("#vd_save_base").on("click", async () => {
        try { await writeVoice("mimo", $("#vd_base_edit").val()); if (window.toastr) toastr.success("已存进角色卡", UI); }
        catch (e) { if (window.toastr) toastr.error(String(e.message || e), UI); }
    });
    $("#vd_fish_save").on("click", async () => {
        try { await writeVoice("fish", $("#vd_fish_voice").val()); if (window.toastr) toastr.success("已存进角色卡", UI); }
        catch (e) { if (window.toastr) toastr.error(String(e.message || e), UI); }
    });
    $("#vd_gen_base").on("click", async function () {
        const $b = $(this); $b.prop("disabled", true).find(".lbl").text("生成中…");
        try {
            const desc = await generateDesc();
            $("#vd_base_edit").val(desc); $("#vd_fish_desc").val(desc);   // 同步给 Fish 设计复用
            await writeVoice("mimo", desc); setMimoDot(desc);
            if (window.toastr) toastr.success("已生成并存进角色卡", UI);
        } catch (e) { if (window.toastr) toastr.error(String(e.message || e), UI); }
        finally { $b.prop("disabled", false).find(".lbl").text("生成"); }
    });
    // Fish：生成描述（复用同一套生成器，并同步/持久化到 MiMo 描述）
    $("#vd_fish_desc_gen").on("click", async function () {
        const $b = $(this); $b.prop("disabled", true).find(".lbl").text("生成中…");
        try {
            const desc = await generateDesc();
            $("#vd_fish_desc").val(desc); $("#vd_base_edit").val(desc);
            await writeVoice("mimo", desc); setMimoDot(desc);
            if (window.toastr) toastr.success("已生成描述", UI);
        } catch (e) { if (window.toastr) toastr.error(String(e.message || e), UI); }
        finally { $b.prop("disabled", false).find(".lbl").text("生成描述"); }
    });
    // Fish：用描述让 MiMo 合成一段高质量参考样本（供试听/建模）。需 MiMo 连接（endpoint/key/model）。
    $("#vd_fish_design").on("click", async function () {
        const s2 = cfg();
        const instr = $("#vd_fish_desc").val().trim();
        if (!instr) { if (window.toastr) toastr.warning("先写/生成一段音色描述", UI); return; }
        if (!(s2.endpoint || "").trim() || !(s2.apiKey || "").trim()) { if (window.toastr) toastr.warning("『设计』用 MiMo 生成样本：先切到 MiMo 后端把 endpoint / API Key / Model 填好", UI); return; }
        const $b = $(this); $b.prop("disabled", true).find(".lbl").text("设计中…");
        $("#vd_fish_preview,#vd_fish_adopt").prop("disabled", true);
        $("#vd_fish_design_status").text("用 MiMo 合成参考样本中…（MiMo 较慢，可能 30~120s）");
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 150000);
            let a;
            try { a = await mimoAudioBytes(s2, instr, DESIGN_SAMPLE, ctrl.signal); }
            finally { clearTimeout(timer); }
            if (!a || !a.length) throw new Error("MiMo 没返回音频");
            designMime = sniffMime(a); designText = DESIGN_SAMPLE; designB64 = bytesToBase64(a);
            if (designUrl) { try { URL.revokeObjectURL(designUrl); } catch { /* noop */ } }
            designUrl = URL.createObjectURL(new Blob([a], { type: designMime }));
            $("#vd_fish_preview,#vd_fish_adopt").prop("disabled", false);
            $("#vd_fish_design_status").text("样本已生成（" + Math.round(a.length / 1024) + "KB）：点『试听』听听，满意就点『采用』建成 Fish 音色。");
        } catch (e) {
            const msg = (e && e.name === "AbortError") ? "MiMo 合成超时(150s)" : String(e.message || e);
            $("#vd_fish_design_status").text("设计失败：" + msg); if (window.toastr) toastr.error(msg, UI);
        }
        finally { $b.prop("disabled", false).find(".lbl").text("设计"); }
    });
    // Fish：试听设计出来的那段音频
    $("#vd_fish_preview").on("click", function () {
        if (!designUrl) return;
        try { stopPlayback(); const a = new Audio(designUrl); currentAudio = a; a.play().catch(() => { }); } catch { /* noop */ }
    });
    // Fish：采用 = 把设计音频建成可复用模型（create-model）→ 回填 reference_id + 存进角色卡
    $("#vd_fish_adopt").on("click", async function () {
        const s2 = cfg();
        if (!designB64) { if (window.toastr) toastr.warning("先『设计』出一个音色", UI); return; }
        const c = ctx(); const ch = c.characters?.[c.characterId] || {};
        const nm = ch?.name || ch?.data?.name || "voice";
        const $b = $(this); $b.prop("disabled", true).find(".lbl").text("建模中…");
        $("#vd_fish_design_status").text("建模中…（把这段音色存成 Fish 可复用模型）");
        try {
            const ext = designMime === "audio/mpeg" ? "mp3" : designMime === "audio/ogg" ? "ogg" : designMime === "audio/flac" ? "flac" : "wav";
            const m = await fishPluginJson("create-model", {
                endpoint: s2.fishEndpoint, apiKey: (s2.fishApiKey || "").trim(),
                audio_base64: designB64, audio_mime: designMime, filename: "voice." + ext, texts: designText,
                title: String(nm).slice(0, 40) + " · voicedesign", visibility: "private", train_mode: "fast", type: "tts",
                enhance_audio_quality: true,
            });
            const id = m && (m._id || m.id);
            if (!id) throw new Error("create-model 没返回模型 id：" + JSON.stringify(m).slice(0, 120));
            $("#vd_fish_voice").val(id); setFishDot(id);
            await writeVoice("fish", id);              // 回填并存进角色卡（成为该角色的固定 Fish 音色）
            stopPlayback(); resetSynth();
            $("#vd_fish_design_status").text("已建模并回填 reference_id：" + id);
            if (window.toastr) toastr.success("音色已建模并设为该角色的 Fish 音色", UI);
        } catch (e) { $("#vd_fish_design_status").text("建模失败：" + String(e.message || e)); if (window.toastr) toastr.error(String(e.message || e), UI); }
        finally { $b.prop("disabled", false).find(".lbl").text("采用"); }
    });
    _reloadBaseFn = reloadBase;
    if (!_reloadBaseBound) { _reloadBaseBound = true; eventSource.on(event_types.CHAT_CHANGED, () => { if (_reloadBaseFn) _reloadBaseFn(); }); }
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
    if (document.querySelector(".vd-tts-settings")) return true;         // 已挂
    const hostEl = document.getElementById("extensions_settings") || document.getElementById("extensions_settings2");
    if (!hostEl) return false;                                              // 容器还没出来，稍后重试
    try { buildSettings(hostEl); return true; }
    catch (e) { _panelFailed = true; console.error("[tts-vd] buildSettings FAILED:", e); return true; }
}

// 居中：!important 从 JS 注入，压过主题/高特异性/旧缓存。box 在 .mes_block 内会被头像挤偏，用 translateX(--vd-shift) 拉回整条消息中心
(() => {
    const el = document.createElement("style");
    el.textContent = ".vd-tts-box{display:flex!important;justify-content:center!important;align-items:center!important;width:100%!important;box-sizing:border-box!important;transform:translateX(var(--vd-shift,0px))!important;pointer-events:none!important}.vd-tts-bar{pointer-events:auto!important;max-width:100%!important}";
    (document.head || document.documentElement).appendChild(el);
})();
// 量一次「消息中心 - 内容列中心」的偏移（头像宽度所致，布局内恒定），写进 CSS 变量给所有播放器用
function updateShift() {
    const box = document.querySelector("#chat .mes .vd-tts-box");
    const mes = box && box.closest(".mes");
    if (!box || !mes) return;
    const prev = box.style.transform; box.style.transform = "none";
    const mr = mes.getBoundingClientRect(), br = box.getBoundingClientRect();
    box.style.transform = prev;
    if (br.width) document.documentElement.style.setProperty("--vd-shift", Math.round((mr.left + mr.width / 2) - (br.left + br.width / 2)) + "px");
}
let _shiftT;
window.addEventListener("resize", () => { clearTimeout(_shiftT); _shiftT = setTimeout(updateShift, 200); });

jQuery(() => {
    try { syncRegex(cfg().enabled); } catch (e) { console.error("[tts-vd] syncRegex", e); }
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
