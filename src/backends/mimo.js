/**
 * MiMo 后端：走 ST 的 chat-completions 代理（openai 源 + reverse_proxy + 用户填的 key）合成音频。
 * voicedesign 从「音色描述」现捏音色，音频在 message.audio.data（base64）。
 * MiMo 播放 & Fish「设计」取样共用 mimoAudioBytes。
 */
import { getRequestHeaders } from "../st.js";
import { sniffMime } from "../audio.js";

/** 调 MiMo 合成音频，返回原始字节 Uint8Array。 */
export async function mimoAudioBytes(s, voice, text, signal) {
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
export async function synthMimoOnce(s, voice, text, signal) {
    const arr = await mimoAudioBytes(s, voice, text, signal);
    return URL.createObjectURL(new Blob([arr], { type: sniffMime(arr) }));
}
