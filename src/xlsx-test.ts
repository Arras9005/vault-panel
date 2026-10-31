import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildXlsx, columnName, crc32, xmlText } from "./xlsx.js";

assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
assert.deepEqual([0, 25, 26, 27, 51, 52, 701, 702].map(columnName), ["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
assert.equal(xmlText('a<b>&"c"'), "a&lt;b&gt;&amp;&quot;c&quot;");
assert.equal(xmlText("x\u0000y\u0008z\r\nw\ud800"), "xyz\nw", "去掉非法控制字符和孤立代理项,统一换行");
assert.equal(xmlText("😀"), "😀", "成对的代理项要保留");

/** 读出 zip 里所有文件,并校验 CRC 与长度。 */
function readZip(buf: Buffer): Map<string, string> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    assert.equal(buf.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = inflateRawSync(buf.subarray(start, start + csize));
    assert.equal(data.length, usize);
    assert.equal(crc32(data), crc);
    files.set(name, data.toString("utf8"));
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const book = buildXlsx(
  [
    ["分组", "名称", "密码"],
    ["服务器", "=cmd|' /C calc'!A0", "a<b&\"c\""],
    ["", "多行\n备注", "😀"],
  ],
  { sheetName: "账号/备份:1", widths: [14, 24, 30] },
);
const files = readZip(book);
assert.deepEqual([...files.keys()].sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
for (const [name, content] of files) assert.ok(content.startsWith("<?xml"), `${name} 应是 XML`);

const sheet = files.get("xl/worksheets/sheet1.xml")!;
assert.ok(sheet.includes('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">分组</t></is></c>'), "表头加粗样式");
assert.ok(sheet.includes('<c r="B2" t="inlineStr"><is><t xml:space="preserve">=cmd|\' /C calc\'!A0</t></is></c>'), "=开头的内容作为文本,不会当公式");
assert.ok(sheet.includes("a&lt;b&amp;&quot;c&quot;"));
assert.ok(sheet.includes('<c r="C3"'));
assert.ok(sheet.includes('<col min="2" max="2" width="24" customWidth="1"/>'));
assert.ok(sheet.includes('state="frozen"'));
assert.ok(sheet.includes('<autoFilter ref="A1:C3"/>'), "表头带筛选按钮");
assert.ok(sheet.indexOf("</sheetData>") < sheet.indexOf("<autoFilter"), "autoFilter 必须在 sheetData 之后");
assert.ok(files.get("xl/workbook.xml")!.includes('name="账号 备份 1"'), "工作表名里的非法字符被替换");
assert.ok(!sheet.includes("<f>"), "不能出现公式节点");

console.log("xlsx-test OK");
