# Vesna for VS Code

A coding agent with spec-driven development built in — the chat, the garden
and the review findings beside your code. This extension is a client of
`vesna serve`: it runs the request classified, designed, planned, approved
and built by subagents in parallel git worktrees, each task reviewed by a
fresh reviewer that can read and cannot write — and shows every step as it
happens, in the editor, with no terminal open.

## Install

Vesna itself is not bundled — install the CLI first, then this extension:

```sh
npm i -g @seasons-ai/vesna
```

Then install "Vesna" from the Marketplace (`seasons-ai.vesna`), open a
folder with (or without) a `.vesna/` spec, and the extension starts
`vesna serve` for you.

## The three views

**Chat** — a side-panel conversation with streaming markdown, a card per
tool call, and the questions Vesna asks as buttons (`y` / `a` / `n`).

![Chat](https://raw.githubusercontent.com/seasons-ai/vesna/main/vscode/media/shots/chat.png)

**Garden** — the spec's phases and tasks as a tree: stages, the running
build, each task's worker/reviewer witnesses, parked findings — click a
node to open the document or brief behind it.

![Garden](https://raw.githubusercontent.com/seasons-ai/vesna/main/vscode/media/shots/garden.png)

**Findings** — review findings as diagnostics, squiggles on the lines they
name and entries in the Problems panel, cleared when the spec closes.

![Findings](https://raw.githubusercontent.com/seasons-ai/vesna/main/vscode/media/shots/problems.png)

The mode (`plan` / `ask` / `auto`) sits in the status bar; click it to
cycle, or run any `Vesna:` command from the palette.

## Settings

- `vesna.command` — the executable that runs `serve`. Default `vesna`,
  resolved on `PATH`; an absolute path, or a runtime such as `bun` also
  works.
- `vesna.args` — arguments placed **between** the command and `serve`:
  `<command> <args...> serve`. With `vesna.command` set to `bun`,
  `["/path/to/vesna/bin/vesna"]` runs a checkout instead of an install.

## What it does not do

- Bundle Vesna — the CLI is a separate install, above.
- Run more than one server per window, or reach across a multi-root
  workspace — one folder, one server.
- Show an MCP-servers panel — MCP is a core feature first, not yet in
  this extension.

## Licence

MIT.
