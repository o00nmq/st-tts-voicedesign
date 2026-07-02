# st-tts-mimo — SillyTavern 里让回复「出语音」

一个 **ST 扩展** + 一条 **预设 prompt**，让角色回复整段带上语音。

## 组成

```
st-tts-mimo/
├─ manifest.json         # ST 扩展清单
├─ index.js
├─ style.css
├─ docs/
│  ├─ preset-prompt.md         # 预设 prompt 写法
│  └─ preset/femiris-tts-prompt.md   # 预设 prompt 示例（Femiris）
└─ README.md
```

## 配置（Extensions → MiMo TTS）

| 项 | 默认 | 说明 |
|---|---|---|
| 启用语音输出 | 开 | 开启时自动往 ST 全局 Regex 加一条隐藏 `<tts>` 的规则，关闭时自动移除 |
| 新回复自动播放 | 开 |
| 播放速度 | `1.0×` | 0.5–2 |
| 段间停顿 | `350ms` | 每段之间的停顿；0=不停顿 |
| 预取窗口 | `3` |
| 分段上限(字) | `300` |
| 正文标签 | 空 | 留空=读整条可见正文；填 `scenario` 则只读 `<scenario>…</scenario>` 里的内容 |
| 音色 base | — | 这张角色卡的嗓音描述 |
| Endpoint / API Key / Model | `api.xiaomimimo.com/v1` / **必填** / `mimo-v2.5-tts-voicedesign` |
| 温度 / top_p | 空 / 空 |

## 现成预设prompt

Femiris 可以直接用 **[docs/preset/femiris-tts-prompt.md](docs/preset/femiris-tts-prompt.md)**（写法通用版见 [docs/preset-prompt.md](docs/preset-prompt.md)）。它把正文写在 `<scenario>` 里，用它就把上面的**正文标签填 `scenario`**

## 提醒

官方API有内容过滤，有特殊需求可以考虑自己部署

## License

[WTFPL v2](LICENSE)