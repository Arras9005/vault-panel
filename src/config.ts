import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** 路径开头的 ~ 展开为用户目录(JSON 里没有 shell 帮忙展开)。 */
function expandHome(path: string, home: string = homedir()): string {
  return /^~([\\/]|$)/.test(path) ? join(home, path.slice(2)) : path;
}

export interface PanelConfig {
  port: number;
  openBrowser: boolean;
  /** 保险库文件的绝对路径 */
  vaultFile: string;
  /** 无操作多少分钟后自动锁定;0 表示不自动锁定 */
  autoLockMinutes: number;
  /** 复制密码后多少秒清空剪贴板;0 表示不清空 */
  clipboardClearSeconds: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("config.json 必须是对象");
  return value as Record<string, unknown>;
}

function integer(value: unknown, fallback: number, min: number, max: number, what: string): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} 必须是 ${min}-${max} 的整数`);
  return n;
}

/** 校验并规范化配置;相对路径的 vaultFile 相对于配置文件所在目录。 */
export function parseConfig(raw: unknown, baseDir: string): PanelConfig {
  const root = asRecord(raw);
  const vault = typeof root.vaultFile === "string" && root.vaultFile.trim() !== "" ? expandHome(root.vaultFile.trim()) : "vault.enc";
  return {
    port: integer(root.port, 8766, 1, 65535, "port"),
    openBrowser: root.openBrowser !== false,
    vaultFile: isAbsolute(vault) ? resolve(vault) : resolve(baseDir, vault),
    autoLockMinutes: integer(root.autoLockMinutes, 10, 0, 1440, "autoLockMinutes"),
    clipboardClearSeconds: integer(root.clipboardClearSeconds, 20, 0, 600, "clipboardClearSeconds"),
  };
}

export function defaultConfig(baseDir: string): PanelConfig {
  return parseConfig({}, baseDir);
}

/**
 * 配置文件放哪:`--config` 或环境变量 VAULT_PANEL_CONFIG 优先,
 * 否则固定放在用户目录 ~/.vault-panel/(保险库默认也在这里,不会落进源码目录被误提交)。
 */
export function resolveConfigFile(explicit?: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  if (explicit) return resolve(explicit);
  if (env.VAULT_PANEL_CONFIG) return resolve(env.VAULT_PANEL_CONFIG);
  return join(home, ".vault-panel", "config.json");
}

/** 序列化为 config.json 的内容;路径统一用 /,免得 Windows 的反斜杠被 JSON 转义弄乱。 */
export function serializeConfig(config: PanelConfig): string {
  return (
    JSON.stringify(
      {
        port: config.port,
        openBrowser: config.openBrowser,
        vaultFile: config.vaultFile.replace(/\\/g, "/"),
        autoLockMinutes: config.autoLockMinutes,
        clipboardClearSeconds: config.clipboardClearSeconds,
      },
      null,
      2,
    ) + "\n"
  );
}

/** 先写临时文件再改名,避免写到一半断电留下损坏的配置。 */
export function saveConfig(file: string, config: PanelConfig): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, serializeConfig(config), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}

/** 配置文件不存在就写一份默认的;返回是否新建。 */
export function ensureConfig(file: string): boolean {
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  saveConfig(file, defaultConfig(dirname(file)));
  return true;
}

export function loadConfig(file: string): PanelConfig {
  if (!existsSync(file)) throw new Error(`找不到配置文件 ${file}。`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`config.json 不是合法 JSON:${(error as Error).message}`);
  }
  return parseConfig(raw, dirname(file));
}
