#!/usr/bin/env node
// Perch installer: `npx github:anrajput1210/perch` downloads the latest release for this computer and installs it.
//   macOS:   Perch.app -> /Applications (or ~/Applications), then opens it.
//   Windows: runs the Perch setup.
// Flags: --uninstall removes Perch (and its agent hooks); --version vX.Y.Z installs a specific release.
//
// Why macOS doesn't warn: Gatekeeper checks files carrying the "quarantine" flag, which browsers and Mail add to
// downloads. A download made by this script carries no such flag, and the app is ad-hoc signed so Apple Silicon
// will run it. (Distributing to strangers properly still means an Apple Developer ID + notarization.)
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";

const REPO = "anrajput1210/perch";
const args = process.argv.slice(2);
const say = (s) => console.log(`  ${s}`);
const fail = (s) => { console.error(`\n  Perch: ${s}\n`); process.exit(1); };

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "perch-installer", ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, headers));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} answered ${res.statusCode}`)); }
      resolve(res);
    }).on("error", reject);
  });
}

async function json(url) {
  const res = await get(url, { Accept: "application/vnd.github+json" });
  let body = "";
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

async function download(url, file) {
  const res = await get(url);
  const total = Number(res.headers["content-length"] || 0);
  let got = 0, shown = -1;
  await new Promise((resolve, reject) => {
    const out = createWriteStream(file);
    res.on("data", (c) => {
      got += c.length;
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct !== shown && pct % 10 === 0) { shown = pct; process.stdout.write(`\r  Downloading… ${pct}%`); }
    });
    res.pipe(out);
    out.on("finish", resolve);
    res.on("error", reject);
    out.on("error", reject);
  });
  process.stdout.write("\r  Downloading… done\n");
}

const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: "ignore", ...opts });
const tryRun = (cmd, a) => { try { run(cmd, a); return true; } catch { return false; } };

function macAppDir() {
  try { accessSync("/Applications", constants.W_OK); return "/Applications"; } catch { /* not admin */ }
  const dir = join(homedir(), "Applications");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function release() {
  const i = args.indexOf("--version");
  const tag = i >= 0 ? args[i + 1] : null;
  try {
    return await json(`https://api.github.com/repos/${REPO}/releases/${tag ? `tags/${tag}` : "latest"}`);
  } catch (e) {
    fail(`couldn't find a ${tag ?? "published"} release on github.com/${REPO} (${e.message}).`);
  }
}

async function installMac() {
  const arch = process.arch === "arm64" ? "aarch64" : "x64";
  const rel = await release();
  const asset = rel.assets.find((a) => a.name === `Perch_macos_${arch}.app.tar.gz`);
  if (!asset) fail(`release ${rel.tag_name} has no macOS ${arch} build yet.`);
  say(`Installing Perch ${rel.tag_name} for ${arch === "aarch64" ? "Apple Silicon" : "Intel"} Macs`);
  const tgz = join(tmpdir(), asset.name);
  await download(asset.browser_download_url, tgz);

  tryRun("osascript", ["-e", 'quit app "Perch"']); // replace a running copy cleanly
  const dir = macAppDir();
  const app = join(dir, "Perch.app");
  rmSync(app, { recursive: true, force: true });
  run("tar", ["-xzf", tgz, "-C", dir]);
  rmSync(tgz, { force: true });
  tryRun("xattr", ["-cr", app]); // belt and braces: no quarantine flag on anything inside
  say(`Installed to ${app}`);
  run("open", [app]);
  say("Perch is running: look for the island at the top of your screen and the icon in the menu bar.");
  say("macOS may ask to let Perch control Spotify/Music (for Now playing) or use the camera (for Mirror).");
}

async function installWindows() {
  const rel = await release();
  const asset = rel.assets.find((a) => /_x64-setup\.exe$/.test(a.name));
  if (!asset) fail(`release ${rel.tag_name} has no Windows build yet.`);
  say(`Installing Perch ${rel.tag_name} for Windows`);
  const exe = join(tmpdir(), asset.name);
  await download(asset.browser_download_url, exe);
  say("Running the setup…");
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
}

function uninstall() {
  if (process.platform === "darwin") {
    tryRun("osascript", ["-e", 'quit app "Perch"']);
    for (const app of ["/Applications/Perch.app", join(homedir(), "Applications/Perch.app")]) {
      if (!existsSync(app)) continue;
      for (const agent of ["claude", "codex", "gemini"]) tryRun(join(app, "Contents/MacOS/perch-hook"), ["--uninstall", agent]);
      rmSync(app, { recursive: true, force: true });
      say(`Removed ${app}`);
    }
    rmSync(join(homedir(), "Library/LaunchAgents/dev.perch.island.plist"), { force: true });
    rmSync(join(homedir(), ".perch"), { recursive: true, force: true });
  } else if (process.platform === "win32") {
    const un = join(process.env.LOCALAPPDATA ?? "", "Perch", "uninstall.exe");
    if (!existsSync(un)) fail("Perch isn't installed (no uninstaller found).");
    spawn(un, [], { detached: true, stdio: "ignore" }).unref();
  }
  say("Perch is uninstalled.");
}

console.log("\n  Perch, a dynamic island for your desktop\n");
if (args.includes("--uninstall")) uninstall();
else if (process.platform === "darwin") await installMac();
else if (process.platform === "win32") await installWindows();
else fail("Perch runs on macOS and Windows.");
console.log("");
