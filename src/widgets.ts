// Everything on the island that isn't a coding agent: home (clock, next meeting), now playing with a live waveform,
// timers and Pomodoro, a file shelf, clipboard history and snippets, a camera mirror, and system controls.
// The Island owns modes and layout; this owns the widgets' state, their HTML, and their buttons.
import { play } from "./sound";
import { upcoming, type CalEvent } from "./ics";

export type Tab = "home" | "code" | "media" | "timer" | "shelf" | "clip" | "cam" | "system";
export type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Now playing (src-tauri/src/platform/*\/media.rs). Art arrives as bytes on track change (Windows) or a URL (macOS). */
export interface Media { title: string; artist: string; app: string; playing: boolean; position: number; duration: number;
  art?: number[] | null; art_type?: string; art_url?: string | null }
export interface Sys { battery: number | null; charging: boolean; cpu: number; ram: number; volume: number; muted: boolean;
  camera: string[]; mic: string[] }
export interface Usage { input: number; output: number; cache_read: number; cache_write: number; messages: number; sessions: number }
/** What the collapsed bar shows when no agent needs it: `lead` is HTML before the label. */
export interface Activity { label: string; lead?: string }

type Timer = { label: string; total: number; endsAt: number; left?: number; phase?: "focus" | "break" | "long"; round?: number };
type ShelfItem = { path: string; name: string };

const svg = (d: string) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: svg('<path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z"/>') },
  { id: "code", label: "Code", icon: svg('<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>') },
  { id: "media", label: "Now playing", icon: svg('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>') },
  { id: "timer", label: "Timer", icon: svg('<circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2M10 3h4"/>') },
  { id: "shelf", label: "Shelf", icon: svg('<path d="M4 13l2-7h12l2 7v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13h5l1 2h4l1-2h5"/>') },
  { id: "clip", label: "Clipboard", icon: svg('<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V4h6v1M9 11h6M9 15h4"/>') },
  { id: "cam", label: "Mirror", icon: svg('<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3"/>') },
  { id: "system", label: "System", icon: svg('<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="8" cy="18" r="1.8"/>') },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const hms = (ms: number) => { const s = Math.ceil(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss(s % 3600).padStart(5, "0")}` : mmss(s); };
const time = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const compact = (n: number) => Intl.NumberFormat([], { notation: "compact", maximumFractionDigits: 1 }).format(n);
const isMac = navigator.userAgent.includes("Mac");
const BARS = 28;
const POMODORO = { focus: 25, break: 5, long: 15, rounds: 4 };
const OWN_APP = /^perch$/i; // the mirror uses the camera too; don't flag ourselves

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked: keep it in memory */ }
}

export class Widgets {
  media: Media | null = null;
  artUrl = "";
  private levels: number[] = Array(BARS).fill(0);
  private levelAt = 0;
  sys: Sys | null = null;
  private hud: { until: number } | null = null;
  private ownVolumeAt = 0;
  private brightness: number | null | undefined; // undefined = not asked yet, null = not supported
  private clips: string[] = [];
  private snippets: string[] = load("perch.snippets", []);
  private clipView: "recent" | "snippets" = "recent";
  private copiedAt = 0;
  private shelf: ShelfItem[] = load("perch.shelf", []);
  private timer: Timer | null = load("perch.timer", null);
  private events: CalEvent[] = [];
  private calUrl = "";
  private calError = "";
  private calTimer = 0;
  private alerted = new Set<string>();
  private usage: Usage | null = null;
  private usageAt = 0;
  private cam: MediaStream | null = null;
  private camError = "";
  private error = "";
  root: HTMLElement | null = null;

  constructor(private invoke: Invoke | undefined, private host: { update(): void; alert(tab: Tab): void }) {
    setInterval(() => this.second(), 1000);
  }

  // ---- inputs ----

  setMedia(m: Media | null) {
    const track = (x: Media | null) => (x ? `${x.title}\u0001${x.artist}` : "");
    if (m?.art?.length) {
      if (this.artUrl.startsWith("blob:")) URL.revokeObjectURL(this.artUrl);
      this.artUrl = URL.createObjectURL(new Blob([new Uint8Array(m.art)], { type: m.art_type || "image/png" }));
    } else if (m?.art_url) {
      this.artUrl = m.art_url;
    } else if (track(m) !== track(this.media)) {
      if (this.artUrl.startsWith("blob:")) URL.revokeObjectURL(this.artUrl);
      this.artUrl = "";
    }
    this.media = m;
    this.host.update();
  }

  /** Output peak level 0..1 (Windows only; macOS falls back to an animated waveform). */
  setLevel(peak: number) {
    this.levels.push(Math.min(1, Math.sqrt(peak) * 1.15)); // sqrt: quiet passages still move
    this.levels.shift();
    this.levelAt = Date.now();
    this.live();
  }

  setSys(s: Sys) {
    const prev = this.sys;
    s = { ...s, camera: s.camera.filter((a) => !OWN_APP.test(a)) };
    this.sys = s;
    // someone pressed the volume keys (not our slider): show the volume HUD for a moment
    if (prev && (prev.volume !== s.volume || prev.muted !== s.muted) && Date.now() - this.ownVolumeAt > 1500) {
      this.hud = { until: Date.now() + 1800 };
    }
    this.host.update();
  }

  addClip(text: string) {
    this.clips = [text, ...this.clips.filter((c) => c !== text)].slice(0, 30);
    this.host.update();
  }

  addFiles(paths: string[]) {
    for (const path of paths) {
      if (this.shelf.some((f) => f.path === path)) continue;
      this.shelf.push({ path, name: path.split(/[\\/]/).pop() || path });
    }
    save("perch.shelf", this.shelf);
    play("peek");
    this.host.alert("shelf");
  }

  configure(o: { calendar_url?: string }) {
    const url = (o.calendar_url ?? "").trim();
    if (url === this.calUrl) return;
    this.calUrl = url;
    clearInterval(this.calTimer);
    this.events = [];
    this.calError = "";
    if (url) {
      void this.refreshCalendar();
      this.calTimer = window.setInterval(() => this.refreshCalendar(), 10 * 60_000);
    }
  }

  private async refreshCalendar() {
    if (!this.invoke || !this.calUrl) return;
    try {
      const ics = await this.invoke<string>("fetch_ics", { url: this.calUrl });
      const now = new Date();
      this.events = upcoming(ics, now, new Date(+now + 36 * 3_600_000)).filter((e) => !e.allDay);
      this.calError = "";
    } catch (e) {
      this.calError = `Calendar: ${e}`;
    }
    this.host.update();
  }

  // ---- clock ----

  private second() {
    const now = Date.now();
    const t = this.timer;
    if (t && !t.left && now >= t.endsAt) this.timerDone();
    // meeting alert 5 minutes before (once per meeting)
    const soon = this.events.find((e) => +e.start - now <= 5 * 60_000 && +e.start > now - 60_000);
    if (soon && !this.alerted.has(soon.title + +soon.start)) {
      this.alerted.add(soon.title + +soon.start);
      play("question");
      this.host.alert("home");
    }
    if (this.hud && now > this.hud.until) { this.hud = null; this.host.update(); return; }
    this.events = this.events.filter((e) => +e.end > now);
    if (this.timer || this.activity()?.lead?.includes("meet")) this.host.update(); // the bar's countdown
    else this.live();
  }

  private timerDone() {
    const t = this.timer!;
    play("finish");
    if (t.phase) {
      // Pomodoro: focus -> break (a long one after every 4th focus) -> next focus round
      const round = t.round ?? 1;
      const next = t.phase === "focus" ? (round % POMODORO.rounds === 0 ? "long" : "break") : "focus";
      const mins = POMODORO[next];
      this.timer = { label: next === "focus" ? "Focus" : next === "long" ? "Long break" : "Break", total: mins * 60_000,
        endsAt: Date.now() + mins * 60_000, phase: next, round: next === "focus" ? round + 1 : round };
    } else {
      this.timer = null;
    }
    save("perch.timer", this.timer);
    this.host.alert("timer");
  }

  // ---- collapsed bar ----

  activity(): Activity | null {
    const now = Date.now();
    const s = this.sys;
    if (this.hud && s) {
      return { label: s.muted ? "Muted" : `${s.volume}%`,
        lead: `<span class="hud-meter"><i style="width:${s.muted ? 0 : s.volume}%"></i></span>` };
    }
    const t = this.timer;
    if (t) {
      const left = t.left ?? Math.max(0, t.endsAt - now);
      return { label: `${hms(left)} · ${t.label}${t.left ? " (paused)" : ""}`, lead: `<span class="bar-ring" style="--p:${1 - left / t.total}"></span>` };
    }
    const next = this.events[0];
    if (next && +next.start - now < 10 * 60_000) {
      const mins = Math.round((+next.start - now) / 60_000);
      return { label: `${next.title} · ${mins > 0 ? `in ${mins} min` : "now"}`, lead: `<span class="bar-dot meet"></span>` };
    }
    const m = this.media;
    if (m?.playing) {
      const art = this.artUrl ? `<img class="bar-art" src="${esc(this.artUrl)}" alt="">` : "";
      return { label: [m.title, m.artist].filter(Boolean).join(" · "), lead: `${art}<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>` };
    }
    return null;
  }

  /** Camera / mic dots for the bar; shown whatever else is going on. */
  privacy(): string {
    const s = this.sys;
    if (!s) return "";
    const dot = (kind: string, name: string, apps: string[]) => apps.length
      ? `<i class="priv ${kind}" title="${name}: ${esc(apps.join(", "))}" role="img" aria-label="${name} in use by ${esc(apps.join(", "))}"></i>` : "";
    return dot("cam", "Camera", s.camera) + dot("mic", "Microphone", s.mic);
  }

  // ---- rendering ----

  /** Changes here re-render the open tab (live values like time and level update in place instead). */
  key(tab: Tab): string {
    const m = this.media;
    return [tab, this.error, tab === "media" || tab === "home" ? m && [m.title, m.artist, m.playing, m.duration > 0, this.artUrl].join("|") : "",
      tab === "home" ? this.events.slice(0, 2).map((e) => e.title + +e.start).join() + this.calError + this.calUrl + (this.sys?.battery ?? "") : "",
      tab === "timer" ? `${!!this.timer}${this.timer?.label}${!!this.timer?.left}` : "",
      tab === "shelf" ? this.shelf.map((f) => f.path).join() : "",
      tab === "clip" ? this.clipView + this.clips.length + this.clips[0] + this.snippets.join() + (Date.now() - this.copiedAt < 1200) : "",
      tab === "cam" ? `${!!this.cam}${this.camError}` : "",
      tab === "system" ? JSON.stringify({ ...this.sys, cpu: 0, ram: 0 }) + this.brightness : ""].join("/");
  }

  render(tab: Tab): string {
    const err = this.error ? `<p class="faint err" role="alert">${esc(this.error)}</p>` : "";
    switch (tab) {
      case "home": return this.home();
      case "media": return this.mediaCard() + err;
      case "timer": return this.timerCard();
      case "shelf": return this.shelfCard() + err;
      case "clip": return this.clipCard() + err;
      case "cam": return this.camCard();
      case "system": return this.systemCard() + err;
      default: return "";
    }
  }

  private home() {
    const now = new Date();
    const next = this.events.slice(0, 2).map((e) => {
      const mins = Math.round((+e.start - +now) / 60_000);
      const when = mins <= 0 ? "Now" : mins < 60 ? `In ${mins} min` : time(e.start);
      return `<div class="event ${mins <= 10 ? "soon" : ""}"><span class="event-when">${when}</span>
        <span class="event-title clamp1">${esc(e.title)}</span>
        ${e.join ? `<button class="btn primary sm" data-act="w-join" data-url="${esc(e.join)}">Join</button>` : ""}</div>`;
    }).join("");
    const cal = this.calError ? `<p class="faint">${esc(this.calError)}</p>`
      : next || `<p class="faint">${this.calUrl ? "No more meetings today." : "Add your calendar's iCal link in Settings to get meeting alerts."}</p>`;
    const m = this.media;
    const playing = m ? `<button class="mini-media" data-act="w-tab" data-tab="media">
        ${this.artUrl ? `<img src="${esc(this.artUrl)}" alt="">` : `<span class="note" aria-hidden="true">♪</span>`}
        <span class="clamp1">${esc(m.title || "Unknown")}<span class="faint"> · ${esc(m.artist || m.app)}</span></span></button>` : "";
    const s = this.sys;
    const chips = s ? `<div class="chips">
        ${s.battery != null ? `<span class="chip">${s.charging ? "⚡" : ""}${s.battery}%</span>` : ""}
        <span class="chip">CPU <b class="live-cpu">${s.cpu}%</b></span><span class="chip">RAM <b class="live-ram">${s.ram}%</b></span></div>` : "";
    return `<div class="card row home"><div class="slot"></div>
      <div class="home-clock"><b class="live-clock">${time(now)}</b>
        <span class="faint">${now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</span>${chips}</div>
      <div class="col home-side">${cal}${playing}</div></div>`;
  }

  private mediaCard() {
    const m = this.media;
    if (!m) return `<div class="card row"><div class="slot"></div><div class="col"><p class="title">Nothing playing</p>
      <p class="muted">Play something in ${isMac ? "Spotify or Music" : "any app (Spotify, a browser, Media Player)"} and it shows up here.</p></div></div>`;
    const art = this.artUrl ? `<img class="media-art" src="${esc(this.artUrl)}" alt="">` : `<div class="media-art none" aria-hidden="true">♪</div>`;
    const timeline = m.duration > 0
      ? `<div class="progress" data-act="w-seek" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="${Math.round(m.duration)}" aria-valuenow="${Math.round(m.position)}" tabindex="0"><i style="width:${Math.min(100, (m.position / m.duration) * 100)}%"></i></div>
         <span class="faint media-time"></span>` : "";
    return `<div class="card row" data-tone="${m.playing ? "media" : ""}">${art}<div class="col">
      <div class="who"><b class="clamp1">${esc(m.title || "Unknown")}</b><span class="faint">${esc([m.artist, m.app].filter(Boolean).join(" · "))}</span></div>
      <div class="wave" aria-hidden="true">${"<i></i>".repeat(BARS)}</div>
      ${timeline}
      <div class="row media-controls">
        <button class="btn ghost" data-act="w-media" data-cmd="prev" aria-label="Previous">⏮</button>
        <button class="btn primary" data-act="w-media" data-cmd="toggle" data-autofocus aria-label="${m.playing ? "Pause" : "Play"}">${m.playing ? "⏸" : "▶"}</button>
        <button class="btn ghost" data-act="w-media" data-cmd="next" aria-label="Next">⏭</button></div>
    </div></div>`;
  }

  private timerCard() {
    const t = this.timer;
    if (!t) {
      const presets = [5, 10, 15, 30, 60].map((n) => `<button class="btn" data-act="w-timer" data-min="${n}">${n} min</button>`).join("");
      return `<div class="card row"><div class="slot"></div><div class="col">
        <p class="title">Start a timer</p>
        <div class="row wrap"><button class="btn primary" data-act="w-pomodoro">Pomodoro 25 / 5</button>${presets}</div>
        <div class="row"><input class="input narrow" type="number" min="1" max="600" placeholder="Minutes" aria-label="Minutes" data-field="minutes">
          <button class="btn" data-act="w-timer-custom">Start</button></div></div></div>`;
    }
    const round = t.phase ? `<span class="faint">Round ${t.round ?? 1} of ${POMODORO.rounds}</span>` : "";
    return `<div class="card row" data-tone="${t.phase === "focus" ? "working" : "finished"}">
      <svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="44"/><circle class="ring-fill" cx="50" cy="50" r="44" pathLength="100"/></svg>
      <div class="col"><p class="faint">${esc(t.label)}${t.left ? " · paused" : ""}</p><b class="timer-big live-timer" role="timer"></b>${round}
        <div class="row">
          <button class="btn primary" data-act="w-timer-pause" data-autofocus>${t.left ? "Resume" : "Pause"}</button>
          <button class="btn" data-act="w-timer-add">+1 min</button>
          ${t.phase ? `<button class="btn" data-act="w-timer-skip">Skip</button>` : ""}
          <button class="btn ghost" data-act="w-timer-stop">Stop</button></div></div></div>`;
  }

  private shelfCard() {
    const items = this.shelf.map((f, i) => {
      const dir = f.path.slice(0, f.path.length - f.name.length).replace(/[\\/]$/, "");
      return `<li class="shelf-item"><span class="file-ext" aria-hidden="true">${esc((f.name.split(".").pop() ?? "").slice(0, 4).toUpperCase())}</span>
        <button class="linkish" data-act="w-open" data-i="${i}" title="Open ${esc(f.path)}"><span class="clamp1">${esc(f.name)}</span><span class="faint clamp1">${esc(dir)}</span></button>
        <button class="btn ghost sm" data-act="w-reveal" data-i="${i}" aria-label="Show ${esc(f.name)} in its folder">Show</button>
        <button class="btn ghost sm" data-act="w-share" data-i="${i}" aria-label="Share ${esc(f.name)}">${isMac ? "AirDrop" : "Share"}</button>
        <button class="btn ghost sm" data-act="w-unshelf" data-i="${i}" aria-label="Remove ${esc(f.name)} from the shelf">✕</button></li>`;
    }).join("");
    return `<div class="card shelf">${items ? `<ul class="list">${items}</ul>
        <div class="row"><span class="faint">Drop more files on the island to park them here.</span><span class="spacer"></span>
          <button class="btn sm" data-act="w-share-all">${isMac ? "AirDrop all" : "Share all"}</button><button class="btn ghost sm" data-act="w-clear-shelf">Clear</button></div>`
      : `<div class="drop-hint"><p class="title">Drop files here</p><p class="muted">Drag files onto the island to park them, then open, find or share them later.</p></div>`}</div>`;
  }

  private clipCard() {
    const list = this.clipView === "recent" ? this.clips : this.snippets;
    const copied = Date.now() - this.copiedAt < 1200;
    const items = list.map((c, i) => `<li class="clip-item"><button class="linkish" data-act="w-copy" data-i="${i}" title="Copy">
        <span class="clamp1">${esc(c.replace(/\s+/g, " ").slice(0, 200))}</span></button>
        ${this.clipView === "recent"
          ? `<button class="btn ghost sm" data-act="w-pin" data-i="${i}" aria-label="${this.snippets.includes(c) ? "Remove from snippets" : "Save as snippet"}">${this.snippets.includes(c) ? "★" : "☆"}</button>`
          : `<button class="btn ghost sm" data-act="w-unpin" data-i="${i}" aria-label="Delete snippet">✕</button>`}</li>`).join("");
    const empty = this.clipView === "recent" ? "Copy some text and it shows up here. Passwords from password managers are skipped." : "Star a copy, or add a snippet below.";
    return `<div class="card clip"><div class="row seg" role="tablist">
        <button class="tab ${this.clipView === "recent" ? "on" : ""}" role="tab" aria-selected="${this.clipView === "recent"}" data-act="w-clipview" data-v="recent">Recent</button>
        <button class="tab ${this.clipView === "snippets" ? "on" : ""}" role="tab" aria-selected="${this.clipView === "snippets"}" data-act="w-clipview" data-v="snippets">Snippets</button>
        <span class="spacer"></span><span class="faint" role="status">${copied ? "Copied" : ""}</span></div>
      ${items ? `<ul class="list">${items}</ul>` : `<p class="faint">${empty}</p>`}
      ${this.clipView === "snippets" ? `<div class="row"><input class="input" placeholder="New snippet" aria-label="New snippet" data-field="snippet"><button class="btn" data-act="w-add-snippet">Add</button></div>` : ""}</div>`;
  }

  private camCard() {
    return `<div class="card cam">${this.camError ? `<p class="muted">${esc(this.camError)}</p>`
      : `<video class="mirror" autoplay muted playsinline aria-label="Camera preview"></video>`}
      <p class="faint">Mirror only: nothing is recorded, and the camera turns off when you leave this tab or close the island.</p></div>`;
  }

  private systemCard() {
    const s = this.sys;
    if (!s) return `<div class="card"><p class="faint">Reading your system…</p></div>`;
    if (this.brightness === undefined && this.invoke) {
      this.brightness = null;
      this.invoke<number | null>("get_brightness").then((b) => { this.brightness = b; this.host.update(); }).catch(() => {});
    }
    const meter = (label: string, v: number, cls: string) =>
      `<div class="meter"><span>${label}</span><span class="meter-track"><i class="${cls}" style="width:${v}%"></i></span><b class="${cls}-n">${v}%</b></div>`;
    const priv = [...s.camera.map((a) => `Camera · ${a}`), ...s.mic.map((a) => `Microphone · ${a}`)];
    return `<div class="card system"><div class="col">
      <div class="slider-row"><button class="btn ghost sm" data-act="w-mute" aria-label="${s.muted ? "Unmute" : "Mute"}">${s.muted ? "🔇" : "🔊"}</button>
        <input type="range" min="0" max="100" value="${s.volume}" data-field="volume" aria-label="Volume"><b>${s.volume}%</b></div>
      ${typeof this.brightness === "number" ? `<div class="slider-row"><span class="sun" aria-hidden="true">☀</span>
        <input type="range" min="0" max="100" value="${this.brightness}" data-field="brightness" aria-label="Brightness"><b>${this.brightness}%</b></div>` : ""}
    </div><div class="col">
      ${s.battery != null ? meter(s.charging ? "Battery ⚡" : "Battery", s.battery, "live-bat") : ""}
      ${meter("CPU", s.cpu, "live-cpu-bar")}${meter("RAM", s.ram, "live-ram-bar")}
      <p class="faint">${isMac ? "macOS shows camera and mic use in the menu bar." : priv.length ? `In use: ${esc(priv.join(", "))}` : "Camera and microphone aren't in use."}</p>
    </div></div>`;
  }

  /** One line for the Code tab: today's Claude Code usage (refreshed at most once a minute). */
  usageLine(): string {
    if (this.invoke && Date.now() - this.usageAt > 60_000) {
      this.usageAt = Date.now();
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      this.invoke<Usage>("claude_usage", { since: midnight.toISOString() }).then((u) => { this.usage = u; this.live(); }).catch(() => {});
    }
    const u = this.usage;
    return `<span class="faint usage clamp1">${u ? `Today: ${compact(u.input + u.cache_read + u.cache_write)} in · ${compact(u.output)} out · ${u.messages} replies` : ""}</span>`;
  }

  /** Update values that change every second without re-rendering the card. */
  live() {
    const r = this.root;
    const q = <T extends Element = HTMLElement>(sel: string) => r?.querySelector<T & HTMLElement>(sel) ?? null;
    const m = this.media;
    const bar = q(".progress i");
    if (bar && m && m.duration > 0) {
      bar.style.width = `${Math.min(100, (m.position / m.duration) * 100)}%`;
      q(".media-time")!.textContent = `${mmss(m.position)} / ${mmss(m.duration)}`;
    }
    // waveform: the real output level when we have it, a gentle fake one otherwise (macOS)
    const real = Date.now() - this.levelAt < 1000;
    const lv = real ? this.levels : this.levels.map((_, i) => (m?.playing ? 0.25 + 0.2 * Math.sin(Date.now() / 260 + i * 0.7) : 0.04));
    r?.querySelectorAll<HTMLElement>(".wave i").forEach((el, i) => (el.style.transform = `scaleY(${Math.max(0.06, lv[i])})`));
    document.querySelectorAll<HTMLElement>(".eq i").forEach((el, i) =>
      (el.style.transform = `scaleY(${Math.max(0.2, real ? lv[BARS - 1 - i * 3] : 0.5 + 0.4 * Math.sin(Date.now() / 180 + i))})`));
    const t = this.timer;
    if (t) {
      const left = t.left ?? Math.max(0, t.endsAt - Date.now());
      const el = q(".live-timer");
      if (el) el.textContent = hms(left);
      const ring = q<SVGCircleElement>(".ring-fill");
      if (ring) ring.style.strokeDashoffset = String(100 * (1 - left / t.total)); // full ring that drains
    }
    const c = q(".live-clock");
    if (c) c.textContent = time(new Date());
    const s = this.sys;
    if (s) {
      for (const [sel, v] of [[".live-cpu", s.cpu], [".live-ram", s.ram]] as const) { const el = q(sel); if (el) el.textContent = `${v}%`; }
      for (const [k, v] of [["live-cpu-bar", s.cpu], ["live-ram-bar", s.ram]] as const) {
        const el = q(`.${k}`); if (el) el.style.width = `${v}%`;
        const n = q(`.${k}-n`); if (n) n.textContent = `${v}%`;
      }
    }
    const u = q(".usage");
    if (u && this.usage) u.outerHTML = this.usageLine();
  }

  /** The tab now showing (null = island closed): starts the camera for the mirror, stops it otherwise. */
  async visible(tab: Tab | null) {
    if (tab !== "cam") {
      this.cam?.getTracks().forEach((t) => t.stop());
      if (this.cam) { this.cam = null; this.host.update(); }
      return;
    }
    if (this.cam) return this.attachCam();
    try {
      this.cam = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: false });
      this.camError = "";
    } catch (e) {
      this.camError = (e as Error).name === "NotAllowedError"
        ? `Camera access was blocked. Allow it for Perch in ${isMac ? "System Settings › Privacy & Security › Camera" : "Settings › Privacy & security › Camera"}.`
        : "No camera found.";
    }
    this.host.update();
    this.attachCam();
  }

  attachCam() {
    const v = this.root?.querySelector<HTMLVideoElement>("video.mirror");
    if (v && this.cam && v.srcObject !== this.cam) v.srcObject = this.cam;
  }

  // ---- input ----

  private run(p: Promise<unknown> | undefined) {
    p?.then(() => { this.error = ""; }).catch((e) => { this.error = String(e); this.host.update(); });
  }

  /** Handle a widget button (data-act starting with "w-"). Returns true when handled. */
  action(act: string, el: HTMLElement): boolean {
    const i = Number(el.dataset.i);
    const field = (name: string) => this.root?.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    switch (act) {
      case "w-tab": this.host.alert(el.dataset.tab as Tab); return true;
      case "w-join":
        if (this.invoke) this.run(this.invoke("open_url", { url: el.dataset.url }));
        else window.open(el.dataset.url, "_blank", "noopener");
        return true;
      case "w-media": this.run(this.invoke?.("media_control", { action: el.dataset.cmd })); return true;
      case "w-pomodoro":
        this.timer = { label: "Focus", total: POMODORO.focus * 60_000, endsAt: Date.now() + POMODORO.focus * 60_000, phase: "focus", round: 1 };
        break;
      case "w-timer": case "w-timer-custom": {
        const min = act === "w-timer" ? Number(el.dataset.min) : Number(field("minutes")?.value);
        if (!(min > 0)) return true;
        this.timer = { label: `${min} min timer`, total: min * 60_000, endsAt: Date.now() + min * 60_000 };
        break;
      }
      case "w-timer-pause": {
        const t = this.timer!;
        if (t.left) { t.endsAt = Date.now() + t.left; delete t.left; } else t.left = Math.max(1, t.endsAt - Date.now());
        break;
      }
      case "w-timer-add": { const t = this.timer!; t.total += 60_000; if (t.left) t.left += 60_000; else t.endsAt += 60_000; break; }
      case "w-timer-skip": delete this.timer!.left; this.timer!.endsAt = Date.now(); this.timerDone(); return true;
      case "w-timer-stop": this.timer = null; break;
      case "w-open": case "w-reveal":
        this.run(this.invoke?.("open_path", { path: this.shelf[i].path, reveal: act === "w-reveal" }));
        return true;
      case "w-share": case "w-share-all":
        this.run(this.invoke?.("share_files", { paths: act === "w-share" ? [this.shelf[i].path] : this.shelf.map((f) => f.path) }));
        return true;
      case "w-unshelf": this.shelf.splice(i, 1); save("perch.shelf", this.shelf); break;
      case "w-clear-shelf": this.shelf = []; save("perch.shelf", this.shelf); break;
      case "w-clipview": this.clipView = el.dataset.v as "recent" | "snippets"; break;
      case "w-copy": {
        const text = (this.clipView === "recent" ? this.clips : this.snippets)[i];
        this.run(this.invoke ? this.invoke("copy_text", { text }) : navigator.clipboard?.writeText(text));
        this.copiedAt = Date.now();
        play("allow");
        setTimeout(() => this.host.update(), 1300);
        break;
      }
      case "w-pin": {
        const c = this.clips[i];
        this.snippets = this.snippets.includes(c) ? this.snippets.filter((s) => s !== c) : [c, ...this.snippets];
        save("perch.snippets", this.snippets);
        break;
      }
      case "w-unpin": this.snippets.splice(i, 1); save("perch.snippets", this.snippets); break;
      case "w-add-snippet": {
        const v = field("snippet")?.value.trim();
        if (!v) return true;
        this.snippets = [v, ...this.snippets.filter((s) => s !== v)];
        save("perch.snippets", this.snippets);
        break;
      }
      case "w-mute":
        this.ownVolumeAt = Date.now();
        this.run(this.invoke?.("set_volume", { muted: !this.sys?.muted }));
        return true;
      default: return false;
    }
    if (act.startsWith("w-timer") || act === "w-pomodoro") save("perch.timer", this.timer);
    this.host.update();
    return true;
  }

  /** Click on the progress bar: seek to that point. */
  seek(el: HTMLElement, clientX: number) {
    const m = this.media;
    if (!m || m.duration <= 0) return;
    const r = el.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * m.duration;
    this.media = { ...m, position };
    this.live();
    this.run(this.invoke?.("media_control", { action: "seek", position }));
  }

  /** A slider was released (volume / brightness). */
  slider(name: string, value: number) {
    if (name === "volume") {
      this.ownVolumeAt = Date.now();
      this.run(this.invoke?.("set_volume", { volume: value / 100 }));
    }
    if (name === "brightness") {
      this.brightness = value;
      this.run(this.invoke?.("set_brightness", { level: value }));
    }
  }
}
