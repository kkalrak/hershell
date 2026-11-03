# hershell

A fast terminal for Windows with a status sidebar, built for running `claude` and `codex` side by side.

- One sidebar item = one PowerShell terminal (xterm.js + WebGL, node-pty)
- Sidebar shows each shell's status: working / waiting for approval / done / idle
- Item title is always the shell's current folder; folders are restored on restart
- Sidebar is sorted by folder name automatically (Korean collation, updates live)

```powershell
npm install
node node_modules\electron\install.js
npm start
```

Development notes: see [AGENTS.md](AGENTS.md).
