# st-tts-voicedesign

一个 **ST TTS 扩展**，附带声音设计效果。支持多后端：

## 支持的API端点

- MiMo TTS
- Fish Audio

## 组成

```
st-tts-voicedesign/
├─ manifest.json
├─ index.js              # 入口：接线 ST 事件 + 注入样式 + 启动挂载（逻辑都在 src/）
├─ style.css
├─ src/                  # 扩展主体（原生 ES modules，无需构建）
│  ├─ st.js              # ST 核心 API 垫片（唯一触碰深层相对路径处）
│  ├─ settings.js        # 配置常量 / 默认值 / cfg / 后端判定
│  ├─ text-extract.js    # 正文提取与分段（适配不同回复格式改这里，见 docs/）
│  ├─ voice.js · audio.js · util.js
│  ├─ emote.js           # 自动加情绪标签（可选）
│  ├─ synth.js           # 合成调度：分派 + 重试 + 串行队列 + 缓存
│  ├─ backends/          # mimo.js · fish.js 两个合成后端
│  ├─ highlight.js       # 朗读高亮（CSS Custom Highlight API）
│  ├─ playback.js        # 播放引擎 + 边生成边播的流式引擎
│  ├─ message-ui.js      # 每条消息里的播放器 UI
│  └─ settings-ui.js     # 扩展设置面板 + Fish 音色设计流程
├─ docs/
│  └─ text-extraction.md # 正文提取/分段说明 + 适配不同回复格式指南
├─ plugin/               # ★ Fish 后端才需要的 ST 服务端插件
│  ├─ index.js
│  └─ README.md
└─ README.md
```

## 安装

1. 把扩展整个目录放到 ST 的 `public/scripts/extensions/third-party/st-tts-voicedesign/`（或用 ST 的「Install extension」填 git 地址），刷新页面。
2. **只在用 Fish 后端时**：额外装 `plugin/`（见 [plugin/README.md](plugin/README.md)）——拷到 ST 的 `plugins/tts-vd-fish/`，`config.yaml` 开 `enableServerPlugins: true`，重启 ST。MiMo 后端不用装。

## 配置（Extensions → 语音输出 (VoiceDesign)）

| 项 | 默认 | 说明 |
|---|---|---|
| 启用语音输出 | 开 | 关闭时不注入播放器、不自动播放（想隐藏正文里某些块，用 ST 自带 Regex 配一条 AI_OUTPUT 规则即可，见 [docs/text-extraction.md](docs/text-extraction.md)） |
| **TTS 后端** | `MiMo` | |
| 新回复自动播放 | 开 | |
| 高亮显示当前阅读段 | 开 | |
| 加情绪标签 | 关 | 增强阅读时的表现力 |
| 播放速度 | `1.0×` | 0.5–2 |
| 段间停顿 / 预取窗口 / 分段上限(字) / 首段上限(字) | `350ms` / `3` / `300` / `150` | |
| 正文标签 | `scenario` | 留空=读整条可见正文；填 `scenario` 则只读 `<scenario>…</scenario>` 里的内容 |
| 温度 / top_p | `0.6` / `0.9` | |

> **用 Fish 时，分段上限建议保持 ≤ 300。** Fish 自己的 `chunk_length` 上限就是 300，且它是按字数切、**不按整句切**；单段超过 300 会被 Fish 内部再切一刀（可能切在句子中间），听感上产生**割裂**。

### 音色

- **MiMo**：一段自然语言嗓音描述。存进角色卡 `data.extensions.mimo_voice_base`（也可在描述里写 `<voice>…</voice>`）。设置面板里可**手填**、或点「生成」让当前文本模型以角色口吻写一段。固定描述 → 声音一致（voicedesign 每次按描述现捏）。
- **Fish**（音色 = 一个 `reference_id`，Fish 上**可复用**的音色 ID；存进角色卡 `data.extensions.fish_voice_id`，或描述里 `<voice_id>…</voice_id>`）。两种来源：
  - **手填**：到 [fish.audio](https://fish.audio) 挑现成音色 / 克隆自己的，把 reference_id 填进去。
  - **用描述设计（借 MiMo 合成样本，复用同一段描述）**：在 Fish 音色区写、或点「生成描述」让当前文本模型以角色口吻写一段自然语言嗓音描述 → 点「设计」（用 **MiMo** 按描述合成一段 ~15s 高质量样本）→「试听」满意后点「采用」→ 扩展自动把它建成 Fish 可复用音色模型（create-model，`enhance_audio_quality`）、把返回的 `reference_id` **回填并存进角色卡**。⚠️ 需先配好 **MiMo 连接**（切到 MiMo 后端填 endpoint / API Key / Model）——设计这一步借用 MiMo 合成，质量比 Fish 自带的 voice-design 好得多。
  - 音色已由 `reference_id`（或 Fish 默认音色）固定，段间一致、无需其它设置。

## 提醒

- MiMo 官方 API 都可能有内容过滤。

## License

[WTFPL v2](LICENSE)
