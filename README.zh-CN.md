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
