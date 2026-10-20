// `npm run dist`: build perch-hook (release), place it where Tauri's externalBin expects it
// (binaries/perch-hook-<target>[.exe]), then build the app bundle, which puts it next to the app's executable.
// TARGET=x86_64-apple-darwin cross-builds (e.g. Intel Macs from an Apple Silicon one); default is this machine.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

const triple = process.env.TARGET || execSync("rustc -vV").toString().match(/host: (\S+)/)[1];
const ext = process.platform === "win32" ? ".exe" : "";
const target = process.env.TARGET ? ` --target ${triple}` : "";
execSync(`cargo build --release --bin perch-hook${target}`, { cwd: "src-tauri", stdio: "inherit" });
mkdirSync("src-tauri/binaries", { recursive: true });
copyFileSync(`src-tauri/target/${process.env.TARGET ? `${triple}/` : ""}release/perch-hook${ext}`, `src-tauri/binaries/perch-hook-${triple}${ext}`);
console.log(`sidecar: binaries/perch-hook-${triple}${ext}`);
execSync(`npx tauri build --config src-tauri/tauri.bundle.json${target}`, { stdio: "inherit" });
