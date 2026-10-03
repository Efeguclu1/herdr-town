# Agent Town

A [Herdr](https://herdr.dev) plugin that renders your running coding agents as
an 8-bit town, and lets you read and answer them without leaving it.

![Agent Town](docs/town-dawn.png)

Herdr already knows which agents are `working`, `blocked`, `done` or `idle`
across every project. Agent Town draws that as a place instead of a list, then
goes one step further: hover a worker and it tells you what it last said, press
`enter` to read the whole message, press `r` to answer it, or press `t` to
relay a message from that worker to another agent.

```bash
herdr plugin install Efeguclu1/herdr-town
herdr plugin pane open --plugin efeguclu.town --entrypoint town
```

## The idea

| Herdr concept | In the town |
| --- | --- |
| Workspace | A **town** |
| A feature being worked on | A **building** under construction |
| Agent in a pane | An 8-bit **worker** |
| `agent_status` | What the worker is doing |
| Time spent `working` | How many **floors** the building has |

Agents whose panes report the same task title are working on the same feature,
so they share a building and hammer at it side by side.

Every agent CLI gets its own colour, spread around the hue circle rather than
picked ad hoc, so two workers are never the same shade. All 19 agents Herdr
ships detection for are covered, plus aliases; anything unrecognised draws from
a reserve kept clear of the assigned colours. Values stay above a brightness
floor because a worker has to read against a midnight sky as well as a noon one.

| State | Worker | Building |
| --- | --- | --- |
| `working` | Swings a hammer, sparks fly | Scaffolding, a swinging crane, flickering windows |
| `blocked` | Arms up under a pulsing red `!` | Hazard tape across the site, red windows |
| `done` | Celebrating in confetti | Fully lit, flag on the roof |
| `idle` | Asleep with floating `z`s | Dark, a couple of windows on |

## Read, reply, and relay

The point of the town is that it replaces reading terminal scrollback. Hover a
worker and a speech bubble shows what it last said. Blocked agents always get
one, because a blocked agent is the reason you looked.

Press `enter` and the town gives way to the full message:

```
 claude blocked  QR handshake fix                                        w2:pF
──────────────────────────────────────────────────────────────────────────────
  I found two ways to fix the handshake.

  1. Patch the client to retry with the old token format. Small, contained,
     but leaves the shim in place for another release.
  2. Bump the library to 3.2 and delete the shim entirely. Cleaner, but it
     touches the reconnect path that the QR flow depends on.

  Which do you want?

 line 1-9 of 34
 ↑↓/wheel scroll  r reply  enter go to this agent  esc back  q quit
```

Press `r` to open a full-screen reply editor, pinned to that agent:

1. Write or paste your message. **Enter inserts a newline**, never sends.
2. Use arrows and Home/End (or Ctrl+A/Ctrl+E) to edit. Ctrl+U clears the draft.
   **Wheel or Page Up/Down scrolls** without moving the insertion point. The
   viewport stays where you scroll until you type, paste, or move the cursor;
   the status row shows the visible row range.
3. Press **Ctrl+S** to review the recipient and complete message.
4. Press **Enter on the confirmation screen** to send, or Esc to keep editing.

Esc from the editor keeps a separate draft for that agent; press `r` to resume
it later. Drafts stay **in memory for this town session only** and are lost when
the view closes. They are not written to the activity history or disk.

Bracketed paste preserves newlines and indentation and strips terminal control
sequences. Pasted keys cannot navigate, approve choices, or confirm a send.
The terminal/host must forward bracketed-paste markers for that protection;
ordinary unbracketed newlines still only insert new lines while editing.
Drafts are limited to 64,000 characters (paste buffering uses a conservative
64,000 UTF-16-unit limit), with a warning if truncated.

Delivery goes through `herdr agent prompt`. The editor freezes while sending
so a double Enter cannot deliver twice. Errors keep the draft and never retry
automatically: check the agent first if delivery was uncertain. If the agent
vanishes, the draft stays available but cannot be sent to a substitute pane.

![Earlier single-line reply UI (before the multiline editor)](docs/reply.png)

### Agent-to-agent relay

Press `t` from the reading view to pass context from the worker you are reading
to another live agent:

1. Read the source worker with `enter`.
2. Press `t` and choose a recipient with `↑` or `↓`. The list includes every
   live agent in every town, not just the current workspace.
3. Press `enter`, write the message, then press `enter` again to send it.

Agent Town pins the chosen pane while you type, so a background refresh cannot
silently redirect the message to a different worker. The recipient receives a
normal Herdr prompt with a small, explicit envelope:

```text
[Herdr Town message from claude (w2:pF)]
Please review the reconnect-path changes and report any race conditions.
```

This is an intentional relay, similar to sending input between tmux panes. It
does not start an unbounded autonomous conversation: you choose the source,
recipient, and message each time. The envelope makes relayed context distinct
from an ordinary human prompt and gives the recipient a pane ID to reference.

## Time of day

The sky runs on your real clock, interpolated between keyframes so dawn creeps
in and sunset deepens rather than snapping between modes.

![The full day cycle](docs/day-cycle.png)

The sun and moon arc across the sky on the real clock, so the town tells you
roughly what time it is. Lit windows respond to the light: at midnight a lit
window glows, at noon it is just glass. Stars fade in as it darkens, and clouds
only appear while it is bright enough to see them.

| Afternoon | Night |
| --- | --- |
| ![Afternoon](docs/town-day.png) | ![Night](docs/town-night.png) |

There is no way to change the time from inside the town, deliberately: the
sky is meant to tell you what time it actually is, and a town you can set to
midnight stops being informative. For development you can pin an hour, but it
has to go through `--env`:

```bash
herdr plugin pane open --plugin efeguclu.town --entrypoint town \
  --env HERDR_TOWN_HOUR=19.5
```

Herdr's server spawns plugin panes, so `HERDR_TOWN_HOUR=19.5 herdr plugin
pane open ...` does **not** work: the variable is set on the client, which
only sends a socket request, and never reaches the launched process.

## Every project at once

Press `w` for the world view: each project as its own town on its own plot, so
you can see across everything you are running.

![World view](docs/world.png)

A town with a blocked agent raises a `!` above its skyline, and the town you
have selected keeps a frame around its plot. A workspace with nothing built
yet shows open land rather than a placeholder building, so the map never
promises a town that the town view then shows as an empty field.

## Attention, buildings, and search

Three shortcuts work from both town and world view:

- **`a` — Attention queue:** blocked agents across all towns, oldest observed
  wait first. Press `enter` to read an agent, then `r` to reply as usual.
  `esc` returns to the queue. Waits are measured while this view is running,
  not the agent's actual block start time; reopening the town resets them.
- **`b` — Building browser:** every building in the selected town, including
  finished buildings and ruins without workers. Press `enter` to inspect its
  status, accumulated agent working time, floors, recorded dates, live agents,
  and contributors. Use arrows or the wheel to scroll the inspector.
- **`/` — Search:** find towns, buildings, and live workers across all workspaces
  by workspace name, task title, agent name, or pane ID. Enter on a town visits
  it, on a building opens its inspector, and on a worker reads its message.

Type in any list to filter it (case-insensitive; all words must match).
`↑`/`↓` or the wheel selects a result, `enter` opens it, `ctrl+u` clears the
filter, and `esc` goes back. Printable shortcuts such as `q` are search text
while in a list; `ctrl+c` quits. Selection follows stable IDs across refreshes.
If a selected result disappears, choose again rather than silently opening a
different agent.

First-observation dates and contributor history are recorded from this release
onward by the background recorder; older records show missing fields as
**not recorded**. If upgrading with a recorder already running, restart it to
begin collecting the new metadata. Last recorded activity is when the feature
was last observed, including idle observations—not its last code change.
Working time and building height are **not completion percentages**.

## While you were away

Press **`s`** from town or world view for a summary of recorded changes since
last marking the summary read: feature completions, newly blocked agents,
other agent state changes, arrivals/departures, and the towns affected.

- `↑`/`↓`, Page Up/Down, or the wheel scrolls; **`r` refreshes** the snapshot.
- **`c` marks the displayed snapshot read**. Later updates remain unread.
- **Esc goes back without marking anything read**.
- Unread updates show a footer hint and open automatically when starting the
  view. If the host forwards terminal focus reports, returning after at least a
  minute also opens the summary from town/world view. Editors are never interrupted.

The recorder keeps up to **1,000 events / 7 days**, in `progress.json`, including
its last observed baseline so restarting does not replay all agents as new.
The first snapshot establishes that baseline; it does not invent past events.
Summaries use the recorder's 15-second observations, not exact transition times,
and can miss changes between polls. Recording gaps, stale data, and expired
history are explicitly labelled. This is not a transcript archive: only task,
workspace, agent, and state metadata are recorded.

The view writes acknowledgements separately to `summary-seen.json` in the plugin
state directory, shared by town views. It never writes recorder-owned progress.

**Upgrading:** reopen the town and restart the existing recorder to enable event
recording. Without a running updated recorder, `s` explains that history is not
yet available (or shows its last observation as stale).

## The town remembers

Towns are not just a view of what is running right now. Every feature its
agents have worked on is remembered, so the skyline is a record of the project:

- **Finished** features stay standing as completed buildings, warm lit windows
  and a flag, no workers outside. Kept for 90 days.
- **Abandoned** features (worked on, never finished) stand as **ruins**:
  eroded rooflines, dark windows, rubble at the base. Kept for 14 days.
- Features touched for under a minute leave nothing behind, so glancing at an
  agent does not permanently alter the town.

Buildings grow with the time their agents spend in Herdr's `working` state:
one hour per floor, up to 8, so a maxed-out tower is seven hours of real work
on a single feature. Two agents on the same feature build it twice as
fast. An agent sitting idle at a prompt builds nothing, which is deliberate:
the skyline should reflect work done, not panes left open.

### The recorder

Progress is counted by a small background process, not by the view. If it were
counted while the town was on screen, buildings would only grow during the
minutes you happened to be watching.

The plugin's `[[startup]]` hook detaches the recorder when Herdr starts, and
opening the town starts one if none is running. It polls every 15 seconds,
holds a heartbeat lock so only one ever runs, and exits once Herdr has been
gone for about five minutes. It is the only writer of progress; the view opens
the store read-only.

```bash
node bin/recorder.js --spawn   # start one by hand
pgrep -fl bin/recorder.js      # check it is alive
pkill -f bin/recorder.js       # stop it (buildings stop growing)
```

## Controls

Herdr forwards mouse reports to plugin panes, including motion, so the town is
browsable with the pointer.

| Mouse | Does |
| --- | --- |
| **hover** a worker | Selects them; their bubble appears as you pass |
| **click** the selected worker | Opens the full message |
| **wheel** | Walks workers, scrolls messages, or chooses a relay recipient |

| Key | Town view | World view |
| --- | --- | --- |
| `←` `→` / `h` `l` | Select a worker | Select a town |
| `↑` `↓` / `k` `j` | Switch town | — |
| `enter` | Read the full message | Enter the town |
| `w` / `tab` | World view | Back to town view |
| `m` | Release the mouse back to Herdr | Same |
| `r` | Refresh now | Refresh now |
| `s` | While-you-were-away summary | Same |
| `a` | All-town attention queue | Same |
| `b` | Browse this town's buildings | Browse selected town's buildings |
| `/` | Search all towns | Same |
| `q` / `esc` | Quit | Quit |

### Reading and relay controls

| Key | Reading view | Relay recipient list | Relay composer |
| --- | --- | --- | --- |
| `↑` `↓` / wheel | Scroll message | Choose recipient | — |
| `r` | Reply to this agent | — | — |
| `t` | Start an agent relay | — | — |
| `enter` | Jump to this agent | Write to selected agent | Send |
| `ctrl+u` | — | — | Clear text |
| `esc` | Back to town | Back to message | Cancel |
| `q` | Quit | Back to message | Type `q` |

Reply editor controls differ from the relay composer: **Enter adds a newline,
Ctrl+S reviews, then Enter confirms**. Esc keeps the reply draft. In both editors,
printable keys belong to the message, so typing `q` writes a `q` instead of quitting.

## Terminal size

The town scales to the pane it is given. Terminal size decides how the town is
*drawn*, never what it contains: the number of buildings comes from your
agents and their history, and the number of floors comes from recorded working
time. A small terminal shows fewer buildings at once and you scroll; it does
not mean the town has fewer.

| terminal | storey | worker | bubble | buildings on screen |
| --- | --- | --- | --- | --- |
| 80x24 | 3px | 12px | 25 chars | 4 |
| 100x30 | 3px | 12px | 32 chars | 5 |
| 120x40 | 5px | 12px | 38 chars | 6 |
| 161x50 | 6px | 12px | 46 chars | 8 |
| 200x60 | 8px | 12px | 46 chars | 10 |

Storey height is derived so that a maxed-out 8-floor tower exactly fills the
sky below the space reserved for speech bubbles, and sprite scale follows
storey height so a worker stays about a storey and a half tall at any size.
Both were once chosen independently, which made floors 5-8 render identically
on a 161x50 pane and left workers 43% as tall as a full tower.

Below 100x30 there is genuinely not enough sky for eight distinct storeys, so
floors compress: 80x24 shows 6 of the 8 as distinct heights.

## Install

```bash
herdr plugin install Efeguclu1/herdr-town
```

Or to work on it locally:

```bash
git clone https://github.com/Efeguclu1/herdr-town
herdr plugin link ./herdr-town
```

No build step and no dependencies, just Node 16+. The town opens as a **tab**
so it survives jumping to an agent: press `enter` from the reading view and
focus moves to that agent's pane while the town keeps running behind it.

Bind it to a key in your Herdr config:

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "efeguclu.town.open"
description = "agent town"
```

Opened from a workspace, it starts on that workspace's town.

## How it works

Herdr has no plugin SDK. The CLI *is* the API, so this polls `herdr agent list`
and `herdr workspace list` once a second through `HERDR_BIN_PATH` (which works
over both Unix sockets and Windows named pipes) and animates at ~12fps between
polls.

Rendering uses the half-block trick: each terminal cell draws `▀` with one
colour as the foreground and another as the background, giving two square
pixels per cell and a real pixel-art canvas at 2× the row resolution. Colours
come from the 16-colour Sweetie-16 palette, which is most of why it reads as
8-bit rather than as a terminal with colours in it.

Speech bubbles are a pixel frame around **real terminal text**. A canvas column
is exactly one terminal column, so text composites into the scene at full font
resolution: readable at sentence length, and one line costs 2 pixel rows
instead of the 7 a pixel font would need.

Reading an agent's message is deliberately dumb. Claude Code and Cursor paint
different screens but the same *shape*: `<transcript> RULE <input box> RULE
<status>`. Finding the trailing cluster of box-drawing rules and cutting there
handles both with no per-agent parser, which matters because Herdr supports
15+ agent CLIs.

| Module | Does |
| --- | --- |
| `src/canvas.js` | Pixel canvas, text cells, ANSI renderer |
| `src/scene.js` | Sky, buildings, workers, bubbles, layout |
| `src/daylight.js` | Day cycle: keyframed sky, sun and moon arcs |
| `src/message.js` | Reading agent screens and stripping chrome |
| `src/world.js` | Herdr snapshot to towns, buildings, workers |
| `src/store.js` | Persistent build progress and town history |
| `src/navigation.js` | Search entries, stable identities, observed blocked waits |
| `src/activity.js` | Bounded recorded changes and separate summary acknowledgements |
| `src/reply.js` | Multiline editing and session-only per-agent drafts |
| `src/input.js` | Streaming keys, bracketed paste, mouse, and focus reports |
| `src/mouse.js` | SGR mouse reports |
| `src/font.js` | 3x5 bitmap font for in-world labels |

Dev tools, not part of the runtime:

```bash
node tools/preview.js out.png town 6 0 19   # render a scene to a PNG at 19:00
node tools/daysheet.js out.png              # the whole day as one contact sheet
node tools/message-test.js                  # what the extractor pulls from every agent
node tools/mouse-probe.js                   # does this terminal forward mouse events
```

Screenshots are real terminal captures. The day-cycle contact sheet is the one
exception: twelve hours cannot be photographed in one sitting, so it is
rendered by `tools/daysheet.js`, which approximates in-bubble text with the
bundled 3x5 font.

The captures predate a round of sizing work, so towns in them sit lower in the
frame and workers are larger relative to buildings than they now render. The
behaviour they show is otherwise current.

## Testing against your agent

Herdr supports 19 agent CLIs. This repo has fixtures for the shapes its author
could actually capture, so if the town shows nonsense for your agent, the fix
starts with a capture:

```bash
npm test                                    # extraction, navigation, activity, reply, input tests
python3 tests/terminal-smoke.py              # optional Unix PTY test with a fake Herdr (no live agents)
node tools/capture.js w2:pF codex-blocked   # save your agent's screen as a fixture
```

A fixture is raw `herdr agent read --source visible` output. The extractor has
no per-agent branches, so every fixture is checked by the same rules: a message
comes out, no box rules or prompt lines or token counters survive, and the
teaser a bubble would show contains real words rather than furniture.

**Check a capture for anything private before attaching it** — it is a verbatim
snapshot of what that agent had on screen. The fixtures in this repo carry real
chrome with invented content for that reason.

Sending a capture is the single most useful contribution: it turns an untested
agent into a tested one.

## Known limitations

- **Verified against Claude Code and Cursor.** Those are the agents the author
  runs. The extractor is structural rather than per-agent, and there is a
  fixture covering agents that draw no input box at all, but the other 16 CLIs
  Herdr supports are untested. See above for how to fix that in one command.
- **Sized for wide terminals.** Everything scales off canvas width. Below about
  100 columns bubbles get cramped.
- **Sunrise and sunset are fixed** at 06:12 and 19:36 year-round rather than
  computed from your latitude and date.
- Built and tested against **Herdr 0.7.5**.

Pane graphics (`pane.graphics.*`) could render true images instead of
half-blocks, but they are experimental and require
`[experimental].kitty_graphics = true`, so this sticks to half-blocks and works
everywhere. Herdr's `pane.agent_status_changed` event is scoped to one pane, so
a view spanning every workspace polls rather than subscribing; the animation
loop needs to tick regardless.

## Licence

MIT
