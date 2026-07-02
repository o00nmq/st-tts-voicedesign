# st-tts-voicedesign — SillyTavern 里让回复「出语音」

一个 **ST 扩展**，让角色回复整段带上语音、边生成边流式朗读。支持多后端：

- **MiMo voicedesign** —— 用一段**自然语言描述**现捏音色（走 ST 自带 chat-completions 代理，服务端转发，无需插件）。**分段边生成边播**（伪流式）。
- **Fish Audio** —— 用一个 **reference_id**（Fish 上可复用的音色 ID：手填现成/克隆的，或在扩展里用「文字描述 → **MiMo 合成样本** → 建模」现做一个）合成（走一个小的**服务端插件**转发，绕开浏览器 CORS）。**分段边生成边播**：回复还在生成时首句就出声；`reference_id` 固定 → 段间音色一致、无漂移。

## 组成

```
st-tts-voicedesign/
├─ manifest.json         # ST 扩展清单
├─ index.js
├─ style.css
├─ plugin/               # ★ Fish 后端才需要的 ST 服务端插件
│  ├─ index.js
│  └─ README.md          # 安装说明
├─ docs/
│  ├─ preset-prompt.md         # 预设 prompt 写法（表演 cue）
│  └─ preset/femiris-tts-prompt.md   # 预设 prompt 示例（Femiris）
└─ README.md
```

## 安装

1. 把扩展整个目录放到 ST 的 `public/scripts/extensions/third-party/st-tts-voicedesign/`（或用 ST 的「Install extension」填 git 地址），刷新页面。
2. **只在用 Fish 后端时**：额外装 `plugin/`（见 [plugin/README.md](plugin/README.md)）——拷到 ST 的 `plugins/tts-vd-fish/`，`config.yaml` 开 `enableServerPlugins: true`，重启 ST。MiMo 后端不用装。

> 从旧版 `st-tts-mimo` 升级：设置会**自动迁移**（旧的 `mimo-tts` 键 → 新键），旧的隐藏 `<tts>` 正则规则也会被自动替换。角色卡里的 `<voice>` / `mimo_voice_base` 继续给 MiMo 用。

## 配置（Extensions → 语音输出 (VoiceDesign)）

| 项 | 默认 | 说明 |
|---|---|---|
| 启用语音输出 | 开 | 开启时自动往 ST 全局 Regex 加一条隐藏 `<tts>` 的规则，关闭时自动移除 |
| **TTS 后端** | `MiMo` | `MiMo voicedesign` / `Fish Audio` |
| 新回复自动播放 | 开 | |
| 面板显示当前朗读段 | 开 | 朗读时在**播放面板**里以字幕显示当前朗读段（去掉标签、不改消息、不打扰阅读） |
| 自动加语气 | 关 | 朗读前给**每段**就地插 `[中文情绪]` 标签（如 `[委屈]`、`[小声，叹气]`；MiMo 与 Fish-S2 都支持）——**仅朗读用、不改显示**。**逐段标注**：分段在干净正文上做（字数上限准确、标签不占额度），每段单独送模型加标签 → **开着也能边生成边播**；标注失败/为空退回原段（绝不丢内容）。连接见下方「加语气连接」（继承主模型 / 自定义 endpoint+模型+推理强度）——流式下建议用**自定义独立 endpoint**，继承主模型可能排在本轮生成之后 |
| 播放速度 | `1.0×` | 0.5–2 |
| 段间停顿 / 预取窗口 / 分段上限(字) / 首段上限(字) | `350ms` / `3` / `300` / `0` | 两后端通用（都分段边生成边播）；**分段上限调小 → 每句更短**；**首段上限>0 → 首段更短、更快出第一句**（0=跟随分段上限） |
| 正文标签 | `scenario` | 留空=读整条可见正文；填 `scenario` 则只读 `<scenario>…</scenario>` 里的内容 |
| 温度 / top_p | 空 / 空 | 留空=用后端默认 |

### 音色

- **MiMo**：一段自然语言嗓音描述。存进角色卡 `data.extensions.mimo_voice_base`（也可在描述里写 `<voice>…</voice>`）。设置面板里可**手填**、或点「生成」让当前文本模型以角色口吻写一段。固定描述 → 声音一致（voicedesign 每次按描述现捏）。
- **Fish**（音色 = 一个 `reference_id`，Fish 上**可复用**的音色 ID；存进角色卡 `data.extensions.fish_voice_id`，或描述里 `<voice_id>…</voice_id>`）。两种来源：
  - **手填**：到 [fish.audio](https://fish.audio) 挑现成音色 / 克隆自己的，把 reference_id 填进去。
  - **用描述设计（借 MiMo 合成样本，复用同一段描述）**：在 Fish 音色区写、或点「生成描述」让当前文本模型以角色口吻写一段自然语言嗓音描述 → 点「设计」（用 **MiMo** 按描述合成一段 ~15s 高质量样本）→「试听」满意后点「采用」→ 扩展自动把它建成 Fish 可复用音色模型（create-model，`enhance_audio_quality`）、把返回的 `reference_id` **回填并存进角色卡**。⚠️ 需先配好 **MiMo 连接**（切到 MiMo 后端填 endpoint / API Key / Model）——设计这一步借用 MiMo 合成，质量比 Fish 自带的 voice-design 好得多。
  - **Seed**：可选，留空 = 用 Fish 默认（音色已由 reference_id 固定，通常不需要 seed）。

### 连接

- **MiMo**：Endpoint（默认 `https://api.xiaomimimo.com/v1`）、API Key（必填，用你自己的）、Model（`mimo-v2.5-tts-voicedesign`）。
- **Fish**：Endpoint（默认 `https://api.fish.audio`）、API Key（必填）、Model（默认 `s2.1-pro-free`，也可填 `s2-pro`/`s1`）、格式（默认 **opus**，可选 mp3/wav）、mp3 码率、延迟（normal/balanced/low）。**需先装服务端插件**，否则会提示「插件未装/未启用」。

## 表演 cue（可选，两后端通用）

配一条预设 prompt，让模型在正文里给要有情绪处用 `<tts>…</tts>` 包一个表演提示；扩展会把 `<tts>` 藏起来显示、但朗读时收进去交给后端当音频标签。写法见 **[docs/preset-prompt.md](docs/preset-prompt.md)**；Femiris 可直接用 **[docs/preset/femiris-tts-prompt.md](docs/preset/femiris-tts-prompt.md)**（它把正文写在 `<scenario>` 里，用它就把**正文标签填 `scenario`**）。

> cue 标签体系是各家 TTS 自己的；上面示例是 MiMo 的音频标签。

## 提醒

- MiMo/Fish 官方 API 都可能有内容过滤，有特殊需求可以考虑自部署或换克隆音色。
- voicedesign 类合成有固有延迟（时间随文本长度增长），扩展用「串行队列 + 预取窗口 + 边生成边播」把首段延迟压到最低。

## License

[WTFPL v2](LICENSE)
