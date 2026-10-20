// The settings window: Perch's own options, which agents are connected, and the demo.
import "./ui.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { configureSound, play } from "./sound";

type Settings = { sound: boolean; volume: number; auto_close_s: number; away_min: number; start_with_windows: boolean; code_mode: boolean;
  position: string; monitor: number; theme: string; opacity: number; scale: number; calendar_url: string };
type AgentStatus = { id: string; name: string; connected: boolean; config: string };

const app = document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
let s = await invoke<Settings>("get_settings");

async function render() {
  const [agents, monitors] = await Promise.all([invoke<AgentStatus[]>("agents"), invoke<string[]>("monitors")]);
  const isMac = navigator.userAgent.includes("Mac");
  const opt = (v: string | number, label: string, cur: string | number) => `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
  app.innerHTML = `
    <h1 class="title">Perch settings</h1>
    <section class="card">
      <label class="setting"><span>Code mode <span class="faint">watch coding agents; off = they ask in their terminal</span></span>
        <input type="checkbox" name="code_mode" ${s.code_mode ? "checked" : ""}></label>
      <label class="setting"><span>Sounds</span><input type="checkbox" name="sound" ${s.sound ? "checked" : ""}></label>
      <label class="setting"><span>Volume</span><input type="range" name="volume" min="0" max="1" step="0.05" value="${s.volume}"></label>
      <label class="setting"><span>Close the island after <span class="faint">seconds idle</span></span>
        <input class="input" type="number" name="auto_close_s" min="10" max="3600" value="${s.auto_close_s}"></label>
      <label class="setting"><span>Hide when I'm away <span class="faint">minutes, 0 = never</span></span>
        <input class="input" type="number" name="away_min" min="0" max="120" value="${s.away_min}"></label>
      <label class="setting"><span>Start with ${isMac ? "your Mac" : "Windows"}</span><input type="checkbox" name="start_with_windows" ${s.start_with_windows ? "checked" : ""}></label>
    </section>
    <section class="card">
      <label class="setting"><span>Position</span><select class="input" name="position">
        ${opt("top", isMac ? "Top (the notch)" : "Top centre", s.position)}${opt("top-left", "Top left", s.position)}${opt("top-right", "Top right", s.position)}${opt("bottom", "Bottom", s.position)}</select></label>
      ${monitors.length > 1 ? `<label class="setting"><span>Screen</span><select class="input" name="monitor">${monitors.map((m, i) => opt(i, m, s.monitor)).join("")}</select></label>` : ""}
      <label class="setting"><span>Theme</span><select class="input" name="theme">
        ${opt("oled", "OLED black", s.theme)}${opt("gray", "Graphite", s.theme)}${opt("midnight", "Midnight blue", s.theme)}${opt("purple", "Deep purple", s.theme)}</select></label>
      <label class="setting"><span>See-through</span><input type="range" name="opacity" min="0.5" max="1" step="0.05" value="${s.opacity}"></label>
      <label class="setting"><span>Size</span><input type="range" name="scale" min="0.8" max="1.4" step="0.05" value="${s.scale}"></label>
      <label class="setting"><span>Calendar <span class="faint">iCal link for meeting alerts (Google: Settings › your calendar › Secret address in iCal format)</span></span>
        <input class="input wide" type="url" name="calendar_url" placeholder="https://…/basic.ics" value="${esc(s.calendar_url)}"></label>
    </section>
    <section class="card">
      ${agents.map((a) => `<div class="setting"><span>${esc(a.name)}<br><span class="faint">${esc(a.config)}</span></span>
        <button class="btn ${a.connected ? "" : "primary"}" data-agent="${a.id}" data-on="${!a.connected}">${a.connected ? "Disconnect" : "Connect"}</button></div>`).join("")}
      <p class="faint">Codex asks you to trust new hooks once with /hooks. Gemini CLI shows activity only; approve in its terminal.</p>
    </section>
    <div class="row"><button class="btn" data-act="demo">Play the demo</button><span class="spacer"></span>
      <span class="faint" role="status" id="status">Shortcut: ${isMac ? "⌘⌥P" : "Ctrl+Alt+P"} opens the island</span></div>`;
}

app.addEventListener("change", async (e) => {
  const t = e.target as HTMLInputElement;
  if (!t.name) return;
  const v = t.type === "checkbox" ? t.checked : t.type === "range" || t.name === "monitor" || t.type === "number" ? Number(t.value) : t.value;
  try {
    s = await invoke<Settings>("set_settings", { settings: { ...s, [t.name]: v } });
    configureSound(s);
    if (t.name === "sound" || t.name === "volume") play("allow");
  } catch (err) {
    document.getElementById("status")!.textContent = String(err);
    return;
  }
  render();
});

app.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (!b) return;
  if (b.dataset.act === "demo") return invoke("start_demo");
  if (b.dataset.agent) {
    try { await invoke("connect_agent", { id: b.dataset.agent, on: b.dataset.on === "true" }); }
    catch (err) { await render(); document.getElementById("status")!.textContent = String(err); return; }
    render();
  }
});

// the tray's Sounds toggle changes settings too
listen<Settings>("settings", (e) => { s = e.payload; configureSound(s); render(); });
configureSound(s);
render();
