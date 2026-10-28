/**
 * 单元 / 集成测试：假 HTTP/WebSocket 宿主下验证换 Cookie、历史回放、
 * prompt 往返、模型选择和批准对话框等 ACP ↔ web 桥接行为。
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { AGENT_METHODS, CLIENT_METHODS, agent, client } from "@agentclientprotocol/sdk";
import { WebSocketServer } from "ws";
import { attach } from "../src/agent.js";
import { exchangeCookie, parseLaunch } from "../src/cookie.js";
import { approvalTitle, approvalValue } from "../src/approval.js";
import { createDrive, promptContent, stopReasonOf } from "../src/drive.js";
import { historyUpdates } from "../src/history.js";
import { applyConfig, configOptions, currentSelection, modelValue } from "../src/models.js";
import { WebClient } from "../src/web.js";

test("exchangeCookie keeps the name=value pair from a 302", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/connect?token=abc&interactions=none");
    res.writeHead(302, {
      location: "./api/remote.mux",
      "set-cookie": "dsh-auth-test=signed; Path=/; HttpOnly; SameSite=Strict",
    });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const pair = await exchangeCookie(`http://127.0.0.1:${port}`, "abc");
    assert.equal(pair, "dsh-auth-test=signed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("parseLaunch reads the latest token after the current start", () => {
  const journal = [
    "Started DeepSeek Harness Web",
    "dsh web: http://127.0.0.1:3080/?token=old",
    "Started DeepSeek Harness Web",
    "dsh web: https://dsh.example/?token=new-token",
  ].join("\n");
  assert.deepEqual(parseLaunch(journal), { port: "3080", token: "new-token" });
  assert.deepEqual(parseLaunch("http://127.0.0.1:3091/?token=loop"), {
    port: "3091",
    token: "loop",
  });
});

test("stop reasons and prompt text", () => {
  assert.equal(stopReasonOf({ kind: "completed" }), "end_turn");
  assert.equal(stopReasonOf({ kind: "aborted", reason: { kind: "user" } }), "cancelled");
  assert.equal(stopReasonOf({ kind: "max-tokens" }), "max_tokens");
  assert.deepEqual(
    promptContent([
      { type: "text", text: "hello" },
      { type: "resource_link", name: "a.js", uri: "file:///tmp/a.js" },
    ]),
    [
      { type: "text", text: "hello" },
      { type: "text", text: "a.js file:///tmp/a.js" },
    ],
  );
});

test("drive ignores the other turn and does not repeat streamed text", async () => {
  const updates = [];
  const drive = createDrive({
    requestId: "req-1",
    baseline: 3,
    emit: (update) => updates.push(update),
  });
  const event = (seq, type, data) => drive.push({ type: "event", event: { seq, type, time: 1, data } });
  event(4, "turn/start", { turn: 1 });
  event(5, "user/message", { role: "user", source: { kind: "user", rpcId: "other" }, content: [] });
  event(6, "assistant/message", {
    turn: 1,
    step: 1,
    message: { role: "assistant", content: [{ type: "text", text: "NOT-OURS" }] },
  });
  event(7, "turn/end", { turn: 1, reason: { kind: "completed" } });
  event(8, "turn/start", { turn: 2 });
  event(9, "user/message", { role: "user", source: { kind: "user", rpcId: "req-1" }, content: [] });
  drive.push({
    type: "assistant-stream",
    frame: {
      type: "chunk",
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", text: "hello" },
    },
  });
  event(10, "assistant/message", {
    turn: 2,
    step: 1,
    message: { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "reasoning", text: "think" }] },
  });
  event(11, "tool/call", { turn: 2, step: 1, callId: "c1", name: "read", arguments: JSON.stringify({ path: "/tmp/a.js" }) });
  event(12, "tool/result", {
    turn: 2,
    step: 1,
    message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "file" }] },
  });
  event(13, "turn/end", { turn: 2, reason: { kind: "completed" } });
  assert.equal(await drive.done, "end_turn");
  assert.deepEqual(updates.map((update) => update.sessionUpdate), [
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
  ]);
  assert.equal(updates[0].content.text, "hello");
  assert.equal(updates[1].content.text, "think");
  assert.equal(updates[2].kind, "read");
  assert.equal(updates[2].locations[0].path, "/tmp/a.js");
  assert.equal(updates[3].status, "completed");
});

test("history replay keeps user, assistant, and tool order", () => {
  const updates = historyUpdates([
    {
      seq: 1,
      type: "user/message",
      data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "old" }] },
    },
    {
      seq: 2,
      type: "user/message",
      data: { role: "user", source: { kind: "agent" }, content: [{ type: "text", text: "injected" }] },
    },
    {
      seq: 3,
      type: "assistant/message",
      data: { message: { content: [{ type: "reasoning", text: "think" }, { type: "text", text: "was" }] } },
    },
    {
      seq: 4,
      type: "tool/call",
      data: { callId: "c1", name: "bash", arguments: JSON.stringify({ command: "ls" }) },
    },
  ]);
  assert.deepEqual(updates.map((update) => update.sessionUpdate), [
    "user_message_chunk",
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call",
  ]);
  assert.equal(updates[0].content.text, "old");
  assert.equal(updates[2].content.text, "was");
});

test("approval choice maps onto the host outcome", () => {
  assert.equal(approvalValue({ outcome: "selected", optionId: "allow-once" }), "allowed-once");
  assert.equal(approvalValue({ outcome: "selected", optionId: "reject-once" }), "rejected");
  assert.equal(approvalValue({ outcome: "cancelled" }), "cancelled");
  assert.equal(approvalTitle({ toolName: "bash", displayReason: { en: "run", "zh-CN": "执行命令" } }), "执行命令");
});

test("ACP prompt round-trip forwards one web turn", async () => {
  const host = await fakeHost();
  const web = new WebClient({ base: host.base, cookie: "dsh-auth-test=ok" });
  const updates = [];
  const app = client().onNotification(CLIENT_METHODS.session_update, ({ params }) => {
    updates.push(params.update);
  });
  try {
    await app.connectWith(attach(agent({ name: "dsh-web-acp" }), web), async (ctx) => {
      const init = await ctx.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
      assert.equal(init.protocolVersion, 1);
      assert.equal(init.agentInfo.name, "dsh-web-acp");
      const created = await ctx.request(AGENT_METHODS.session_new, {
        cwd: "/tmp/proj",
        mcpServers: [],
      });
      assert.equal(created.sessionId, "session-1");
      const listed = await ctx.request(AGENT_METHODS.session_list, {});
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0].title, "已有会话");
      assert.equal(listed.sessions[0].cwd, "/tmp/proj");
      const resumed = await ctx.request(AGENT_METHODS.session_resume, {
        sessionId: "session-1",
        cwd: "/tmp/proj",
        mcpServers: [],
      });
      assert.equal(resumed.configOptions[0].id, "model");
      assert.equal(resumed.configOptions[0].currentValue, modelValue("buddy", "deepseek-v4-flash"));
      const result = await ctx.request(AGENT_METHODS.session_prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "hi" }],
      });
      assert.equal(result.stopReason, "end_turn");
      await ctx.request(AGENT_METHODS.session_close, { sessionId: created.sessionId });
    });
  } finally {
    web.closeSocket();
    await host.close();
  }
  assert.equal(host.prompt?.mode, "queue");
  assert.equal(host.prompt?.content[0].text, "hi");
  assert.equal(host.prompt?.payloadShape, "args.request");
  assert.deepEqual(updates.map((update) => update.sessionUpdate), [
    "agent_message_chunk",
    "tool_call",
    "tool_call_update",
  ]);
  assert.equal(updates[0].content.text, "hello");
  assert.equal(updates[2].content[0].content.text, "file");
});

test("session/load replays older pages before the live window", async () => {
  const older = [
    record(1, "user/message", { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "old" }] }),
    record(2, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "was" }] } }),
  ];
  const recent = [
    record(4, "user/message", { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "recent" }] }),
    record(5, "assistant/message", { turn: 2, step: 1, message: { content: [{ type: "text", text: "answer" }] } }),
  ];
  const host = await fakeHost({
    snapshot: {
      type: "snapshot",
      cursor: 5,
      records: recent,
      hasMore: true,
      header: { version: 4, id: "session-1", createdAt: 1, cwd: "/tmp/proj" },
      projections: { asOfSeq: 5, values: {} },
    },
    page: { records: older, hasMore: false },
  });
  const web = new WebClient({ base: host.base, cookie: "dsh-auth-test=ok" });
  const updates = [];
  const app = client().onNotification(CLIENT_METHODS.session_update, ({ params }) => {
    updates.push(params.update);
  });
  try {
    await app.connectWith(attach(agent({ name: "dsh-web-acp" }), web), async (ctx) => {
      const init = await ctx.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
      assert.equal(init.agentCapabilities.loadSession, true);
      await ctx.request(AGENT_METHODS.session_load, {
        sessionId: "session-1",
        cwd: "/tmp/proj",
        mcpServers: [],
      });
    });
  } finally {
    web.closeSocket();
    await host.close();
  }
  assert.equal(host.pageRequest.beforeSeq, 4);
  assert.equal(host.pageRequest.throughSeq, 5);
  assert.deepEqual(updates.map((update) => update.content?.text), ["old", "was", "recent", "answer"]);
});

test("model catalog becomes a client model selector", () => {
  const catalog = {
    default: { provider: "buddy", model: "deepseek-v4-flash" },
    groups: [{
      id: "buddy",
      name: "Buddy",
      models: [{
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" },
      }, {
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
      }],
    }],
  };
  const selection = currentSelection(catalog, {
    values: { modelSelection: { lastUsed: null, next: { provider: "buddy", model: "deepseek-v4.1-flash" } } },
  });
  const options = configOptions(catalog, selection);
  assert.equal(options[0].currentValue, modelValue("buddy", "deepseek-v4.1-flash"));
  assert.equal(options[0].options[0].options.length, 2);
  // 同名模型可能来自多家供应商，option 名字必须带供应商后缀。
  assert.equal(options[0].options[0].options[0].name, "DeepSeek V4 Flash (Buddy)");
  assert.equal(options[0].options[0].options[1].name, "DeepSeek V4.1 Flash (Buddy)");
  assert.equal(options[1], undefined);
  const next = applyConfig(catalog, selection, "model", modelValue("buddy", "deepseek-v4-flash"));
  assert.deepEqual(next, { provider: "buddy", model: "deepseek-v4-flash" });
  const withEffort = configOptions(catalog, next);
  assert.equal(withEffort[1].currentValue, "high");
  assert.deepEqual(applyConfig(catalog, next, "reasoning_effort", "high"), {
    provider: "buddy",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
  });
});

test("selecting a model forwards session/selectModel", async () => {
  const host = await fakeHost();
  const web = new WebClient({ base: host.base, cookie: "dsh-auth-test=ok" });
  try {
    await client().connectWith(attach(agent({ name: "dsh-web-acp" }), web), async (ctx) => {
      await ctx.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
      const created = await ctx.request(AGENT_METHODS.session_new, { cwd: "/tmp/proj", mcpServers: [] });
      assert.equal(created.configOptions[0].category, "model");
      const updated = await ctx.request(AGENT_METHODS.session_set_config_option, {
        sessionId: created.sessionId,
        configId: "model",
        value: modelValue("buddy", "deepseek-v4.1-flash"),
      });
      assert.equal(updated.configOptions[0].currentValue, modelValue("buddy", "deepseek-v4.1-flash"));
    });
  } finally {
    web.closeSocket();
    await host.close();
  }
  assert.deepEqual(host.selected, { provider: "buddy", model: "deepseek-v4.1-flash" });
  assert.equal(host.modelCatalogArgs, "empty");
});

test("approval request becomes a client permission dialog", async () => {
  const host = await fakeHost();
  const web = new WebClient({ base: host.base, cookie: "dsh-auth-test=ok" });
  const app = client().onRequest(CLIENT_METHODS.session_request_permission, ({ params }) => {
    assert.equal(params.sessionId, "session-1");
    assert.equal(params.toolCall.toolCallId, "call-9");
    assert.equal(params.options[0].kind, "allow_once");
    assert.equal(params.options[1].kind, "reject_once");
    return { outcome: { outcome: "selected", optionId: "allow-once" } };
  });
  try {
    await app.connectWith(attach(agent({ name: "dsh-web-acp" }), web), async (ctx) => {
      await ctx.request(AGENT_METHODS.initialize, { protocolVersion: 1 });
      await ctx.request(AGENT_METHODS.session_new, { cwd: "/tmp/proj", mcpServers: [] });
      await host.eventsReady;
      host.ask({ toolName: "bash", callId: "call-9", reason: "run echo" });
      await host.answerWait;
    });
  } finally {
    web.closeSocket();
    await host.close();
  }
  assert.equal(host.answered.clientId, "client-1");
  assert.equal(host.answered.eventId, "event-1");
  assert.deepEqual(host.answered.outcome, { kind: "result", value: "allowed-once" });
});

function record(seq, type, data) {
  return { type: "event", event: { seq, type, time: 1, data } };
}

function fakeHost(options = {}) {
  const follows = [];
  let resolveEvents = () => {};
  let resolveAnswer = () => {};
  const state = {
    prompt: null,
    pageRequest: null,
    answered: null,
    selected: null,
    modelCatalogArgs: null,
    base: "",
    close: async () => {},
    eventsReady: new Promise((resolve) => {
      resolveEvents = resolve;
    }),
    answerWait: new Promise((resolve) => {
      resolveAnswer = resolve;
    }),
    ask(request) {
      state.sendEvent?.({
        type: "waterfall",
        event: "approval/request",
        eventId: "event-1",
        agentId: "session-1",
        request,
      });
    },
  };
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/connect")) {
      res.writeHead(302, { "set-cookie": "dsh-auth-test=ok; Path=/; HttpOnly" });
      res.end();
      return;
    }
    const cookie = req.headers.cookie ?? "";
    if (!cookie.includes("dsh-auth-test=ok")) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const request = body?.payload?.args?.request;
      const method = body?.method;
      let value;
      if (method === "session/modelCatalog") {
        if (request || body?.payload?.request) {
          res.writeHead(400);
          res.end("bad envelope");
          return;
        }
        state.modelCatalogArgs = "empty";
        value = {
          default: { provider: "buddy", model: "deepseek-v4-flash" },
          routableProviders: ["buddy"],
          groups: [{
            id: "buddy",
            name: "Buddy",
            models: [
              { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
              { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
            ],
          }],
          failures: [],
        };
      } else if (method === "$events/result") {
        state.answered = body.payload.args;
        resolveAnswer(state.answered);
        value = {};
      } else if (!request || body?.payload?.request) {
        res.writeHead(400);
        res.end("bad envelope");
        return;
      } else if (method === "session/create") value = { sessionId: "session-1" };
      else if (method === "session/list") {
        value = {
          items: [{
            sessionId: "session-1",
            cwd: "/tmp/proj",
            updatedAt: Date.parse("2026-10-19T00:00:00Z"),
            projections: { values: { title: "已有会话" } },
          }, {
            sessionId: "child",
            parentSessionId: "session-1",
            cwd: "/tmp/proj",
            updatedAt: 1,
          }],
        };
      } else if (method === "session/prompt") {
        state.prompt = { ...request, payloadShape: "args.request" };
        replyTurn(follows, request.requestId);
        value = { accepted: true };
      } else if (method === "session/cancel") value = { accepted: true };
      else if (method === "session/page") {
        state.pageRequest = request;
        value = options.page ?? { records: [], hasMore: false };
      } else if (method === "session/projections") {
        value = {
          kind: "sequenced",
          asOfSeq: 0,
          values: { modelSelection: { lastUsed: state.selected, next: state.selected } },
        };
      } else if (method === "session/selectModel") {
        state.selected = {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        };
        value = { selected: state.selected };
      } else {
        res.writeHead(404);
        res.end("no method");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        type: "server-response",
        rpcId: body.rpcId,
        result: { ok: true, value },
      }));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!String(req.headers.cookie ?? "").includes("dsh-auth-test=ok")) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== "open") return;
        const send = (value) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "item", streamId: message.streamId, value }));
          }
        };
        if (message.endpoint === "$events") {
          if (message.payload?.args?.request) return;
          state.sendEvent = send;
          send({ type: "ready", clientId: "client-1", host: {} });
          resolveEvents();
          return;
        }
        if (message.endpoint !== "session/follow") return;
        follows.push(send);
        send(options.snapshot ?? {
          type: "snapshot",
          cursor: 3,
          header: { version: 4, id: "session-1", createdAt: 1, cwd: "/tmp/proj" },
          records: [],
          hasMore: false,
          projections: { asOfSeq: 3, values: {} },
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      state.base = `http://127.0.0.1:${address.port}`;
      state.close = () => new Promise((done) => {
        wss.close();
        server.close(() => done());
      });
      resolve(state);
    });
  });
}

function replyTurn(follows, requestId) {
  const send = (frame) => {
    for (const follow of follows) follow(frame);
  };
  const event = (seq, type, data) => send({ type: "event", event: { seq, type, time: 1, data } });
  event(4, "turn/start", { turn: 1 });
  event(5, "user/message", { role: "user", source: { kind: "user", rpcId: "other" }, content: [] });
  event(6, "assistant/message", {
    turn: 1,
    step: 1,
    message: { role: "assistant", content: [{ type: "text", text: "NOT-OURS" }] },
  });
  event(7, "turn/end", { turn: 1, reason: { kind: "completed" } });
  event(8, "turn/start", { turn: 2 });
  event(9, "user/message", {
    role: "user",
    source: { kind: "user", rpcId: requestId },
    content: [{ type: "text", text: "hi" }],
  });
  send({
    type: "assistant-stream",
    frame: { type: "chunk", turn: 2, step: 1, chunk: { type: "text-delta", text: "hello" } },
  });
  event(10, "assistant/message", {
    turn: 2,
    step: 1,
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  event(11, "tool/call", {
    turn: 2,
    step: 1,
    callId: "call-1",
    name: "bash",
    arguments: JSON.stringify({ command: "echo hi" }),
  });
  event(12, "tool/result", {
    turn: 2,
    step: 1,
    message: {
      role: "tool",
      toolCallId: "call-1",
      content: [{ type: "text", text: "file" }],
    },
  });
  event(13, "turn/end", { turn: 2, reason: { kind: "completed" } });
}
