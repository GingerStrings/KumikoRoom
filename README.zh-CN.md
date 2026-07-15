# KumikoRoom

[English README](README.md)

KumikoRoom 是一个本地优先的音乐陪伴房间应用，围绕黄前久美子主题构建。它包含房间式聊天界面、本地记忆、音乐搜索和播放工具，以及运行时模型配置。

这是一个本地开发用的同人项目。API Key、个人数据和同人素材都应保留在本机。

## 项目内容

- `apps/web`：Next.js 房间界面。
- `apps/api`：FastAPI 后端，负责房间状态、聊天、记忆、音乐工具和模型访问。
- `apps/desktop`：Electron 外壳，用来打开本地房间 URL。
- `docs`：设计说明和实现计划。
- `user-data`：本地运行数据，已被 git 忽略。

## 快速启动

在仓库根目录安装依赖：

```powershell
npm install
```

启动 API：

```powershell
cd apps\api
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
uvicorn kumikoroom.main:app --reload --port 8000
```

另开一个终端启动 Web：

```powershell
npm run dev --workspace apps/web
```

打开：

```text
http://127.0.0.1:3000/room
```

FL Studio 创作资料室入口：

```text
http://127.0.0.1:3000/studio
```

如果想使用其他 Web 端口：

```powershell
npm run dev --workspace apps/web -- --port 3100
```

如果 API 不在 `8000` 端口，启动 Web 前指定后端地址：

```powershell
$env:KUMIKOROOM_API_URL="http://127.0.0.1:8001"
npm run dev --workspace apps/web -- --port 3100
```

## 桌面外壳

Electron 外壳会打开房间 URL。默认地址是 `http://127.0.0.1:3000/room`，所以需要先启动 API 和 Web。

```powershell
npm run start --workspace apps/desktop
```

如果房间运行在其他地址：

```powershell
$env:KUMIKOROOM_WEB_URL="http://127.0.0.1:3100/room"
npm run start --workspace apps/desktop
```

## 模型配置

KumikoRoom 可以使用本地 mock provider，也可以连接 OpenAI 兼容的 Chat Completions 接口。

### 页面内配置

在房间界面的模型设置面板里可以填写：

- Provider：`openai_compatible` 或 `deepseek`。
- Base URL：例如 `https://api.openai.com/v1`、`https://api.deepseek.com`，或兼容的本地接口。
- 模型名称。
- API Key。

在页面里填写的 API Key 只保存在当前浏览器存储里，不会提交到仓库。

后端默认直连模型接口，不读取 Windows 系统代理环境。这样可以避开本地代理导致的 `SSL: UNEXPECTED_EOF_WHILE_READING` 这类 TLS 问题。

### 环境变量默认值

也可以用环境变量提供 DeepSeek 默认配置。复制 `.env.example` 到本地 env 文件，或在 shell 里设置：

```powershell
$env:KUMIKOROOM_LLM_PROVIDER="deepseek"
$env:DEEPSEEK_API_KEY="<your-local-key>"
$env:DEEPSEEK_MODEL="deepseek-v4-flash"
$env:DEEPSEEK_BASE_URL="https://api.deepseek.com"
$env:KUMIKOROOM_MEMORY_DB_PATH="user-data/memory/kumikoroom-memory.sqlite3"
```

不要提交 `.env`、`.env.local`、API Key 或 SQLite 记忆数据库。

## FL Studio 创作资料室

创作资料室以只读方式把本机 FL Studio 21 工程整理成可搜索的工程库，提供单工程仪表盘、编曲与 Pattern 浏览、插件和 Mixer 检查、依赖诊断、自动备份时间线、结构化版本比较，以及适合打印的工程报告。

1. 启动 API 与 Web，打开 `/studio`。
2. 点击“添加工程目录”，登记一个或多个包含 `.flp` 的文件夹。资料室会执行增量扫描；文件发生变化时在后台重新分析，已有缓存继续可用。
3. 打开工程卡片，在仪表盘和各分析页签中查看工程结构。本地打开操作只会解析已登记扫描根目录中的文件。

分析数据默认保存在 `user-data/studio/kumikoroom-studio.sqlite3`，可通过 `KUMIKOROOM_STUDIO_DB_PATH` 修改位置。数据库包含本机路径和解析后的工程结构，也属于私人数据，请谨慎分享。

源 FLP 仅用于读取，资料室不会保存、复制、恢复或覆盖它。备份发现会检查工程数据目录中的 `Backup`/`Backups`，以及 FL Studio 标准用户备份目录。高可信度匹配会自动进入版本时间线；不确定候选保持独立，等待用户确认。确认操作只在 SQLite 中记录关联。

当前能力边界：

- 已验证目标为 FL Studio 21。较新或相差较大的旧版本可能只得到部分分析或解析诊断。
- 第三方插件内部状态、全部原生插件状态块和所有 Mixer 路由暂不保证完整解析。
- 调式、和弦和段落建议属于结构推断，界面会显示可信度。音频波形、频谱、响度、母带分析、工程编辑、自动清理和恢复不在当前版本范围内。
- 找不到的本地依赖会保留为诊断，资料室不会自动下载或修复。

可以对 Git 仓库外的私人 FLP 运行可选只读契约：

```powershell
$env:KUMIKOROOM_TEST_FLP_PATH="D:\private\project.flp"
python -m pytest apps/api/tests/test_studio_local_flp.py -q
```

契约会核对解析前后源文件哈希，并检查 FL 版本、速度、Pattern 和 Channel Rack 核心结构。正常测试不设置该变量时，这项本机契约会显示为跳过。

## 本地小说 RAG

KumikoRoom 可以从本地《吹响吧！上低音号》/ 久美子相关 EPUB 建立只在本机使用的 SQLite 索引，用来辅助人物语气和原作来源 grounding。

```powershell
cd apps\api
python -m kumikoroom.novel_rag rebuild
```

默认语料目录是存在时的 `D:\555\codex\jc`，可以用 `KUMIKOROOM_NOVEL_CORPUS_DIR` 覆盖。索引默认写到 `user-data/rag/kumiko-novels.sqlite3`，这个路径已被 git 忽略。设置 `KUMIKOROOM_NOVEL_RAG_ENABLED=false` 可以关闭本地小说 RAG。

## 测试

API 测试：

```powershell
python -m pytest apps/api/tests -q
```

Web 测试：

```powershell
npm run test --workspace apps/web
```

桌面测试：

```powershell
npm run test --workspace apps/desktop
```

全部 workspace 测试：

```powershell
npm test
```

## 本地数据和同人项目边界

仓库会忽略 `.env`、`.env.local`、`user-data/` 和 `*.sqlite3`。

不要提交角色图片、语音样本、训练好的声线模型、受版权保护的音频，或其他同人素材。本地素材请放在 `user-data/` 下。
