/**
 * dsh-mcp-broker — per-session MCP attach for external ACP bridges.
 *
 * Exposes one host command `/mcp` whose handler mounts `@deepseek-ai/dsh-mcp-client`
 * instances under the *calling agent's* scope, so tools appear only in that session.
 * Remote callers reach it through the existing `commands/execute` endpoint; no new
 * Remote endpoints, no global patch rows per server.
 *
 * @module dsh-mcp-broker/lib/broker
 */

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Parse one `/mcp` invocation line.
 * Accepted forms (name is the DSH tool namespace, 1-32 chars of [A-Za-z0-9_-]):
 *   add <name> --command <abs-path> [--arg <v>]... [--env K=V]... [--cwd <dir>] [--timeout <ms>]
 *   add <name> --url <http(s)-url> [--header K=V]... [--timeout <ms>]
 *   add <json>            (full JSON object: {"name":...,"transport":{...}})
 *   remove <name> | list
 * @param {string} line - raw input after the command name.
 * @returns {{action: string, name?: string, config?: object}}
 */
export function parseMcpLine(line) {
  const trimmed = (line ?? "").trim();
  if (!trimmed) throw new Error("usage: /mcp add <name> --command <path> [--arg v] [--env K=V] | /mcp remove <name> | /mcp list");
  // JSON form: take the raw remainder before any quote-stripping split.
  const json = /^add\s+(\{[\s\S]*)$/.exec(trimmed);
  if (json !== null) {
    const parsed = JSON.parse(json[1]);
    return { action: "add", name: parsed.name, config: transportConfig(parsed.name, parsed.transport ?? parsed, parsed.cwd) };
  }
  const [action, ...rest] = splitArgs(trimmed);
  if (action === "list") return { action };
  if (action === "remove") {
    const name = rest[0];
    if (!name || !SERVER_NAME.test(name)) throw new Error(`invalid server name: ${name ?? "(missing)"}`);
    return { action, name };
  }
  if (action !== "add") throw new Error(`unknown action: ${action}`);
  const head = rest[0];
  return { action: "add", name: head, config: fromFlags(head, rest.slice(1)) };
}

/** Build a mcp-client config from CLI flags. */
function fromFlags(name, tokens) {
  if (!SERVER_NAME.test(name ?? "")) throw new Error(`invalid server name: ${name}`);
  const transport = { args: [], env: {}, headers: {} };
  let timeout;
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i];
    const value = tokens[++i];
    if (value === void 0) throw new Error(`${flag} requires a value`);
    switch (flag) {
      case "--command": transport.command = value; break;
      case "--arg": transport.args.push(value); break;
      case "--env": transport.env = assignPair(transport.env, value); break;
      case "--url": transport.url = value; break;
      case "--header": transport.headers = assignPair(transport.headers, value); break;
      case "--cwd": transport.cwd = value; break;
      case "--timeout": timeout = Number(value); break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  const config = transportConfig(name, transport);
  if (timeout !== void 0) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be a positive number of ms");
    config.toolCallTimeoutMs = timeout;
  }
  return config;
}

function transportConfig(name, t, sessionCwd) {
  if (!SERVER_NAME.test(name ?? "")) throw new Error(`invalid server name: ${name}`);
  if (t.type === "streamable-http" || (t.url !== void 0 && t.command === void 0)) {
    if (typeof t.url !== "string" || !/^https?:\/\//.test(t.url)) throw new Error(`server "${name}": url must be http(s)`);
    return {
      transport: "streamable-http",
      serverName: name,
      url: t.url,
      headers: toStringRecord(t.headers),
      failOnStartupError: true,
    };
  }
  if (typeof t.command !== "string" || !t.command.startsWith("/")) {
    throw new Error(`server "${name}": command must be an absolute path`);
  }
  return {
    transport: "stdio",
    serverName: name,
    command: t.command,
    args: Array.isArray(t.args) ? t.args.map(String) : [],
    env: toStringRecord(t.env),
    cwd: typeof t.cwd === "string" ? t.cwd : (typeof sessionCwd === "string" ? sessionCwd : ""),
    failOnStartupError: true,
  };
}

function toStringRecord(value) {
  const out = {};
  for (const [k, v] of Object.entries(value ?? {})) out[k] = String(v);
  return out;
}

function assignPair(record, pair) {
  const index = pair.indexOf("=");
  if (index <= 0) throw new Error(`expected KEY=VALUE, got: ${pair}`);
  return { ...record, [pair.slice(0, index)]: pair.slice(index + 1) };
}

/** Whitespace split honoring single/double quotes. */
function splitArgs(line) {
  const out = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(line)) !== null) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

const name = "mcp-broker";
const inject = ["commands"];

/**
 * @param {import("@deepseek-ai/cordis").Ctx} ctx
 */
async function apply(ctx) {
  /** @type {Map<string, {dispose: () => any}>} */
  const mounted = new Map();
  const key = (agentId, serverName) => `${agentId}\0${serverName}`;
  const sessionOf = (agent) => agent?.session?.header?.id ?? agent?.id;

  // Resolved lazily from the host's own bundle so the broker never pins a
  // dsh package version across upgrades.
  let clientModule;
  async function mcpClient() {
    if (clientModule === void 0) {
      clientModule = await ctx.loader.import("@deepseek-ai/dsh-mcp-client", ctx.baseUrl);
    }
    return clientModule;
  }

  async function detachAll(agentId) {
    for (const [mountKey, handle] of [...mounted.entries()]) {
      if (!mountKey.startsWith(`${agentId}\0`)) continue;
      mounted.delete(mountKey);
      try {
        await handle.dispose();
      } catch {}
    }
  }

  ctx.effect(() => {
    ctx.on("agent/disposed", ({ agent }) => void detachAll(sessionOf(agent)), { global: true });
    return () => {
      for (const handle of mounted.values()) {
        try {
          void handle.dispose();
        } catch {}
      }
      mounted.clear();
    };
  }, "mcp-broker.lifetime");

  return ctx.commands.register({
    name: "mcp",
    definitionId: "dsh-mcp-broker:mcp",
    description: "Attach or detach an MCP server for this session only (for external ACP bridges).",
    input: { hint: "add <name> --command <path> [--arg v] [--env K=V] | remove <name> | list" },
    recordInput: true,
    handler: async ({ agent, rawInput }) => {
      let parsed;
      try {
        parsed = parseMcpLine(rawInput);
      } catch (error) {
        return { kind: "error", text: error instanceof Error ? error.message : String(error) };
      }
      const agentId = sessionOf(agent);
      if (parsed.action === "list") {
        const names = [...mounted.keys()].filter((k) => k.startsWith(`${agentId}\0`)).map((k) => k.slice(agentId.length + 1));
        return { kind: "success", text: names.length > 0 ? `mounted: ${names.join(", ")}` : "mounted: (none)" };
      }
      if (parsed.action === "remove") {
        const handle = mounted.get(key(agentId, parsed.name));
        if (handle === void 0) return { kind: "error", text: `no MCP server "${parsed.name}" attached to this session` };
        mounted.delete(key(agentId, parsed.name));
        try {
          await handle.dispose();
        } catch (error) {
          return { kind: "error", text: `detach "${parsed.name}" failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        return { kind: "success", text: `MCP server "${parsed.name}" detached.` };
      }
      const mountKey = key(agentId, parsed.name);
      try {
        const client = await mcpClient();
        const fiber = await agent.ctx.plugin(client, parsed.config);
        const previous = mounted.get(mountKey);
        mounted.set(mountKey, { dispose: () => fiber.dispose() });
        // 重复 add 同名 = 替换：先挂新的成功再拆旧的，失败不丢原挂载。
        if (previous) {
          try {
            await previous.dispose();
          } catch {}
        }
        return { kind: "success", text: `MCP server "${parsed.name}" attached to this session.` };
      } catch (error) {
        return { kind: "error", text: `attach "${parsed.name}" failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });
}

export { apply, inject, name };
