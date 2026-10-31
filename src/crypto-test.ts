import assert from "node:assert/strict";
import { CryptoError, checkCost, deriveKey, newKdf, open, parseEnvelope, seal } from "./crypto.js";

// 测试用低成本参数,正式使用的默认值要慢得多
const cost = { N: 1 << 10, r: 8, p: 1 };

const kdf = newKdf(cost);
const key = await deriveKey("correct horse", kdf);
assert.equal(key.length, 32);
assert.deepEqual(await deriveKey("correct horse", kdf), key, "同样的密码和盐得到同样的密钥");
assert.notDeepEqual(await deriveKey("correct horsf", kdf), key);
// NFKC 规范化:全角字符与半角等价
assert.deepEqual(await deriveKey("ＡＢＣ１２３", kdf), await deriveKey("ABC123", kdf));

// 往返
const plain = Buffer.from(JSON.stringify({ hello: "世界", n: 1 }));
const text = seal(key, kdf, plain);
assert.ok(!text.includes("世界"), "文件里不能出现明文");
assert.deepEqual(open(key, parseEnvelope(text)), plain);

// 每次加密使用新的 nonce
assert.notEqual(JSON.parse(text).nonce, JSON.parse(seal(key, kdf, plain)).nonce);

// 错误密码
const wrong = await deriveKey("wrong", kdf);
assert.throws(() => open(wrong, parseEnvelope(text)), (e: unknown) => e instanceof CryptoError && e.code === "auth");

// 篡改任何一处都必须解密失败
function flip(value: string): string {
  const bytes = Buffer.from(value, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString("base64");
}
function tampered(change: (file: Record<string, any>) => void): string {
  const file = JSON.parse(text);
  change(file);
  return JSON.stringify(file);
}
const mustFailAuth = (changed: string) =>
  assert.throws(() => open(key, parseEnvelope(changed)), (e: unknown) => e instanceof CryptoError && e.code === "auth");
mustFailAuth(tampered((f) => (f.data = flip(f.data))));
mustFailAuth(tampered((f) => (f.tag = flip(f.tag))));
mustFailAuth(tampered((f) => (f.nonce = flip(f.nonce))));
mustFailAuth(tampered((f) => (f.kdf.salt = flip(f.kdf.salt))));
mustFailAuth(tampered((f) => (f.kdf.N = 2048)));

// 格式错误
const mustFailFormat = (input: string) => assert.throws(() => parseEnvelope(input), (e: unknown) => e instanceof CryptoError && e.code === "format");
mustFailFormat("not json");
mustFailFormat("[]");
mustFailFormat(JSON.stringify({ app: "other" }));
mustFailFormat(tampered((f) => (f.version = 2)));
mustFailFormat(tampered((f) => (f.cipher = "aes-128-cbc")));
mustFailFormat(tampered((f) => (f.kdf.name = "pbkdf2")));
mustFailFormat(tampered((f) => (f.tag = "AAAA")));
mustFailFormat(tampered((f) => (f.kdf.N = 1 << 30))); // 文件里的参数不可信:过大会耗尽内存

// 参数边界
assert.throws(() => checkCost({ N: 1000, r: 8, p: 1 }), CryptoError); // 不是 2 的幂
assert.throws(() => checkCost({ N: 1 << 9, r: 8, p: 1 }), CryptoError);
assert.throws(() => checkCost({ N: 1 << 18, r: 32, p: 1 }), CryptoError); // 内存超限
checkCost({ N: 1 << 17, r: 8, p: 1 });

console.log("crypto-test OK");
