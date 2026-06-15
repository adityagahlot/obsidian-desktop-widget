# Obsidian Desktop Widget

[![CI](https://github.com/NimrodLeFay/obsidian-desktop-widget/actions/workflows/ci.yml/badge.svg)](https://github.com/NimrodLeFay/obsidian-desktop-widget/actions/workflows/ci.yml)

A floating, transparent desktop graph for your [Obsidian](https://obsidian.md) vault. The widget runs as an Electron app, lives in your system tray, and visualizes your knowledge graph directly on the desktop.

> Fork of [adityagahlot/obsidian-desktop-widget](https://github.com/adityagahlot/obsidian-desktop-widget) with tray support, working autostart, a portable exe, and a bunch of new features.

## Features

### Graph
- Full graph view for all notes in your vault
- Local graph mode for a selected note and its neighbors (configurable link depth)
- Focus mode with backlinks / outlinks / recent sidebar
- Live refresh — the graph updates automatically when you edit notes in Obsidian
- Tag filter (multi-tag chips), folder filter, and orphans-only view
- Heatmap coloring: color nodes by note age or word count instead of category
- Hover tooltips with link count, recency, and tags
- Note preview panel with basic markdown rendering and clickable wikilinks
- Export the current graph as PNG

### Window & desktop integration
- Transparent, frameless desktop window — optional always-on-top
- System tray: close/minimize hides to tray, left-click toggles, right-click menu
- Global hotkey **Ctrl+Shift+G** to show/hide the widget from anywhere
- Fullscreen mode (⛶ button, Esc to exit)
- Run on startup (works in dev mode and from the portable exe)
- Single instance — relaunching just brings the existing window back

### Appearance
- 9 built-in themes: Default, Nebula, Forest, Amber, Ice, Crimson, Cyber, Mono, Sakura
- Custom theme with 6 color pickers (accent, nodes, links) — applied live, persisted
- Panel opacity slider
- Adjustable label size and node scale

### Updates
- Built-in update check against GitHub releases (manual button + silent check on launch)

## Installation

### Windows

From the [latest release](https://github.com/NimrodLeFay/obsidian-desktop-widget/releases/latest):

- **`ObsidianGraphWidget-Setup-x.x.x.exe`** (recommended) — installer; much faster startup, since the portable exe unpacks itself to a temp folder on every launch
- **`ObsidianGraphWidget.exe`** — portable, no installation; if you enable "Run on startup", keep the exe where it is

Note: the binaries are unsigned, so Windows SmartScreen may warn on first launch — choose "Run anyway".

### From source

Requirements: [Node.js](https://nodejs.org/) 18+ and npm.

```bash
git clone https://github.com/NimrodLeFay/obsidian-desktop-widget.git
cd obsidian-desktop-widget
npm install
npm start
```

On first launch, choose your Obsidian vault folder when prompted.

## Controls

| Area | Action |
| --- | --- |
| ⚙ tab (left edge) | Open the control panel |
| Full / Local / Focus | Switch graph mode |
| Search box | Find and select a note |
| Filter section | Tag chips, folder dropdown, orphans-only toggle |
| Color Nodes By | Category, age heatmap, or word-count heatmap |
| 📌 | Toggle always-on-top |
| ⛶ | Fullscreen (Esc to exit) |
| — / ✕ | Hide to system tray |
| Tray icon | Left-click: show/hide · right-click: menu |
| **Ctrl+Shift+G** | Global show/hide hotkey |
| Drag nodes / scroll / drag background | Reposition, zoom, pan |

## Color legend (category mode)

| Color | Meaning |
| --- | --- |
| Grey | Regular note |
| Purple | Selected / center note |
| Blue | Tagged note |
| Green | Modified in the last 7 days |

## Building the exe

```bash
npm run build:win
```

Output: `dist/ObsidianGraphWidget.exe` (portable). Heads-up: don't redirect build logs into the project folder — a file growing during packaging corrupts the asar archive.

## Privacy

The widget reads your vault's Markdown files locally (read-only — it never writes to your vault). No internet connection is needed except for the optional update check against the GitHub API.

## Credits

- Original project by [Aditya Gahlot](https://github.com/adityagahlot/obsidian-desktop-widget)
- Fork maintained by Kolja
- License: ISC (same as upstream)
