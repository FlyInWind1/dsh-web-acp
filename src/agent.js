/**
 * ACP Agent 侧：把 session 新建/加载/提示/取消/模型选择接到 Web `/api`。
 * 每个打开的会话共用一条 follow 流（Feed），历史回放、本轮 drive、批准监听都从这里串起来。
 */
import crypto from "node:crypto";
import { AGENT_METHODS, CLIENT_METHODS, RequestError } from "@agentclientprotocol/sdk";
import { watchApprovals } from "./approval.js";
import { createDrive, promptContent } from "./drive.js";
import { replayHistory } from "./history.js";
import { attachMcpServers } from "./mcp.js";
import { applyConfig, configOptions, currentSelection } from "./models.js";
import { parsePermissionOutput, permissionOption } from "./permissions.js";

/**
 * @param {import("@agentclientprotocol/sdk").AgentApp} app
 * @param {import("./web.js").WebClient} web
 */
export function attach(app, web) {
  /** @type {Map<string, { cwd: string, feed: Feed | null, replayed: boolean, modeId?: string }>} */
  const sessions = new Map();

  function remember(sessionId, cwd) {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.cwd = cwd || existing.cwd;
      return existing;
    }
    const created = { cwd, feed: null, replayed: false };
    sessions.set(sessionId, created);
    return created;
  }

  function ensureFeed(record, sessionId, client) {
    if (record.feed) return record.feed;
    const feed = new Feed(web, sessionId, (active) => {
      const modeId = active ? "plan" : "default";
      record.modeId = modeId;
      client.notify(CLIENT_METHODS.session_update, {
        sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: modeId },
      }).catch(() => {});
    });
    record.feed = feed;
    return feed;
  }

  async function replay(record, sessionId, client) {
    const feed = ensureFeed(record, sessionId, client);
    const snapshot = await feed.ready;
    if (record.replayed) return;
    record.replayed = true;
    try {
      await replayHistory(web, sessionId, snapshot, (update) => client.notify(CLIENT_METHODS.session_update, {
        sessionId,
        update,
      }));
    } catch (error) {
      record.replayed = false;
      throw error;
    }
  }

  // ACP mode ↔ DSH plan 模式：宿主端用 commands/execute 跑 `/plan`、`/plan off`，
  // 权威状态在投影 values.plan.active。没有 availableModes 时 IDEA 会把模式
  // 切换当成"需要新 chat"，所以必须声明。
  const AVAILABLE_MODES = [
    { id: "default", name: "Agent", description: "Full tool access" },
    { id: "plan", name: "Plan", description: "Read-only planning until the plan is approved" },
  ];

  function modesFor(projection) {
    return {
      currentModeId: projection?.values?.plan?.active === true ? "plan" : "default",
      availableModes: AVAILABLE_MODES,
    };
  }

  async function mountMcp(sessionId, mcpServers, cwd) {
    if (!mcpServers?.length) return;
    const { failures } = await attachMcpServers(web, sessionId, mcpServers, cwd);
    if (failures.length > 0) console.error(`mcp attach: ${failures.join("; ")}`);
  }

  /** 跑一条宿主 `/permission` 命令（无 request 包装的 commands/execute）。 */
  async function runPermission(sessionId, arg) {
    const value = await web.callArgs("commands/execute", {
      agentId: sessionId,
      line: arg ? `/permission ${arg}` : "/permission",
      submittedAttachments: [],
    });
    if (value?.result?.kind === "error") throw new Error(value.result.text);
    return value?.result?.text ?? "";
  }

  async function permissionState(sessionId) {
    try {
      return parsePermissionOutput(await runPermission(sessionId));
    } catch (error) {
      console.error(`permission: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /** 完整 config options（model + reasoning + permission），供响应与回读。 */
  async function allConfigOptions(sessionId) {
    const catalog = await web.callArgs("session/modelCatalog", {});
    const projection = await web.call("session/projections", { sessionId }).catch(() => null);
    const options = configOptions(catalog, currentSelection(catalog, projection));
    const permission = permissionOption(await permissionState(sessionId));
    if (permission) options.push(permission);
    return options;
  }

  async function sessionConfig(sessionId) {
    let projection = null;
    try {
      projection = await web.call("session/projections", { sessionId }).catch(() => null);
      const options = await allConfigOptions(sessionId);
      const modes = modesFor(projection);
      const record = sessions.get(sessionId);
      if (record) record.modeId = modes.currentModeId;
      return {
        modes,
        ...(options.length > 0 ? { configOptions: options } : {}),
      };
    } catch (error) {
      console.error(`model catalog: ${error instanceof Error ? error.message : error}`);
      return { modes: modesFor(projection) };
    }
  }

  return app
    .onConnect((connection) => {
      watchApprovals(web, connection, sessions).catch((error) => {
        if (connection.signal.aborted) return;
        console.error(`approval watch: ${error instanceof Error ? error.message : error}`);
      });
    })
    .onRequest(AGENT_METHODS.initialize, () => ({
      protocolVersion: 1,
      agentInfo: { name: "dsh-web-acp", version: "0.1.0" },
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
    }))
    .onRequest(AGENT_METHODS.session_new, async ({ params }) => {
      const value = await web.call("session/create", { cwd: params.cwd });
      remember(value.sessionId, params.cwd);
      await mountMcp(value.sessionId, params.mcpServers, params.cwd);
      return { sessionId: value.sessionId, ...await sessionConfig(value.sessionId) };
    })
    .onRequest(AGENT_METHODS.session_list, async ({ params }) => {
      const value = await web.callArgs("session/list", {
        _request: params.cursor ? { cursor: params.cursor } : {},
      });
      const sessionsOut = [];
      for (const item of value?.items ?? []) {
        if (item.origin === "subagent" || item.parentSessionId) continue;
        const cwd = item.cwd || sessions.get(item.sessionId)?.cwd || "/";
        if (params.cwd && cwd !== params.cwd) continue;
        const title = item.projections?.values?.title;
        sessionsOut.push({
          sessionId: item.sessionId,
          cwd,
          ...(typeof title === "string" ? { title } : {}),
          ...(typeof item.updatedAt === "number"
            ? { updatedAt: new Date(item.updatedAt).toISOString() }
            : {}),
        });
      }
      return { sessions: sessionsOut };
    })
    .onRequest(AGENT_METHODS.session_load, async ({ params, client }) => {
      const record = remember(params.sessionId, params.cwd);
      await mountMcp(params.sessionId, params.mcpServers, params.cwd);
      await replay(record, params.sessionId, client);
      return sessionConfig(params.sessionId);
    })
    .onRequest(AGENT_METHODS.session_resume, async ({ params, client }) => {
      const record = remember(params.sessionId, params.cwd);
      await mountMcp(params.sessionId, params.mcpServers, params.cwd);
      await replay(record, params.sessionId, client);
      return sessionConfig(params.sessionId);
    })
    .onRequest(AGENT_METHODS.session_set_mode, async ({ params, client }) => {
      if (params.modeId !== "default" && params.modeId !== "plan") {
        throw RequestError.invalidParams(void 0, `unknown mode: ${params.modeId}`);
      }
      const record = remember(params.sessionId, "");
      // 宿主端点参数是顶层 agentId/line/submittedAttachments（无 request 包装）。
      await web.callArgs("commands/execute", {
        agentId: params.sessionId,
        line: params.modeId === "plan" ? "/plan" : "/plan off",
        submittedAttachments: [],
      });
      record.modeId = params.modeId;
      // feed 可能还没开（没 prompt 过），直接通知一次；
      // 模型自己经 exit_plan_mode 退出时由 Feed 的 plan/mode 钩子通知。
      client.notify(CLIENT_METHODS.session_update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
      }).catch(() => {});
      return {};
    })
    .onRequest(AGENT_METHODS.session_set_config_option, async ({ params }) => {
      if (params.configId === "permission") {
        if (typeof params.value !== "string") {
          throw RequestError.invalidParams(void 0, "permission requires a select value");
        }
        await runPermission(params.sessionId, params.value);
        return { configOptions: await allConfigOptions(params.sessionId) };
      }
      const catalog = await web.callArgs("session/modelCatalog", {});
      const projection = await web.call("session/projections", { sessionId: params.sessionId }).catch(() => null);
      const next = applyConfig(catalog, currentSelection(catalog, projection), params.configId, params.value);
      const selected = await web.call("session/selectModel", {
        sessionId: params.sessionId,
        ...next,
      });
      return { configOptions: configOptions(catalog, selected?.selected ?? next) };
    })
    .onRequest(AGENT_METHODS.session_close, ({ params }) => {
      sessions.get(params.sessionId)?.feed?.stop();
      sessions.delete(params.sessionId);
      return {};
    })
    .onRequest(AGENT_METHODS.session_prompt, async ({ params, client, signal }) => {
      const record = remember(params.sessionId, "");
      const feed = ensureFeed(record, params.sessionId, client);
      await feed.ready;
      const requestId = crypto.randomUUID();
      const drive = createDrive({
        requestId,
        baseline: feed.cursor,
        emit: (update) => client.notify(CLIENT_METHODS.session_update, {
          sessionId: params.sessionId,
          update,
        }),
      });
      feed.add(drive);
      const onAbort = () => {
        web.call("session/cancel", { sessionId: params.sessionId }).catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await web.call("session/prompt", {
          requestId,
          sessionId: params.sessionId,
          mode: "queue",
          content: promptContent(params.prompt),
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }, signal);
        return { stopReason: await drive.done };
      } finally {
        signal.removeEventListener("abort", onAbort);
        feed.remove(drive);
      }
    })
    .onNotification(AGENT_METHODS.session_cancel, ({ params }) => {
      web.call("session/cancel", { sessionId: params.sessionId }).catch(() => {});
    });
}

/** 单会话的 follow 复用器：一条 mux 流扇出到多个 drive，并缓存首包 snapshot 供回放。 */
class Feed {
  /**
   * @param {import("./web.js").WebClient} web
   * @param {string} sessionId
   * @param {((active: boolean) => void) | null} [onPlanMode] 宿主 plan/mode 事件的回调
   */
  constructor(web, sessionId, onPlanMode = null) {
    this.cursor = 0;
    this.snapshot = null;
    this.drives = new Set();
    this.stopped = false;
    this.onPlanMode = onPlanMode;
    this.abort = new AbortController();
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.task = this.run(web, sessionId);
  }

  add(drive) {
    this.drives.add(drive);
  }

  remove(drive) {
    this.drives.delete(drive);
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
  }

  async run(web, sessionId) {
    try {
      for await (const frame of web.follow(sessionId, this.abort.signal)) {
        if (frame?.type === "snapshot") {
          if (typeof frame.cursor === "number") this.cursor = frame.cursor;
          if (!this.snapshot) {
            this.snapshot = frame;
            this.resolveReady(frame);
          }
        } else if (frame?.type === "event" && typeof frame.event?.seq === "number") {
          this.cursor = Math.max(this.cursor, frame.event.seq);
          if (frame.event.type === "plan/mode" && this.onPlanMode) {
            this.onPlanMode(frame.event.data?.active === true);
          }
        }
        for (const drive of this.drives) drive.push(frame);
      }
      if (!this.stopped) {
        const error = new Error("session follow ended");
        this.rejectReady(error);
        for (const drive of this.drives) drive.fail(error);
      }
    } catch (error) {
      if (this.stopped || this.abort.signal.aborted) return;
      this.rejectReady(error);
      for (const drive of this.drives) drive.fail(error);
    }
  }
}
