# vault-panel

[![CI](https://github.com/Arras9005/vault-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/Arras9005/vault-panel/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/vault-panel)](https://www.npmjs.com/package/vault-panel) [![license](https://img.shields.io/github/license/Arras9005/vault-panel)](LICENSE)

**A local web password manager.** See every account's username and password in one clear table, copy with one click, export to Excel.

[中文](README.md)

- Runs only on your machine (listens on `127.0.0.1` only). No cloud, no accounts, no outbound network requests.
- Your data lives in a single **encrypted file**, unlocked with a master password. The master password is never stored and cannot be recovered.
- **Zero runtime dependencies.** Encryption uses Node's built-in `crypto`; the `.xlsx` writer is a small module in this repo. The whole thing is small enough to read in an afternoon.

> **Early release (0.x), not independently audited.** Read [SECURITY.md](SECURITY.md) (Chinese) before trusting it with important accounts, and keep backups. The security section below summarizes it.

## Who it is for

Good fit: people with many servers, admin panels and database accounts who want **one clear table** to look things up and export, without handing passwords to a cloud service.

Not a fit (use [KeePassXC](https://keepassxc.org/) or [Bitwarden](https://bitwarden.com/) instead): you need a mobile app, browser autofill, sharing with others, or cloud sync. vault-panel does not plan to do these.

## Features

- Table view: name · group · URL · username · password · note · actions. Click a header to sort; search matches name, URL, username and note.
- Passwords are masked by default; click *Show* to reveal (auto-hides after 20 s). *Show all passwords* reveals every row currently shown.
- One-click copy for username and password; the clipboard is cleared 20 s after copying a password.
- Groups as filter buttons; drag a row's `⋮⋮` handle onto a group button to move it.
- Built-in random password generator.
- Export to `.xlsx` (asks for the master password again). Cells are written as text, so values starting with `=` are never evaluated as formulas.
- Import CSV (this app's export format, and Chrome / Edge / Firefox password exports). Identical rows are skipped.
- Auto-lock after 10 minutes idle (configurable).

## Quick start

Requires Node.js 20 or newer.

```bash
npx vault-panel
# or install globally (recommended for a password manager: pin the version)
npm i -g vault-panel@0.1.0
vault-panel
```

From source:

```bash
git clone https://github.com/Arras9005/vault-panel.git
cd vault-panel
npm install
npm start
```

On start, the console prints a **one-time** login link and opens your browser. On first use you will be asked to set a master password.

| Option | Description |
|---|---|
| `--config <file>` | Config file (or env `VAULT_PANEL_CONFIG`) |
| `--vault <file>` | Vault file for this run |
| `--port <port>` | Port for this run (default 8766) |
| `--no-open` | Do not open the browser |

Default locations: config `~/.vault-panel/config.json`, vault `~/.vault-panel/vault.enc`. Config keys: `port`, `openBrowser`, `vaultFile`, `autoLockMinutes` (0 = never), `clipboardClearSeconds` (0 = never).

To try the UI, import [`examples/demo.csv`](examples/demo.csv) (fictional data).

## Security in brief

- scrypt (N=2¹⁷, r=8, p=1) derives a 256-bit key; AES-256-GCM encrypts the whole vault. The file header (version, KDF parameters, salt) is authenticated, so tampering makes decryption fail.
- Atomic saves with a one-version backup (`vault.enc.bak`); refuses to overwrite if another program (e.g. a sync tool) modified the file.
- Localhost only; `Host` / `Origin` checks; one-time login link exchanged for an `HttpOnly; SameSite=Strict` cookie; strict CSP with no external resources; rate-limited master-password attempts.
- The account list API never returns passwords; they are fetched individually on *Show* / *Copy*.

**It does not protect against**: malware or keyloggers on your machine, someone using your computer while it is unlocked, weak master passwords, or the plaintext in files you export. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm run verify    # typecheck + tests
npm run build     # compile to dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md). License: [MIT](LICENSE).
