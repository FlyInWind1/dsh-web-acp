/**
 * 从本次 `dsh web` 启动日志里解析 launch token，并用 `/connect` 换成 API Cookie。
 * 默认靠 `journalctl --user` 读 systemd 用户单元日志。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LAUNCH_URL =
  /http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)|https?:\/\/[^\s/:]+(?::(\d+))?\/\?token=(\S+)/g;

/**
 * 从本次 `dsh web` 启动日志里取出 launch token。
 * 直连地址带端口；`--public-url` 的地址不带端口，调用仍走回环。
 * @param {string} journal
 * @returns {{ port: string, token: string }}
 */
export function parseLaunch(journal) {
  const started = journal.lastIndexOf("Started DeepSeek Harness Web");
  const chunk = started === -1 ? journal : journal.slice(started);
  LAUNCH_URL.lastIndex = 0;
  let last;
  for (let match = LAUNCH_URL.exec(chunk); match; match = LAUNCH_URL.exec(chunk)) last = match;
  if (!last) throw new Error("本次 dsh-web 启动日志里没有带 token 的地址");
  const [, loopPort, loopToken, urlPort, urlToken] = last;
  if (loopToken) return { port: loopPort, token: loopToken };
  return { port: urlPort || "3080", token: urlToken };
}

/** @param {string} unit */
export async function readJournal(unit) {
  // `-I` 只留本次启动的日志，`-g` 再过滤出含 token 的行 → 1 行。
  const { stdout } = await execFileAsync(
    "journalctl",
    ["--user", "-u", unit, "-I", "-g", "dsh web: ", "--no-pager"],
    { encoding: "utf8", maxBuffer: 1 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * `GET /connect?token=` 换 API Cookie。不跟随 302。
 * 返回值是 `name=value`，不含属性。
 * @param {string} base
 * @param {string} token
 */
export async function exchangeCookie(base, token) {
  const url = new URL("/connect", base);
  url.searchParams.set("token", token);
  // 必须是 answer：批准转发用的 $events 流要求 cookie 以 interactions=answer 签发，
  // none 会让 approval watch 报 "forwarded Remote events require interactions=answer"。
  url.searchParams.set("interactions", "answer");
  const response = await fetch(url, { redirect: "manual" });
  const raw = response.headers.get("set-cookie") ?? "";
  if (response.status !== 302 || !raw) {
    throw new Error(`换 Cookie 失败，HTTP ${response.status}`);
  }
  const pair = raw.split(";", 1)[0].trim();
  const name = pair.slice(0, pair.indexOf("="));
  if (!name.startsWith("dsh-auth-") || pair.length <= name.length + 1) {
    throw new Error("Set-Cookie 不是 dsh-auth");
  }
  return pair;
}
