/**
 * 自动加语气（可选，边生成边播）：逐段加情绪/语气标签，只做 voice tag，不管 CoT。
 *
 * CoT/状态栏/注释等「非正文」由 text-extract 的清理(speakClean/stripHidden)/正文标签负责剔除；
 * 到这里拿到的已是干净段。emote 只在【每个干净段】上插情绪标签(inserts)，标签不占字数额度、只供合成、不改显示。
 * 逐段标注 → 每段封口即「标注+合成+播」，可边生成边流式；非流式(speak)与流式(streamPlay)共用同一套
 * synthSeg(见 synth.js)/prepSeg/segTagCache。
 */
import { cfg, activeBackend } from "./settings.js";
import { getContext, getRequestHeaders } from "./st.js";

export const segTagCache = new Map();   // 干净段 → Promise<加了标签的段>（同段不重复标注；改 emote 设置/换轮时清）
let tagChain = Promise.resolve();   // 标注串行化，避免瞬间并发打爆情绪模型

// 情绪标注 system 提示：静态常量（可命中缓存）；变量正文只进 user prompt。
// 模型返回的是「插入指令」而非重述全文——扩展把标签插进逐字原文，模型碰不到正文本身（不会被改写），也省 token。
const EMOTE_SYS_ZH = `你是 TTS 语音表演标注助手。你会收到一小段角色扮演正文（叙述/对白）。你【绝不改动、绝不重述原文】，只返回一份 JSON 指令，由外部程序在【逐字原文】上执行：在正文里插入情绪/语气/演绎标签。

严格只输出一个 JSON，无解释、无 Markdown、无代码块、无多余字符，格式为：
{"inserts":[{"quote":"…","tag":"[中文]"}]}
不要输出正文本身，不要写任何对标注无意义的内容。若这段没有明显可标注的演绎，返回 {"inserts":[]}。

【定位铁律（最重要）】
所有 quote 都必须是原文里【一字不差、能原样搜到】的连续片段——程序用骨架匹配在逐字原文中定位，找不到就丢弃该条。因此：
· 骨架匹配只看字（中文字/字母/数字）、忽略标点与空白：所以标点/空格不必精确复制，但【一个字都不能改、不能补、不能少、不能调序】——改了字就定位失败、被丢弃。
· 片段必须【唯一可定位】：不要选在这段里会重复出现的太短或太通用的片段（如单独的"她""是的""好的""嗯"）。若某处措辞短或会重复，就向左右多带几个字，直到这一小段在这段文本里只出现一次。各片段一般 4~10 字为宜。
· quote 要精确落在它所标注的那句/那处上，不要跨句、不要过长。

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
· 这一小段里通常至多标 1~2 处；不要句句都标、不要在相邻位置重复同一类标签。拿不准、或该处并无明显演绎价值时，就不标。宁少勿滥。

示例1（语气落在台词、不双标）：
输入：她攥紧了衣角，声音发颤："你……真的要走吗？别丢下我。"
输出：{"inserts":[{"quote":"你……真的","tag":"[委屈]"},{"quote":"别丢下我","tag":"[哽咽，颤抖]"}]}

示例2（客观叙述，克制不滥标）：
输入：清晨的市场很热闹。他停下脚步，低声嘟囔："又涨价了。"
输出：{"inserts":[{"quote":"又涨价了","tag":"[无奈，小声]"}]}

示例3（无明显演绎，返回空）：
输入：他走到窗边，拉开窗帘，看了看外面的天色。
输出：{"inserts":[]}`;

// 英文标签版（Fish 用）：Fish 是 Fish Audio 原生标记语言=英文，实测英文标签演绎最明显；结构与 EMOTE_SYS_ZH 一致，只把「标签语言=英文」+示例标签换成英文。改任一版时请同步另一版（除标签语言外保持一致）。
const EMOTE_SYS_EN = `你是 TTS 语音表演标注助手。你会收到一小段角色扮演正文（叙述/对白）。你【绝不改动、绝不重述原文】，只返回一份 JSON 指令，由外部程序在【逐字原文】上执行：在正文里插入情绪/语气/演绎标签（标签一律用英文——这是 Fish TTS 的原生标记语言，英文标记演绎最明显；正文本身仍是原文、不翻译）。

严格只输出一个 JSON，无解释、无 Markdown、无代码块、无多余字符，格式为：
{"inserts":[{"quote":"…","tag":"[english]"}]}
不要输出正文本身，不要写任何对标注无意义的内容。若这段没有明显可标注的演绎，返回 {"inserts":[]}。

【定位铁律（最重要）】
所有 quote 都必须是原文里【一字不差、能原样搜到】的连续片段——程序用骨架匹配在逐字原文中定位，找不到就丢弃该条。因此：
· 骨架匹配只看字（中文字/字母/数字）、忽略标点与空白：所以标点/空格不必精确复制，但【一个字都不能改、不能补、不能少、不能调序】——改了字就定位失败、被丢弃。
· 片段必须【唯一可定位】：不要选在这段里会重复出现的太短或太通用的片段（如单独的"她""是的""好的""嗯"）。若某处措辞短或会重复，就向左右多带几个字，直到这一小段在这段文本里只出现一次。各片段一般 4~10 字为宜。
· quote 要精确落在它所标注的那句/那处上，不要跨句、不要过长。

【inserts —— 加情绪/语气/演绎，重放置、更克制；标签词一律用英文】
每条：quote = 正文里一字不差、唯一可定位的一小段；tag = 一个【方括号 + 英文】标签（Fish 原生情绪标记语言；复合含义用英文逗号分隔、同一处 ≤3 个词，如 [aggrieved] 或 [choked up, trembling]）。程序会把 tag 插到 quote 正前面，所以 quote 要精确落在你想让标签生效的位置。

放置规则（按标签类型选 quote 落点；标签词用英文）：
· 情绪 emotion（aggrieved/helpless/angry/nervous/sarcastic/joyful/cold/sad/excited/surprised…）：quote 取该句开头几字，让整句带上这种情绪。
· 语气 tone（whispering/soft tone/in a hurry tone/shouting/coquettish/commanding…）与 声音/音效 effect（sighing/sneering/choked up/trembling/breathy/chuckling/sobbing/gasping…）：quote 精确取其实际作用处的字（叹气声出现处、语气转变处），不要笼统放句首。
· 停顿 pause（[break] / [long-break]）：quote 取停顿后紧接的那几字，使停顿落在其之前。
以上示例词非穷举——Fish S2 支持自由英文描述、不限固定词表，可按语境换用更贴切的英文；只标情绪/语气/演绎，不标音色/性别/方言/唱腔。

密度与克制（务必遵守）：
· 一处发声只标一次：叙述引出紧随其后的台词时，情绪/语气只标一次，放在台词前——【绝不】在描写句和台词上各标一遍。若叙述已含表达方式的说明（如"柔声道""冷笑着说""声音发颤"），说明该词已交代语气，就不要在它上面再加语气/音效标签，把标签只落到它引出的台词上。
· 不要给"描写角色说话状态"的叙述句（如"她的声音有点抖""语气很冷"）单独打语音标签——那会让旁白声线跟着变；把该演绎交给相邻的台词，标在台词上。
· 只在真有情绪或演绎的地方标；纯客观叙述、过场、环境描写、事务性对白一律不标。
· 这一小段里通常至多标 1~2 处；不要句句都标、不要在相邻位置重复同一类标签。拿不准、或该处并无明显演绎价值时，就不标。宁少勿滥。

示例1（语气落在台词、不双标）：
输入：她攥紧了衣角，声音发颤："你……真的要走吗？别丢下我。"
输出：{"inserts":[{"quote":"你……真的","tag":"[aggrieved]"},{"quote":"别丢下我","tag":"[choked up, trembling]"}]}

示例2（客观叙述，克制不滥标）：
输入：清晨的市场很热闹。他停下脚步，低声嘟囔："又涨价了。"
输出：{"inserts":[{"quote":"又涨价了","tag":"[helpless, soft tone]"}]}

示例3（无明显演绎，返回空）：
输入：他走到窗边，拉开窗帘，看了看外面的天色。
输出：{"inserts":[]}`;

/** 加语气的一次补全：自定义连接走 ST chat 代理（可设 endpoint/model/推理强度），否则继承主模型 generateRaw。
 *  两条路都用固定 EMOTE_SYS_* 作 system（利于缓存）、变量正文放 user 侧。
 *  标签语言按【合成后端】选：Fish→英文标签（其原生标记语言，实测演绎最明显），MiMo→中文标签。各版仍是静态常量、按后端各自命中缓存。 */
async function emoteComplete(user, respLen) {
    const s = cfg();
    const EMOTE_SYS = activeBackend() === "fish" ? EMOTE_SYS_EN : EMOTE_SYS_ZH;
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

// ── emote 定位：骨架匹配（容忍标点/空白正规化）──
// 模型虽被要求逐字照抄 quote/from/to，实测仍常正规化标点（如 ……→…、引号“”↔"、空格增删），
// 使逐字 indexOf 命中失败 → 标签/keep 被静默丢弃（听感变平、机械）。改用「字母/数字骨架」定位：
// 只留 \p{L}\p{N}、丢标点+空白，并记录每个骨架字符在原文中的起始下标 → 容忍上述差异且绝不改动原文。
function skeletonize(str) {
    const skel = [], map = [];   // skel[k]=第 k 个骨架字符（单码点）, map[k]=其在原文中的起始下标
    for (let i = 0; i < str.length;) {
        const ch = String.fromCodePoint(str.codePointAt(i));
        if (/[\p{L}\p{N}]/u.test(ch)) { skel.push(ch); map.push(i); }
        i += ch.length;
    }
    return { skel, map };
}
// 在骨架数组 skel 中从 fromK 起找子序列 qSkel，返回起始骨架下标；找不到 -1。
function findSkel(skel, qSkel, fromK) {
    if (!qSkel.length) return -1;
    outer: for (let i = Math.max(0, fromK); i + qSkel.length <= skel.length; i++) {
        for (let j = 0; j < qSkel.length; j++) if (skel[i + j] !== qSkel[j]) continue outer;
        return i;
    }
    return -1;
}

/** 把模型给的插入指令 [{quote,tag}] 应用到逐字原文 canvas：按原文顺序【骨架定位】quote，在其前插入 tag。
 *  只插入、绝不改字；定位不到就跳过；只接受 [方括号+文字] 形式的标签（中/英均可，按后端选：Fish=英文、MiMo=中文）。 */
function applyInserts(canvas, inserts) {
    const { skel, map } = skeletonize(canvas);
    const points = []; let scanK = 0;
    for (const ins of (Array.isArray(inserts) ? inserts : [])) {
        if (!ins || typeof ins.quote !== "string" || typeof ins.tag !== "string") continue;
        const tag = ins.tag.trim();
        if (!/^\[[^\]\n]{1,40}\]$/.test(tag)) continue;
        const qSkel = skeletonize(ins.quote.trim()).skel;
        if (!qSkel.length) continue;
        let k = findSkel(skel, qSkel, scanK);
        if (k === -1) k = findSkel(skel, qSkel, 0);
        if (k === -1) continue;
        points.push({ pos: map[k], tag });   // 插到 quote 首个骨架字符前（其前的标点/空白留在标签外）
        scanK = k + qSkel.length;
    }
    points.sort((a, b) => a.pos - b.pos);
    let res = canvas;
    for (let i = points.length - 1; i >= 0; i--) res = res.slice(0, points[i].pos) + points[i].tag + res.slice(points[i].pos);
    return res;
}

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

/** 给【一个干净段】加情绪标签：送模型拿 {inserts}，applyInserts 插到逐字段里，返回加了标签的段。
 *  解析失败/无标签/定位不到 → 原样返回该段（绝不改字、绝不丢内容）。 */
async function annotateSeg(seg) {
    const user = "文本如下。按 system 规则返回 {inserts} JSON（quote 必须是文本里一字不差、唯一可定位的片段）：\n\n" + seg;
    const respLen = Math.min(2048, Math.max(256, Math.ceil(seg.length / 2) + 128));
    let raw = (await emoteComplete(user, respLen)).trim();
    raw = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
    let obj;
    try { obj = JSON.parse(raw); }
    catch { const m = extractJsonObject(raw); try { obj = m ? JSON.parse(m) : null; } catch { obj = null; } }
    const inserts = (obj && Array.isArray(obj.inserts)) ? obj.inserts : [];
    return applyInserts(seg, inserts);
}

/** emote 开时：把【一个干净段】送模型加情绪标签，返回加了标签的段；串行(tagChain) + 按段缓存；失败/无标签退回原段（绝不丢内容）。
 *  emote 关：直接返回原段。预热与播放共用同一 segTagCache → 每段只标注一次。 */
export function prepSeg(seg) {
    if (!cfg().emote || !seg) return Promise.resolve(seg);
    let p = segTagCache.get(seg);
    if (!p) {
        p = tagChain.then(() => annotateSeg(seg)).catch(() => seg);   // 标注失败退回原段（绝不丢内容）
        tagChain = p.catch(() => { });
        segTagCache.set(seg, p);
    }
    return p;
}

/** 清空标注缓存 + 重置标注串行链（换轮生成/切聊天/换后端/改 emote 设置时调）。 */
export function clearEmoteCache() {
    segTagCache.clear();
    tagChain = Promise.resolve();
}
