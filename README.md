# Perch

A dynamic island for macOS and Windows, with a mascot called Dango. It watches your coding agents (Claude Code,
Codex, Gemini CLI) and lets you approve their requests from the island. It also shows what's playing, timers and
Pomodoro, a file shelf, clipboard history and snippets, a camera mirror, system controls, and your next meeting.

## Install

Needs [Node.js](https://nodejs.org) 18 or newer. In Terminal (macOS) or PowerShell (Windows):

```sh
npx github:anrajput1210/perch
```

This downloads the latest release for your computer, installs it, and opens it. To remove Perch later:

```sh
npx github:anrajput1210/perch --uninstall
```

On macOS, Perch may ask to control Spotify or Music (for Now playing) and to use the camera (for Mirror).
Code mode connects to your agents from Settings, which you open from the menu bar icon.

## Build from source

```sh
npm install
npx tauri dev      # run it
npm run dist       # make the installer (the .app/.dmg on macOS, setup.exe on Windows)
```
