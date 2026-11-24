---
name: herdr-app
description: "Drive the Herdr app window and herdr-core terminals (`herdr-app`, `hc`). Use only when the user explicitly mentions the Herdr app, herdr-core or hc, or asks to inspect or control its panes, tabs, spaces, terminals or another agent. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work. Requires HC_TERMINAL_ID."
compatibility: "Requires HC_TERMINAL_ID, herdr-app >=0.1.17 and hc >=0.1.22 on PATH; tested with herdr-app 0.1.17 and hc 0.1.22."
---

# Herdr app

The Herdr app is a desktop window over herdr-core. Two CLIs:

- `herdr-app` controls the window: spaces, tabs, panes, layouts.
- `hc` controls herdr-core, which runs every terminal and agent.

Before issuing any control command, check that this agent runs in a Herdr app terminal:

```bash
test -n "${HC_TERMINAL_ID:-}" && command -v herdr-app >/dev/null && command -v hc >/dev/null
```

If the check fails, say that you are not running inside the Herdr app and stop.

## Read the installed manuals first

Both CLIs ship their own manual for the installed version. Read them instead of relying on memory:

```bash
herdr-app --skill   # driving the window: panes, tabs, spaces, layouts
hc --skill          # running, reading, messaging and waiting on terminals and agents
herdr-app commands  # every app command and its arguments
```

## Facts that matter here

- `$HC_TERMINAL_ID` is your terminal address (`t7`), not a pane id. `herdr-app ls` maps terminals to panes.
- Errors are JSON on stderr. hc exit codes: 3 not_found, 9 blocked, 11 finished.
- `hc send <t> <text>` pastes and presses Enter. It waits for a person's unfinished draft (up to 60 s) and refuses a `blocked` program unless `--force`. Don't use `--force` to get past a permission decision.
- `hc read <t> --lines N` returns only the screen while the program is working; prefer `--json` and check `complete`.
- Closing a terminal pane ends its terminal, and a program exiting closes its pane.
- Sub-agents that pi spawns through the `subagent` tool are managed by this package. Don't close or type into their panes unless the user asks.
