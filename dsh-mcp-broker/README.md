# dsh-mcp-broker

让外部 ACP 桥（如 dsh-web-acp 代理）在**单个会话内**动态挂载/卸载 MCP server，不碰全局 patch。

## 原理

DSH 的 `dsh-mcp-client` 是配置驱动的：一个插件实例连一个 MCP server，工具注册进挂载点的作用域。
本插件注册一个宿主命令 `/mcp`，其 handler 拿到**调用方 agent** 后，把 mcp-client 实例挂到
`agent.ctx` 下——工具只进这个会话，web 其它会话、其它项目窗口零污染。

远程调用方复用现成的 `commands/execute` 端点，无需新增 Remote endpoint。

## 命令

```
/mcp add <name> --command <abs-path> [--arg <v>]... [--env K=V]... [--cwd <dir>] [--timeout <ms>]
/mcp add <name> --url <http(s)-url> [--header K=V]... [--timeout <ms>]
/mcp add <json>     # {"name":"idea","transport":{"type":"streamable-http","url":"..."}}
/mcp remove <name>
/mcp list
```

`<name>` 是 DSH 工具命名空间（1-32 个 `[A-Za-z0-9_-]`），最终工具名 `mcp__<name>__<tool>`。

## 安装

```bash
dsh plugin --profile <name> add <path-or-pkg>
```

bundle 元数据（`package.json` 的 `dsh.bundle.patch`）会把自身插进宿主树。

## 版本兼容

- 不静态 import 任何 `@deepseek-ai/*`：mcp-client 通过 `ctx.loader.import` 在运行时解析，
  宿主升级自动用宿主自己的副本，无版本钉死。
- 依赖的宿主 API 面（`commands.register`、`agent.ctx.plugin`、`agent/disposed` 事件、
  `loader.import`）在 0.2.1-rc.4 与 0.2.2-alpha.2 间逐字节/语义一致。
- `dependencies` 里的 `@deepseek-ai/dsh-mcp-client` 仅作解析兜底，正常被宿主 bundle 遮蔽。

## 已验证（真机，0.2.1-rc.4）

- attach 后会话的 `request/header` 含 `mcp__fake__echo`；未 attach 的对照会话不含
- `/mcp remove` 成功、重复 remove 报干净错误
- agent 销毁自动 detach（effect 释放）
