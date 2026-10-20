// The settings window: sections in a sidebar, every change saved the moment it's made.
// Opened from the island's gear button or the tray. In a plain browser it runs on sample data (for design work).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./ui.css";
import "./island.css"; // the Code mode switch
import { configureSound, play } from "./sound";
import { upcoming } from "./ics";
import { icon } from "./icons";
import { glide, installSpring } from "./motion";

type Settings = { sound: boolean; volume: number; auto_close_s: number; away_min: number; start_with_windows: boolean; code_mode: boolean;
  position: string; monitor: number; theme: string; opacity: number; scale: number; calendar_url: string };
type AgentStatus = { id: string; name: string; connected: boolean; config: string };
type Section = "general" | "look" | "agents" | "calendar" | "about";

const inTauri = "__TAURI_INTERNALS__" in window;
const sample: Settings = { sound: true, volume: 0.5, auto_close_s: 60, away_min: 3, start_with_windows: false, code_mode: true,
  position: "top", monitor: 0, theme: "oled", opacity: 1, scale: 1, calendar_url: "" };
const invoke = inTauri ? (await import("@tauri-apps/api/core")).invoke
  : async <T,>(cmd: string, a?: Record<string, unknown>): Promise<T> => ({
      get_settings: sample, set_settings: a?.settings, monitors: ["Built-in display · 1920×1080", "DELL U2723QE · 3840×2160"],
      agents: [{ id: "claude", name: "Claude Code", connected: true, config: "~/.claude/settings.json" },
        { id: "codex", name: "Codex", connected: false, config: "~/.codex/hooks.json" },
        { id: "gemini", name: "Gemini CLI", connected: false, config: "~/.gemini/settings.json" }],
    } as Record<string, unknown>)[cmd] as T;

installSpring();
const isMac = navigator.userAgent.includes("Mac");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const app = document.getElementById("app")!;
let s = await invoke<Settings>("get_settings");
let section: Section = (() => { try { return (localStorage.getItem("perch.settings.section") as Section) || "general"; } catch { return "general"; } })();
let agents: AgentStatus[] = [];
let monitors: string[] = [];
let calNote = "";

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: icon("gear") },
  { id: "look", label: "Appearance", icon: icon("palette") },
  { id: "agents", label: "Agents", icon: icon("code") },
  { id: "calendar", label: "Calendar", icon: icon("calendar") },
  { id: "about", label: "About", icon: icon("info") },
];

// ---- controls ----

const toggle = (key: keyof Settings, label: string, hint = "") => `<div class="setting">
    <span><span class="set-label">${label}</span>${hint ? `<span class="faint">${hint}</span>` : ""}</span>
    <button class="switch" role="switch" aria-checked="${!!s[key]}" aria-label="${label}" data-key="${key}"><i></i></button></div>`;

const choices = (key: keyof Settings, label: string, opts: [string | number, string][]) => `<div class="setting">
    <span class="set-label">${label}</span>
    <div class="seg" role="radiogroup" aria-label="${label}">${opts.map(([v, l]) =>
      `<button role="radio" aria-checked="${s[key] === v}" data-key="${key}" data-value="${v}">${l}</button>`).join("")}</div></div>`;

const slider = (key: keyof Settings, label: string, min: number, max: number, step: number, fmt: (v: number) => string) => `<div class="setting">
    <span class="set-label">${label}</span>
    <span class="set-slider"><input type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-key="${key}" aria-label="${label}">
      <b data-out="${key}">${fmt(Number(s[key]))}</b></span></div>`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const FMT: Record<string, (v: number) => string> = { volume: pct, opacity: pct, scale: pct };

function general() {
  return `<section class="card">
      <div class="setting code-row">
        <span><span class="set-label">Code mode</span><span class="faint">Show your coding agents and answer their questions from the island. Off: they ask in their terminal.</span></span>
        <button class="code-switch" role="switch" aria-checked="${s.code_mode}" data-key="code_mode" aria-label="Code mode">
          <span class="cs-track"><span class="cs-word" aria-hidden="true">CODE</span><span class="cs-off" aria-hidden="true">off</span>
          <span class="cs-knob" aria-hidden="true"><span class="cs-tag">&lt;/&gt;</span><span class="cs-prompt">&gt;<i></i></span></span></span></button></div>
    </section>
    <section class="card">
      ${toggle("sound", "Sounds", "Little chimes for approvals, timers and finished tasks")}
      ${s.sound ? slider("volume", "Sound volume", 0, 1, 0.05, pct) : ""}
      ${choices("auto_close_s", "Close the island after", [[15, "15 s"], [30, "30 s"], [60, "1 min"], [120, "2 min"], [300, "5 min"]])}
      ${choices("away_min", "Hide when I'm away", [[0, "Never"], [1, "1 min"], [3, "3 min"], [10, "10 min"], [30, "30 min"]])}
      ${toggle("start_with_windows", isMac ? "Open at login" : "Start with Windows")}
    </section>`;
}

function look() {
  const pos = (v: string, label: string) => `<button class="pos-pick" role="radio" aria-checked="${s.position === v}" data-key="position" data-value="${v}">
      <span class="screen"><i class="pos-${v}"></i></span><span>${label}</span></button>`;
  const theme = (v: string, label: string, bg: string, card: string) => `<button class="theme-pick" role="radio" aria-checked="${s.theme === v}" data-key="theme" data-value="${v}">
      <span class="swatch" style="background:${bg}"><i style="background:${card}"></i></span><span>${label}</span></button>`;
  return `<section class="card">
      <div class="set-label">Where the island sits</div>
      <div class="picks" role="radiogroup" aria-label="Position">${pos("top", isMac ? "Top · notch" : "Top")}${pos("top-left", "Top left")}${pos("top-right", "Top right")}${pos("bottom", "Bottom")}</div>
      ${monitors.length > 1 ? `<div class="setting"><span class="set-label">Screen</span><select class="input" data-key="monitor" aria-label="Screen">
        ${monitors.map((m, i) => `<option value="${i}" ${i === s.monitor ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></div>` : ""}
    </section>
    <section class="card">
      <div class="set-label">Theme</div>
      <div class="picks" role="radiogroup" aria-label="Theme">${theme("oled", "OLED black", "#000", "#131418")}${theme("gray", "Graphite", "#1d1f23", "#2a2d33")}
        ${theme("midnight", "Midnight", "#0a1022", "#131b34")}${theme("purple", "Deep purple", "#150c24", "#211538")}</div>
      ${slider("opacity", "See-through", 0.5, 1, 0.05, pct)}
      ${slider("scale", "Size", 0.8, 1.4, 0.05, pct)}
    </section>`;
}

function agentsPage() {
  return `<section class="card">${agents.map((a) => `<div class="setting">
      <span><span class="set-label">${esc(a.name)} <span class="pill-state ${a.connected ? "on" : ""}">${a.connected ? "Connected" : "Not connected"}</span></span>
        <span class="faint">${esc(a.config)}</span></span>
      <button class="btn ${a.connected ? "" : "primary"}" data-agent="${a.id}" data-on="${!a.connected}">${a.connected ? "Disconnect" : "Connect"}</button></div>`).join("")}
    </section>
    <p class="faint pad">Connecting adds Perch to that agent's hooks (a backup of the file is kept). Codex asks you to trust new hooks once with
      <code>/hooks</code>. Gemini CLI shows activity only, so approve in its terminal. ${s.code_mode ? "" : "<b>Code mode is off</b>, so agents won't show up until you turn it on in General."}</p>`;
}

function calendar() {
  return `<section class="card">
      <div class="set-label">Meeting alerts</div>
      <p class="faint">Paste your calendar's private iCal link. Perch checks it every 10 minutes and taps you 5 minutes before a meeting, with a Join button for Zoom, Meet and Teams links.</p>
      <div class="row"><input class="input" type="url" data-key="calendar_url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value="${esc(s.calendar_url)}" aria-label="iCal link">
        <button class="btn" data-act="check-cal">Check link</button></div>
      <p class="faint" role="status">${esc(calNote)}</p>
    </section>
    <section class="card how">
      <p><b>Google Calendar:</b> Settings › click your calendar › Integrate calendar › <i>Secret address in iCal format</i>.</p>
      <p><b>Outlook:</b> Settings › Calendar › Shared calendars › Publish a calendar › copy the <i>ICS</i> link.</p>
      <p><b>Apple Calendar:</b> share the calendar publicly and copy its <i>webcal://</i> link.</p>
    </section>`;
}

function about() {
  return `<section class="card">
      <div class="setting"><span class="set-label">Open the island</span><kbd>${isMac ? "⌘ ⌥ P" : "Ctrl + Alt + P"}</kbd></div>
      <div class="setting"><span class="set-label">Inside the island</span><span class="faint">← → switch tabs · Y / N answer approvals · 1–9 pick answers · Esc closes</span></div>
      <div class="setting"><span class="set-label">See what Perch can do</span><button class="btn" data-act="demo">Play the demo</button></div>
    </section>
    <section class="card">
      <div class="setting"><span class="set-label">Update or reinstall</span><code>npx github:anrajput1210/perch</code></div>
      <div class="setting"><span class="set-label">Uninstall</span><code>npx github:anrajput1210/perch --uninstall</code></div>
      <div class="setting"><span class="set-label">Start over</span><button class="btn ghost" data-act="reset">Reset all settings</button></div>
    </section>`;
}

function render() {
  const page = { general, look, agents: agentsPage, calendar, about }[section]();
  app.innerHTML = `<div class="set-shell">
      <nav class="set-nav" role="tablist" aria-label="Settings sections">
        <div class="set-brand">Perch</div>
        ${SECTIONS.map((x) => `<button role="tab" aria-selected="${x.id === section}" data-section="${x.id}"><span class="ico" aria-hidden="true">${x.icon}</span>${x.label}</button>`).join("")}
      </nav>
      <div class="set-page" role="tabpanel"><h1 class="title">${SECTIONS.find((x) => x.id === section)!.label}</h1>${page}</div></div>`;
  // highlights slide from the old choice to the new one, even though the page was just rebuilt
  glide(app.querySelector(".set-nav"), "nav");
  app.querySelectorAll<HTMLElement>(".seg, .picks").forEach((g) => glide(g, g.getAttribute("aria-label") ?? ""));
}

// outside #app so re-renders don't wipe it
const toastEl = Object.assign(document.createElement("div"), { className: "toast", role: "status" });
toastEl.setAttribute("aria-live", "polite");
document.body.append(toastEl);
let toastTimer = 0;
function toast(text: string, bad = false) {
  const t = toastEl;
  t.textContent = text;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 1600);
}

async function save(patch: Partial<Settings>, quiet = false) {
  try {
    s = await invoke<Settings>("set_settings", { settings: { ...s, ...patch } });
    configureSound(s);
    if (!quiet) toast("Saved");
  } catch (err) {
    toast(String(err), true);
  }
}

// ---- events ----

app.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (!b) return;
  if (b.dataset.section) {
    section = b.dataset.section as Section;
    try { localStorage.setItem("perch.settings.section", section); } catch { /* fine */ }
    return render();
  }
  const key = b.dataset.key as keyof Settings | undefined;
  if (key && b.getAttribute("role") === "switch") {
    const on = b.getAttribute("aria-checked") !== "true";
    b.setAttribute("aria-checked", String(on)); // flip in place so it animates
    if (b.classList.contains("code-switch")) { b.classList.remove("flipping"); void b.offsetWidth; b.classList.add("flipping"); }
    await save({ [key]: on });
    if (key === "sound") { if (on) play("allow"); render(); }
    return;
  }
  if (key && b.dataset.value !== undefined) {
    const v = typeof s[key] === "number" ? Number(b.dataset.value) : b.dataset.value;
    await save({ [key]: v });
    return render();
  }
  if (b.dataset.agent) {
    try {
      await invoke("connect_agent", { id: b.dataset.agent, on: b.dataset.on === "true" });
      toast(b.dataset.on === "true" ? "Connected" : "Disconnected");
    } catch (err) { toast(String(err), true); }
    agents = await invoke<AgentStatus[]>("agents");
    return render();
  }
  if (b.dataset.act === "demo") { await invoke("start_demo"); return toast("Playing the demo on the island"); }
  if (b.dataset.act === "reset") { await save({ ...sample, calendar_url: s.calendar_url }); toast("Settings reset"); return render(); }
  if (b.dataset.act === "check-cal") {
    const url = app.querySelector<HTMLInputElement>('[data-key="calendar_url"]')!.value.trim();
    calNote = "Checking…";
    render();
    try {
      const ics = await invoke<string>("fetch_ics", { url });
      const now = new Date();
      const evs = upcoming(ics, now, new Date(+now + 7 * 86_400_000)).filter((x) => !x.allDay);
      calNote = evs.length ? `Works. ${evs.length} meeting${evs.length > 1 ? "s" : ""} this week; next: ${evs[0].title}, ${evs[0].start.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`
        : "Works, but there are no meetings in the next 7 days.";
      if (url !== s.calendar_url) await save({ calendar_url: url }, true);
    } catch (err) {
      calNote = `Couldn't read that link: ${err}`;
    }
    render();
  }
});

// sliders: move live, save on release
app.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  const key = t.dataset.key;
  if (t.type === "range" && key) app.querySelector(`[data-out="${key}"]`)!.textContent = (FMT[key] ?? String)(Number(t.value));
});
app.addEventListener("change", async (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  const key = t.dataset.key as keyof Settings | undefined;
  if (!key) return;
  await save({ [key]: t.type === "range" || key === "monitor" ? Number(t.value) : t.value.trim() });
  if (key === "volume") play("allow");
});

if (inTauri) {
  const { listen } = await import("@tauri-apps/api/event");
  // the tray's Sounds toggle and the island's Code switch change settings too
  listen<Settings>("settings", (e) => { s = e.payload; configureSound(s); render(); });
}
[agents, monitors] = await Promise.all([invoke<AgentStatus[]>("agents"), invoke<string[]>("monitors")]);
configureSound(s);
render();
