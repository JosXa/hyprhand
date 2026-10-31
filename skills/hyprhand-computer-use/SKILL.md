---
name: hyprhand-computer-use
description: Use when operating GUI apps on the user's Hyprland desktop (clicking, typing, reading app UIs, screenshots, window management) through the hyprhand CLI, including several agents working in parallel.
---

# hyprhand: computer use on Hyprland

`hyprhand` controls the Hyprland desktop. It reads app UIs through AT-SPI accessibility, acts on elements semantically where it can, and falls back to real pointer and keyboard input. Every agent gets its own colored, labeled cursor on screen, so the user can watch several agents work at once.

Prefer structured routes first: shell commands, app CLIs, browser automation, MCP tools. Use hyprhand for GUI-only flows and visual checks.

## Identity

Pass `--agent NAME` on every call (or set `HYPRHAND_AGENT`). The name selects your cursor color, your element ids, and your remembered target window. Pick a short, stable name per task, such as `calc` or `courier`. Parallel agents must use different names.

## Loop

1. `hyprhand --agent me observe --window <class|id|title-regex> --interactive` lists the window and its elements as `eN role "name" @x,y,w,h (states)`.
2. Act on ids: `click eN`, `type "text" --into eN`, `set-value eN 5`, `read eN`.
3. Observe again to confirm. Element ids are only valid for your latest observe.

Windows marked `no-a11y` (Electron apps such as Discord, Slack, Vivaldi, WhatsApp) expose no elements. For those, take `hyprhand screenshot --window <w> --out /tmp/x.png`, read the image, and click with window-relative coordinates: `hyprhand click 600,878 --in discord`. Screenshots never show the agent cursors.

## Commands

```bash
hyprhand --agent me observe [--window W] [--interactive] [--annotated --out /tmp/ui.png] [--format json]
hyprhand --agent me click eN|W|x,y [--in W] [--double] [--button right] [--physical] [--stay]
hyprhand --agent me type "text" [--into eN|W] [--append] [--submit] [--keyboard] [--stay]
hyprhand --agent me key ctrl+l Return [--to W] [--stay]
hyprhand --agent me scroll down --amount 3 --at eN|W|x,y
hyprhand --agent me drag --from eN|x,y --to eN|x,y [--duration 800]
hyprhand --agent me set-value eN 42
hyprhand --agent me read eN
hyprhand --agent me open-app org.kde.dolphin [--wait dolphin]
hyprhand --agent me open-app "flatpak run org.kde.kcalc" --wait kcalc
hyprhand screenshot [--window W | --monitor DP-1 | --region x,y,w,h] --out /tmp/s.png
hyprhand windows [--all] | active-window | monitors | workspaces | cursor | keybindings
hyprhand focus-window W | close-window W | workspace N | move-window-workspace N --target W [--silent]
hyprhand dispatch <hyprland-dispatcher> [args...]
hyprhand cursors [list|start|stop|forget]
hyprhand doctor
```

`W` is a window id from `windows`/`observe` (`w1a2b`), an exact app class, or a regex on class or title. Coordinates are global layout pixels unless `--in W` makes them window-relative.

## How actions are delivered

- `click eN` runs the element's accessibility action (Press, Click, Activate, Toggle for checkboxes). It does not touch the real pointer or focus, so it works on background windows and in parallel. List items, tree items, and tabs use a real click, because their accessibility action only selects.
- `type --into eN` sets an editable text field's content directly. `--submit` then presses Enter in that window.
- Everything else (coordinates, `--double`, right clicks, drags, scrolls, keys, typing without an editable element) uses real input. hyprhand serializes it across agents with a lock, then puts the user's pointer and focused window back. Add `--stay` when the next step needs the focus to stay, such as a menu that closes when focus leaves or a click that focuses a composer before `type`.
- `type` and `key` without a target go to your agent's last used window.

## Rules

- Observe before acting and after each meaningful step; do not chain blind actions.
- Ask before payments, credentials, destructive settings, or sending messages the user did not request.
- Real input briefly takes over the user's pointer and keyboard. Keep it short, and prefer element ids so most work stays semantic.
- If an element answers `stale`, observe again.
- Telegram Desktop exposes its composer and buttons but not its chat list. Use keyboard shortcuts such as `ctrl+0` for Saved Messages or the search field.
- `HYPRHAND_CURSOR=0` disables the overlay, and `HYPRHAND_RESTORE=0` leaves the pointer and focus where the action ended.

## MCP

`hyprhand mcp` serves every command as an MCP tool over stdio, with names using underscores (`open_app`, `focus_window`). Each tool accepts an `agent` argument.
