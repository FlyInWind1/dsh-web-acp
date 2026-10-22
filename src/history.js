/**
 * 会话历史回放：把 durable 事件（及更早分页）收成 ACP `session/update`，
 * 打开已有会话时先灌给客户端。只保留用户原话、助手正文/思考和工具调用。
 */
import { toolKind } from "./drive.js";

export function historyUpdates(events) {
  /** @type {object[]} */
  const updates = [];
  for (const event of events) {
    if (!event?.type) continue;
    const data = event.data ?? {};
    if (event.type === "user/message") {
      const kind = data.source?.kind;
      if (kind && kind !== "user") continue;
      const text = joinText(data.content);
      if (!text.trim()) continue;
      updates.push({
        sessionUpdate: "user_message_chunk",
        messageId: String(event.seq),
        content: { type: "text", text },
      });
      continue;
    }
    if (event.type === "assistant/message") {
      const blocks = data.message?.content;
      if (!Array.isArray(blocks)) continue;
      const thought = blocks
        .filter((block) => block?.type === "reasoning" && block.text)
        .map((block) => block.text)
        .join("");
      const text = blocks
        .filter((block) => block?.type === "text" && block.text)
        .map((block) => block.text)
        .join("");
      if (thought) {
        updates.push({
          sessionUpdate: "agent_thought_chunk",
          messageId: `${event.seq}:thought`,
          content: { type: "text", text: thought },
        });
      }
      if (text) {
        updates.push({
          sessionUpdate: "agent_message_chunk",
          messageId: String(event.seq),
          content: { type: "text", text },
        });
      }
      continue;
    }
    if (event.type === "tool/call") {
      updates.push(toolCallUpdate(data));
      continue;
    }
    if (event.type === "tool/result") {
      const callId = data.message?.toolCallId ?? data.message?.source?.callId;
      const failed = data.message?.isError === true;
      const text = joinText(data.message?.content) || data.error?.reason || "";
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: callId,
        status: failed ? "failed" : "completed",
        ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
      });
    }
  }
  return updates;
}

function joinText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function toolCallUpdate(data) {
  let raw = data.arguments;
  if (typeof raw === "string" && raw) {
    try {
      raw = JSON.parse(raw);
    } catch {
      /* keep the raw string */
    }
  }
  const hint = raw && typeof raw === "object" ? raw.command || raw.path || raw.file_path || "" : "";
  const extra = String(hint).replace(/\s+/g, " ").trim().slice(0, 80);
  const path = raw && typeof raw === "object" ? raw.path || raw.file_path : undefined;
  return {
    sessionUpdate: "tool_call",
    toolCallId: data.callId,
    title: extra ? `${data.name} ${extra}` : data.name,
    name: data.name,
    kind: toolKind(data.name),
    status: "in_progress",
    rawInput: raw,
    ...(typeof path === "string" && path.startsWith("/") ? { locations: [{ path }] } : {}),
  };
}

function firstSeq(records) {
  const seq = records?.[0]?.event?.seq;
  return typeof seq === "number" ? seq : null;
}

/**
 * 快照窗口不够时用 session/page 向前补齐，按时间顺序吐出 ACP 更新。
 * @param {import("./web.js").WebClient} web
 * @param {string} sessionId
 * @param {{ cursor: number, records?: any[], hasMore?: boolean }} snapshot
 * @param {(update: object) => Promise<void> | void} emit
 */
export async function replayHistory(web, sessionId, snapshot, emit) {
  /** @type {any[][]} */
  const older = [];
  let before = firstSeq(snapshot.records);
  let hasMore = snapshot.hasMore === true && before != null;
  for (let page = 0; hasMore && page < 40; page += 1) {
    const value = await web.call("session/page", {
      address: { kind: "session", sessionId },
      throughSeq: snapshot.cursor,
      beforeSeq: before,
      maxMessages: 200,
    });
    const records = value?.records ?? [];
    if (records.length === 0) break;
    older.push(records);
    const nextBefore = firstSeq(records);
    if (nextBefore == null || nextBefore >= before) break;
    before = nextBefore;
    hasMore = value.hasMore === true;
  }
  /** @type {any[]} */
  const events = [];
  for (const records of older.reverse()) {
    for (const record of records) if (record?.event) events.push(record.event);
  }
  for (const record of snapshot.records ?? []) if (record?.event) events.push(record.event);
  for (const update of historyUpdates(events)) await emit(update);
}
