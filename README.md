# AW(智能体工作台)

通过钉钉应用机器人的 Stream 长连接接收文本，在本机执行 `codex exec --json`，后续消息使用 `codex exec resume <会话UUID>` 延续上下文。最终回复通过钉钉消息中的 `sessionWebhook` 发回。

无需公网 IP、端口映射或 HTTP 回调服务。需要本机保持运行且能连接钉钉和本机 Codex 配置的模型服务。


## 项目结构

```text
serve/       Node.js 服务端与钉钉机器人
web/         Vue 前端界面（源码位于 web/src/）
test/        自动化测试
dist/        前端构建产物
```

## 启动界面

使用 pnpm 管理依赖，前端采用 Vue 3、Vite 8、Tailwind CSS 4 与 Lucide 图标，后端为本机 Node.js HTTP 服务。推荐 Node.js 24，项目已提供 `.nvmrc`。无需配置钉钉凭据即可打开界面。

```sh
nvm use
pnpm install --frozen-lockfile
pnpm dev
```

浏览器打开 **http://127.0.0.1:5173**。Vite 将 /api 请求代理到本机 3210 端口。

`pnpm dev` 会同时启动前端和后端，不需要再运行 `pnpm start`。如果出现 `Failed running 'serve/server.js'. Waiting for file changes before restarting...`，请查看这条提示之前的具体错误。端口被占用时，先在之前运行 `pnpm start` 或 `pnpm dev` 的终端按 `Ctrl+C` 停止旧服务，再启动。可用 `lsof -nP -iTCP:3210 -sTCP:LISTEN` 检查后端端口占用。运行前使用 `nvm use` 切换到 Node.js 24，避免默认 Node.js 版本过旧。

构建后以单个 Node 服务运行：

```sh
pnpm build
pnpm start
```

浏览器打开 **http://127.0.0.1:3210**。服务仅监听 127.0.0.1，默认不启动钉钉机器人。

- **多工作空间**：左侧按项目分组，展开当前空间查看本地历史和新建会话。工作空间管理支持添加已有项目目录、编辑名称、独立设置模型与权限、移除登记；项目文件与原始聊天记录不会被移除。现有目录自动成为默认空间，空间列表和当前选择持久化到 `.data/workspaces.json`。未登记的历史目录可在“其他本地会话”中添加为空间。嵌套目录优先归入路径更具体的空间。
- **对话工作台**：左侧导航与本地历史，中间聊天，右侧切换 Git 代码变更和实时运行日志。Codex 支持新建与续接本地会话，任务完成后显示回复；目前不是逐字流式输出。输入框旁的权限选项支持快捷切换“只读模式”和“读写工作目录”，切换后自动保存并用于下一次任务；任务执行中或机器人运行时暂不可切换。
- **模型选择**：输入框底部可沿用本机默认模型、选择本地 Codex 模型缓存中的模型，或输入自定义模型 ID。切换后自动保存并用于下一次任务，同时同步配置页；任务执行中或机器人运行时不可切换。读取 `CODEX_HOME`（默认 `~/.codex`）中的 `models_cache.json` 和 `config.toml` 顶层默认模型，不访问远程模型接口，不返回原始配置。缓存列表不保证当前模型服务或账号支持对应模型。
- **智能体环境**：检测 Codex、Claude Code、Gemini CLI、DeepSeek CLI、Aider、OpenCode 的可执行文件和相关目录。检测到 CLI 不代表已登录。当前仅 Codex 接通对话，其他智能体的对话适配待扩展。DeepSeek 也可以作为其他客户端配置的模型服务使用，检测不到独立 CLI 不代表不能使用该模型。
- **本地历史**：直接读取当前用户的 `~/.codex/sessions` 和 `~/.claude/projects` JSONL 记录，每个来源列出最近 80 个文件，每条会话展示最近 300 条文本消息。Claude Code 当前支持阅读历史。Gemini 等其他格式尚未适配；不修改源历史文件。
- **钉钉机器人**：独立配置 Client ID、Secret、用户/会话白名单、工作目录、模型与权限，保存后可在页面启动、停止机器人，并在右侧查看日志。配置写入 `.data/studio.json`，权限为 600；Secret 不回显，输入框留空保留原值。工作台读取该文件并优先于环境配置；独立的 `pnpm robot` 仍使用进程环境和 `.env`。
- **代码预览**：读取配置工作目录的 `git diff HEAD`，同时包含已暂存和未暂存的改动；新文件仅在文件列表展示。非 Git 目录显示提示，点击刷新或网页任务完成后更新。内容过长时截取前 200 KB。

网页对话与工作台启动的机器人互斥运行，避免同时操作同一会话；独立启动的 CLI 或机器人进程不受工作台控制，请避免同时执行。网页任务与 Git 预览使用当前工作空间目录，后端拒绝跨空间续接会话。任务执行中或机器人运行时禁止切换空间，钉钉机器人启动时使用当前空间的目录、模型与权限；机器人凭据由一个实例统一管理，会话绑定与执行状态按工作空间分别保存：默认空间沿用原状态文件，其他空间保存在状态目录的 `workspaces/<空间ID>/state.json`。机器人使用统一进程锁，避免多个空间重复连接同一应用。当前标签页内切换空间会保留各空间的输入草稿和已打开对话；刷新后从本地历史重新打开。网页日志保留当前进程最近 400 条，服务重启后清空；会话历史仍由智能体保存。

## 单独启动钉钉机器人

要求 Node.js 22.12+（推荐 Node.js 24）、已安装并完成认证的 Codex CLI。使用当前用户的 Codex 配置和认证，无需单独给桥接项目配置 OpenAI API Key。

```sh
cd /Users/mamalin/Documents/code/ding-cli
pnpm install --frozen-lockfile
```

首次安装时复制 `.env.example` 为 `.env`。本次搭建已生成 `.env`，可直接编辑。填写：

```dotenv
DINGTALK_CLIENT_ID=应用的ClientID或AppKey
DINGTALK_CLIENT_SECRET=应用的ClientSecret或AppSecret
DINGTALK_ALLOWED_USERS=你的senderStaffId
```

在钉钉开发者后台创建或选择企业内部应用，添加机器人能力，消息接收模式选择 **Stream 模式**，发布应用版本，设置可使用范围，然后将机器人加入聊天。此项目接入的是应用机器人，需要 Client ID 和 Client Secret。

`DINGTALK_ALLOWED_USERS` 使用机器人消息里的 `senderStaffId`，多个 ID 以英文逗号分隔。如果不知道自己的 ID，可以先将此配置填为 `pending`，启动后给机器人发送消息，本机日志会输出被拒绝消息的 `senderStaffId`；将自己的 ID 填回 `.env` 并重启。未授权消息不会交给 Codex。

```sh
pnpm doctor
pnpm robot
```

`doctor` 验证本地配置和 Codex 可执行文件；启动时会连接钉钉。连接成功后，单聊发送文本，或在群中 @机器人发送文本。

## 接入已有会话

默认以「钉钉 conversationId + senderStaffId」区分会话，首次文本新建，后续文本续接，映射保存在 `.data/state.json`。同一用户在不同群里有独立会话，同群不同用户也分别保存。

在钉钉里发送：

```text
/bind 你的Codex会话UUID
```

再发送任务即可继续该本地会话。UUID 可从本机 Codex 会话选择器或会话详情中取得。也可在 `.env` 配置 `DING_CODEX_SESSION_ID`，作为尚未建立映射的聊天的初始会话。该配置会被所有新聊天使用，需要分别独立会话时请留空。

续接会话使用已保存的上下文，会在该会话中添加新一轮任务；桌面端是否即时刷新由客户端行为决定。避免桌面端与机器人同时执行同一个会话。

| 指令           | 功能                                    |
| -------------- | --------------------------------------- |
| `/help`        | 查看帮助                                |
| `/status`      | 查看会话 UUID、工作目录、沙箱和上次状态 |
| `/new`         | 清除当前聊天绑定，下一条消息新建会话    |
| `/bind <UUID>` | 绑定已有 Codex 会话                     |
| `/last`        | 取回当前会话上次执行结果                |

## Codex 配置

默认只读，可用于问答、项目分析。要让 Codex 修改本地项目，设置：

```dotenv
DING_CODEX_WORKDIR=/你的/项目路径
DING_CODEX_SANDBOX=workspace-write
```

修改配置后重启。执行使用 `approval_policy=never`，不会等待终端确认；受沙箱约束的操作会由 Codex 处理或失败。项目不启用绕过沙箱选项。

| 配置                             | 默认值 / 含义                              |
| -------------------------------- | ------------------------------------------ |
| `DING_CODEX_BIN`                 | 留空或 `codex` 自动检测；也可指定可执行文件路径 |
| `DING_CODEX_WORKDIR`             | 留空时为启动目录，也可在界面管理工作空间   |
| `DING_CODEX_SANDBOX`             | `read-only`，可改为 `workspace-write`      |
| `DING_CODEX_MODEL`               | 留空沿用本机 Codex 配置                    |
| `DING_CODEX_SESSION_ID`          | 留空按聊天自动新建                         |
| `DING_CODEX_TIMEOUT_MS`          | `600000`，单次任务 10 分钟，超时终止子进程 |
| `DINGTALK_ALLOWED_CONVERSATIONS` | 可选，进一步限定聊天 conversationId        |
| `STATE_FILE`                     | `.data/state.json`                         |

配置采用 `DING_CODEX_` 前缀，避免继承启动本项目的 Codex 进程自身的 `CODEX_SESSION_ID`、`CODEX_SANDBOX`。进程环境中的同名配置优先于 `.env`。

CLI 路径优先从服务进程的 `PATH` 获取，再检查当前用户的 `.local/bin`、npm 全局目录、Bun、Volta、Cargo、OpenCode 和 nvm 安装目录，以及 `PNPM_HOME`、`NPM_CONFIG_PREFIX` 指定的位置；macOS 额外检查 Homebrew 和标准位置的 `Codex.app`。环境检测与 Codex 实际执行共用路径解析，不需要为常见安装手动填写路径。自定义 `DING_CODEX_BIN` 优先，路径无效时不会偷偷切换安装。修改安装或环境变量后请重启服务。检测不会自动安装 CLI、执行 shell 启动脚本或验证登录状态；未找到时仍可手动指定绝对路径。

## 执行与恢复

所有任务在本机按顺序执行，避免并发修改项目或同一会话。最多接收 20 条等待中的消息；队列满时不确认消息，交由钉钉重试。已接收消息立即确认并按消息 ID 去重，保留最近 2000 个 ID。

会话 ID 在收到 Codex 的 `thread.started` 事件后立即保存，最终结果在发送前保存。钉钉回复失败或 webhook 过期时，重新发送 `/last` 可取回结果，不会重新执行任务。长回复按 UTF-8 字节拆分。

这是本机内存队列，不是持久化任务队列。强制结束进程或断电可能丢失已确认但尚未完成的任务。重启后使用 `/status`、`/last` 检查；上次状态为“执行中”可能表示进程被中断，请结合本地会话确认后再发送下一条指令。`Ctrl+C` 会停止接收新消息，等待已接收任务结束。

同一状态文件只允许运行一个实例。正常停止、连接失败或启动失败时会自动清理 `.data/state.json.lock`；异常退出后，下次启动会检查锁中的 PID，自动清理已退出进程留下的锁。旧版仅保存 PID 的锁文件也兼容。

如果旧机器人仍在运行，页面提示“有机器人正在运行中”并提供“强制启动”按钮。点击后先核对旧进程属于本项目，发送正常停止信号并等待最多 5 秒；仍未退出时强制结束，确认退出后清理旧锁并重新启动。强制结束可能中断未完成任务。无法确认进程身份时不会结束进程。锁文件使用实例标记，旧实例退出时不会删除新实例的锁。

`.env`、`.data/`、依赖目录已加入 `.gitignore`。本地状态保存会话 UUID 和上次回复，文件权限为 `600`。不在日志或钉钉回复中输出原始 Codex stderr。

## 验证

```sh
pnpm test
```

测试覆盖本地 API 跨域限制、密钥隐藏、网页任务互斥、Codex / Claude 历史读取与新版记录格式兼容，以及会话续接、重启持久化、去重、白名单、用户隔离、排队、失败恢复、指令、子进程 JSONL 解析与超时、回复校验和中文分段。测试使用模拟 Codex 和钉钉接口，不会发送真实钉钉消息。

本次搭建另用本机 Codex CLI 做了真实模型验证：新建只读会话返回 `DING_CODEX_OK`，再按同一 UUID 续接，成功复述上一条回复。钉钉端到端验证需要填入应用凭据和允许使用者 ID。

SDK 参考：[钉钉官方 Stream SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)。Codex 参数以本机 `codex exec --help`、`codex exec resume --help` 和真实执行结果核对；本次访问 OpenAI 官方文档站返回 Forbidden。
