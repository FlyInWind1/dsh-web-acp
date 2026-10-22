# dsh-web-acp

把已经在跑的 DeepSeek Harness（`dsh web`）包成一个 [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) 服务，供任意支持 ACP 的客户端使用。

ACP 客户端通过 stdio 连接本程序；程序再把请求转发到 web 宿主的 `/api`。会话、模型和执行都留在 web 进程里，这里不另开一套 DSH，也不去抢 `session.lock`。因此网页和 ACP 客户端可以同时查看、同时驱动同一个会话。

## 功能

- 从 `dsh web` 的启动日志里换取 API Cookie，过期后自动再换。
- 新建、列出、打开、继续和关闭会话，并把已有聊天记录回放给客户端。
- 将客户端发出的消息转成网页上的一轮对话，并把回复、思考和工具调用流式送回。
- 需要批准时，通过 ACP 向客户端请求允许或拒绝。
- 把网页上已配置的模型交给客户端选择，选中后写回同一个会话。

## 环境要求

- **Node.js** ≥ 22
- 已在本机运行 **`dsh web`**（默认 API 基址 `http://127.0.0.1:3080`）
- 自动换 Cookie 时依赖 **systemd 用户单元** 与 **`journalctl`**（见下方说明）；也可手动提供 Cookie

## 安装

```bash
git clone https://github.com/FlyInWind1/dsh-web-acp.git
cd dsh-web-acp
npm ci
```

入口为 `node src/bin.js`（`package.json` 中 `bin` 指向 `./src/bin.js`）。

## 配置

### 环境变量

| 变量 | 说明 |
|------|------|
| `DSH_WEB_BASE` | Web API 基址，例如 `http://127.0.0.1:3080`。未设置时默认 `http://127.0.0.1:3080`；若日志里是 `--public-url` 且无端口，程序会用日志中的 token，HTTP 仍走回环地址。 |
| `DSH_WEB_COOKIE` | 可选。已有效的 `dsh-auth-*=…` Cookie（`name=value`）。设置后跳过 journal 换票。 |
| `DSH_WEB_UNIT` | 可选。`journalctl --user -u` 的单元名，默认 `dsh-web.service`。用于从本次启动日志解析 launch token。 |

### ACP 客户端（JetBrains `acp.json`）

JetBrains IDE 读取 `~/.jetbrains/acp.json`。在 `agent_servers` 里登记本程序即可，例如：

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "/绝对路径/dsh-web-acp/src/bin.js"
    }
  }
}
```

`command` 指向仓库里的 `src/bin.js`（带 shebang，需可执行且本机有 Node ≥ 22）。需要时再加 `env`，例如：

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "/绝对路径/dsh-web-acp/src/bin.js",
      "env": {
        "DSH_WEB_BASE": "http://127.0.0.1:3080",
        "DSH_WEB_UNIT": "dsh-web.service"
      }
    }
  }
}
```

### Cookie 如何获取

1. **自动（推荐）**：`dsh web` 以 systemd 用户服务运行，且日志里出现带 `?token=` 的启动 URL。程序读取 journal，用 `GET /connect?token=…` 换取 `Set-Cookie` 中的 `dsh-auth-*`。
2. **手动**：浏览器或 curl 完成 connect 后，把 Cookie 设为 `DSH_WEB_COOKIE`。

## 开发

```bash
npm test
```

测试使用 Node 内置 `node:test`，不依赖真实 `dsh web` 进程。

## 架构简述

```
ACP 客户端 (stdio)  ↔  dsh-web-acp  ↔  dsh web (/api HTTP + /api/remote.mux WebSocket)
```

一次性 RPC 走 HTTP；`session/follow` 等流式能力走 WebSocket mux，与网页前端相同。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
