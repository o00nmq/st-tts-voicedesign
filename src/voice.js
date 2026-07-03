/** 读角色卡里的「音色」。 */
import { ctx, activeBackend } from "./settings.js";

/** 读角色卡里的「音色」：MiMo=自然语言描述(data.extensions.mimo_voice_base / <voice>)；
 *  Fish=reference_id(data.extensions.fish_voice_id / <voice_id>)。data.extensions 优先，其次描述里的标签。 */
export function readVoiceField(backend) {
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

export const readBase = () => readVoiceField(activeBackend());
