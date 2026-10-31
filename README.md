# hyprhand

Computer use for [Hyprland](https://hyprland.org). hyprhand lets AI agents read and operate GUI apps on your desktop. Each agent gets its own colored, labeled cursor, so you can watch several of them work at the same time.

![Two agents drive KCalc and Dolphin in parallel, then a third draws "HI!" in Pinta and discards it](docs/demo.gif)

The demo above runs at 1.6× speed. The `calc` agent computes 12 × 34 while `files` opens a folder in Dolphin. Then `artist` picks Pinta's brush, sets its width, finds the canvas, draws, and clicks Discard in the save dialog. A fast decision model chose every target from a plain description, and each decision took about 0.2 s.

hyprhand is a CLI and an MCP server. It is plain Node.js with small Python helpers for accessibility and the cursor overlay.

## How it acts

hyprhand picks the cheapest route that works and drops to the next one only when it has to:

| Route | Used for | Cost |
| --- | --- | --- |
| **Jev decisions** | Finding a described control (`find`, `--find`), verifying the screen (`check`, `wait-for`), and running step sequences (`do`) | 0.15–0.5 s and a fraction of a cent per decision |
| **Accessibility (AT-SPI)** | Clicking elements, setting text and values, reading content | Instant; leaves your pointer and focus alone |
| **Real input** | Coordinates, drags, scrolling, right and double clicks, key presses | Briefly borrows your pointer and keyboard |

### Jev decisions

[TypeSafe Jev](https://docs.typesafe.ai) is a small, fast classifier. hyprhand builds the screen state itself and asks Jev one structured question at a time, following the design of [typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use). The state lists the accessibility items in reading order, each with its role, label, screen region, and row neighbors. Apps without accessibility, such as Electron apps, send a scaled screenshot instead.

- `find "the Send button" --in telegram` returns the matching element, how it was found (`accessibility` or `vision`), and a confidence.
- `--find` on `click`, `move`, `type`, and `scroll` acts on that match directly.
- On a screenshot, Jev looks twice, following TypeSafe's [vision guidance](https://docs.typesafe.ai). It first answers whether the control is visible and boxes it on the whole window. Then hyprhand crops three times that box, enlarges it, and asks again. The confidence comes from the zoomed look, so a control that is cut off or missing scores low instead of returning a wrong box. Images go up as multipart uploads at JPEG quality 90, and small windows are enlarged first. In Discord this places the gift and GIF buttons, the input box, and the server icons at 0.75–0.99 in about 0.8 s.
- `check "the message was sent" --in W` asks Jev a yes/no question about the screenshot and the accessibility items. It answers `yes`, `no`, or `unsure` with a score in about 0.3 s, so agents can verify a step without reading screenshots themselves.
- `wait-for "the upload finished" --in W` repeats that check every second until it holds, and fails after `--timeout` (30 s by default). It keeps polling while the window does not exist yet, so it also waits for an app to start.
- `do "<goal>" --in W` loops: Jev picks one action (click an item, type allowed text, Enter, Escape, back, scroll, wait), hyprhand runs it, and Jev checks whether the goal is met. The run stops with a status of `done`, `unsure` (with the alternatives Jev hesitated between), `no_way_forward`, `stuck`, or `step_limit`. Every earlier action carries what it led to, including "back to the screen from before step 1", so a goal that ends where it started ("open Documents, then go back") still finishes. Each run is logged under `~/.cache/hyprhand/runs`.
- When an app opens a dialog, `find` and `do` follow it, so `--find "the Discard button" --in pinta` reaches Pinta's save prompt.

Jev classifies; it does not plan. `do` works best when the goal lists concrete steps in order, such as `"Press 1, 2, Multiply, 3, 4, Equals"`. When it is unsure, it stops and says so instead of guessing. The calling agent then reads the screen itself or writes a more specific goal.

### Accessibility

`observe` lists windows from `hyprctl` and the accessible elements inside them, each with a short id (`e12`), role, name, states, and screen bounds. AT-SPI reports wrong global coordinates on Wayland, so hyprhand adds window-relative positions to the window position from Hyprland. Clicking an element runs its accessibility action, and typing into a text field sets its content. Neither touches your pointer or keyboard focus, so agents can work on background windows and in parallel.

### Real input

Real input goes through `hyprctl dispatch movecursor`, `ydotool`, and `wtype`, and hyprhand keeps it from interfering with you:

- A lock lets one agent at a time use real input.
- While it runs, hyprhand sets `input:follow_mouse` to 0, so your mouse does not pull focus away, and afterwards it restores your pointer, focused window, and `follow_mouse`.
- `type` sends the whole text through one `wtype` process, so Electron and GTK4 receive every character, and kills it the moment Hyprland reports a focus change; `key` checks focus before each combo. If a launcher or menu holds the keyboard, the error names its layer.
- `type` and `key` refuse to run when they have no live target window, so input never lands in whatever happens to be focused.
- Screenshots wait for window animations to finish.

## Cursors

A click-through GTK layer-shell overlay draws one cursor per agent. Each cursor travels along a curved path, follows a drag along the same straight line and at the same speed as the real pointer, and shows a name pill, ripples on clicks, and a highlight on its target. It fades out a few seconds after its agent's last action. The agent name picks the color, and screenshots hide the overlay.

## Recording

`hyprhand record start --monitor HDMI-A-1` records the screen with the agent cursors to an mp4 through `wf-recorder`, and `hyprhand record stop` returns the file path, length, and size. Record a monitor, a window (`--window W`), or a region (`--region x,y,w,h`). Files go to `~/Videos/hyprhand` unless you pass `--out`.

## Requirements

Arch package names:

```bash
sudo pacman -S hyprland grim ydotool wtype wf-recorder python-atspi at-spi2-core python-gobject gtk-layer-shell python-pillow nodejs
systemctl --user enable --now ydotool
```

The `ydotoold` daemon must be able to write to `/dev/uinput`. For Jev, set `TYPESAFE_API_KEY` from [console.typesafe.ai/keys](https://console.typesafe.ai/keys); without it, everything except `find`, `--find`, `check`, `wait-for`, and `do` still works.

Electron apps (Discord, Slack, VS Code, Chromium browsers) expose accessibility only when started with `--force-renderer-accessibility`. Without that flag, hyprhand uses Jev vision or screenshots for them.

## Install

```bash
git clone git@github.com:JosXa/hyprhand.git
ln -s "$PWD/hyprhand/bin/hyprhand.js" ~/.local/bin/hyprhand
hyprhand doctor
```

hyprhand finds the Hyprland session by itself through `hyprctl instances` and enables the AT-SPI bus when it is off. It therefore works from services, SSH, and agent harnesses that lack a desktop environment.

The agent skill lives in [skills/hyprhand-computer-use](skills/hyprhand-computer-use/SKILL.md). Link or copy that directory into your agent's skill folder.

## Usage

Pass `--agent NAME` on every call. The name selects the cursor color, the element ids, and the window that agent last used. Parallel agents need different names.

```bash
# Let Jev choose
hyprhand --agent calc do "Press 1, 2, Multiply, 3, 4, Equals" --in kcalc
hyprhand --agent calc click --find "the All clear button" --in kcalc
hyprhand --agent courier find "the message input box" --in discord
hyprhand --agent calc check "the display shows 408" --in kcalc
hyprhand --agent calc wait-for "the calculator window is open" --in kcalc --timeout 20000

# Work with element ids yourself
hyprhand --agent calc observe --window kcalc --interactive
hyprhand --agent calc click e11
hyprhand --agent courier type "Hello" --into e8 --submit

# Real input
hyprhand --agent courier key ctrl+0 --to org.telegram.desktop --stay
hyprhand --agent artist drag --from 700,500 --to 700,800 --duration 600
hyprhand --agent courier click 600,878 --in discord --stay

# Windows, screenshots, recording
hyprhand open-app "flatpak run org.kde.kcalc" --wait kcalc
hyprhand windows --all
hyprhand screenshot --window discord --out /tmp/discord.png
hyprhand screenshot --region 0,0,1200,800 --in vivaldi --out /tmp/top-left.png
hyprhand record start --monitor DP-3
hyprhand record stop
```

Coordinates are global unless `--in W` makes them window-relative. `W` is a window id from `windows` (`w1a2b`), an exact app class, or a regex on class or title. Screenshots are at most 1568 px per side, so an agent captures one window or a region of it.

Run `hyprhand help` for all commands and `hyprhand <command> --help` for their options.

### MCP

```json
{ "command": "hyprhand", "args": ["mcp"] }
```

Every command becomes a tool (`do`, `find`, `observe`, `click`, `open_app`, and so on). Each tool takes an `agent` argument, so one server can drive several cursors.

### Environment

| Variable | Effect |
| --- | --- |
| `HYPRHAND_AGENT` | Agent name when `--agent` is not passed |
| `TYPESAFE_API_KEY` | Enables `find`, `--find`, `check`, `wait-for`, and `do` |
| `HYPRHAND_JEV_MODEL` | Jev model, default `jev-latest` |
| `HYPRHAND_COLOR` | Cursor color override, such as `#ff5f87` |
| `HYPRHAND_CURSOR=0` | Disables the cursor overlay |
| `HYPRHAND_RESTORE=0` | Leaves the pointer and focus where real input ended |
| `HYPRHAND_DEBUG=1` | Prints overlay errors |

## Known limits

- Jev's matches on screenshots are slower than on accessibility items (two requests) and score lower on icons without text, so check a vision hit before anything that sends or deletes.
- Electron apps such as Discord and Slack expose no accessibility tree unless started with `--force-renderer-accessibility`, so hyprhand falls back to vision there.

## Credits

hyprhand started from [omarchy-control](https://github.com/IgorWarzocha/omarchy-control) by Igor Warzocha. The multi-cursor idea comes from Vercel Labs' [agent-desktop](https://github.com/vercel-labs/agent-desktop), and the Jev decision design from [typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use).

## License

MIT
