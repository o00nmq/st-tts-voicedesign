/** 音频字节工具：格式嗅探 + base64 编码。 */

/** 按字节魔数嗅探音频格式（自带 key 的路子拿不到 format，直接从返回字节判） */
export function sniffMime(b) {
    if (b.length >= 4 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "audio/wav";   // RIFF
    if (b.length >= 4 && b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "audio/ogg";   // OggS
    if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg";                   // ID3
    if (b.length >= 2 && b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return "audio/mpeg";                            // mp3 frame
    if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return "audio/flac";  // fLaC
    return "audio/wav";
}

/** base64 编码字节（分块，避免大数组 spread 爆栈） */
export function bytesToBase64(arr) {
    let bin = ""; const CH = 0x8000;
    for (let i = 0; i < arr.length; i += CH) bin += String.fromCharCode.apply(null, arr.subarray(i, i + CH));
    return btoa(bin);
}
