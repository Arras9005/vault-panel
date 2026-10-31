# 参与贡献

欢迎提 Issue 和 PR。动手之前先看这几条,能省很多来回。

## 项目定位

本机运行、零运行时依赖、代码量小到能读完。下面这些**不在计划内**,相关 PR 大概率不会合并:云同步、账号体系、多人共享、手机端、浏览器自动填充、引入第三方运行时依赖。

## 开发环境

需要 Node.js 20 或更新版本。

```bash
npm install
npm run verify    # 类型检查 + 全部测试
npm start         # 启动(源码方式,用 tsx 直接跑 TypeScript)
npm run build     # 编译到 dist/
```

## 提交 PR 前

- `npm run verify` 必须通过。
- 改了加密、保存、导出、导入的逻辑,要补测试:`src/*-test.ts`(沿用现有风格,`node:assert/strict` + `tsx`)。
- 改了界面,在 `examples/demo.csv` 的示例数据上自己点一遍(导入它即可)。
- **不要新增运行时依赖。** 确实需要时,请先开 Issue 讨论。
- 提交信息写清楚改了什么、为什么,关联的 Issue 用 `fixes #123`。

## 绝对不要提交

保险库文件(`*.enc`、`*.enc.bak`)、`config.json`、导出的 `.xlsx` / `.csv`、真实的账号和密码。截图一律使用 `examples/demo.csv` 里的示例数据。`.gitignore` 已经排除了这些,但提交前仍请看一眼 `git status`。

## 安全问题

请不要公开提 Issue,见 [SECURITY.md](SECURITY.md)。
