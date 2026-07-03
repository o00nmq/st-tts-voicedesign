/**
 * 扩展设置面板
 */
import { cfg, ctx, activeBackend, DESIGN_SAMPLE, UI } from "./settings.js";
import { writeExtensionField, getContext, saveSettingsDebounced, eventSource, event_types } from "./st.js";
import { readVoiceField } from "./voice.js";
import { sniffMime, bytesToBase64 } from "./audio.js";
import { mimoAudioBytes } from "./backends/mimo.js";
import { fishPluginJson } from "./backends/fish.js";
import { stopPlayback, applyRate, previewUrl } from "./playback.js";
import { resetSynth } from "./synth.js";
import { clearEmoteCache } from "./emote.js";
import { setAutoplay, setHighlight } from "./message-ui.js";

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
                <option value="mimo">MiMo voicedesign</option>
                <option value="fish">Fish Audio</option>
              </select>
            </label>
          </div>

          <div class="vd-sec">
            <div class="vd-sec-head"><i class="fa-solid fa-play"></i><span>播放</span></div>
            <label class="checkbox_label"><input type="checkbox" id="vd_autoplay"><span>新回复自动播放</span></label>
            <label class="checkbox_label"><input type="checkbox" id="vd_highlight"><span>高亮当前朗读段</span></label>
            <label class="checkbox_label"><input type="checkbox" id="vd_emote"><span>加情绪标签</span></label>
            <div class="vd-btnrow">
              <label class="vd-num" title="加情绪标签哪个模型：继承主模型 或 自定义连接"><span>加语气用</span><select class="text_pole" id="vd_emote_conn"><option value="inherit">继承主模型</option><option value="custom">自定义连接</option></select></label>
              <label class="vd-num vd-emote-custom" title="推理强度（仅支持的模型有效；不确定用默认）"><span>推理强度</span><select class="text_pole" id="vd_emote_reasoning"><option value="default">默认</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
            </div>
            <div class="vd-emote-custom">
              <label class="vd-field"><span>加标签 Endpoint</span><input class="text_pole" id="vd_emote_endpoint" type="text" placeholder="https://…/v1"></label>
              <label class="vd-field"><span>加标签 API Key</span><input class="text_pole" id="vd_emote_apikey" type="password" autocomplete="off" placeholder="key"></label>
              <label class="vd-field"><span>加标签 Model</span><input class="text_pole" id="vd_emote_model" type="text" placeholder="模型名"></label>
            </div>
            <label class="vd-field"><span>播放速度 <b id="vd_rate_val"></b></span><input type="range" id="vd_rate" min="0.5" max="2" step="0.05"></label>
            <div class="vd-btnrow">
              <label class="vd-num" title="每段之间的停顿(毫秒)，让句子有停顿"><span>段间停顿(ms)</span><input class="text_pole" id="vd_gap" type="number" min="0" max="3000" step="50"></label>
              <label class="vd-num" title="同时并行合成/预取的段数"><span>预取窗口</span><input class="text_pole" id="vd_window" type="number" min="1" max="8" step="1"></label>
              <label class="vd-num" title="每段最多多少字"><span>分段上限(字)</span><input class="text_pole" id="vd_maxseg" type="number" min="20" max="2000" step="20"></label>
              <label class="vd-num" title="首段最多多少字（0=跟随分段上限，独立于分段上限）"><span>首段上限(字)</span><input class="text_pole" id="vd_firstseg" type="number" min="0" max="2000" step="10"></label>
            </div>
          </div>

          <div class="vd-sec vd-mimo-only">
            <div class="vd-sec-head"><i class="fa-solid fa-user-tag"></i><span>音色</span><i class="vd-dot fa-solid fa-circle" id="vd_base_dot"></i></div>
            <textarea class="text_pole vd-base-edit" id="vd_base_edit" rows="3" placeholder="这张角色卡的嗓音描述；可手动改，或点“生成”让角色自己写"></textarea>
            <div class="vd-btnrow">
              <button id="vd_gen_base" class="menu_button" title="用当前文本模型、以角色口吻生成一段"><i class="fa-solid fa-wand-magic-sparkles"></i><span class="lbl">生成</span></button>
              <button id="vd_save_base" class="menu_button" title="把音色存进角色卡"><i class="fa-solid fa-floppy-disk"></i><span class="lbl">保存</span></button>
              <button id="vd_reload_base" class="menu_button" title="从角色卡重新读取"><i class="fa-solid fa-rotate"></i><span class="lbl">读取</span></button>
            </div>
            <div class="vd-hint">存进<b>角色卡</b>（<code>data.extensions.mimo_voice_base</code>，随卡走、优先级最高）；也可在角色卡描述写 <code>&lt;voice&gt;…&lt;/voice&gt;</code>。</div>
          </div>

          <div class="vd-sec vd-fish-only">
            <div class="vd-sec-head"><i class="fa-solid fa-fish"></i><span>音色</span><i class="vd-dot fa-solid fa-circle" id="vd_fish_dot"></i></div>
            <input class="text_pole" id="vd_fish_voice" type="text" placeholder="reference_id：Fish 上可复用的音色 ID">
            <div class="vd-btnrow">
              <button id="vd_fish_save" class="menu_button" title="把 reference_id 存进角色卡"><i class="fa-solid fa-floppy-disk"></i><span class="lbl">保存</span></button>
              <button id="vd_fish_reload" class="menu_button" title="从角色卡重新读取"><i class="fa-solid fa-rotate"></i><span class="lbl">读取</span></button>
            </div>

            <div class="vd-design">
              <div class="vd-design-head"><i class="fa-solid fa-wand-magic-sparkles"></i> 用描述设计音色（MiMo 合成样本 → 试听 → 建模回填 reference_id）</div>
              <textarea class="text_pole vd-base-edit" id="vd_fish_desc" rows="3" placeholder="音色的自然语言描述"></textarea>
              <div class="vd-btnrow">
                <button id="vd_fish_desc_gen" class="menu_button" title="用当前文本模型以角色口吻生成一段音色描述"><i class="fa-solid fa-pen-fancy"></i><span class="lbl">生成描述</span></button>
                <button id="vd_fish_design" class="menu_button" title="用描述让 MiMo 合成一段高质量参考样本"><i class="fa-solid fa-flask"></i><span class="lbl">设计</span></button>
                <button id="vd_fish_preview" class="menu_button" title="试听设计出来的样本" disabled><i class="fa-solid fa-play"></i><span class="lbl">试听</span></button>
                <button id="vd_fish_adopt" class="menu_button" title="把这段样本建成 Fish 可复用音色并回填 reference_id" disabled><i class="fa-solid fa-check"></i><span class="lbl">采用</span></button>
              </div>
              <div class="vd-hint" id="vd_fish_design_status"></div>
            </div>
            <div class="vd-hint">reference_id = Fish 上<b>可复用</b>的音色 ID（自己克隆 / 他人公开）。存进角色卡 <code>data.extensions.fish_voice_id</code> / 描述里 <code>&lt;voice_id&gt;…&lt;/voice_id&gt;</code>。</div>
          </div>

          <div class="vd-sec vd-mimo-only">
            <div class="vd-sec-head"><i class="fa-solid fa-plug"></i><span>连接</span></div>
            <label class="vd-field"><span>Endpoint</span><input class="text_pole" id="vd_endpoint" type="text" placeholder="https://api.xiaomimimo.com/v1"></label>
            <label class="vd-field"><span>API Key</span><input class="text_pole" id="vd_apikey" type="password" autocomplete="off" placeholder="sk-…"></label>
            <label class="vd-field"><span>Model</span><input class="text_pole" id="vd_model" type="text"></label>
          </div>

          <div class="vd-sec vd-fish-only">
            <div class="vd-sec-head"><i class="fa-solid fa-plug"></i><span>连接</span></div>
            <label class="vd-field"><span>Endpoint</span><input class="text_pole" id="vd_fish_endpoint" type="text" placeholder="https://api.fish.audio"></label>
            <label class="vd-field"><span>API Key</span><input class="text_pole" id="vd_fish_apikey" type="password" autocomplete="off" placeholder="fish key…"></label>
            <label class="vd-field"><span>Model</span><input class="text_pole" id="vd_fish_model" type="text" placeholder="s2.1-pro-free / s2-pro / s1"></label>
            <div class="vd-btnrow">
              <label class="vd-num" title="音频格式"><span>格式</span><select class="text_pole" id="vd_fish_format"><option value="mp3">mp3</option><option value="wav">wav</option><option value="opus">opus</option></select></label>
              <label class="vd-num" title="mp3 码率（仅 mp3）"><span>mp3 码率</span><select class="text_pole" id="vd_fish_bitrate"><option value="64">64</option><option value="128">128</option><option value="192">192</option></select></label>
              <label class="vd-num" title="延迟/质量权衡"><span>延迟</span><select class="text_pole" id="vd_fish_latency"><option value="normal">normal</option><option value="balanced">balanced</option><option value="low">low</option></select></label>
              <label class="vd-num" title="控制戏剧性/表现力"><span>重复惩罚</span><input class="text_pole" id="vd_fish_reppen" type="number" min="0.5" max="2" step="0.05" placeholder="默认1.2"></label>
            </div>
          </div>

          <div class="vd-sec">
            <div class="vd-sec-head"><i class="fa-solid fa-sliders"></i><span>通用</span></div>
            <div class="vd-btnrow">
              <label class="vd-num" title="采样温度"><span>温度</span><input class="text_pole" id="vd_temp" type="number" min="0" max="2" step="0.05" placeholder="默认"></label>
              <label class="vd-num" title="top_p"><span>top_p</span><input class="text_pole" id="vd_topp" type="number" min="0" max="1" step="0.05" placeholder="默认"></label>
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
    $("#vd_fish_reppen").val(s.fishRepPenalty);
    $("#vd_temp").val(s.temperature);
    $("#vd_topp").val(s.topP);
    applyBackendUI(s.backend);
    reloadBase();

    const save = () => saveSettingsDebounced();
    $("#vd_enabled").on("change", function () { s.enabled = this.checked; save(); });
    $("#vd_backend").on("change", function () {
        s.backend = this.value === "fish" ? "fish" : "mimo";
        applyBackendUI(s.backend);
        stopPlayback(); resetSynth();   // 换后端：音色语义不同，停播 + 清缓存
        save();
    });
    $("#vd_autoplay").on("change", function () { setAutoplay(this.checked); });   // 同步消息上的自动播放按钮
    $("#vd_highlight").on("change", function () { setHighlight(this.checked); });
    $("#vd_emote").on("change", function () { s.emote = this.checked; clearEmoteCache(); stopPlayback(); save(); });
    $("#vd_emote_conn").on("change", function () { s.emoteConn = this.value; applyEmoteConnUI(this.value); clearEmoteCache(); save(); });
    $("#vd_emote_endpoint").on("input", function () { s.emoteEndpoint = this.value.trim(); clearEmoteCache(); save(); });
    $("#vd_emote_apikey").on("input", function () { s.emoteApiKey = this.value.trim(); save(); });
    $("#vd_emote_model").on("input", function () { s.emoteModel = this.value.trim(); clearEmoteCache(); save(); });
    $("#vd_emote_reasoning").on("change", function () { s.emoteReasoning = this.value; clearEmoteCache(); save(); });
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
    // 重复惩罚：留空=Fish 默认；填了就 clamp 到 0.5~2（与 temperature/top_p 同类，不进缓存 key）
    $("#vd_fish_reppen").on("input", function () { const v = this.value.trim(); s.fishRepPenalty = v === "" ? "" : Math.max(0.5, Math.min(2, Number(v) || 0)); save(); });
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
    $("#vd_fish_preview").on("click", function () { previewUrl(designUrl); });
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

// 挂设置面板：容器可能还没就绪 → 重试；buildSettings 若抛错则记一次、不再无限重试；被 ST 冲掉了会补挂回来
let _panelFailed = false;
export function mountSettings() {
    if (_panelFailed) return true;
    if (document.querySelector(".vd-tts-settings")) return true;         // 已挂
    const hostEl = document.getElementById("extensions_settings") || document.getElementById("extensions_settings2");
    if (!hostEl) return false;                                              // 容器还没出来，稍后重试
    try { buildSettings(hostEl); return true; }
    catch (e) { _panelFailed = true; console.error("[tts-vd] buildSettings FAILED:", e); return true; }
}
