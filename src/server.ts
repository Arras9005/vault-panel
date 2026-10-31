#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { csvToEntries } from "./csv.js";
import { ensureConfig, loadConfig, resolveConfigFile, type PanelConfig } from "./config.js";
import { AttemptLimiter } from "./limiter.js";
import { Vault, VaultError } from "./vault.js";
import { buildXlsx } from "./xlsx.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const hasFlag = (name: string): boolean => argv.includes(name);
const optionValue = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

function exitWith(message: string): never {
  console.error(`\n[错误] ${message}\n`);
  process.exit(1);
}

const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "";

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`vault-panel ${version}\n本机运行的账号密码管理网页:表格查看用户名和密码,可导出 Excel。\n
用法: vault-panel [选项]

  --config <文件>   配置文件路径(也可用环境变量 VAULT_PANEL_CONFIG)
  --vault <文件>    本次运行使用的保险库文件(覆盖配置里的 vaultFile,不写回配置)
  --port <端口>     本次运行使用的端口(覆盖配置里的 port,不写回配置)
  --no-open         启动时不自动打开浏览器
  -v, --version     显示版本
  -h, --help        显示帮助

默认配置文件是 ~/.vault-panel/config.json,保险库默认是同目录的 vault.enc;不存在会自动创建。`);
  process.exit(0);
}
if (hasFlag("--version") || hasFlag("-v")) {
  console.log(version);
  process.exit(0);
}

const configFile = resolveConfigFile(optionValue("--config"));
try {
  if (ensureConfig(configFile)) console.log(`[配置] 首次运行,已创建配置文件:${configFile}`);
} catch (error) {
  exitWith(`无法创建配置文件 ${configFile}:${(error as Error).message}`);
}

function loadOrExit(): PanelConfig {
  try {
    return loadConfig(configFile);
  } catch (error) {
    return exitWith((error as Error).message);
  }
}

const config = loadOrExit();
const portArg = optionValue("--port");
const listenPort = portArg === undefined ? config.port : Number(portArg);
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) exitWith("--port 必须是 1-65535 的整数");
const vaultArg = optionValue("--vault");
const vaultFile = vaultArg ? resolve(vaultArg) : config.vaultFile;
const shouldOpenBrowser = config.openBrowser && !hasFlag("--no-open");

const vault = new Vault(vaultFile);
const limiter = new AttemptLimiter();
const allowedHosts = [`127.0.0.1:${listenPort}`, `localhost:${listenPort}`];
const allowedOrigins = allowedHosts.map((host) => `http://${host}`);

// ---------- 登录:一次性链接换 Cookie ----------
// Cookie 不区分端口,名字里带上端口,同时开两个实例时才不会互相覆盖
const COOKIE = `vp_session_${listenPort}`;
const sessions = new Set<string>();
let loginToken = randomBytes(16).toString("hex");

function loginUrl(): string {
  return `http://127.0.0.1:${listenPort}/login?t=${loginToken}`;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionOf(req: IncomingMessage): string | undefined {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return undefined;
}

function hasSession(req: IncomingMessage): boolean {
  const id = sessionOf(req);
  return id !== undefined && sessions.has(id);
}

// ---------- 自动锁定 ----------
let lastActive = Date.now();
if (config.autoLockMinutes > 0) {
  setInterval(() => {
    if (vault.unlocked && Date.now() - lastActive > config.autoLockMinutes * 60_000) {
      vault.lock();
      console.log(`[锁定] ${config.autoLockMinutes} 分钟无操作,保险库已自动锁定。`);
    }
  }, 10_000).unref();
}

// ---------- 响应 ----------
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** 页面是自包含的:脚本和样式只允许带本次随机 nonce 的内联块,只请求同源接口,不加载任何外部资源。 */
function policy(nonce?: string): string {
  const inline = nonce ? `'nonce-${nonce}'` : "'none'";
  return `default-src 'none'; script-src ${inline}; style-src ${inline}; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

function reply(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}, nonce?: string): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": policy(nonce),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...extra,
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void => reply(res, status, JSON.stringify(body), "application/json; charset=utf-8");

const STATUS_OF: Record<string, number> = { locked: 423, "bad-password": 403, corrupt: 422, exists: 409, missing: 404, invalid: 400, conflict: 409 };

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, ...error.extra });
  if (error instanceof VaultError) return sendJson(res, STATUS_OF[error.code] ?? 400, { error: error.message, code: error.code });
  console.error(error);
  sendJson(res, 500, { error: `服务器内部错误:${(error as Error).message}` });
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        // 立即拒绝;响应发出后由外层关闭连接,不再继续接收
        rejected = true;
        chunks.length = 0;
        reject(new HttpError(413, "请求内容过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function jsonBody(req: IncomingMessage, limit = 65_536): Promise<Record<string, unknown>> {
  const text = await readBody(req, limit);
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求内容不是合法的 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "请求内容必须是对象");
  return parsed as Record<string, unknown>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

// ---------- 主密码校验(带限速) ----------
function waitSeconds(): number {
  return Math.ceil(limiter.wait() / 1000);
}

/** 校验请求排队执行:并发提交多个密码时,不能绕过失败计数。 */
let pendingChecks: Promise<unknown> = Promise.resolve();

function limited<T>(action: () => Promise<T>): Promise<T> {
  const run = pendingChecks.then(() => limitedNow(action));
  pendingChecks = run.catch(() => undefined);
  return run;
}

async function limitedNow<T>(action: () => Promise<T>): Promise<T> {
  const wait = waitSeconds();
  if (wait > 0) throw new HttpError(429, `主密码输错次数过多,请 ${wait} 秒后再试`, { retryAfter: wait });
  try {
    const result = await action();
    limiter.success();
    return result;
  } catch (error) {
    if (error instanceof VaultError && error.code === "bad-password") {
      limiter.fail();
      const next = waitSeconds();
      if (next > 0) throw new HttpError(429, `${error.message}。请 ${next} 秒后再试`, { retryAfter: next });
    }
    throw error;
  }
}

async function confirmPassword(password: string): Promise<void> {
  await limited(async () => {
    if (!(await vault.verifyPassword(password))) throw new VaultError("主密码不正确", "bad-password");
  });
}

// ---------- 接口 ----------
class Download {
  constructor(
    readonly body: Buffer,
    readonly type: string,
  ) {}
}

type Handler = (req: IncomingMessage) => Promise<unknown>;

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EXPORT_HEAD = ["分组", "名称", "网址", "用户名", "密码", "备注"];
const EXPORT_WIDTHS = [14, 24, 34, 24, 26, 40];
const IMPORT_LIMIT = 8 * 1024 * 1024;

const routes: Record<string, Handler> = {
  "GET /api/status": async () => ({
    exists: vault.exists(),
    unlocked: vault.unlocked,
    vaultFile,
    autoLockMinutes: config.autoLockMinutes,
    clipboardClearSeconds: config.clipboardClearSeconds,
  }),
  "POST /api/setup": async (req) => {
    await vault.create(text((await jsonBody(req)).password));
    console.log(`[保险库] 已创建:${vaultFile}`);
    return { ok: true };
  },
  "POST /api/unlock": async (req) => {
    const body = await jsonBody(req);
    await limited(() => vault.unlock(text(body.password)));
    return { ok: true };
  },
  // 前端在用户有操作(鼠标、键盘、滚动)时定期调用,只用来刷新"最后活动时间"
  "POST /api/touch": async () => ({ ok: true }),
  "POST /api/lock": async () => {
    vault.lock();
    return { ok: true };
  },
  "POST /api/change-password": async (req) => {
    const body = await jsonBody(req);
    await limited(() => vault.changePassword(text(body.oldPassword), text(body.newPassword)));
    return { ok: true };
  },
  "GET /api/entries": async () => ({ groups: vault.groups(), entries: vault.list() }),
  "POST /api/entries": async (req) => ({ entry: vault.add(await jsonBody(req)) }),
  "POST /api/entries/update": async (req) => {
    const body = await jsonBody(req);
    return { entry: vault.update(text(body.id), body) };
  },
  "POST /api/entries/delete": async (req) => {
    vault.remove(text((await jsonBody(req)).id));
    return { ok: true };
  },
  "POST /api/reveal": async (req) => {
    const ids = (await jsonBody(req)).ids;
    return { passwords: vault.passwords(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []) };
  },
  "POST /api/groups/add": async (req) => ({ name: vault.addGroup((await jsonBody(req)).name) }),
  "POST /api/groups/rename": async (req) => {
    const body = await jsonBody(req);
    return { name: vault.renameGroup(text(body.from), body.to) };
  },
  "POST /api/groups/delete": async (req) => {
    vault.deleteGroup(text((await jsonBody(req)).name));
    return { ok: true };
  },
  "POST /api/export": async (req) => {
    const body = await jsonBody(req);
    vault.groups(); // 已锁定时在这里就返回 423,不去校验密码
    await confirmPassword(text(body.password));
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : undefined;
    const rows = vault.exportEntries(ids).map((e) => [e.group, e.name, e.url, e.username, e.password, e.note]);
    console.log(`[导出] 已导出 ${rows.length} 条账号(明文)。`);
    return new Download(buildXlsx([EXPORT_HEAD, ...rows], { sheetName: "账号", widths: EXPORT_WIDTHS }), XLSX_TYPE);
  },
  "POST /api/import": async (req) => {
    const csv = text((await jsonBody(req, IMPORT_LIMIT)).csv);
    vault.groups();
    let parsed;
    try {
      parsed = csvToEntries(csv);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return vault.importRows(parsed.rows);
  },
};

const NO_SESSION_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>vault-panel</title></head><body><p>未登录。请使用控制台里打印的链接打开本页面(链接只能使用一次;需要重新打开请重启 vault-panel)。</p></body></html>`;

const LOGIN_DONE_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>vault-panel</title></head><body><p>登录成功,正在跳转……如果没有自动跳转,请<a href="/">点这里</a>。</p></body></html>`;

function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" })
      .on("error", () => undefined)
      .unref();
  } catch {
    // 打不开浏览器时,用户可手动复制控制台里的链接
  }
}

const server = createServer(async (req, res) => {
  try {
    // 只接受访问本机地址的请求,防止 DNS 重绑定
    if (!allowedHosts.includes(String(req.headers.host))) {
      sendJson(res, 403, { error: "forbidden host" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/login") {
      if (!sameSecret(url.searchParams.get("t") ?? "", loginToken)) {
        reply(res, 403, "登录链接无效或已使用。请使用控制台里最新打印的链接。", "text/plain; charset=utf-8");
        return;
      }
      const id = randomBytes(32).toString("hex");
      sessions.add(id);
      if (sessions.size > 20) sessions.delete(sessions.values().next().value as string);
      loginToken = randomBytes(16).toString("hex"); // 链接作废,换新的备用
      console.log(`[登录] 浏览器已连接。如需在另一个窗口打开,请用这个新链接(同样只能用一次):\n  ${loginUrl()}`);
      // 不用 302:从别的网页点开登录链接时,SameSite=Strict 的 Cookie 不会随跨站发起的跳转带上,第一次进来会显示"未登录"。
      // 由本站页面自己跳转(meta refresh)就是同站请求,Cookie 能正常带上。
      reply(res, 200, LOGIN_DONE_PAGE, "text/html; charset=utf-8", { "Set-Cookie": `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/` });
      return;
    }

    if (req.method === "GET" && pathname === "/") {
      if (!hasSession(req)) {
        reply(res, 401, NO_SESSION_PAGE, "text/html; charset=utf-8");
        return;
      }
      const nonce = randomBytes(16).toString("base64");
      const page = readFileSync(join(root, "web", "index.html"), "utf8").replaceAll("__NONCE__", nonce);
      reply(res, 200, page, "text/html; charset=utf-8", {}, nonce);
      return;
    }

    if (pathname.startsWith("/api/")) {
      // 同源 fetch 一定带 same-origin;跨站请求(CSRF)在这里被挡掉
      const fetchSite = req.headers["sec-fetch-site"];
      const origin = req.headers.origin;
      if ((fetchSite !== undefined && fetchSite !== "same-origin") || (origin !== undefined && !allowedOrigins.includes(origin))) {
        sendJson(res, 403, { error: "forbidden origin" });
        return;
      }
      if (!hasSession(req)) {
        sendJson(res, 401, { error: "未登录" });
        return;
      }
      const handler = routes[`${req.method} ${pathname}`];
      if (!handler) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (pathname !== "/api/status") lastActive = Date.now();
      const result = await handler(req);
      if (result instanceof Download) reply(res, 200, result.body, result.type, { "Content-Disposition": 'attachment; filename="export.xlsx"' });
      else sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) res.once("finish", () => req.destroy());
    sendError(res, error);
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  exitWith(error.code === "EADDRINUSE" ? `端口 ${listenPort} 已被占用,请在配置里改 port,或用 --port 指定别的端口。` : error.message);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    vault.lock();
    process.exit(0);
  });
}

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`vault-panel 已启动(仅本机可访问)。请在浏览器打开下面的链接(只能使用一次):\n  ${loginUrl()}`);
  console.log(`配置文件:${configFile}\n保险库:${vaultFile}${vault.exists() ? "" : "(尚未创建,打开页面后设置主密码)"}`);
  if (shouldOpenBrowser) openBrowser(loginUrl());
});
