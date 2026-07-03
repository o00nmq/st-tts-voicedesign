/**
 * 每条消息里的播放器 UI：播放/停止 + 自动播放开关 + 高亮开关 + 实时倍速 + 缓冲进度。
 * 负责给新/历史消息注入播放器、监听 #chat 新增补按钮、以及「自动播放/高亮」两个开关的全局同步。
 */
import { chat, saveSettingsDebounced } from "./st.js";
import { cfg, UI, activeBackend } from "./settings.js";
import { readBase } from "./voice.js";
import { getSpeakText } from "./text-extract.js";
import { speak, togglePause, getPlayingMesId, applyRate, fmtRate } from "./playback.js";
import { clearHighlight } from "./highlight.js";

/** 开关「新回复自动播放」：同步所有消息上的按钮 + 设置面板，并持久化 */
export function setAutoplay(on) {
    cfg().autoplay = !!on;
    $(".vd-tts-box .vd-auto-btn").toggleClass("on", !!on);
    $("#vd_autoplay").prop("checked", !!on);
    saveSettingsDebounced();
    if (window.toastr) toastr.info("新回复自动播放：" + (on ? "开" : "关"), UI, { timeOut: 1200 });
}

/** 开关「高亮当前朗读段」：同步所有消息上的按钮 + 设置面板，并持久化；关时清掉现有高亮 */
export function setHighlight(on) {
    cfg().highlight = !!on;
    $(".vd-tts-box .vd-hl-btn").toggleClass("on", !!on);
    $("#vd_highlight").prop("checked", !!on);
    if (!on) clearHighlight();
    saveSettingsDebounced();
    if (window.toastr) toastr.info("高亮当前朗读段：" + (on ? "开" : "关"), UI, { timeOut: 1200 });
}

/** 朗读一条：把干净正文交给 speak（分段在干净文本上做→字数准确；emote 开则逐段加标签） */
function playMessage(mesId, voice) {
    speak(mesId, voice, getSpeakText(mesId));
}

export async function processMessage(messageId, allowAutoplay) {
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
            if (getPlayingMesId() === messageId) { togglePause(messageId); return; }   // 再点 = 暂停/继续
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
export function sweepButtons() {
    document.querySelectorAll("#chat .mes[mesid]").forEach((el) => {
        const id = Number(el.getAttribute("mesid"));
        if (!Number.isNaN(id)) processMessage(id, false);
    });
}

/** 监听 #chat 直接子节点新增（新消息 / 切聊天重铸 / 翻页加载）自动补按钮；只看 childList、不看子树，流式打字不会触发 */
let chatObserverOn = false;
export function observeChat() {
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

// 居中：box 在 .mes_block 内会被头像挤偏，用 translateX(--vd-shift) 拉回整条消息中心（配套 style.css / index 注入的 !important 规则）。
// 量一次「消息中心 - 内容列中心」的偏移（头像宽度所致，布局内恒定），写进 CSS 变量给所有播放器用。
export function updateShift() {
    const box = document.querySelector("#chat .mes .vd-tts-box");
    const mes = box && box.closest(".mes");
    if (!box || !mes) return;
    const prev = box.style.transform; box.style.transform = "none";
    const mr = mes.getBoundingClientRect(), br = box.getBoundingClientRect();
    box.style.transform = prev;
    if (br.width) document.documentElement.style.setProperty("--vd-shift", Math.round((mr.left + mr.width / 2) - (br.left + br.width / 2)) + "px");
}
