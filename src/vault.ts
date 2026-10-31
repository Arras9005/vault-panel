import { randomUUID, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CryptoError, DEFAULT_COST, deriveKey, newKdf, open, parseEnvelope, seal, type Kdf, type KdfCost } from "./crypto.js";

export type VaultErrorCode = "locked" | "bad-password" | "corrupt" | "exists" | "missing" | "invalid" | "conflict";

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: VaultErrorCode,
  ) {
    super(message);
  }
}

const invalid = (message: string) => new VaultError(message, "invalid");

export const MIN_PASSWORD_LENGTH = 8;

const FIELDS = ["name", "group", "url", "username", "password", "note"] as const;
type Field = (typeof FIELDS)[number];
export type EntryFields = Record<Field, string>;

const LABELS: Record<Field, string> = { name: "名称", group: "分组", url: "网址", username: "用户名", password: "密码", note: "备注" };
const LIMITS: Record<Field, number> = { name: 200, group: 40, url: 2000, username: 500, password: 1000, note: 5000 };
const MAX_GROUPS = 200;

export interface Entry extends EntryFields {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** 列表里返回的条目:不含密码明文,需要时再单独取。 */
export type PublicEntry = Omit<Entry, "password"> & { hasPassword: boolean };

interface VaultData {
  groups: string[];
  entries: Entry[];
}

const collator = new Intl.Collator("zh");

function readFields(input: unknown, clamp: boolean): Partial<EntryFields> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid("请求内容不正确");
  const source = input as Record<string, unknown>;
  const out: Partial<EntryFields> = {};
  for (const field of FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (typeof value !== "string") throw invalid(`${LABELS[field]}必须是文本`);
    // 密码原样保存,其他字段去掉首尾空白
    let text = field === "password" ? value : value.trim();
    if (text.length > LIMITS[field]) {
      if (!clamp) throw invalid(`${LABELS[field]}太长(最多 ${LIMITS[field]} 个字符)`);
      text = text.slice(0, LIMITS[field]);
    }
    out[field] = text;
  }
  return out;
}

function checkGroupName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "") throw invalid("分组名不能为空");
  if (name.length > LIMITS.group) throw invalid(`分组名太长(最多 ${LIMITS.group} 个字符)`);
  return name;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** 解密后的内容不可信到只需要"形状正确":缺字段补空,多余字段丢弃。 */
function normalizeData(raw: unknown): VaultData {
  if (typeof raw !== "object" || raw === null) throw new VaultError("保险库内容格式不正确", "corrupt");
  const root = raw as Record<string, unknown>;
  const groups = Array.isArray(root.groups) ? root.groups.filter((g): g is string => typeof g === "string" && g !== "") : [];
  const entries = (Array.isArray(root.entries) ? root.entries : []).flatMap((item): Entry[] => {
    if (typeof item !== "object" || item === null) return [];
    const e = item as Record<string, unknown>;
    const str = (value: unknown) => (typeof value === "string" ? value : "");
    return [
      {
        id: str(e.id) || randomUUID(),
        name: str(e.name),
        group: groups.includes(str(e.group)) ? str(e.group) : "",
        url: str(e.url),
        username: str(e.username),
        password: str(e.password),
        note: str(e.note),
        createdAt: str(e.createdAt),
        updatedAt: str(e.updatedAt),
      },
    ];
  });
  return { groups, entries };
}

export class Vault {
  private key?: Buffer;
  private kdf?: Kdf;
  private data?: VaultData;
  /** 上次读写后文件的状态;保存前对比,发现被别的程序(如同步工具)改过就拒绝覆盖。 */
  private seen?: { mtimeMs: number; size: number };

  constructor(
    readonly file: string,
    private readonly cost: KdfCost = DEFAULT_COST,
  ) {}

  exists(): boolean {
    return existsSync(this.file);
  }

  get unlocked(): boolean {
    return this.data !== undefined;
  }

  private need(): VaultData {
    if (!this.data || !this.key || !this.kdf) throw new VaultError("保险库已锁定", "locked");
    return this.data;
  }

  private checkNewPassword(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) throw invalid(`主密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
  }

  async create(password: string): Promise<void> {
    if (this.exists()) throw new VaultError("保险库已存在", "exists");
    this.checkNewPassword(password);
    const kdf = newKdf(this.cost);
    const key = await deriveKey(password, kdf);
    this.key = key;
    this.kdf = kdf;
    this.data = { groups: [], entries: [] };
    this.seen = undefined;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      this.write(this.data);
    } catch (error) {
      this.lock();
      throw error;
    }
  }

  async unlock(password: string): Promise<void> {
    if (!this.exists()) throw new VaultError("保险库不存在", "missing");
    const text = readFileSync(this.file, "utf8");
    const stat = statSync(this.file);
    try {
      const envelope = parseEnvelope(text);
      const key = await deriveKey(password, envelope.kdf);
      const data = normalizeData(JSON.parse(open(key, envelope).toString("utf8")));
      this.lock();
      this.key = key;
      this.kdf = envelope.kdf;
      this.data = data;
      this.seen = { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
      if (error instanceof CryptoError) throw new VaultError(error.message, error.code === "auth" ? "bad-password" : "corrupt");
      if (error instanceof SyntaxError) throw new VaultError("保险库内容格式不正确", "corrupt");
      throw error;
    }
  }

  lock(): void {
    this.key?.fill(0);
    this.key = undefined;
    this.kdf = undefined;
    this.data = undefined;
    this.seen = undefined;
  }

  /** 重新派生一次密钥并与当前密钥比较:用于导出、改密码前的二次确认。 */
  async verifyPassword(password: string): Promise<boolean> {
    this.need();
    const key = await deriveKey(password, this.kdf!);
    const same = key.length === this.key!.length && timingSafeEqual(key, this.key!);
    key.fill(0);
    return same;
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    this.need();
    if (!(await this.verifyPassword(oldPassword))) throw new VaultError("当前主密码不正确", "bad-password");
    this.checkNewPassword(newPassword);
    const kdf = newKdf(this.cost);
    const key = await deriveKey(newPassword, kdf);
    const oldKey = this.key!;
    const oldKdf = this.kdf!;
    this.key = key;
    this.kdf = kdf;
    try {
      this.write(this.data!);
    } catch (error) {
      this.key = oldKey;
      this.kdf = oldKdf;
      key.fill(0);
      throw error;
    }
    oldKey.fill(0);
    // 备份是用旧密码加密的,留着等于旧密码仍能打开保险库
    try {
      unlinkSync(`${this.file}.bak`);
    } catch {
      // 没有备份就算了
    }
  }

  /** 加密并原子写入:先写临时文件,把上一版留作 .bak,再改名覆盖。 */
  private write(data: VaultData): void {
    if (existsSync(this.file)) {
      const stat = statSync(this.file);
      if (this.seen && (stat.mtimeMs !== this.seen.mtimeMs || stat.size !== this.seen.size)) {
        throw new VaultError("保险库文件已被其他程序修改(可能是同步工具)。为避免覆盖,请先锁定,再重新解锁载入最新内容。", "conflict");
      }
    }
    const plaintext = Buffer.from(JSON.stringify({ version: 1, groups: data.groups, entries: data.entries }), "utf8");
    const text = seal(this.key!, this.kdf!, plaintext);
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
    if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`);
    renameSync(temp, this.file);
    const stat = statSync(this.file);
    this.seen = { mtimeMs: stat.mtimeMs, size: stat.size };
  }

  /** 在副本上修改并保存;保存成功后才替换内存里的数据。 */
  private change<T>(mutate: (draft: VaultData) => T): T {
    const draft = structuredClone(this.need());
    const result = mutate(draft);
    this.write(draft);
    this.data = draft;
    return result;
  }

  groups(): string[] {
    return [...this.need().groups];
  }

  list(): PublicEntry[] {
    return this.need().entries.map(({ password, ...rest }) => ({ ...rest, hasPassword: password !== "" }));
  }

  passwords(ids: string[]): Record<string, string> {
    const wanted = new Set(ids);
    const out: Record<string, string> = {};
    for (const entry of this.need().entries) if (wanted.has(entry.id)) out[entry.id] = entry.password;
    return out;
  }

  private static checkGroup(draft: VaultData, group: string | undefined): void {
    if (group !== undefined && group !== "" && !draft.groups.includes(group)) throw invalid(`分组不存在:${group}`);
  }

  add(input: unknown): PublicEntry {
    const fields = readFields(input, false);
    if (!fields.name) throw invalid("请填写名称");
    return this.change((draft) => {
      Vault.checkGroup(draft, fields.group);
      const now = new Date().toISOString();
      const entry: Entry = { id: randomUUID(), name: "", group: "", url: "", username: "", password: "", note: "", ...fields, createdAt: now, updatedAt: now };
      draft.entries.push(entry);
      const { password, ...rest } = entry;
      return { ...rest, hasPassword: password !== "" };
    });
  }

  update(id: string, input: unknown): PublicEntry {
    const fields = readFields(input, false);
    return this.change((draft) => {
      const entry = draft.entries.find((e) => e.id === id);
      if (!entry) throw invalid("账号不存在");
      Vault.checkGroup(draft, fields.group);
      Object.assign(entry, fields);
      if (!entry.name) throw invalid("请填写名称");
      entry.updatedAt = new Date().toISOString();
      const { password, ...rest } = entry;
      return { ...rest, hasPassword: password !== "" };
    });
  }

  remove(id: string): void {
    this.change((draft) => {
      const index = draft.entries.findIndex((e) => e.id === id);
      if (index < 0) throw invalid("账号不存在");
      draft.entries.splice(index, 1);
    });
  }

  addGroup(raw: unknown): string {
    const name = checkGroupName(raw);
    return this.change((draft) => {
      if (draft.groups.some((g) => sameName(g, name))) throw invalid(`分组已存在:${name}`);
      if (draft.groups.length >= MAX_GROUPS) throw invalid(`分组最多 ${MAX_GROUPS} 个`);
      draft.groups.push(name);
      return name;
    });
  }

  renameGroup(from: string, raw: unknown): string {
    const to = checkGroupName(raw);
    return this.change((draft) => {
      const index = draft.groups.indexOf(from);
      if (index < 0) throw invalid(`分组不存在:${from}`);
      if (draft.groups.some((g, i) => i !== index && sameName(g, to))) throw invalid(`分组已存在:${to}`);
      draft.groups[index] = to;
      for (const entry of draft.entries) if (entry.group === from) entry.group = to;
      return to;
    });
  }

  /** 删除分组不删除账号,里面的账号变为未分组。 */
  deleteGroup(name: string): void {
    this.change((draft) => {
      const index = draft.groups.indexOf(name);
      if (index < 0) throw invalid(`分组不存在:${name}`);
      draft.groups.splice(index, 1);
      for (const entry of draft.entries) if (entry.group === name) entry.group = "";
    });
  }

  /** 批量导入:字段超长时截断而不是整批失败;分组不存在则自动创建;与已有账号完全相同的跳过(重复导入同一份文件不会产生重复)。 */
  importRows(rows: unknown[]): { added: number; skipped: number; groupsAdded: number } {
    return this.change((draft) => {
      const groupsBefore = draft.groups.length;
      let added = 0;
      let skipped = 0;
      const now = new Date().toISOString();
      const fingerprint = (e: { name: string; url: string; username: string; password: string }) => JSON.stringify([e.name, e.url, e.username, e.password]);
      const known = new Set(draft.entries.map(fingerprint));
      for (const row of rows) {
        const fields = readFields(row, true);
        const name = fields.name || fields.url || fields.username || "";
        if (!name && !fields.password && !fields.note) continue;
        let group = "";
        if (fields.group) {
          const found = draft.groups.find((g) => sameName(g, fields.group!));
          if (found) group = found;
          else if (draft.groups.length < MAX_GROUPS) {
            draft.groups.push(fields.group);
            group = fields.group;
          }
        }
        const entry: Entry = { id: randomUUID(), name: name || "(未命名)", group, url: fields.url ?? "", username: fields.username ?? "", password: fields.password ?? "", note: fields.note ?? "", createdAt: now, updatedAt: now };
        if (known.has(fingerprint(entry))) {
          skipped += 1;
          continue;
        }
        known.add(fingerprint(entry));
        draft.entries.push(entry);
        added += 1;
      }
      return { added, skipped, groupsAdded: draft.groups.length - groupsBefore };
    });
  }

  /** 导出用:按分组顺序、再按名称排序;ids 为空表示全部。 */
  exportEntries(ids?: string[]): Entry[] {
    const data = this.need();
    const wanted = ids ? new Set(ids) : undefined;
    const rank = (group: string) => {
      const index = data.groups.indexOf(group);
      return index < 0 ? data.groups.length : index;
    };
    return data.entries
      .filter((e) => !wanted || wanted.has(e.id))
      .sort((a, b) => rank(a.group) - rank(b.group) || collator.compare(a.name, b.name));
  }
}
