# Fish Audio 服务端插件（tts-vd-fish）

仅 **Fish Audio 后端**需要它。MiMo 后端走 ST 自带的 chat-completions 代理，不用装这个。

## 为什么需要

Fish 的 `POST /v1/tts` 在 Cloudflare 后面、**不返回任何 CORS 头**，而且是「二进制」端点——浏览器扩展没法直连（预检就被挡），ST 自带的 chat-completions 代理也只能转发 MiMo 那种 chat 形状。所以用这个 **服务端插件**（Node，无 CORS）在 ST 服务端用你的 key 转发到 `api.fish.audio`，把音频原样回传给同源的浏览器。

## 安装

1. 把本目录（含 `index.js`）拷到 SillyTavern 的插件目录，命名为 `tts-vd-fish`：

   ```
   SillyTavern/plugins/tts-vd-fish/index.js
   ```

   > 挂载路由取自 `index.js` 里的 `info.id`（= `tts-vd-fish`），跟目录名无关；但建议目录也叫这个，省得混。

2. 开启服务端插件：`config.yaml` 里

   ```yaml
   enableServerPlugins: true
   ```

3. **重启 SillyTavern**（服务端插件在启动时加载）。启动日志里应能看到：

   ```
   [tts-vd-fish] plugin loaded — POST /api/plugins/tts-vd-fish/tts
   ```

4. 扩展设置里把 **TTS 后端**切到 `Fish Audio`，填 Fish 的 **API Key**。音色二选一：给角色卡设 **reference_id**（可选），或直接用 **默认音色 + seed**（seed 留空会自动生成并固定）。

## 无依赖

纯 Node 内建 API（`fetch`/`Buffer`，Node 18+），没有 `npm install`。

## 路由

`POST /api/plugins/tts-vd-fish/tts`，JSON body：`{ endpoint, apiKey, model, text, seed, format, reference_id?, mp3_bitrate?, opus_bitrate?, latency?, temperature?, top_p? }`（`reference_id` 可选：留空用 Fish 默认音色）。成功回传二进制音频（`Content-Type` 跟随上游），失败回 `{ error }`。扩展会自己带上这些字段，无需手动调用。
