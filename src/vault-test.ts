import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, VaultError, type VaultErrorCode } from "./vault.js";

const cost = { N: 1 << 10, r: 8, p: 1 };
const dir = mkdtempSync(join(tmpdir(), "vault-test-"));
const file = join(dir, "sub", "vault.enc");

const code = (expected: VaultErrorCode) => (e: unknown) => e instanceof VaultError && e.code === expected;

try {
  const vault = new Vault(file, cost);
  assert.equal(vault.exists(), false);
  assert.throws(() => vault.list(), code("locked"));
  await assert.rejects(vault.unlock("whatever-123"), code("missing"));
  await assert.rejects(vault.create("short"), code("invalid"));

  await vault.create("master-password");
  assert.equal(vault.exists(), true);
  assert.equal(vault.unlocked, true);
  await assert.rejects(vault.create("master-password"), code("exists"));

  // 分组
  assert.equal(vault.addGroup("  服务器 "), "服务器");
  vault.addGroup("网站");
  assert.throws(() => vault.addGroup("服务器"), code("invalid"));
  assert.throws(() => vault.addGroup(""), code("invalid"));
  assert.deepEqual(vault.groups(), ["服务器", "网站"]);

  // 账号
  assert.throws(() => vault.add({ name: "" }), code("invalid"));
  assert.throws(() => vault.add({ name: "x", group: "不存在" }), code("invalid"));
  assert.throws(() => vault.add({ name: "x", password: 1 }), code("invalid"));
  assert.throws(() => vault.add({ name: "x".repeat(201) }), code("invalid"));
  const a = vault.add({ name: "测试机", group: "服务器", url: "ssh://10.0.0.1", username: "root", password: " p@ss ", note: "备注" });
  const b = vault.add({ name: "邮箱", username: "me@example.com", password: "mail-pass" });
  assert.equal(a.hasPassword, true);
  assert.ok(!("password" in a), "返回的条目里不能带密码");
  assert.ok(vault.list().every((e) => !("password" in e)));
  assert.deepEqual(vault.passwords([a.id, b.id, "nope"]), { [a.id]: " p@ss ", [b.id]: "mail-pass" }, "密码原样保存,不去空白");

  vault.update(a.id, { username: "admin", group: "网站" });
  assert.equal(vault.list().find((e) => e.id === a.id)?.username, "admin");
  assert.equal(vault.passwords([a.id])[a.id], " p@ss ", "未提交的字段保持不变");
  assert.throws(() => vault.update(a.id, { name: "" }), code("invalid"));
  assert.throws(() => vault.update("nope", {}), code("invalid"));

  // 分组重命名 / 删除
  assert.equal(vault.renameGroup("网站", "Web"), "Web");
  assert.equal(vault.list().find((e) => e.id === a.id)?.group, "Web");
  assert.throws(() => vault.renameGroup("Web", "服务器"), code("invalid"));
  vault.deleteGroup("Web");
  assert.equal(vault.list().find((e) => e.id === a.id)?.group, "", "删除分组后账号变为未分组");

  // 文件里没有明文
  const raw = readFileSync(file, "utf8");
  for (const secret of ["测试机", "p@ss", "mail-pass", "me@example.com"]) assert.ok(!raw.includes(secret), `文件里不应出现 ${secret}`);

  // 重新打开
  const again = new Vault(file, cost);
  await assert.rejects(again.unlock("wrong-password"), code("bad-password"));
  assert.equal(again.unlocked, false);
  await again.unlock("master-password");
  assert.deepEqual(again.groups(), ["服务器"]);
  assert.equal(again.list().length, 2);
  assert.equal(again.passwords([b.id])[b.id], "mail-pass");
  again.lock();
  assert.throws(() => again.list(), code("locked"));

  // 保存时保留上一版备份
  assert.equal(existsSync(`${file}.bak`), true);
  assert.equal(existsSync(`${file}.tmp`), false);

  // 二次确认密码
  assert.equal(await vault.verifyPassword("master-password"), true);
  assert.equal(await vault.verifyPassword("master-passwore"), false);

  // 修改主密码
  await assert.rejects(vault.changePassword("wrong", "new-master-pass"), code("bad-password"));
  await assert.rejects(vault.changePassword("master-password", "short"), code("invalid"));
  await vault.changePassword("master-password", "new-master-pass");
  assert.equal(existsSync(`${file}.bak`), false, "改密码后旧备份要删除");
  const third = new Vault(file, cost);
  await assert.rejects(third.unlock("master-password"), code("bad-password"));
  await third.unlock("new-master-pass");
  assert.equal(third.list().length, 2);

  // 文件被外部修改:拒绝覆盖
  third.lock();
  await third.unlock("new-master-pass");
  writeFileSync(file, readFileSync(file, "utf8") + " ");
  assert.throws(() => third.add({ name: "冲突" }), code("conflict"));
  assert.equal(third.list().length, 2, "保存失败时内存里的数据不变");

  // 被篡改的文件打不开
  const damaged = JSON.parse(readFileSync(file, "utf8"));
  const bytes = Buffer.from(damaged.data, "base64");
  bytes[3] = (bytes[3] ?? 0) ^ 1;
  damaged.data = bytes.toString("base64");
  writeFileSync(file, JSON.stringify(damaged));
  await assert.rejects(new Vault(file, cost).unlock("new-master-pass"), code("bad-password"));
  writeFileSync(file, "garbage");
  await assert.rejects(new Vault(file, cost).unlock("new-master-pass"), code("corrupt"));

  // 导入 / 导出
  const file2 = join(dir, "vault2.enc");
  const v2 = new Vault(file2, cost);
  await v2.create("master-password");
  v2.addGroup("已有");
  const result = v2.importRows([
    { name: "A", group: "已有", username: "u1", password: "p1" },
    { name: "B", group: "新分组", username: "u2", password: "p2" },
    { name: "", url: "https://x.example", username: "u3" },
    { note: "只有备注" },
    {},
    { name: "超长", password: "x".repeat(2000) },
  ]);
  assert.deepEqual(result, { added: 5, skipped: 0, groupsAdded: 1 });
  assert.deepEqual(v2.groups(), ["已有", "新分组"]);
  const list = v2.list();
  assert.equal(list.find((e) => e.username === "u3")?.name, "https://x.example", "没有名称时用网址当名称");
  assert.equal(v2.passwords(list.filter((e) => e.name === "超长").map((e) => e.id))[list.find((e) => e.name === "超长")!.id]?.length, 1000, "超长字段被截断");
  // 导出顺序:按分组顺序,未分组在最后
  assert.deepEqual(v2.exportEntries().map((e) => e.group), ["已有", "新分组", "", "", ""]);
  assert.equal(v2.exportEntries([list[0]!.id]).length, 1);
  // 重复导入同一批数据:全部跳过,不产生重复账号
  const repeat = v2.importRows([{ name: "A", group: "已有", username: "u1", password: "p1" }, { name: "A", username: "u1", password: "other" }]);
  assert.deepEqual(repeat, { added: 1, skipped: 1, groupsAdded: 0 });
  assert.equal(v2.list().length, 6);

  console.log("vault-test OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
