/**
 * 工具批准桥：监听宿主 `$events`，对本连接打开过的会话弹出 ACP 权限请求，
 * 再把允许/拒绝写回 web 的 `session/resolveApproval`。
 */
import { CLIENT_METHODS } from "@agentclientprotocol/sdk";
import { toolKind } from "./drive.js";

export function approvalTitle(request) {
  const display = request?.displayReason;
  if (display && typeof display === "object") {
    return display["zh-CN"] || display.zh || display.en || request.reason || request.toolName || "需要批准";
  }
  return request?.reason || request?.toolName || "需要批准";
}

/** @param {{ outcome?: string, optionId?: string }} outcome */
export function approvalValue(outcome) {
  if (outcome?.outcome === "cancelled") return "cancelled";
  if (outcome?.optionId === "allow-once") return "allowed-once";
  return "rejected";
}

/**
 * 听宿主的 `$events`。本连接打开过的会话弹出 ACP 批准框，其余交给别的客户端。
 * @param {import("./web.js").WebClient} web
 * @param {{ client: { request: Function }, signal: AbortSignal }} connection
 * @param {Map<string, unknown>} sessions
 */
export async function watchApprovals(web, connection, sessions) {
  let clientId = "";
  for await (const frame of web.events(connection.signal)) {
    if (connection.signal.aborted) return;
    if (frame?.type === "ready" && typeof frame.clientId === "string") {
      clientId = frame.clientId;
      continue;
    }
    if (!clientId || !frame?.eventId) continue;
    if (frame.type !== "waterfall" || frame.event !== "approval/request" || !sessions.has(frame.agentId)) {
      await web.answerEvent(clientId, frame.eventId, { kind: "next" }).catch(() => {});
      continue;
    }
    const request = frame.request ?? {};
    try {
      const response = await connection.client.request(CLIENT_METHODS.session_request_permission, {
        sessionId: frame.agentId,
        toolCall: {
          toolCallId: request.callId || frame.eventId,
          title: approvalTitle(request),
          ...(request.toolName ? { name: request.toolName, kind: toolKind(request.toolName) } : {}),
          status: "pending",
        },
        options: [
          { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
          { optionId: "reject-once", name: "拒绝", kind: "reject_once" },
        ],
      });
      await web.answerEvent(clientId, frame.eventId, {
        kind: "result",
        value: approvalValue(response?.outcome),
      });
    } catch (error) {
      if (connection.signal.aborted) return;
      console.error(`approval: ${error instanceof Error ? error.message : error}`);
      await web.answerEvent(clientId, frame.eventId, { kind: "next" }).catch(() => {});
    }
  }
}
