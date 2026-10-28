import assert from "node:assert/strict";
import test from "node:test";
import { apply, parseMcpLine } from "../index.js";

test("parseMcpLine reads stdio flags", () => {
  const parsed = parseMcpLine('add idea --command /opt/idea/mcp --arg --port=1 --env TOKEN=ab=cwd --cwd /tmp/p');
  assert.equal(parsed.action, "add");
  assert.equal(parsed.name, "idea");
  assert.deepEqual(parsed.config, {
    transport: "stdio",
    serverName: "idea",
    command: "/opt/idea/mcp",
    args: ["--port=1"],
    env: { TOKEN: "ab=cwd" },
    cwd: "/tmp/p",
    failOnStartupError: true,
  });
});

test("parseMcpLine reads http flags and timeout", () => {
  const parsed = parseMcpLine("add gw --url https://127.0.0.1:9/mcp --header A=1 --timeout 5000");
  assert.deepEqual(parsed.config, {
    transport: "streamable-http",
    serverName: "gw",
    url: "https://127.0.0.1:9/mcp",
    headers: { A: "1" },
    failOnStartupError: true,
    toolCallTimeoutMs: 5000,
  });
});

test("parseMcpLine reads the JSON form", () => {
  const line = JSON.stringify({ name: "s", transport: { type: "streamable-http", url: "http://x/y" } });
  const parsed = parseMcpLine(`add ${line}`);
  assert.equal(parsed.name, "s");
  assert.equal(parsed.config.transport, "streamable-http");
});

test("JSON form survives spaces in values", () => {
  const line = JSON.stringify({ name: "s", transport: { command: "/opt/my server/mcp", args: ["--x a b"] } });
  const parsed = parseMcpLine(`add ${line}`);
  assert.equal(parsed.config.command, "/opt/my server/mcp");
  assert.deepEqual(parsed.config.args, ["--x a b"]);
});

test("parseMcpLine validates", () => {
  assert.deepEqual(parseMcpLine("list"), { action: "list" });
  assert.deepEqual(parseMcpLine("remove idea"), { action: "remove", name: "idea" });
  assert.throws(() => parseMcpLine(""), /usage/);
  assert.throws(() => parseMcpLine("add bad!name --command /x"), /invalid server name/);
  assert.throws(() => parseMcpLine("add s --command relative/path"), /absolute path/);
  assert.throws(() => parseMcpLine("add s --url ftp://x"), /url must be http/);
  assert.throws(() => parseMcpLine("add s --command /x --env NOEQ"), /KEY=VALUE/);
});

/** Minimal cordis ctx surface the broker uses. */
function fakeCtx() {
  const registered = {};
  const listeners = new Map();
  const disposers = [];
  return {
    baseUrl: import.meta.url,
    loader: { import: async (name) => ({ __mcpClient: name }) },
    commands: { register: (def) => { registered[def.name] = def; return () => delete registered[def.name]; } },
    effect: (setup) => { const d = setup(); if (d) disposers.push(d); },
    on: (event, fn) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
    emit: (event, payload) => { for (const fn of listeners.get(event) ?? []) fn(payload); },
    disposeAll: () => disposers.forEach((d) => d()),
    registered,
  };
}

function fakeAgent(id) {
  const mounted = [];
  return {
    id,
    session: { header: { id } },
    ctx: { plugin: async (client, config) => {
      const handle = { config, disposed: false };
      mounted.push(handle);
      return { dispose: async () => { handle.disposed = true; } };
    } },
    mounted,
  };
}

test("handler attaches per agent, isolates sessions, detaches on dispose", async () => {
  const ctx = fakeCtx();
  await apply(ctx);
  const handler = ctx.registered.mcp.handler;
  const a = fakeAgent("agent-A");
  const b = fakeAgent("agent-B");

  const ok = await handler({ agent: a, rawInput: "add idea --command /opt/mcp" });
  assert.equal(ok.kind, "success");
  assert.equal(a.mounted.length, 1);
  assert.equal(a.mounted[0].config.serverName, "idea");

  const dup = await handler({ agent: a, rawInput: "add idea --command /opt/mcp" });
  assert.equal(dup.kind, "error");
  assert.match(dup.text, /already attached/);

  assert.equal((await handler({ agent: b, rawInput: "add idea --command /opt/mcp" })).kind, "success");
  const listA = await handler({ agent: a, rawInput: "list" });
  assert.equal(listA.text, "mounted: idea");

  const removed = await handler({ agent: a, rawInput: "remove idea" });
  assert.equal(removed.kind, "success");
  assert.equal(a.mounted[0].disposed, true);

  await handler({ agent: b, rawInput: "add gw --url http://127.0.0.1:9/mcp" });
  assert.equal(b.mounted.length, 2);
  ctx.emit("agent/disposed", { agent: b });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(b.mounted.every((m) => m.disposed));
});

test("attach failure surfaces as an error result", async () => {
  const ctx = fakeCtx();
  ctx.loader.import = async () => { throw new Error("module not found"); };
  await apply(ctx);
  const result = await ctx.registered.mcp.handler({ agent: fakeAgent("x"), rawInput: "add s --command /bin/srv" });
  assert.equal(result.kind, "error");
  assert.match(result.text, /module not found/);
});
