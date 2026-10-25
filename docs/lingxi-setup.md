# 灵矽 Realtime 运行与联调

当前实现使用浏览器直连灵矽 WSS。项目 Node 服务仅代用长期 API key 申请临时凭证，玩家点击开始即可连接，无需填写凭证。页面默认使用原有本地识别；玩家手动选择“灵矽 Realtime”后才申请临时凭证。新增路径已通过自动与模拟浏览器检查；真实服务地址、凭证及真人效果仍待联调，原有 Vosk 验收结论不能代替灵矽结果。

## 本机启动

需要 Node.js 18 或更新版本。安装依赖：

```sh
npm ci --ignore-scripts
```

在启动 Node 服务的同一个终端配置实际地址。`LINGXI_API_BASE` 仅填写 HTTPS origin（不含 `/v1`），完整 `LINGXI_REALTIME_URL` 应以 `/v1/realtime` 结尾且不带查询参数；需要模型时通过 `LINGXI_MODEL` 指定部署支持的别名：

```sh
export LINGXI_API_BASE='https://实际灵矽域名'
export LINGXI_REALTIME_URL='wss://实际灵矽域名/v1/realtime'
# 若部署要求指定原生模型，另设 LINGXI_MODEL；否则省略。
```

长期 API key 通过环境变量 `LINGXI_API_KEY` 注入。在 macOS 的 zsh 中可隐去输入，避免把密钥直接写入 shell 命令历史：

```sh
read -rs 'LINGXI_API_KEY?请输入灵矽 API key：'
export LINGXI_API_KEY
npm start
```

服务不自动加载 `.env` 文件；如果从密钥文件读取，使用自己的受控环境注入方式。`.env` 和 `.env.*` 已被 Git 忽略，但不要依赖忽略规则保护其他命名的凭证文件，也不要把真实 key 放入示例或交付包。

打开终端打印的 localhost 地址，默认选择原有“本地中文识别”。要试用灵矽，在页面选择“灵矽 Realtime”，点击开始并授权麦克风，等待配置确认和三秒倒计时。未配置时显示明确错误，不会自动改用其他引擎。灵矽模式不下载或加载 Vosk 模型。

## 凭证接口与部署边界

`POST /api/lingxi/session` 只接受同源的 `application/json` 空对象 `{}`。不允许客户端提供 key、地址、模型或额外会话参数。请求体上限 4 KiB，签发响应上限 64 KiB，签发超时 10 秒；每个服务进程最多 4 个并行签发请求、每分钟最多 10 次尝试。超额返回 429，调用方不无限重试。

默认接口只接受本机 origin（localhost/127.0.0.1/IPv6 loopback），与实际服务端口及 Host 一致。长期 key 只通过 HTTPS Bearer 请求发送给配置的灵矽服务。对浏览器返回 WSS 地址、`ek_`、`expiresAtMs` 和固定 session 配置，设置 no-store；原始上游错误、长期 key 和其他响应字段不会透传。

公开部署需要另行配置经过认证的反向代理。当前内置支持同源 HTTPS 入口：

- `LINGXI_ALLOWED_ORIGIN`：唯一允许的 HTTPS origin。
- `LINGXI_PROXY_SECRET`：反向代理与 Node 服务之间的共享秘密，不能交给浏览器。
- 代理先认证访问者，删除客户端传入的 `X-Voice-Snake-Proxy-Token`，再注入自己的同名头；Node 验证该头及 Origin。
- 配置公开 origin 后，凭证接口不再接受本机 origin 旁路。Node 仍只监听回环地址；不要暴露后端端口绕过代理。

当前没有新增账号系统。缺少已认证代理时，仅作本机使用，不应把匿名凭证签发接口暴露公网。CORS 不代替认证。GitHub Pages 可以提供静态资源，但不能执行凭证接口；公开部署需要另部署受控 HTTPS 凭证服务。静态页面通过 `web/runtime-config.js` 配置凭证接口 URL，该文件只包含公开 URL，不包含 API key；默认值是同源 `./api/lingxi/session`，适用于本地 Node 服务。应用 CSP 只额外开放已配置的灵矽 WSS origin。

申请期限为 120 秒，握手使用返回的实际到期时间。建连前发现过期时最多申请两次。已经建立的连接不会根据凭证到期定时断开；真实断连后游戏暂停，用户恢复通道时申请新凭证，再说“继续”。临时凭证不是一次性票据，游戏后端也无法强制过滤直连事件；灵矽侧并发、额度及能力限制仍须由实际部署确认。

## 采集、指令与录屏

麦克风使用 AudioWorklet，输出转换为 16kHz 单声道 PCM16 小端，每 256 个输出采样发送一次。实际输入采样率不同会进行保留跨块相位的重采样。倒计时期间不上传音频，暂停和结算后保持监听；失焦/隐藏后停止灵矽通道，回到页面须重新连接。

只执行 `conversation.item.input_audio_transcription.completed`。delta 和助手文本不触发动作；按连接代次及 item ID 去重，结合采集时间和游戏 inputEpoch 拒绝旧局、迟到或无音频时间依据的结果。灵矽单次识别失败暂停游戏，健康连接可继续监听；网络、配置、积压或协议错误关闭连接。不会自动切换到 Vosk。

打开 `?review=1` 可主动录屏。录屏使用当前语音适配器的麦克风流；报告保留 `engine: lingxi`，画面标明灵矽 Realtime，停止录屏不停止识别。临时凭证不进入录屏事件。`?review=synthetic` 始终明确标注合成输入，不算真人验收。

## 验证命令

```sh
npm test
npm run test:browser
npm run test:lingxi-browser
```

浏览器检查需要 README 中的 Playwright 与 Chrome 路径配置。`test:lingxi-browser` 使用模拟凭证/Realtime 事件和合成音轨，实际运行 AudioWorklet、棋盘和录屏，不调用灵矽服务、不采集真人声音。首次真实联调先验证凭证签发、session 配置回显和单句 completed，再执行口令、异常和连续三局验收。

公开运行包与网站不会随本地开发自动更新。重新发布时同步凭证后端和静态资源，并保留灵矽实测记录；只复制静态 ZIP 不会提供凭证服务。运行包中的 Vosk 模型仅用于用户主动选择的离线备用。
