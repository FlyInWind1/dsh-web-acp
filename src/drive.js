/**
 * 单次 prompt 的驱动器：把 Web follow 帧（事件 / chunk）翻成 ACP `session/update`，
 * 只认本轮（按 requestId / turn），并在对应 `turn/end` 时结束。
 */

export function stopReasonOf(reason) {
  if (reason?.kind === "aborted") return "cancelled";
  if (reason?.kind === "max-tokens") return "max_tokens";
  return "end_turn";
}

export function toolKind(name) {
  if (name === "bash" || name === "shell") return "execute";
  if (name === "read") return "read";
  if (name === "grep" || name === "glob") return "search";
  if (name === "edit" || name === "write") return "edit";
  if (name === "web_search" || name === "web_fetch" || name === "read_page") return "fetch";
  return "other";
}

function parseArgs(raw) {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function titleOf(name, raw) {
  const args = parseArgs(raw);
  const hint =
    args && typeof args === "object"
      ? args.command || args.path || args.file_path || args.query || ""
      : "";
  const extra = String(hint).replace(/\s+/g, " ").trim().slice(0, 80);
  return extra ? `${name} ${extra}` : name;
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * @param {{ requestId: string, baseline: number, emit: (update: object) => void }} options
 */
export function createDrive({ requestId, baseline, emit }) {
  let boundTurn = /** @type {number | null} */ (null);
  let pendingTurn = /** @type {number | null} */ (null);
  const streamedText = new Set();
  const streamedThought = new Set();
  const announcedTools = new Set();
  let settled = false;
  /** @type {(reason: string) => void} */
  let resolve;
  /** @type {(error: Error) => void} */
  let reject;
  const done = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  function finish(reason) {
    if (settled) return;
    settled = true;
    resolve(reason);
  }

  function fail(error) {
    if (settled) return;
    settled = true;
    reject(error instanceof Error ? error : new Error(String(error)));
  }

  function onStream(frame) {
    if (frame?.type !== "chunk" || frame.turn !== boundTurn) return;
    const chunk = frame.chunk;
    if (chunk?.type === "text-delta" && chunk.text) {
      streamedText.add(frame.step);
      emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk.text },
      });
    } else if (chunk?.type === "reasoning-delta" && chunk.text) {
      streamedThought.add(frame.step);
      emit({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: chunk.text },
      });
    }
  }

  function onEvent(event) {
    if (!event || typeof event.seq !== "number" || event.seq <= baseline) return;
    const data = event.data ?? {};
    if (event.type === "turn/start") {
      pendingTurn = data.turn;
      return;
    }
    if (event.type === "user/message") {
      if (data.source?.rpcId === requestId) boundTurn = pendingTurn ?? data.turn ?? null;
      else pendingTurn = null;
      return;
    }
    if (boundTurn == null || data.turn !== boundTurn) return;
    if (event.type === "assistant/message") {
      const blocks = data.message?.content;
      if (!streamedText.has(data.step)) {
        const visible = Array.isArray(blocks)
          ? blocks.filter((block) => block?.type === "text").map((block) => block.text).join("")
          : "";
        if (visible) {
          emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: visible },
          });
        }
      }
      if (!streamedThought.has(data.step) && Array.isArray(blocks)) {
        const thought = blocks
          .filter((block) => block?.type === "reasoning" && block.text)
          .map((block) => block.text)
          .join("");
        if (thought) {
          emit({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: thought },
          });
        }
      }
      return;
    }
    if (event.type === "tool/call") {
      if (announcedTools.has(data.callId)) return;
      announcedTools.add(data.callId);
      const args = parseArgs(data.arguments);
      const path = args && typeof args === "object" ? args.path || args.file_path : undefined;
      emit({
        sessionUpdate: "tool_call",
        toolCallId: data.callId,
        title: titleOf(data.name, data.arguments),
        name: data.name,
        kind: toolKind(data.name),
        status: "in_progress",
        rawInput: args,
        ...(typeof path === "string" && path.startsWith("/") ? { locations: [{ path }] } : {}),
      });
      return;
    }
    if (event.type === "tool/result") {
      const callId = data.message?.toolCallId ?? data.message?.source?.callId;
      const failed = data.message?.isError === true;
      const text = textOf(data.message?.content) || data.error?.reason || "";
      emit({
        sessionUpdate: "tool_call_update",
        toolCallId: callId,
        status: failed ? "failed" : "completed",
        ...(text
          ? { content: [{ type: "content", content: { type: "text", text } }] }
          : {}),
      });
      return;
    }
    if (event.type === "turn/end") {
      if (data.reason?.kind === "error" && data.reason.error?.message) {
        emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: data.reason.error.message },
        });
      }
      finish(stopReasonOf(data.reason));
    }
  }

  return {
    done,
    fail,
    /**
     * @param {any} frame
     */
    push(frame) {
      if (settled || !frame) return;
      if (frame.type === "assistant-stream") onStream(frame.frame);
      else if (frame.type === "event") onEvent(frame.event);
    },
  };
}

/** ACP prompt 块收成 Web 能接受的 text part。至少一块非空白文本。 */
export function promptContent(blocks) {
  /** @type {{ type: "text", text: string }[]} */
  const content = [];
  for (const block of blocks ?? []) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      content.push({ type: "text", text: block.text });
    } else if (block?.type === "resource_link") {
      const label = [block.name, block.uri].filter(Boolean).join(" ");
      if (label.trim()) content.push({ type: "text", text: label });
    } else if (block?.type === "resource" && typeof block.resource?.text === "string") {
      if (block.resource.text.trim()) content.push({ type: "text", text: block.resource.text });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "(empty prompt)" });
  return content;
}
