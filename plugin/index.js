/**
 * TTS VoiceDesign —— Fish Audio 服务端插件（SillyTavern server plugin, ES module）
 *
 * 为什么需要它：Fish 的 /v1/tts 在 Cloudflare 后面、不返回任何 CORS 头，而且是「二进制」端点，
 * 浏览器扩展没法直连（预检就被挡），ST 自带的 chat-completions 代理也带不动它。
 * 这个插件在 **服务端**（Node，无 CORS）用你的 key 转发到 api.fish.audio，把音频原样回传给同源的浏览器。
 *
 * 路由：POST /api/plugins/tts-vd-fish/tts  （挂载点取自下面的 info.id）
 * 装法：把本目录放到 ST 的  plugins/tts-vd-fish/ ；config.yaml 里 enableServerPlugins: true ；重启 ST。
 *
 * 注意：ST 用 `await import()` 加载插件，且其 app 是 "type": "module"，所以 .js 会当 **ES module** 解析——
 * 因此本文件用 ESM 具名导出（export const info / export async function init/exit），不能用 CommonJS 的 module.exports。
 * 依赖：全局 fetch / Buffer（Node 18+，本镜像 Node 24）；无 npm 依赖。
 */

export const info = {
    id: "tts-vd-fish",
    name: "TTS VoiceDesign — Fish Audio proxy",
    description: "服务端转发 Fish Audio /v1/tts（绕开浏览器 CORS）。",
};

const DEFAULT_ENDPOINT = "https://api.fish.audio";
const TIMEOUT_MS = 150000;

/** 单次转发到 Fish；抛错交给路由统一处理 */
async function forwardToFish(payload) {
    const {
        endpoint, apiKey, model, reference_id, text,
        format, mp3_bitrate, opus_bitrate, latency, temperature, top_p, repetition_penalty,
        chunk_length, normalize, prosody,
    } = payload || {};

    if (!apiKey) { const e = new Error("missing apiKey"); e.status = 400; throw e; }
    if (!text) { const e = new Error("missing text"); e.status = 400; throw e; }
    // reference_id 可选：有就用指定音色模型，无则用 Fish 默认音色

    const base = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
    const body = { text: String(text), format: format || "mp3" };
    if (reference_id) body.reference_id = reference_id;
    if ((format || "mp3") === "mp3" && mp3_bitrate) body.mp3_bitrate = Number(mp3_bitrate);
    if (format === "opus" && opus_bitrate) body.opus_bitrate = Number(opus_bitrate);
    if (latency) body.latency = latency;
    if (temperature != null && temperature !== "" && !Number.isNaN(Number(temperature))) body.temperature = Number(temperature);
    if (top_p != null && top_p !== "" && !Number.isNaN(Number(top_p))) body.top_p = Number(top_p);
    if (repetition_penalty != null && repetition_penalty !== "" && !Number.isNaN(Number(repetition_penalty))) body.repetition_penalty = Number(repetition_penalty);
    if (chunk_length) body.chunk_length = Number(chunk_length);
    if (typeof normalize === "boolean") body.normalize = normalize;
    if (prosody && typeof prosody === "object") body.prosody = prosody;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp;
    try {
        resp = await fetch(base + "/v1/tts", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + apiKey,
                "Content-Type": "application/json",
                "model": model || "s2.1-pro-free",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        const e = new Error(errText.slice(0, 400) || ("Fish HTTP " + resp.status));
        e.status = resp.status;
        throw e;
    }
    const contentType = resp.headers.get("content-type") || "audio/mpeg";
    const buf = Buffer.from(await resp.arrayBuffer());
    return { buf, contentType };
}

export async function init(router) {
    router.post("/tts", async (req, res) => {
        try {
            const { buf, contentType } = await forwardToFish(req.body);
            res.setHeader("Content-Type", contentType);
            res.setHeader("Content-Length", buf.length);
            return res.status(200).send(buf);
        } catch (err) {
            const status = err && err.name === "AbortError" ? 504 : (err && err.status) || 502;
            const message = err && err.name === "AbortError" ? "upstream timeout (150s)" : String((err && err.message) || err);
            return res.status(status).json({ error: message });
        }
    });
    // create-model：把（MiMo 合成的）参考音频 + 文稿建成 Fish 可复用音色模型，返回含 _id 的 JSON。multipart。
    router.post("/create-model", async (req, res) => {
        const b = req.body || {};
        try {
            if (!b.apiKey) return res.status(400).json({ error: "missing apiKey" });
            if (!b.audio_base64) return res.status(400).json({ error: "missing audio_base64" });
            const base = String(b.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
            const audio = Buffer.from(b.audio_base64, "base64");
            if (!audio.length) return res.status(400).json({ error: "empty audio" });
            const fd = new FormData();
            fd.append("type", b.type || "tts");
            fd.append("train_mode", b.train_mode || "fast");
            fd.append("visibility", b.visibility || "private");
            fd.append("title", String(b.title || "voicedesign"));
            if (b.description) fd.append("description", String(b.description));
            if (b.texts) fd.append("texts", String(b.texts));
            if (b.enhance_audio_quality) fd.append("enhance_audio_quality", "true");
            fd.append("voices", new Blob([audio], { type: b.audio_mime || "audio/wav" }), b.filename || "voice.wav");
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
            let resp;
            try {
                resp = await fetch(base + "/model", {
                    method: "POST",
                    headers: { "Authorization": "Bearer " + b.apiKey },   // 不设 Content-Type：fetch 按 FormData 自动带 multipart 边界
                    body: fd,
                    signal: controller.signal,
                });
            } finally { clearTimeout(timer); }
            return res.status(resp.status).type("application/json").send(await resp.text());
        } catch (err) {
            const to = err && err.name === "AbortError";
            return res.status(to ? 504 : 502).json({ error: to ? "create-model timeout" : String((err && err.message) || err) });
        }
    });

    console.log("[tts-vd-fish] plugin loaded — /api/plugins/tts-vd-fish/{tts,create-model}");
}

export async function exit() { /* 无需清理 */ }
