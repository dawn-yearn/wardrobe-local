# Wardrobe Local · 本地衣橱

基于 [tandpfun/wardrobe](https://github.com/tandpfun/wardrobe) 修改的独立维护版本。使用 React/Vite 页面和本机 Node 服务管理衣物、搭配、人物参考照片与生成任务，提供 Windows 启动脚本及 DashScope 接入。

所有衣橱数据保存在使用者自己的电脑。日常浏览、手动添加、编辑、删除和查看已保存搭配无需 AI Key；AI 识别和生图需要联网，使用配置的服务商账户并可能产生费用。

## 安装与启动

需要 Node.js 22 的最新版本或更新版本，以及 npm。Windows 推荐使用 PowerShell：

```powershell
git clone https://github.com/dawn-yearn/wardrobe-local.git
cd wardrobe-local
npm.cmd ci
Copy-Item .env.example .env
```

`npm.cmd ci` 按锁文件安装 JavaScript 依赖到本项目的 `node_modules`，需要联网。不需要 Python、Conda、Docker 或云数据库。

安装后双击 **启动本地衣橱.cmd**，或在项目目录执行：

```powershell
npm.cmd start
```

浏览器默认打开 `http://127.0.0.1:5173`。保持启动窗口；结束使用时按 Enter 或 Ctrl+C 停止服务。只关闭网页不会停止服务。启动器会检查依赖、提示端口冲突，不自动安装包或切换端口；自动打开浏览器失败时可手动访问显示的地址。

服务仅监听本机地址。安装首次启动是空衣橱，程序会创建 `data/`；仓库不附带衣物、人物照片或 AI 凭证。已有 `.env` 时不要重复执行覆盖它的复制命令。

macOS/Linux 可使用 `npm ci`、`cp .env.example .env`、`npm start`；Windows `.cmd` 启动器仅适用于 Windows。本版本已在 Windows 完成本地验证。

## 日常使用

- **手动添加**：选择或粘贴衣物图片，填写信息后保存，不调用 AI。
- **AI 导入**：识别图片中的衣物，生成单品图，审核后保存。人物试穿需要人物参考照片。
- **创建搭配 / 我的搭配**：选择衣橱单品生成造型，查看和管理已保存的搭配。新造型生成需要 AI 和人物参考照片。
- **本地设置**：修改昵称，上传/替换人物参考照片，查看 AI 配置状态和数据目录。

编辑与删除写入本地磁盘，换浏览器仍保留。AI 任务进行时等结果完成后再停止服务；意外中断后显示中断状态，可手动重试，不会重启后自动扣费重跑。

## AI 配置

编辑项目根目录 `.env`，配置自己的 DashScope Key：

```dotenv
WARDROBE_VISION_PROVIDER=dashscope
WARDROBE_IMAGE_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-own-api-key
DASHSCOPE_COMPATIBLE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_API_BASE_URL=https://dashscope.aliyuncs.com/api/v1
DASHSCOPE_VISION_MODEL=qwen3.6-flash
DASHSCOPE_IMAGE_MODEL=qwen-image-2.0
DASHSCOPE_OUTFIT_MODEL=qwen-image-2.0
WARDROBE_MODEL_REFERENCE=data/model-reference.png
WARDROBE_DATA_DIR=data
```

修改后重启服务。Key 仅由本机后端读取，不使用 `VITE_` 前缀。无 Key、余额不足或断网时可以继续手动管理衣橱。每次生成或重试都可能计费，费用取决于服务商账单。

已有 OpenAI provider 可选，具体变量见 [.env.example](.env.example)。衣物和人物照片在 AI 请求时会发送给所选服务商；仅本地浏览与手动管理不会主动发送给 AI。

验证范围：自动测试覆盖本地读写、模拟生成、审核、恢复及缺 Key 情形，Windows 启动和备份恢复已验证，真实 DashScope 衣物识别验证通过。真实单品生图、人物试穿及搭配生图尚未联调；模型和账户可用性以使用者实际配置为准。

## 数据、备份和恢复

默认完整数据在 `data/`，包括衣物清单、照片、搭配、人物参考照片、个人设置、上传素材和任务。停止服务后复制整个数据目录到私密备份位置；不要只备份 JSON，也不要把备份嵌套在 `data/` 内。

恢复时先停止服务，将当前数据目录重命名保留，再把完整备份复制回 `data/`，启动后核对清单和图片。确认结构是 `data/library.json`，避免复制成 `data/data/library.json`。若修改了数据目录或将人物照片放在其他位置，按实际配置一起备份。

另行私密保存 `.env`，不要公开上传。换电脑时保留代码、锁文件、完整数据及自己的 `.env`，安装 Node 后运行 `npm ci`。`.gitignore` 排除了个人数据、真实环境文件和备份；只克隆仓库不能恢复个人衣橱。

## 开发和验证

```powershell
npm.cmd test
npm.cmd run build
```

自动测试使用模拟 provider 和隔离数据，不调用真实 AI。Windows 启动器集成测试在其他系统跳过。CI 只测试和构建，不部署、不需要 AI Key。

`npm.cmd run dev` 使用本机 5173 端口；`npm.cmd run preview` 使用本机 4173 端口并挂载本地 API。打开 `dist/index.html` 或普通静态服务器不能代替本机服务。可运行 `npm.cmd start -- --port 5180` 指定其他端口，调试时可添加 `--no-open`。

历史云兼容模块和模拟测试保留供参考，日常入口不启用 Meoo 登录、数据库或 Storage，也不提供云部署配置。

仓库附带上游可选的 [导入衣物技能](.agents/skills/import-clothes/SKILL.md) 和 [搭配技能](.agents/skills/generate-outfits/SKILL.md)，需要兼容的 Codex 环境。技能执行使用该环境的工具，与网页配置的 AI 服务可能不同；只在用户明确请求对应生成任务时使用。

贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 来源与许可

本项目基于 [tandpfun/wardrobe](https://github.com/tandpfun/wardrobe) 修改，原项目名为 Open Wardrobe，采用 MIT License。本版本增加 Windows 本地启动、免云账号的数据与图片业务、DashScope 接入及本地备份恢复说明。

保留原项目版权声明与 MIT 许可，详见 [LICENSE](LICENSE)。本项目为独立维护的衍生版本。使用者导入的第三方图片和个人数据不因代码采用 MIT 而自动获得相同许可。
