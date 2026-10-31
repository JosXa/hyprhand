---
name: hyprhand-computer-use
description: Use when operating GUI apps on the user's Hyprland desktop (clicking, typing, reading app UIs, screenshots, window management) through the hyprhand CLI, including several agents working in parallel.
---

# hyprhand: computer use on Hyprland

`hyprhand` controls the Hyprland desktop. It reads app UIs through AT-SPI accessibility, acts on elements semantically where it can, and falls back to real pointer and keyboard input. Every agent gets its own colored, labeled cursor on screen, so the user can watch several agents work at once.

Prefer structured routes first: shell commands, app CLIs, browser automation, MCP tools. Use hyprhand for GUI-only flows and visual checks.

## Identity

Pass `--agent NAME` on every call (or set `HYPRHAND_AGENT`). The name selects your cursor color, your element ids, and your remembered target window. Pick a short, stable name per task, such as `calc` or `courier`. Parallel agents must use different names. `--label` shows a few words of intent next to your cursor; clicks show the element name by default.

## Jev first

hyprhand asks [TypeSafe Jev](https://docs.typesafe.ai), a fast decision model, to pick targets and next actions. A Jev decision takes about 0.2–0.5 s and costs a fraction of a cent, which is far quicker and cheaper than you reading an element list or a screenshot. Use it as the default way to act, and fall back to reading the UI yourself when Jev reports it is unsure. It needs `TYPESAFE_API_KEY`; `hyprhand doctor` shows whether it is set.

1. Describe the control instead of looking it up: `hyprhand --agent me click --find "the Send button" --in telegram`. `--find` works on `click`, `move`, `type`, `scroll`, `set-value` (with `--value N`) and `read`, and `hyprhand find "…" --in W` only reports the match. Jev chooses among accessibility elements when the window has them, and locates the control on a screenshot otherwise (Electron apps). The result names the target, how it was found (`accessibility` or `vision`), and the confidence.
2. For a sequence of steps in one window, run `hyprhand --agent me do "<goal>" --in W`. Jev picks one action per step (click an item, type, Enter, Escape, back, scroll, wait), checks after each step whether the goal is met, and returns a report with `status`: `done`, `unsure` (with the alternatives it hesitated between), `no_way_forward`, `stuck`, or `step_limit`. Quoted text in the goal and `--input name=value` are the only text it may type.
3. Jev classifies; it does not plan. Write the goal as the concrete steps in order, for example `do "Press 1, 0, Multiply, 2, 0, Equals"`, rather than `do "work out 10 times 20"`. When a run stops as `unsure` or `no_way_forward`, read the report, observe yourself, and continue with plain commands or a more specific goal.
4. Verify with Jev instead of reading screenshots: `hyprhand --agent me check "the message was sent" --in W` returns `verdict` `yes`, `no`, or `unsure` with a score in about 0.3 s. Phrase it as one concrete, visible fact. Treat `unsure` as no and look yourself. `do --dry-run` shows the first decision without acting.
5. Wait with Jev instead of sleeping: `hyprhand --agent me wait-for "the KCalc window shows its buttons" --in kcalc --timeout 20000` polls that check every second, also while the window has not appeared yet, and exits nonzero on timeout.

On screenshots Jev looks at the whole window, then at an enlarged crop around its first guess, and the confidence comes from that close look. A control that is clipped or missing fails with "does not see" or "a close look rejected it". In that case, enlarge or focus the window, or describe the control by its visible text or position. Check vision hits with `check` before anything that sends or deletes.

## Manual loop

1. `hyprhand --agent me observe --window <class|id|title-regex> --interactive` lists the window and its elements as `eN role "name" @x,y,w,h (states)`.
2. Act on ids: `click eN`, `type "text" --into eN`, `set-value eN 5`, `read eN`.
3. Observe again to confirm. Element ids are valid until your next `observe` or `find`; `check`, `wait-for`, and `do` leave them alone.

Windows marked `no-a11y` (Electron apps such as Discord, Slack, Vivaldi, WhatsApp) expose no elements. For those, take `hyprhand screenshot --window <w> --out /tmp/x.png`, read the image, and click with window-relative coordinates: `hyprhand click 600,878 --in discord`. Screenshots never show the agent cursors. A capture is at most 1568 px per side, so whole-desktop shots do not exist: pick the window, and for a large window pick the part you need with `--region x,y,w,h --in <w>` (window-relative).

## Commands

```bash
hyprhand --agent me do "<goal as ordered steps>" [--in W] [--input name=value] [--steps 25] [--min-confidence 0.4] [--dry-run]
hyprhand --agent me find "<description>" [--in W]
hyprhand --agent me check "<statement>" [--in W]
hyprhand --agent me wait-for "<condition>" [--in W] [--timeout 30000] [--interval 1000]
hyprhand --agent me click|move|type|scroll|set-value|read ... --find "<description>" [--in W]
hyprhand --agent me observe [--window W] [--interactive] [--annotated [--region x,y,w,h] --out /tmp/ui.png] [--format json]
hyprhand --agent me click eN|W|x,y [--in W] [--double] [--button right] [--physical] [--stay] [--label "Send"]
hyprhand --agent me move eN|W|x,y [--label "Looking at totals"]
hyprhand --agent me type "text" [--into eN|W] [--append] [--submit] [--keyboard] [--stay]
hyprhand --agent me key ctrl+l Return [--to W] [--stay]
hyprhand --agent me scroll down --amount 3 --at eN|W|x,y
hyprhand --agent me drag --from eN|x,y --to eN|x,y [--duration 800]
hyprhand --agent me set-value eN 42
hyprhand --agent me read eN
hyprhand --agent me open-app org.kde.dolphin [--wait dolphin]
hyprhand --agent me open-app "flatpak run org.kde.kcalc" --wait kcalc
hyprhand screenshot (--window W [--region x,y,w,h] | --region x,y,w,h) --out /tmp/s.png
hyprhand windows [--all] | active-window | monitors | workspaces | cursor | keybindings
hyprhand focus-window W | close-window W | workspace N | move-window-workspace N --target W [--silent]
hyprhand dispatch <hyprland-dispatcher> [args...]
hyprhand cursors [list|start|stop|forget]
hyprhand --agent me record start (--monitor NAME | --window W | --region x,y,w,h) [--out file.mp4]
hyprhand --agent me record stop
hyprhand doctor
```

`W` is a window id from `windows`/`observe` (`w1a2b`), an exact app class, or a regex on class or title. Coordinates are global layout pixels unless `--in W` makes them window-relative.

## How actions are delivered

- `click eN` runs the element's accessibility action (Press, Click, Activate, Toggle for checkboxes). It does not touch the real pointer or focus, so it works on background windows and in parallel. List items, tree items, and tabs use a real click, because their accessibility action only selects.
- `type --into eN` sets an editable text field's content directly. `--submit` then presses Enter in that window.
- Everything else (coordinates, `--double`, right clicks, drags, scrolls, keys, typing without an editable element) uses real input. hyprhand serializes it across agents with a lock and pauses hover focus (`input:follow_mouse`) while it runs, then puts the user's pointer and focused window back. If keyboard focus still moves, for example because the user clicked elsewhere, `type` and `key` stop with an error before sending more input; observe and retry. Add `--stay` when the next step needs the focus to stay, such as a menu that closes when focus leaves or a click that focuses a composer before `type`.
- `type` and `key` without a target go to your agent's last used window.

## Rules

- Observe before acting and after each meaningful step; do not chain blind actions.
- Ask before payments, credentials, destructive settings, or sending messages the user did not request.
- Real input briefly takes over the user's pointer and keyboard. Keep it short, and prefer element ids so most work stays semantic.
- If an element answers `stale`, observe again.
- Telegram Desktop exposes its composer and buttons but not its chat list. Use keyboard shortcuts such as `ctrl+0` for Saved Messages or the search field.
- `HYPRHAND_CURSOR=0` disables the overlay, and `HYPRHAND_RESTORE=0` leaves the pointer and focus where the action ended. `HYPRHAND_COLOR` overrides your cursor color, `HYPRHAND_JEV_MODEL` picks the Jev model (default `jev-latest`), and `HYPRHAND_DEBUG=1` prints overlay errors.
- `record stop` returns the mp4 path, length, and size; recordings go to `~/Videos/hyprhand` unless `--out` is given and include every agent cursor.

## MCP

`hyprhand mcp` serves every command as an MCP tool over stdio, with names using underscores (`open_app`, `focus_window`). Each tool accepts an `agent` argument, and calls run concurrently, so parallel agents can share one server.
