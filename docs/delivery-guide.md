# 交付与验收操作

当前交付按候选版本管理。Windows/macOS × Chrome/Edge 真实语音验收已由朱晶于 2026-10-25 确认通过，详细记录待归档；自动测试与合成视频仍单独记录，不替代实机证据。实际下载入口、发布版本和检查结果见[交付清单](release-checklist.md)。

## 运行包

`voice-snake-offline.zip` 包含源码、运行依赖、中文模型、文档和许可声明。需要已安装 Node.js 18 或更新版本；解压至普通本地目录后执行：

```sh
node tools/serve.cjs
```

打开终端打印的 localhost 地址。不需要先安装 npm 依赖或重新下载模型；不要直接双击 HTML，因为模块、Worker 和麦克风需要通过 HTTP/HTTPS 访问。Windows、macOS 上的 Chrome 和 Edge 真实语音验收均已通过，被测版本与环境明细待归档。

`voice-snake-site.zip` 为静态部署目录，不包含凭证或服务端程序。解压后可部署到 HTTPS 静态站点根目录或项目子目录；模型路径与脚本路径相对部署目录解析。`build.json` 标明对应源码提交和已知验证边界。

## 录制真人 Demo

1. 打开游戏地址并加 `?review=1`，使用默认本地识别模式；点击“开始游戏”，授权并确认正在监听。
2. 在“验收录制”中点击圆形录制图标。只有主动点击才记录，内容包括棋盘、状态、识别反馈和当前麦克风音轨，不录制其他窗口或桌面。
3. 按[Demo 脚本](demo-script.md)说口令完成操作。录制期间仍仅用语音操控游戏；录制按钮不改变游戏状态。单段最多五分钟。
4. 点击方形停止图标，或说“结束游戏”自动结束录制。停止录制不会停止游戏麦克风；结束游戏则停止识别与录制。
5. 点击视频图标下载 WebM，点击文件图标下载事件 JSON。下载后核对有画面、有口令声音，并记录源码提交；刷新页面会丢失未下载的内存录像。录像可能包含录制期间说出的其他话，上传前需检查。

JSON 是识别回调及命令接收事件记录，不包含人工标注的口令说完时间，不能自动算作端到端延迟或口令正确率。按[实机模板](acceptance-record.md)和[口令表](acceptance-samples.csv)填写实际结果。

## 合成音频预演

`voice-snake-synthetic.webm` 为补充演示，画面固定标注“合成音频预演 · 非真人验收”。它通过真实本地模型识别已生成的音频，不请求物理麦克风；不能替代正式真人视频。配套事件 JSON 和 `preview-verification.json` 记录命令、画面尺寸与音轨检查。

当前自动演示工具输出 `test-results/demo/voice-snake-demo.mp4`：60 秒，H.264 视频及 AAC 音轨，固定苹果路线，两局累计吃到 7 个苹果，覆盖上、下、左、右、暂停、继续、再来一局及结束游戏。“再来一局”后展示分数与蛇长重置，再继续吃苹果。音频经真实本地模型识别，游戏操作不通过文本或直接派发指令完成；画面保留“合成音频预演 · 非真人验收”标识。事件记录为 `voice-snake-demo-events.json`，媒体检查为 `demo-verification.json`。

本次交付副本随源码存放在 `docs/media/`，可[播放或下载 MP4](media/voice-snake-demo.mp4?raw=1)，并查看[事件记录](media/voice-snake-demo-events.json)及[视频检查结果](media/demo-verification.json)。候选发布中原有的短 WebM 为历史附件，不替换既有版本产物。

复现需先按 README 生成 13 条 WAV、设置 Playwright 及浏览器路径，并通过 `FFMPEG_EXECUTABLE` 指定支持 H.264/AAC 的 FFmpeg 可执行文件，然后运行 `npm run demo:synthetic`。中间文件位于 `test-results/demo/minute-staging/`，全部输出均位于忽略目录，不自动上传音频。

## 重新打包和校验

源码提交干净后执行：

```sh
npm run setup:voice
npm run package:delivery
npm run verify:delivery
npm run test:hosting
```

后三步中的浏览器检查需 README 中的 Playwright 环境。打包输出在 `test-results/delivery-*`，入口索引为 `test-results/delivery-latest.json`。两个 ZIP 配套 SHA-256；离线包校验会实际解压并运行测试，不重新安装依赖。`--allow-dirty` 只用于开发预检，不能将此类包称为已提交版本的精确产物。

## 仍需实际执行

- 朱晶：归档 Windows 实机验收明细和性能记录；录制并核对真人 Demo；按实际比赛入口提交并保留回执。
- 王任：归档 macOS Chrome/Edge 实机记录和相关环境证据。
- 根据实际测试填写支持范围；暂未验证的环境明确注明，不填造结果。
