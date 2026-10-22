/**
 * ACP Agent 侧：把 session 新建/加载/提示/取消/模型选择接到 Web `/api`。
 * 每个打开的会话共用一条 follow 流（Feed），历史回放、本轮 drive、批准监听都从这里串起来。
 */
import crypto from "node:crypto";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import { watchApprovals } from "./approval.js";
import { createDrive, promptContent } from "./drive.js";
import { replayHistory } from "./history.js";
import { applyConfig, configOptions, currentSelection } from "./models.js";

/**
 * @param {import("@agentclientprotocol/sdk").AgentApp} app
 * @param {import("./web.js").WebClient} web
 */
export function attach(app, web) {
  /** @type {Map<string, { cwd: string, feed: Feed | null, replayed: boolean }>} */
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

  async function replay(record, sessionId, client) {
    const feed = record.feed ?? new Feed(web, sessionId);
    record.feed = feed;
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

  async function sessionConfig(sessionId) {
    try {
      const catalog = await web.callArgs("session/modelCatalog", {});
      const projection = await web.call("session/projections", { sessionId }).catch(() => null);
      const options = configOptions(catalog, currentSelection(catalog, projection));
      return options.length > 0 ? { configOptions: options } : {};
    } catch (error) {
      console.error(`model catalog: ${error instanceof Error ? error.message : error}`);
      return {};
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
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
    }))
    .onRequest(AGENT_METHODS.session_new, async ({ params }) => {
      const value = await web.call("session/create", { cwd: params.cwd });
      remember(value.sessionId, params.cwd);
      return { sessionId: value.sessionId, ...await sessionConfig(value.sessionId) };
    })
    .onRequest(AGENT_METHODS.session_list, async ({ params }) => {
      const value = await web.call("session/list", params.cursor ? { cursor: params.cursor } : {});
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
      await replay(record, params.sessionId, client);
      return sessionConfig(params.sessionId);
    })
    .onRequest(AGENT_METHODS.session_resume, async ({ params, client }) => {
      const record = remember(params.sessionId, params.cwd);
      await replay(record, params.sessionId, client);
      return sessionConfig(params.sessionId);
    })
    .onRequest(AGENT_METHODS.session_set_config_option, async ({ params }) => {
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
      const feed = record.feed ?? new Feed(web, params.sessionId);
      record.feed = feed;
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
   */
  constructor(web, sessionId) {
    this.cursor = 0;
    this.snapshot = null;
    this.drives = new Set();
    this.stopped = false;
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
