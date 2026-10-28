#!/usr/bin/env node
/**
 * 进程入口：从环境变量接好 Web 客户端，把 stdin/stdout 做成 ACP NDJSON 流，
 * 再挂上 agent 处理器。IDE / 其他 ACP 客户端通过 stdio 启动的就是这个文件。
 */
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { attach } from "./agent.js";
import { createWebClient } from "./web.js";

const web = createWebClient({
  base: process.env.DSH_WEB_BASE,
  cookie: process.env.DSH_WEB_COOKIE,
  systemdUnit: process.env.DSH_WEB_SYSTEMD_UNIT,
});

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

const hooks = {};
const connection = attach(agent({ name: "dsh-web-acp" }), web, hooks).connect(stream);

// IDEA 关闭聊天 = 对本进程发 SIGTERM。反注册本进程挂载的 MCP server，
// 否则宿主里的 mcp-client 会对着已死的 stdio 桥无限重连报错。
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  const deadline = new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    timer.unref?.();
  });
  await Promise.race([hooks.unmountAllMcp() ?? Promise.resolve(), deadline]).catch(() => {});
  web.closeSocket();
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    void cleanup().finally(() => process.exit(0));
  });
}
// stdin 关闭（连接断开）也清理，之后让事件循环自然退出。
void connection.closed?.then(() => cleanup());
