/**
 * 配置：常量、默认值、设置读取（含旧版键一次性迁移）、后端判定。
 * 无运行期状态，供所有模块引用。
 */
import { extension_settings, getContext } from "./st.js";

export const NAME = "tts-voicedesign";
export const OLD_NAME = "mimo-tts";                          // 旧版设置键，一次性迁移
export const UI = "语音输出";                                 // toastr 标题
export const FISH_PLUGIN_BASE = "/api/plugins/tts-vd-fish";  // 配套服务端插件路由（同源、无 CORS）
export const FISH_PLUGIN = FISH_PLUGIN_BASE + "/tts";
// 设计取样句：让 MiMo 用「音色描述」念这段 → 拿到高质量样本音频 → 交给 Fish create-model 克隆成可复用 reference_id。
export const DESIGN_SAMPLE = "你好呀，很高兴认识你。今天天气真不错，我们要不要一起去公园走走，顺便聊聊最近发生的那些有趣又难忘的小事情呢？我觉得这样会很放松。";

export const DEFAULTS = {
    enabled: true,
    autoplay: true,
    highlight: true,   // 朗读时高亮当前段
    emote: false,      // 自动加语气：朗读前给正文插情绪标签（仅朗读用，不改显示）
    emoteConn: "inherit",   // 加标签用哪个模型：inherit=继承主模型(generateRaw) | custom=自定义连接
    emoteEndpoint: "",
    emoteApiKey: "",
    emoteModel: "",
    emoteReasoning: "default",   // 推理强度：default(不传) | minimal | low | medium | high（仅自定义连接）
    rate: 1,        // 播放速度 0.5~2
    gap: 350,       // 段间停顿(ms)，让句子之间有停顿
    window: 2,      // 伪流式滑动窗口：同时并行合成/预取的段数
    maxSeg: 300,    // 分段上限(字)：贪心把句子攒到接近这个上限、在句号处断；越大=合成次数越少但首段越慢
    firstSeg: 150,    // 首段上限(字)：0=跟随 maxSeg；调小=首段更短、更快出第一句
    bodyTag: "scenario",    // 正文标签：留空=读整条可见正文；填如 "scenario" 则只读 <scenario>…</scenario> 里的内容
    backend: "mimo",        // TTS 后端：mimo | fish
    // 采样（temperature/top_p 两后端共用；留空=各后端服务端默认）
    temperature: 0.6,   // Fish 值域 0~1、MiMo 0~2
    topP: 0.9,
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
    fishRepPenalty: "",         // 重复惩罚（仅 Fish）：控制戏剧性/表现力；留空=Fish 默认(1.2)
};

export const ctx = () => getContext();

export function cfg() {
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

export const activeBackend = () => (cfg().backend === "fish" ? "fish" : "mimo");
