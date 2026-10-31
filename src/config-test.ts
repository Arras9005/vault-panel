import assert from "node:assert/strict";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { defaultConfig, parseConfig, resolveConfigFile, serializeConfig } from "./config.js";

const base = resolve("/tmp/vp");

// 默认值
const config = parseConfig({}, base);
assert.equal(config.port, 8766);
assert.equal(config.openBrowser, true);
assert.equal(config.autoLockMinutes, 10);
assert.equal(config.clipboardClearSeconds, 20);
assert.equal(config.vaultFile, resolve(base, "vault.enc"), "相对路径相对于配置文件所在目录");

// 显式配置
const custom = parseConfig({ port: 9000, openBrowser: false, vaultFile: resolve("/data/v.enc"), autoLockMinutes: 0, clipboardClearSeconds: 0 }, base);
assert.equal(custom.port, 9000);
assert.equal(custom.openBrowser, false);
assert.ok(isAbsolute(custom.vaultFile));
assert.equal(custom.vaultFile, resolve("/data/v.enc"));
assert.equal(custom.autoLockMinutes, 0);

// ~ 开头的路径展开为用户目录
assert.equal(parseConfig({ vaultFile: "~/v.enc" }, base).vaultFile, resolve(homedir(), "v.enc"));
assert.equal(parseConfig({ vaultFile: "~\\v.enc" }, base).vaultFile, resolve(homedir(), "v.enc"));

// 非法值
assert.throws(() => parseConfig([], base), /对象/);
assert.throws(() => parseConfig({ port: 0 }, base), /port/);
assert.throws(() => parseConfig({ port: "abc" }, base), /port/);
assert.throws(() => parseConfig({ autoLockMinutes: -1 }, base), /autoLockMinutes/);
assert.throws(() => parseConfig({ clipboardClearSeconds: 601 }, base), /clipboardClearSeconds/);

// 序列化往返
const dflt = defaultConfig(base);
assert.deepEqual(parseConfig(JSON.parse(serializeConfig(dflt)), base), dflt);

// 配置文件位置:显式参数 > 环境变量 > 用户目录
assert.equal(resolveConfigFile("/x/c.json", {}, "/home/u"), resolve("/x/c.json"));
assert.equal(resolveConfigFile(undefined, { VAULT_PANEL_CONFIG: "/y/c.json" }, "/home/u"), resolve("/y/c.json"));
assert.equal(resolveConfigFile(undefined, {}, "/home/u").replace(/\\/g, "/").endsWith("/home/u/.vault-panel/config.json"), true);

console.log("config-test OK");
