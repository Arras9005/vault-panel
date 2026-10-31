# vault-panel

[![CI](https://github.com/Arras9005/vault-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/Arras9005/vault-panel/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/vault-panel)](https://www.npmjs.com/package/vault-panel) [![license](https://img.shields.io/github/license/Arras9005/vault-panel)](LICENSE)

**本机运行的账号密码管理网页**:在浏览器里用表格查看各类账号的用户名和密码,一键复制,可导出为 Excel。

[English](README.en.md)

- 只在你的电脑上运行(只监听 `127.0.0.1`),没有云端、没有账号体系、没有任何对外网络请求。
- 数据存成一个**加密文件**,用主密码解锁;主密码不保存,忘记后无法找回。
- **零运行时依赖**:加密用 Node 内置的 `crypto`,Excel 文件由自带的小模块生成。代码量小,可以自己读完。

> **早期版本(0.x),尚未经过第三方安全审计。** 用于重要账号前,请先读 [SECURITY.md](SECURITY.md) 了解它能防什么、不能防什么,并保留好备份。

<!-- 截图:放在 docs/screenshots/,用 examples/demo.csv 的示例数据,不要用真实账号。例如:
![主界面](docs/screenshots/main.png)
-->

## 适合谁,不适合谁

适合:有不少服务器、后台、数据库账号要管理,想要**一张清楚的表格**随时查看和导出,又不想把密码交给云服务的人。

不适合(请用 [KeePassXC](https://keepassxc.org/) 或 [Bitwarden](https://bitwarden.com/)):需要手机端、浏览器自动填充、多人共享、云同步的人。vault-panel 不打算做这些。

## 界面

表格列:名称 · 分组 · 网址 · 用户名 · 密码 · 备注 · 操作。

- 密码默认显示为 `••••••••`,点「显示」才看到明文(20 秒后自动隐藏);「显示全部密码」可一次展开当前表格里的所有密码。
- 用户名、密码旁边都有「复制」按钮;复制密码后 20 秒自动清空剪贴板。
- 上方的分组按钮用来筛选,把行左侧的 `⋮⋮` 拖到分组按钮上即可移动分组。
- 点表头排序,搜索框同时匹配名称、网址、用户名、备注;按 `/` 快速定位到搜索框,`Esc` 清空。
- 导入 CSV、管理分组、修改主密码在右上角「更多」菜单里。
- 无操作(没有鼠标、键盘、滚动)10 分钟自动锁定。

## 快速开始

需要 Node.js 20 或更新版本。

**方式一:用 npm(推荐)**

```bash
npx vault-panel                # 直接运行,不用安装
# 或全局安装
npm i -g vault-panel
vault-panel
```

> 密码管理器建议**全局安装并固定版本**(`npm i -g vault-panel@0.1.0`),而不是每次 `npx` 都拉取最新代码。

**方式二:从源码运行**

```bash
git clone https://github.com/Arras9005/vault-panel.git
cd vault-panel
npm install
npm start
```

Windows 也可双击 `start.bat`,macOS 双击 `start.command`(首次需要 `chmod +x start.command`)。

启动后控制台会打印一个**只能使用一次**的登录链接,浏览器会自动打开。第一次使用先设置主密码。

| 选项 | 说明 |
|---|---|
| `--config <文件>` | 指定配置文件(也可用环境变量 `VAULT_PANEL_CONFIG`) |
| `--vault <文件>` | 本次运行使用的保险库文件 |
| `--port <端口>` | 本次运行使用的端口,默认 8766 |
| `--no-open` | 不自动打开浏览器 |
| `-v, --version` / `-h, --help` | 版本 / 帮助 |

配置文件默认是 `~/.vault-panel/config.json`(Windows 是 `C:\Users\你\.vault-panel\config.json`),保险库默认是同目录的 `vault.enc`;不存在会自动创建。配置项:

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | 8766 | 监听端口 |
| `openBrowser` | true | 启动时是否自动打开浏览器 |
| `vaultFile` | `vault.enc` | 保险库文件;相对路径相对于配置文件所在目录,支持 `~/` 开头 |
| `autoLockMinutes` | 10 | 无操作多少分钟后自动锁定;0 表示不自动锁定 |
| `clipboardClearSeconds` | 20 | 复制密码后多少秒清空剪贴板;0 表示不清空 |

## 导出 Excel

点「导出 Excel」,再输入一次主密码确认,得到 `账号导出-日期.xlsx`,列为 分组 / 名称 / 网址 / 用户名 / 密码 / 备注,表头带筛选按钮。

**导出文件里是明文密码**,用完请妥善保管或删除。单元格都按文本写入,以 `=` 开头的内容不会被 Excel 当作公式执行。

## 导入

点「更多 → 导入 CSV」。支持本程序导出的表头(分组、名称、网址、用户名、密码、备注),以及 Chrome / Edge / Firefox 导出的密码 CSV。Excel 文件请先「另存为 CSV(UTF-8)」。与已有账号完全相同的行会被跳过,重复导入同一份文件不会产生重复。导入后请删除 CSV 文件。

想先试一下界面?导入仓库里的 [`examples/demo.csv`](examples/demo.csv)(全是虚构的示例数据)。

## 多台电脑

保险库是单个文件,可以自己用 Mutagen、Syncthing、网盘同步。程序保存前会检查文件有没有被别的程序改过,改过就拒绝覆盖,提示你先锁定再重新解锁载入最新内容。**不要两台电脑同时编辑。**

## 备份与恢复

每次保存前,上一版会复制为 `vault.enc.bak`。如果 `vault.enc` 损坏或误操作,先退出程序,把 `vault.enc.bak` 重命名为 `vault.enc` 即可(用的是备份当时的主密码)。也请定期把保险库文件复制到别处。

## 开发

```bash
npm run verify    # 类型检查 + 全部测试
npm run build     # 编译到 dist/
```

| 文件 | 作用 |
|---|---|
| `src/crypto.ts` | 密钥派生(scrypt)、加解密(AES-256-GCM)、文件格式 |
| `src/vault.ts` | 保险库:账号和分组、原子保存、备份、冲突检测 |
| `src/xlsx.ts` | 生成 .xlsx |
| `src/csv.ts` | 解析 CSV 并识别表头 |
| `src/limiter.ts` | 主密码输错限速 |
| `src/server.ts` | 本机 HTTP 服务、登录、接口 |
| `web/index.html` | 单文件前端 |

参与贡献请先看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)
