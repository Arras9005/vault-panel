import assert from "node:assert/strict";
import { csvToEntries, parseCsv } from "./csv.js";

// 基本解析
assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
assert.deepEqual(parseCsv("a,b\r\n1,2"), [["a", "b"], ["1", "2"]]);
assert.deepEqual(parseCsv('"x,y","he said ""hi""","line1\nline2"'), [["x,y", 'he said "hi"', "line1\nline2"]]);
assert.deepEqual(parseCsv("﻿a,b\n"), [["a", "b"]], "去掉 BOM");
assert.deepEqual(parseCsv("a,,c\n"), [["a", "", "c"]]);
assert.deepEqual(parseCsv(""), []);
assert.throws(() => parseCsv('a,"b'), /引号/);

// Chrome 导出格式
const chrome = csvToEntries("name,url,username,password,note\nGitHub,https://github.com,me,s3cret,工作\n,,,,\n");
assert.deepEqual(chrome.rows, [{ name: "GitHub", url: "https://github.com", username: "me", password: "s3cret", note: "工作" }]);

// 本程序的导出格式(Excel 另存为 CSV 后可以导回)
const own = csvToEntries("分组,名称,网址,用户名,密码,备注\n服务器,测试机,,root,pw,\n");
assert.deepEqual(own.rows, [{ group: "服务器", name: "测试机", url: "", username: "root", password: "pw", note: "" }]);

// Firefox:没有名称列
const firefox = csvToEntries('"url","username","password","httpRealm"\n"https://a.example","u","p",""\n');
assert.deepEqual(firefox.rows, [{ url: "https://a.example", username: "u", password: "p" }]);

// 缺列的行补空;识别不了表头时报错
assert.deepEqual(csvToEntries("username,password\nu\n").rows, [{ username: "u", password: "" }]);
assert.throws(() => csvToEntries("foo,bar\n1,2\n"), /无法识别表头/);
assert.throws(() => csvToEntries(""), /空/);

console.log("csv-test OK");
