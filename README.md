<p align="center">
  <img src="docs/mark.png" width="72" height="72" alt="Grotesque">
</p>

<h1 align="center">Grotesque</h1>

<p align="center">Personal macOS window over Grok Build.</p>

macOS 12 or newer. You already have [Grok Build](https://x.ai/docs/build/overview). In Terminal run `grok login`.

Download from [Releases](https://github.com/justsaiiint/grotesque/releases) and clone-and-build are equal.

## Download

1. Get the latest `.app` from [Releases](https://github.com/justsaiiint/grotesque/releases).
2. Move Grotesque to Applications, or open it from Downloads.
3. If macOS blocks it: right-click Grotesque → **Open**.
4. You should see the shell: sidebar, main chat, floating prompt bar.
5. Under **Projects**, click **+** (shows on hover) and pick a folder.
6. Optional: set model+intelligence and mode. Type a prompt.
7. Press **Enter** to send (Shift+Enter for a new line; ⌘Enter to send now while busy; Esc to stop). Send stays gray until you type or attach a file. The reply streams in the main area.
8. Sidebar **Plugins** → **Connect plugins** (or **Add plugin**) to connect a server.

## Clone and build

Needs Node, Rust ([rustup](https://rustup.rs)), and Xcode Command Line Tools (`xcode-select --install`).

```bash
git clone https://github.com/justsaiiint/grotesque.git
cd grotesque
npm install
npm run package
```

First build can take several minutes. Then open Grotesque from Applications, or drag it to the Dock. If macOS blocks it: right-click Grotesque → **Open**. Continue from step 4 above.

Dev:

```bash
cd grotesque
npm run tauri dev
```

Wait for a window titled Grotesque.

## How you get an update

Open Grotesque. If **Update Grotesque** is in the sidebar foot (or Settings → About), click it. Warn if a chat is running. After it finishes: **Updated to** that version.

## How you stop the app

- Press ⌘Q to quit (warns if a chat is running).
- ⌘W or the red close button hides the window. Grotesque stays running. Click the Dock icon to show it again.
- If you started from Terminal with `npm run tauri dev`, you can also press Control+C there.
- To remove Grotesque: quit, then move it to Trash.

## If it fails

- `command not found: npm` → Node is missing or Terminal cannot see it.
- Long compile errors → open a GitHub issue and paste the Terminal error.
- Window never opens → check the Terminal for red error text.
- Status or red error about CLI missing → install Grok Build (`~/.grok/bin/grok`).
- Status or red error about not logged in → in Terminal run: `grok login`.

## Pull requests

A worse UI does not land. Open a pull request on this repo.

## License

[MIT](LICENSE). Copyright (c) 2026 @justsaiiint.
