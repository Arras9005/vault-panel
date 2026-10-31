/** RFC 4180 风格的 CSV 解析:支持引号、引号内的逗号和换行、"" 转义、CRLF 和 UTF-8 BOM。 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new Error("CSV 格式不正确:引号没有闭合");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type ImportField = "name" | "group" | "url" | "username" | "password" | "note";

/** 表头别名(小写比较),覆盖本程序的导出表头和 Chrome / Edge / Firefox / Bitwarden 的导出。 */
const ALIASES: Record<ImportField, string[]> = {
  name: ["name", "名称", "标题", "title"],
  group: ["group", "分组", "folder", "grouping", "category"],
  url: ["url", "网址", "website", "web site", "login_uri"],
  username: ["username", "用户名", "login_username", "user", "login"],
  password: ["password", "密码", "login_password"],
  note: ["note", "notes", "备注", "extra"],
};

export interface ImportResult {
  rows: Partial<Record<ImportField, string>>[];
}

/** 第一行必须是表头;至少要能识别出用户名或密码列。 */
export function csvToEntries(input: string): ImportResult {
  const table = parseCsv(input);
  const head = table[0];
  if (!head) throw new Error("文件是空的");
  const columns = new Map<ImportField, number>();
  head.forEach((title, index) => {
    const key = title.trim().toLowerCase();
    for (const field of Object.keys(ALIASES) as ImportField[]) {
      if (!columns.has(field) && ALIASES[field].includes(key)) columns.set(field, index);
    }
  });
  if (!columns.has("username") && !columns.has("password")) {
    throw new Error("无法识别表头:第一行需要包含「用户名」「密码」等列(也支持 Chrome / Firefox / Edge 的导出格式)");
  }
  const rows = table.slice(1).flatMap((cells) => {
    const row: Partial<Record<ImportField, string>> = {};
    for (const [field, index] of columns) row[field] = cells[index] ?? "";
    return Object.values(row).some((v) => v !== "") ? [row] : [];
  });
  return { rows };
}
