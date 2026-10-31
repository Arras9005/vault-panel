import { createCipheriv, createDecipheriv, randomBytes, scrypt, type ScryptOptions } from "node:crypto";

/**
 * 保险库文件格式(JSON,所有二进制字段为 base64):
 *   { app, version, kdf: { name, N, r, p, salt }, cipher, nonce, tag, data }
 * 密钥由主密码经 scrypt 派生,内容用 AES-256-GCM 加密;
 * 文件头(app、version、kdf 参数、cipher)整体作为附加认证数据,被改动会导致解密失败。
 */
const APP = "vault-panel";
const VERSION = 1;
const CIPHER = "aes-256-gcm";

export interface KdfCost {
  N: number;
  r: number;
  p: number;
}

export interface Kdf extends KdfCost {
  salt: Buffer;
}

export interface Envelope {
  kdf: Kdf;
  nonce: Buffer;
  tag: Buffer;
  data: Buffer;
}

/** 默认成本:约 128 MiB 内存、数百毫秒;参数写进文件,以后可以提高。 */
export const DEFAULT_COST: KdfCost = { N: 1 << 17, r: 8, p: 1 };

const MIN_N = 1 << 10;
const MAX_N = 1 << 18;
const MAX_MEMORY = 512 * 1024 * 1024;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** format = 不是合法的保险库文件;auth = 密码错误或内容被篡改(两者无法区分)。 */
export class CryptoError extends Error {
  constructor(
    message: string,
    readonly code: "format" | "auth",
  ) {
    super(message);
  }
}

function scryptMemory(cost: KdfCost): number {
  return 128 * cost.N * cost.r + 128 * cost.r * cost.p;
}

/** 校验 KDF 成本;文件里的参数不可信,过大的值会被拿来耗尽内存。 */
export function checkCost(cost: KdfCost): void {
  const { N, r, p } = cost;
  const ok =
    Number.isInteger(N) && N >= MIN_N && N <= MAX_N && (N & (N - 1)) === 0 &&
    Number.isInteger(r) && r >= 1 && r <= 32 &&
    Number.isInteger(p) && p >= 1 && p <= 16 &&
    scryptMemory(cost) <= MAX_MEMORY;
  if (!ok) throw new CryptoError("保险库的密钥派生参数不合法", "format");
}

export function newKdf(cost: KdfCost = DEFAULT_COST): Kdf {
  checkCost(cost);
  return { ...cost, salt: randomBytes(SALT_BYTES) };
}

/** 主密码先做 NFKC 规范化,避免同一个密码在不同系统上输入出不同的字节。 */
export function deriveKey(password: string, kdf: Kdf): Promise<Buffer> {
  checkCost(kdf);
  const options: ScryptOptions = { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: scryptMemory(kdf) * 2 + (1 << 20) };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), kdf.salt, 32, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function header(kdf: Kdf) {
  return { app: APP, version: VERSION, kdf: { name: "scrypt", N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt.toString("base64") }, cipher: CIPHER };
}

function aad(kdf: Kdf): Buffer {
  return Buffer.from(JSON.stringify(header(kdf)), "utf8");
}

/** 加密并序列化成文件内容;每次调用都使用新的随机 nonce。 */
export function seal(key: Buffer, kdf: Kdf, plaintext: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, key, nonce);
  cipher.setAAD(aad(kdf));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const file = { ...header(kdf), nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  return JSON.stringify(file) + "\n";
}

function field(source: Record<string, unknown>, name: string, bytes?: number): Buffer {
  const value = source[name];
  if (typeof value !== "string") throw new CryptoError("不是有效的保险库文件", "format");
  const buffer = Buffer.from(value, "base64");
  if (bytes !== undefined && buffer.length !== bytes) throw new CryptoError("不是有效的保险库文件", "format");
  return buffer;
}

export function parseEnvelope(text: string): Envelope {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new CryptoError("不是有效的保险库文件", "format");
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) throw new CryptoError("不是有效的保险库文件", "format");
  const file = root as Record<string, unknown>;
  if (file.app !== APP) throw new CryptoError("不是有效的保险库文件", "format");
  if (file.version !== VERSION) throw new CryptoError(`不支持的保险库版本:${String(file.version)}`, "format");
  if (file.cipher !== CIPHER) throw new CryptoError("不支持的加密算法", "format");
  const k = file.kdf;
  if (typeof k !== "object" || k === null || Array.isArray(k)) throw new CryptoError("不是有效的保险库文件", "format");
  const kdfRaw = k as Record<string, unknown>;
  if (kdfRaw.name !== "scrypt") throw new CryptoError("不支持的密钥派生算法", "format");
  const kdf: Kdf = { N: Number(kdfRaw.N), r: Number(kdfRaw.r), p: Number(kdfRaw.p), salt: field(kdfRaw, "salt", SALT_BYTES) };
  checkCost(kdf);
  return { kdf, nonce: field(file, "nonce", NONCE_BYTES), tag: field(file, "tag", TAG_BYTES), data: field(file, "data") };
}

/** 解密;密码错误和内容被改动都抛出 code 为 auth 的错误。 */
export function open(key: Buffer, envelope: Envelope): Buffer {
  try {
    const decipher = createDecipheriv(CIPHER, key, envelope.nonce);
    decipher.setAAD(aad(envelope.kdf));
    decipher.setAuthTag(envelope.tag);
    return Buffer.concat([decipher.update(envelope.data), decipher.final()]);
  } catch {
    throw new CryptoError("主密码错误,或保险库文件已损坏", "auth");
  }
}
