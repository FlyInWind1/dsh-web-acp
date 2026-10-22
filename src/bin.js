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

attach(agent({ name: "dsh-web-acp" }), web).connect(stream);
