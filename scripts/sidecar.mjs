// Build perch-hook (release) and place it where Tauri's externalBin expects it: binaries/perch-hook-<target>[.exe].
// The bundle then puts it next to the app's executable, which is where the app looks for it.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

const triple = execSync("rustc -vV").toString().match(/host: (\S+)/)[1];
const ext = process.platform === "win32" ? ".exe" : "";
execSync("cargo build --release --bin perch-hook", { cwd: "src-tauri", stdio: "inherit" });
mkdirSync("src-tauri/binaries", { recursive: true });
copyFileSync(`src-tauri/target/release/perch-hook${ext}`, `src-tauri/binaries/perch-hook-${triple}${ext}`);
console.log(`sidecar: binaries/perch-hook-${triple}${ext}`);
