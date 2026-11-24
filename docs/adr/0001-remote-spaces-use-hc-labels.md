# Remote Herdr app spaces use hc labels instead of pane splits

Status: accepted (2026-11-24)

## Context

A space the Herdr app opens on a machine added with `hc machine add` runs its terminals, and pi, on that machine. `herdr-app` is not there, the remote core cannot reach back to the app's machine (`hc machine ls` is empty on the remote), and `HC_TERMINAL_ID` is the bare id (`t8`) while the app lists the terminal as `<machine>/t8`. So pi in a remote space could not confirm a pane and registered no tools, silently.

The app adopts any terminal labeled `herdr.space=<id>` and `herdr.tab=<id>` as a pane in that tab, using ids local to the terminal's machine. Every terminal the app starts carries those labels, remote ones included.

## Decision

When `herdr-app ls` cannot confirm this terminal's pane, the Herdr app backend falls back to the terminal's own labels (`hc get $HC_TERMINAL_ID`). Each sub-agent is then `hc run --bg --no-parent --cwd <cwd>` with the same labels, running the existing launch bootstrap. Read, send, exit polling and cleanup are unchanged `hc` calls. The version gate checks only `hc`.

The pane is still confirmed: the labeled terminal's program must be an ancestor of the pi process, so a leaked `HC_TERMINAL_ID` registers nothing.

## Consequences

- Sub-agents in remote spaces show as panes in the local window; remote machines need only `hc`.
- No placement control: the app splits the last pane to the right for each adopted terminal, instead of the two-column stack. Focus is not restored and panes keep the program's title. A local mod that rearranges adopted panes could restore the layout later.
- `--no-parent` is required: with a parent, hc types child notes into the parent pi's input.
- The fallback also applies locally whenever `herdr-app ls` fails but the labels exist (for example, the app window is closed).
