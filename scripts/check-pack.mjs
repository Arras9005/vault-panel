// 发布前检查:npm 包里必须有该有的文件,绝不能混进账号数据、配置、源码或测试。
// 用法:先 npm run build,再 npm run check:pack(prepublishOnly 会自动执行)。
import { execSync } from "node:child_process";

const required = ["package.json", "README.md", "README.en.md", "CHANGELOG.md", "LICENSE", "web/index.html", "dist/server.js", "dist/vault.js", "dist/crypto.js", "dist/xlsx.js"];
const forbidden = [/^src\//, /^docs\//, /^scripts\//, /^examples\//, /^\.github\//, /(^|\/)config\.json$/, /\.enc($|\.)/, /\.xlsx$/, /\.csv$/, /-test\./, /^node_modules\//, /\.log$/, /\.env/];

const out = execSync("npm pack --dry-run --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const info = JSON.parse(out)[0];
const files = info.files.map((f) => f.path);

const missing = required.filter((f) => !files.includes(f));
const bad = files.filter((f) => forbidden.some((re) => re.test(f)));

console.log(`包内共 ${files.length} 个文件,约 ${(info.size / 1024).toFixed(1)} KB(解压后 ${(info.unpackedSize / 1024).toFixed(1)} KB)`);
for (const f of files) console.log(`  ${f}`);

if (missing.length > 0) console.error(`\n[失败] 缺少文件:${missing.join(", ")}(是否忘了 npm run build?)`);
if (bad.length > 0) console.error(`\n[失败] 不该出现在包里的文件:${bad.join(", ")}`);
if (missing.length > 0 || bad.length > 0) process.exit(1);
console.log("\n[通过] 包内容检查通过。");
