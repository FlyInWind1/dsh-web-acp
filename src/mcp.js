/**
 * ACP mcpServers → 宿主 `/mcp add` 行（dsh-mcp-broker 的 JSON 形式）。
 * 挂载是会话级的：工具只进这个 web 会话，不碰全局 patch。
 */

/** ACP env/headers 是 [{name,value}]，转成 record。 */
function toRecord(entries) {
  const out = {};
  for (const item of entries ?? []) {
    if (typeof item?.name === "string" && typeof item.value === "string") out[item.name] = item.value;
  }
  return out;
}

/**
 * @param {object} server - ACP McpServer（stdio 无 type，http 带 type:"http"）
 * @param {string} sessionCwd - 会话工作目录，stdio 子进程继承
 * @returns {{name: string, transport: object}}
 */
export function toBrokerEntry(server, sessionCwd) {
  const name = String(server?.name ?? "");
  if (server?.type === "http" || (typeof server?.url === "string" && server.command === void 0)) {
    return { name, transport: { type: "streamable-http", url: server.url, headers: toRecord(server.headers) } };
  }
  return {
    name,
    transport: {
      command: server?.command,
      args: Array.isArray(server?.args) ? server.args.map(String) : [],
      env: toRecord(server?.env),
      cwd: typeof sessionCwd === "string" && sessionCwd ? sessionCwd : undefined,
    },
  };
}

/**
 * 把会话的 mcpServers 全部 attach 到宿主；单个失败不阻断其余，错误汇总抛出。
 * @param {import("./web.js").WebClient} web
 * @param {string} sessionId
 * @param {Array} mcpServers
 * @param {string} cwd
 */
export async function attachMcpServers(web, sessionId, mcpServers, cwd) {
  const attached = [];
  const failures = [];
  for (const server of mcpServers ?? []) {
    const entry = toBrokerEntry(server, cwd);
    const line = `/mcp add ${JSON.stringify(entry)}`;
    try {
      const value = await web.callArgs("commands/execute", {
        agentId: sessionId,
        line,
        submittedAttachments: [],
      });
      if (value?.result?.kind === "success") attached.push(entry.name);
      else failures.push(`${entry.name}: ${value?.result?.text ?? "attach failed"}`);
    } catch (error) {
      failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { attached, failures };
}
