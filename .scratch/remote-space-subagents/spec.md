# Sub-agents in remote Herdr app spaces

Status: resolved (pending human commit)

## Problem

pi in a Herdr app space on a machine added with `hc machine add` gets no subagent tools and no message: `herdr-app` is not on that machine and cannot see the window.

## Goal

Spawning from a remote space shows sub-agents as panes in that space's tab in the local app window. Decision and trade-offs: `docs/adr/0001-remote-spaces-use-hc-labels.md`.

## Done when

- A labeled terminal without `herdr-app` registers tools (hc-only version gate); a leaked `HC_TERMINAL_ID` does not.
- Launch handoff, sentinel, steering reads and close work for pane-less surfaces.
- README, AGENTS.md updated; `pnpm check` and `pnpm test` pass.

## Comments

- 2026-11-24: Verified by experiment: a terminal started on `wkmacmini` with that machine's labels appeared as a pane in the local window; two in a row split right (50/25/25). Implemented in `herdr-app.ts` / `herdr.ts`. E2E on this machine in a labeled `hc run` terminal with `herdr-app` removed from PATH: launch handoff (cwd honored), sentinel, plain shell send/read, close + `hc rm` all pass; a leaked id under `hc exec` reports outside-herdr. Not run: a real pi on a remote machine spawning through an LLM turn.
