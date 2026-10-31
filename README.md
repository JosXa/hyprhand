# hyprhand

Computer use for [Hyprland](https://hyprland.org). hyprhand lets AI agents read and operate GUI apps on a Hyprland desktop, and it shows each agent as its own colored, labeled cursor so you can watch several of them work at once.

It is a CLI and an MCP server, written in plain Node.js with small Python helpers for accessibility and the overlay.

## What it does

- **Reads app UIs through AT-SPI.** `observe` lists windows from `hyprctl` and the accessible elements inside them, each with a short id, role, name, state, and global screen bounds. Bounds come from window-relative accessibility coordinates plus the Hyprland window position, since global coordinates from AT-SPI are wrong on Wayland.
- **Acts semantically first.** Clicking an element runs its accessibility action, and typing into a text field sets its content. Neither touches your pointer or keyboard focus, so agents can work on background windows and in parallel.
- **Falls back to real input when needed.** Coordinates, double and right clicks, drags, scrolling, and key presses go through `hyprctl dispatch movecursor`, `ydotool`, and `wtype`. A lock serializes real input between agents, and hyprhand puts your pointer and focused window back afterwards.
- **Draws one cursor per agent.** A click-through GTK layer-shell overlay animates each agent's cursor along a curved path, with a name pill, click ripples, and target highlights. A cursor fades out a few seconds after its agent's last action. Screenshots hide the overlay.
- **Finds the session by itself.** It discovers `HYPRLAND_INSTANCE_SIGNATURE`, `WAYLAND_DISPLAY`, and the ydotool socket through `hyprctl instances`, so it works from services, SSH, and agent harnesses that lack a desktop environment. It also enables the AT-SPI bus when it is off.
- **Handles Flatpak apps.** Sandboxed apps register with a different process id; hyprhand matches them by window title.

## Requirements

Arch package names:

```bash
sudo pacman -S hyprland grim ydotool wtype python-atspi at-spi2-core python-gobject gtk-layer-shell python-pillow nodejs
systemctl --user enable --now ydotool
```

The `ydotoold` daemon must be able to write to `/dev/uinput`. Run `hyprhand doctor` to check everything.

Electron apps (Discord, Slack, VS Code, Chromium browsers) expose accessibility only when started with `--force-renderer-accessibility`. Without it, agents use screenshots and window-relative coordinates for them.

## Install

```bash
git clone git@github.com:JosXa/hyprhand.git
ln -s "$PWD/hyprhand/bin/hyprhand.js" ~/.local/bin/hyprhand
hyprhand doctor
```

The agent skill lives in [skills/hyprhand-computer-use](skills/hyprhand-computer-use/SKILL.md). Link or copy that directory into your agent's skill folder.

## Usage

```bash
hyprhand --agent calc open-app "flatpak run org.kde.kcalc" --wait kcalc
hyprhand --agent calc observe --window kcalc --interactive
hyprhand --agent calc click e11
hyprhand --agent courier key ctrl+0 --to org.telegram.desktop --stay
hyprhand --agent courier type "Hello" --into e8 --submit
hyprhand --agent courier click 600,878 --in discord --stay
hyprhand screenshot --window discord --out /tmp/discord.png
hyprhand cursors
```

Run `hyprhand help` for all commands and `hyprhand <command> --help` for their options.

### MCP

```json
{ "command": "hyprhand", "args": ["mcp"] }
```

Every command becomes a tool (`observe`, `click`, `type`, `open_app`, and so on). Each tool takes an `agent` argument, so one server can drive several cursors.

### Environment

| Variable | Effect |
| --- | --- |
| `HYPRHAND_AGENT` | Agent name when `--agent` is not passed |
| `HYPRHAND_COLOR` | Cursor color override, such as `#ff5f87` |
| `HYPRHAND_CURSOR=0` | Disable the cursor overlay |
| `HYPRHAND_RESTORE=0` | Leave the pointer and focus where real input ended |
| `HYPRHAND_DEBUG=1` | Print overlay errors |

## Credits

hyprhand started from [omarchy-control](https://github.com/IgorWarzocha/omarchy-control) by Igor Warzocha. The multi-cursor idea comes from Vercel Labs' [agent-desktop](https://github.com/vercel-labs/agent-desktop).

## License

MIT
