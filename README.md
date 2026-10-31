# hyprhand

[![Project type: Houseplant](https://img.shields.io/badge/%F0%9F%AA%B4%20Houseplant%20-x?style=flat&label=Project%20type&color=1E1E1D)](https://www.hannahilea.com/blog/houseplant-programming)

Give your coding agent hands on your [Hyprland](https://hyprland.org) desktop. It can open apps, click through them, type, drag and check its own work, while you watch its own cursor move around next to yours.

![Two agents work in parallel: one computes 12 × 34 × 25 in KCalc, the other paints "HI!" and types "hyprhand" in Pinta](docs/demo.gif)

Two agents share the desktop in the demo, which runs at 1.6× speed. `calc` works out 12 × 34 × 25 in KCalc and confirms each result. `artist` picks colors in Pinta, paints, sets a font size in a dialog, types, and throws the picture away. Nobody gave them coordinates: each target came from a description like "the red color swatch".

## What it feels like

- **Every agent gets its own cursor.** Each one has a color and a name tag, ripples where it clicks, and fades out when its agent goes quiet. Several agents can work at once, and you can still tell who did what.
- **You keep your mouse.** Most clicks and text go through the accessibility tree, so background windows get used without stealing your pointer or focus. When real input is unavoidable, hyprhand borrows the pointer briefly, gives it back, and stops typing the moment focus moves.
- **Agents describe what they want.** "Click the Send button" goes to [TypeSafe Jev](https://docs.typesafe.ai), a fast decision model. Jev picks the matching control in about 0.2 s, or finds it on a screenshot when an app has no accessibility. Jev also answers yes/no questions about the screen and can drive short step sequences on its own. Your main agent spends its tokens on thinking instead of squinting at screenshots.
- **It records itself.** `hyprhand record` captures the screen, cursors included, which is how the demo above was made.
- **It speaks MCP.** Any MCP client can use it, and it ships an agent skill for harnesses that load skills.

## Install

hyprhand is [houseplant software](https://www.hannahilea.com/blog/houseplant-programming): it grows on one desktop (CachyOS, Hyprland, three monitors) and gets tended when something there needs it. I'm sharing it so you, or your agent, can take a cutting and grow your own variation. I can't look after it on your machine, though. Anyone can fork or copy it. I may accept contributions, I may not. Take care of your own seedlings.

```bash
git clone https://github.com/JosXa/hyprhand.git ~/hyprhand
ln -s ~/hyprhand/bin/hyprhand.js ~/.local/bin/hyprhand
```

It runs on Node.js with a few Python helpers. On Arch:

```bash
sudo pacman -S nodejs grim ydotool wtype wf-recorder python-atspi at-spi2-core python-gobject gtk-layer-shell python-pillow
systemctl --user enable --now ydotool
```

For the Jev features, create a key at [console.typesafe.ai/keys](https://console.typesafe.ai/keys) and export it as `TYPESAFE_API_KEY`. Everything else works without it.

Check the setup:

```bash
hyprhand doctor
```

### Hook up your agent

Link the skill into your agent's skill folder, for example for OpenCode or Claude Code:

```bash
ln -s ~/hyprhand/skills/hyprhand-computer-use ~/.config/opencode/skill/
ln -s ~/hyprhand/skills/hyprhand-computer-use ~/.claude/skills/
```

Or register it as an MCP server:

```json
{ "command": "hyprhand", "args": ["mcp"] }
```

The skill teaches the agent the rest. If you want to look yourself, run `hyprhand help`.

## Good to know

- Electron apps such as Discord, Slack and VS Code hide their accessibility tree unless started with `--force-renderer-accessibility`. Without it, hyprhand finds things on screenshots, which works but takes longer.
- hyprhand finds the Hyprland session by itself, so it also works from services, SSH and agent harnesses that have no desktop environment.

## Credits

hyprhand started from [omarchy-control](https://github.com/IgorWarzocha/omarchy-control) by Igor Warzocha. The idea of one cursor per agent comes from Vercel Labs' [agent-desktop](https://github.com/vercel-labs/agent-desktop), and the Jev decision design from [typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use).

## License

MIT
