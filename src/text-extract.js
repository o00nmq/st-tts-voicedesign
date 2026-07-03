/**
 * 正文提取与分段（「正文正则处理」——把角色卡的花式回复格式解析成干净、可朗读的句段）。
 *
 * 这是全扩展里唯一决定「念什么、不念什么、怎么断句」的地方。想适配你自己的回复格式
 * （不同的正文标签、状态栏/小剧场写法、CoT 约定等），基本只需改本文件。详见
 * docs/text-extraction.md。
 *
 * ── 管线总览 ────────────────────────────────────────────────
 *   原始 mes / 流式全量文本
 *     └─(regexAiOutput)     先套一遍 ST 的 AI_OUTPUT 显示正则 → 与最终存下的 mes 对齐（缓存命中）
 *     └─(bodyTag 提取)      有正文标签则只取 <bodyTag>…</bodyTag> 内，否则用整条
 *     └─(speakClean)        去掉「看不见的块」(CoT/代码块/details/图片) + 标签去壳 + markdown 标记
 *     └─(splitSentences)    切句 → 贪心攒到「分段上限」在句号断，各段大小一致
 *
 * 三条调用路径共用同一套清理，保证「流式预热」「整条补齐」「高亮定位」三者切分一致（缓存对齐、不重不漏）：
 *   getSpeakText     —— 非流式：从最终 chat[id].mes 提干净正文（speak 用）
 *   streamStableText —— 流式：从累积全量文本提「已稳定」的干净正文（砍未闭合结尾）
 *   stableSegments   —— 流式：已封口的段（供边生成边合成）
 */
import { chat, regexAiOutput } from "./st.js";
import { cfg } from "./settings.js";

/** 转义正则元字符：bodyTag 是用户自由文本，直接拼进 new RegExp 会因 ( [ + 等抛 SyntaxError 卡死 TTS */
export const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 把「已限定到正文范围」的文本清成可朗读：图片/链接去掉、标签去壳（只留标签内的文字）、
 *  去 markdown 标记（**粗* _斜_ `码`）——对齐渲染后的 DOM 文本（缓存命中）、也不让 TTS 念出星号。正文标签模式只需要这一层。 */
export function speakClean(s) {
    return String(s || "")
        // 先剔除「看不见的块」——注意 CoT 注释/折叠块也可能出现在正文标签(如 <scenario>)内部，必须在去标签壳之前先删
        .replace(/<!--[\s\S]*?-->/g, " ")                       // CoT
        .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")          // 代码块
        .replace(/<details[\s\S]*?<\/details>/gi, " ")          // 折叠块（状态栏/小剧场/变量更新）
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")                  // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")                // 链接 → 只留链接文字
        .replace(/<[^>]+>/g, " ")                               // 其余标签去壳（留里面的文字）
        .replace(/[*_~`]+/g, "")                                // 强调/行内代码 标记
        .replace(/\s+/g, " ").trim();
}
export const stripHidden = speakClean;   // 现在一套清理，两条路径共用（正文标签内/整条都要剔 CoT/折叠）

/** 流式期间：砍掉结尾「未闭合」的构造（注释/代码块/details/半个标签），避免把没写完的内容当成稳定句子去合成 */
export function dropUnclosedTail(s) {
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
export function streamStableText(rawFull) {
    let raw = regexAiOutput(String(rawFull || ""));
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
export function stableSegments(rawFull) {
    const parts = splitSentences(streamStableText(rawFull));
    return parts.length > 1 ? parts.slice(0, -1) : [];
}

/** 要朗读的文本（从原文 chat[id].mes 清，与 streamStableText 同一套 → 缓存对齐）：有正文标签只取标签内，否则整条剔隐藏块 */
export function getSpeakText(messageId) {
    let raw = String((chat[messageId] && chat[messageId].mes) || "");
    // 与 streamStableText 对齐：先套一遍 AI_OUTPUT 显示正则。否则流式清理(套了)与整条清理(没套)不一致 →
    // ① 补末段/整条时按字符游标切分错位（重复/漏读）；② 会念出被用户显示正则隐藏的内容（如 <think>）。
    raw = regexAiOutput(raw);
    const bt = (cfg().bodyTag || "").trim();
    if (bt) {
        const m = raw.match(new RegExp("<" + reEsc(bt) + "\\b[^>]*>([\\s\\S]*?)</" + reEsc(bt) + ">", "i"));
        if (m) return speakClean(m[1]);   // 有标签只念标签内；没这个标签就退回整条
    }
    return stripHidden(raw);
}

/** 分段：切句 → 贪心攒到「分段上限」CAP、在句号断，各段大小一致。兜底：单句超 CAP→逗号切→硬切。CAP=设置 maxSeg */
export function splitSentences(text, maxLen, firstLen) {
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
