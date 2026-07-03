/**
 * 朗读高亮：CSS Custom Highlight API（非侵入，不改 DOM，避免和 ST 重渲染打架）；不支持则静默降级。
 */
import { cfg } from "./settings.js";

const HL_NAME = "vd-reading";
const hlSupported = (typeof Highlight !== "undefined") && (typeof CSS !== "undefined") && !!CSS.highlights;
let hlMesId = null, hlCursor = 0;   // 当前高亮所在消息 + 该消息内匹配游标（处理重复段）

export function clearHighlight() {
    if (hlSupported) { try { CSS.highlights.delete(HL_NAME); } catch { /* noop */ } }
    hlMesId = null; hlCursor = 0;
}

/** 在消息正文 DOM 里定位 segText 并高亮当前朗读段；找不到/不支持就跳过（不影响播放）。
 *  规范化只保留「字母/数字/汉字」，丢掉空白+所有标点——因为段文本来自【原文】清理，而 DOM 是【渲染后】文本，
 *  markdown 排版会做印刷体替换（... → …、直引号 → 弯引号、-- → — 等），只去空白仍会匹配不到；按字骨架比对才稳。 */
const HL_KEEP = /[\p{L}\p{N}]/u;   // 参与匹配的字符：字母/数字/汉字（丢标点，避开印刷体差异）
export function highlightSegment(mesId, segText) {
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
    if (at === -1) { try { CSS.highlights.delete(HL_NAME); } catch { /* noop */ } return; }   // 匹配不到（隐藏块夹断等）→ 清掉旧高亮
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
