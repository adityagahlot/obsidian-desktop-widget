# Obsidian Desktop Widget

A floating, transparent desktop graph for your Obsidian vault. The widget runs as an Electron app, stays on top of your desktop, and can be click-through by default so it does not get in the way.

## Features

- Full graph view for all notes in your vault
- Local graph mode for a selected note and its direct neighbors
- Focus mode for the current note, backlinks, and recently edited notes
- Transparent, always-on-top desktop window
- Click-through mode with an interact toggle
- Live node drag, zoom, and pan
- Hover tooltips with link count, recency, and tags
- Saves your selected vault path between sessions

## Project structure

This repository is the Electron app folder. These files need to stay together in the same folder:

```text
obsidian-desktop-widget/
|-- main.js              # Electron main process
|-- preload.js           # Secure bridge between Electron and the UI
|-- package.json         # Node/Electron dependencies and scripts
|-- package-lock.json    # Locked dependency versions
|-- src/
|   |-- index.html       # App UI
|   `-- renderer.js      # Graph rendering and vault parsing logic
|-- launch.bat           # Windows launcher helper
|-- launch.vbs           # Windows no-console launcher helper
`-- create-shortcut.ps1  # Optional Windows shortcut script
```

Do not copy only `src/` or only the Electron files somewhere else. Run `npm install` and `npm start` from the folder that contains `package.json`, `main.js`, and `preload.js`.

`node_modules/` is intentionally not included in GitHub. It is recreated locally by running `npm install`.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- npm, included with Node.js
- An Obsidian vault folder containing Markdown files

## Install and run

Clone the repository:

```bash
git clone https://github.com/adityagahlot/obsidian-desktop-widget.git
cd obsidian-desktop-widget
```

Install dependencies:

```bash
npm install
```

Start the Electron app:

```bash
npm start
```

On first launch, choose your Obsidian vault folder when prompted.

## Troubleshooting Electron install on Windows

If `npm install` finishes but `npm start` fails because Electron did not download correctly, you can install the Electron binary manually.

First, check the Electron version used by this project:

```powershell
Get-Content node_modules\electron\package.json
```

Look for the `version` field.

Then:

1. Go to [Electron releases](https://github.com/electron/electron/releases).
2. Find the release that matches the version in `node_modules\electron\package.json`.
3. Download the Windows x64 zip file named like `electron-vXX.X.X-win32-x64.zip`.
4. Unzip it.
5. Place the unzipped contents inside this folder:

```text
node_modules\electron\dist\
```

The folder should contain `electron.exe` directly inside `dist`.

Finally, create this file:

```text
node_modules\electron\path.txt
```

Put only this text inside it:

```text
electron.exe
```

Then run:

```bash
npm start
```

## Running from a downloaded ZIP

If you download the project as a ZIP from GitHub:

1. Extract the ZIP.
2. Open a terminal inside the extracted folder that contains `package.json`.
3. Run `npm install`.
4. Run `npm start`.

If you see a nested folder after extracting, open the inner project folder before running the commands.

## Controls

| Area | Action |
| --- | --- |
| Hover window | Shows the control panel and legend |
| Full / Local / Focus buttons | Switch graph mode |
| Search box | Find and select a note in Local or Focus mode |
| Refresh | Re-read the vault from disk |
| Click-thru / Interact | Toggle mouse interaction |
| Vault | Change the selected vault folder |
| Close | Close the app |
| Drag nodes | Reposition nodes |
| Scroll | Zoom in or out |
| Click and drag background | Pan the graph |

## Click-through mode

When click-through mode is active, desktop clicks pass through the widget. Switch to Interact mode when you want to drag nodes, click controls, or move around the graph.

## Color legend

| Color | Meaning |
| --- | --- |
| Grey | Regular note |
| Purple | Selected or center note |
| Blue | Tagged note |
| Green | Modified in the last 7 days |

## Build optional installers

Package for the current platform:

```bash
npm run build
```

Windows installer:

```bash
npm run build:win
```

macOS DMG:

```bash
npm run build:mac
```

Build output is written to `dist/`.

## How it reads your vault

The widget scans Markdown files recursively and extracts:

- `[[wikilinks]]` for graph edges
- `#tags` and frontmatter tags for node styling
- File modified times for recency highlighting

Your vault data stays on your machine. The app does not need an internet connection to read your notes.