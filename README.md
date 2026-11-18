# OpenCode config

Custom TUI/server plugins and `cli.json` for OpenCode V2.
Copy config/plugin files to `~/.config/opencode/` (not `tests/` or `package.json`); in a clone run `bun install` and `git config core.hooksPath .githooks` so pushes run `bun test tests`.

- `shift-enter-newline`: Shift+Enter newline for terminals without Kitty keyboard modifiers.
- `find-conversation`, `timestamps-final`: TUI plugins; `taller-tabs` adds half-row tabs and static hover titles.
- `fetch-verbose`: redacted HTTP diagnostics for model requests.

Local agent instructions and service credentials are not published.
