/**
 * Fish 后端：POST 配套服务端插件（同源、绕 CORS），插件用 Bearer key 转发到 api.fish.audio，回传二进制音频。
 * 分段合成（每段一次调用，reference_id 固定 → 段间音色一致，边生成边播）；reference_id 可选（留空=默认音色）。
 * 「设计」建模走 fishPluginJson("create-model", …)。
 */
import { getRequestHeaders } from "../st.js";
import { sniffMime } from "../audio.js";
import { FISH_PLUGIN, FISH_PLUGIN_BASE } from "../settings.js";

/** Fish 合成 → objectURL（播放用）。 */
export async function synthFishOnce(s, voice, text, signal) {
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
    // 重复惩罚：控制戏剧性/表现力（越低越有起伏、也越易重复或长静默；越高越平稳）；填了才带，留空=Fish 默认(1.2)
    if (s.fishRepPenalty !== "" && s.fishRepPenalty != null && !Number.isNaN(Number(s.fishRepPenalty))) body.repetition_penalty = Math.max(0.5, Math.min(2, Number(s.fishRepPenalty)));
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
export async function fishPluginJson(path, payload) {
    const resp = await fetch(FISH_PLUGIN_BASE + "/" + path, { method: "POST", headers: getRequestHeaders(), body: JSON.stringify(payload) });
    if (resp.status === 404) throw new Error("Fish 服务端插件未装/未启用（把 plugin/ 装到 ST 的 plugins/tts-vd-fish/、开 enableServerPlugins、重启）");
    const txt = await resp.text();
    let json = null; try { json = txt ? JSON.parse(txt) : null; } catch { /* noop */ }
    if (!resp.ok) throw new Error(String((json && (json.error || json.message)) || txt || ("HTTP " + resp.status)).slice(0, 200));
    return json;
}
