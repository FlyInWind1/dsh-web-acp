/**
 * 对 `dsh web` 的 `/api` 封装：鉴权、HTTP RPC、以及 remote.mux 上的 follow / events 流。
 * 故意不碰 session.lock，好让网页和 ACP 客户端同时用同一会话。
 */
import crypto from "node:crypto";
import WebSocket from "ws";
import { exchangeCookie, parseLaunch, readJournal } from "./cookie.js";

export class AuthError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "AuthError";
    this.status = 401;
  }
}

class StreamQueue {
  constructor() {
    /** @type {any[]} */
    this.items = [];
    /** @type {((value: IteratorResult<any>) => void) | null} */
    this.waiting = null;
    this.ended = false;
    /** @type {Error | null} */
    this.error = null;
  }

  push(value) {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value, done: false });
      return;
    }
    this.items.push(value);
  }

  end() {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  fail(error) {
    this.error = error instanceof Error ? error : new Error(String(error));
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  next() {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.ended) {
      if (this.error) return Promise.reject(this.error);
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    }).then((result) => {
      if (this.error && result.done) throw this.error;
      return result;
    });
  }
}

/**
 * Web `/api` 客户端。一次性 RPC 走 HTTP，`session/follow` 走 `/api/remote.mux`。
 * 不打开 session.lock。
 */
export class WebClient {
  /**
   * @param {{ base?: string, cookie?: string, unit?: string, readJournal?: typeof readJournal }} options
   */
  constructor(options = {}) {
    this.pinnedBase = options.base;
    this.base = options.base ?? "http://127.0.0.1:3080";
    this.cookie = options.cookie;
    this.unit = options.unit ?? "dsh-web.service";
    this.readJournal = options.readJournal ?? readJournal;
    /** @type {WebSocket | null} */
    this.socket = null;
    /** @type {Map<string, StreamQueue>} */
    this.streams = new Map();
    this.connecting = null;
  }

  async ensureCookie(force = false) {
    if (this.cookie && !force) return this.cookie;
    const journal = await this.readJournal(this.unit);
    const launch = parseLaunch(journal);
    const base = this.pinnedBase ?? `http://127.0.0.1:${launch.port}`;
    this.base = base;
    this.cookie = await exchangeCookie(base, launch.token);
    this.closeSocket();
    return this.cookie;
  }

  closeSocket() {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    for (const stream of this.streams.values()) stream.fail(new Error("web socket closed"));
    this.streams.clear();
    socket?.close();
  }

  /**
   * @param {string} method
   * @param {object} request
   * @param {AbortSignal} [signal]
   */
  async call(method, request, signal) {
    return this.callArgs(method, { request }, signal);
  }

  /**
   * @param {string} method
   * @param {object} args
   * @param {AbortSignal} [signal]
   */
  async callArgs(method, args, signal) {
    return this.withAuth((cookie) => this.post(method, args, cookie, signal));
  }

  /** 把 `$events` 瀑布的决定送回去。`outcome` 是 `{kind:"result",value}` 或 `{kind:"next"}`。 */
  answerEvent(clientId, eventId, outcome, signal) {
    return this.callArgs("$events/result", { clientId, eventId, outcome }, signal);
  }

  /**
   * @param {string} sessionId
   * @param {AbortSignal} signal
   */
  follow(sessionId, signal) {
    return this.openStream("session/follow", {
      request: {
        address: { kind: "session", sessionId },
        assistantStream: true,
      },
    }, signal);
  }

  /** 宿主转发事件。第一条是 `{type:"ready", clientId}`。 */
  events(signal) {
    return this.openStream("$events", {}, signal);
  }

  /**
   * @param {string} endpoint
   * @param {object} args
   * @param {AbortSignal} signal
   */
  async *openStream(endpoint, args, signal) {
    const queue = await this.withAuth(async (cookie) => {
      const socket = await this.mux(cookie);
      const streamId = crypto.randomUUID();
      const stream = new StreamQueue();
      this.streams.set(streamId, stream);
      const onAbort = () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "cancel", streamId }));
        }
        stream.fail(new Error(`${endpoint} aborted`));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      socket.send(JSON.stringify({
        type: "open",
        streamId,
        endpoint,
        payload: { args },
      }));
      return stream;
    });
    while (true) {
      if (signal.aborted) return;
      const next = await queue.next();
      if (next.done) return;
      yield next.value;
    }
  }

  async withAuth(action) {
    await this.ensureCookie(false);
    try {
      return await action(this.cookie);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      await this.ensureCookie(true);
      return action(this.cookie);
    }
  }

  async post(method, args, cookie, signal) {
    const rpcId = crypto.randomUUID();
    const response = await fetch(new URL(`/api/${method}`, this.base), {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method,
        payload: { args },
      }),
      signal,
    });
    if (response.status === 401) throw new AuthError();
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.type !== "server-response") {
      throw new Error(`${method} HTTP ${response.status}`);
    }
    if (body.result?.ok !== true) {
      throw new Error(body.result?.error?.message ?? `${method} failed`);
    }
    return body.result.value;
  }

  mux(cookie) {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const url = new URL("/api/remote.mux", this.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.connecting = new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Cookie: cookie } });
      const fail = (error) => {
        if (this.socket === socket) this.closeSocket();
        reject(error);
      };
      socket.once("open", () => {
        this.socket = socket;
        this.connecting = null;
        resolve(socket);
      });
      socket.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
      socket.once("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        fail(status === 401 ? new AuthError() : new Error(`websocket HTTP ${status}`));
      });
      socket.on("message", (data) => this.onFrame(String(data)));
      socket.on("close", () => {
        if (this.socket === socket) this.closeSocket();
      });
    });
    return this.connecting;
  }

  onFrame(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const stream = this.streams.get(message.streamId);
    if (!stream) return;
    if (message.type === "item") stream.push(message.value);
    else if (message.type === "end") {
      this.streams.delete(message.streamId);
      stream.end();
    } else if (message.type === "error") {
      this.streams.delete(message.streamId);
      const detail = message.error?.message ?? message.error ?? "remote stream failed";
      stream.fail(new Error(typeof detail === "string" ? detail : "remote stream failed"));
    }
  }
}

/** @param {{ base?: string, cookie?: string, unit?: string }} [env] */
export function createWebClient(env = {}) {
  return new WebClient({
    base: env.base,
    cookie: env.cookie,
    unit: env.unit,
  });
}
