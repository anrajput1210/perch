// The island: modes (hidden / peek / compact / expanded), tabs, the coding-agent views, and Dango's place in each.
// Everything else on the island (media, timer, shelf, clipboard, mirror, system, home) lives in widgets.ts.
import { Dango, type MascotState } from "./mascot";
import { play, type SoundName } from "./sound";
import type { Alert, Session, Snapshot, Step, Store } from "./store";
import { TABS, Widgets, type Invoke, type Tab } from "./widgets";

type Mode = "hidden" | "peek" | "compact" | "expanded";
type View = "overview" | "empty" | "widget" | "approval" | "question" | "finished" | "diff" | "confused";

const COUNTDOWN_MS = 10_000;
const MASCOT = 96; // canvas CSS size; positions below scale it down
const W = { hidden: 200, peek: 200, compact: 280, expanded: 640 };
const BAR_H = 30;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const AGENT_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor" };
const agentName = (a: string) => AGENT_NAME[a] ?? a;
const STATE_TEXT: Record<string, string> = {
  idle: "Waiting", thinking: "Thinking", working: "Working", approval: "Needs your OK", question: "Has a question",
  error: "Hit an error", finished: "Done", ratelimit: "Out of usage",
};
const VERB: Record<string, string> = { Bash: "run a command", Edit: "change a file", Write: "write a file", WebFetch: "open a web page" };

export class Island {
  private el: HTMLElement;
  private content: HTMLElement;
  private bar: HTMLElement;
  private canvas: HTMLCanvasElement;
  private countdown: HTMLElement;
  private dango: Dango;
  private snap: Snapshot = { sessions: [], alerts: [] };
  private mode: Mode = "hidden";
  private view: View = "empty";
  private renderKey = "";
  private userOpen = false;
  private peeking = false;
  private focusId: string | null = null;
  private diffStep: Step | null = null;
  private dizzyUntil = 0;
  private pokes: number[] = [];
  private lastActivity = Date.now();
  private hoverTimer = 0;
  private leaveTimer = 0;
  private q = { alertId: 0, index: 0, picks: [] as string[][], other: "" };
  private noteText = "";
  private noteTimer = 0;
  private minis = new Map<string, { el: HTMLCanvasElement; dango: Dango }>();
  private autoCloseMs = 60_000;
  private awayMs = 3 * 60_000;
  private lastMove = Date.now();
  private tab: Tab = "home";
  private shownTab: Tab | null = null;
  private pos = "top";
  private scale = 1;
  readonly widgets: Widgets;
  private codeMode = true;
  /** The gear in the header was pressed. */
  onSettings?: () => void;
  /** The Code mode switch in the header was flipped. */
  onCodeMode?: (on: boolean) => void;
  /** Called with the island's target hit area (window coordinates) whenever it moves or resizes. */
  onLayout?: (r: { x: number; y: number; w: number; h: number }) => void;

  constructor(root: HTMLElement, private store: Store, invoke?: Invoke) {
    root.innerHTML = `
      <div class="hover-zone" aria-hidden="true"></div>
      <div class="island" data-mode="hidden" role="dialog" aria-label="Perch">
        <div class="bar"><span class="bar-lead"></span><span class="bar-label"></span><span class="spacer"></span><span class="privacy"></span><span class="minis"></span></div>
        <div class="content"></div>
        <canvas class="dango" aria-hidden="true"></canvas>
        <div class="countdown"></div>
      </div>`;
    this.el = root.querySelector(".island")!;
    this.content = root.querySelector(".content")!;
    this.bar = root.querySelector(".bar")!;
    this.canvas = root.querySelector(".dango")!;
    this.countdown = root.querySelector(".countdown")!;
    this.dango = new Dango(this.canvas);
    this.dango.start();
    this.widgets = new Widgets(invoke, { update: () => this.update(), alert: (tab) => this.show(tab) });
    this.widgets.root = this.content;

    root.querySelector(".hover-zone")!.addEventListener("mouseenter", () => this.onHoverEdge());
    this.el.addEventListener("mouseenter", () => this.onEnter());
    this.el.addEventListener("mouseleave", () => this.onLeave());
    this.el.addEventListener("mousemove", () => (this.lastActivity = Date.now()));
    this.canvas.addEventListener("click", () => this.onMascotClick());
    this.content.addEventListener("click", (e) => this.onAction(e));
    this.content.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.act === "other") this.q.other = t.value;
      if (t.type === "range" && t.dataset.field) {
        t.nextElementSibling!.textContent = `${t.value}%`;
        this.widgets.slider(t.dataset.field, Number(t.value));
      }
    });
    this.content.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.type === "range" && t.dataset.field) this.widgets.slider(t.dataset.field, Number(t.value), true);
    });
    addEventListener("keydown", (e) => this.onKey(e));
    setInterval(() => this.tick(), 200);
    store.subscribe((s) => { this.snap = s; this.update(); });
  }

  /** Point Dango's eyes at a screen/page position. */
  look(x: number, y: number) {
    if (Date.now() - this.lastMove > this.awayMs && this.awayMs) { this.lastMove = Date.now(); this.update(); }
    this.lastMove = Date.now();
    const r = this.canvas.getBoundingClientRect();
    this.dango.lookAt((x - (r.left + r.width / 2)) / 260, (y - (r.top + r.height / 2)) / 200);
  }

  /** Settings from the settings window (auto-close seconds, away minutes; 0 = never hide). */
  configure(o: { auto_close_s: number; away_min: number; code_mode?: boolean; position?: string; scale?: number; calendar_url?: string }) {
    if (o.code_mode !== undefined && o.code_mode !== this.codeMode) { this.codeMode = o.code_mode; this.renderKey = ""; }
    if (!this.codeMode && this.tab === "code") this.tab = "home";
    this.pos = o.position ?? this.pos;
    this.scale = o.scale ?? this.scale;
    this.el.parentElement!.dataset.pos = this.pos;
    this.el.style.setProperty("--scale", String(this.scale));
    this.widgets.configure(o);
    this.autoCloseMs = o.auto_close_s * 1000;
    this.awayMs = o.away_min * 60_000;
    this.update();
  }

  private away() { return this.awayMs > 0 && Date.now() - this.lastMove > this.awayMs; }

  /** Open on the tab that matters most right now: agents, then music, else wherever the user left it. */
  open() {
    if (!this.userOpen && !this.diffStep) {
      if (this.codeMode && this.snap.sessions.length) this.tab = "code";
      else if (this.widgets.media?.playing) this.tab = "media";
      else if (this.tab === "code" && !this.codeMode) this.tab = "home";
    }
    this.userOpen = true;
    this.lastActivity = Date.now();
    this.update();
  }

  /** Open straight onto a tab (timer finished, files dropped, meeting soon). */
  show(tab: Tab) {
    this.tab = tab;
    this.userOpen = true;
    this.lastActivity = Date.now();
    this.update();
  }
  close() { this.userOpen = false; this.peeking = false; this.diffStep = null; this.update(); }
  poke() { this.onMascotClick(); }

  /** A short message in the peeking bar, e.g. from the tray menu. */
  note(text: string) {
    this.noteText = text;
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => { this.noteText = ""; this.update(); }, 5000);
    this.update();
  }

  /** Demo autopilot: press a control the way a user would, with a visible press. */
  press(act: string, i?: number) {
    if (act === "open") return this.open();
    if (act === "diff-last") {
      const s = this.focus();
      const d = s && [...s.steps].reverse().find((x) => x.kind === "diff");
      if (d) { this.diffStep = d; this.open(); }
      return;
    }
    const sel = i === undefined ? `[data-act="${act}"]` : `[data-act="${act}"][data-i="${i}"]`;
    const b = this.content.querySelector<HTMLElement>(sel);
    if (!b) return;
    b.classList.add("auto-press");
    setTimeout(() => b.click(), 420);
  }

  // ---- state -> mode/view ----

  private focus(): Session | undefined {
    const ss = this.snap.sessions;
    const alert = this.snap.alerts[0];
    if (alert) return ss.find((s) => s.id === alert.sessionId);
    return ss.find((s) => s.state === "finished") ?? ss.find((s) => s.id === this.focusId)
      ?? ss.find((s) => s.state === "working" || s.state === "thinking") ?? ss[0];
  }

  private compute(): [Mode, View] {
    const alert = this.snap.alerts[0];
    if (Date.now() < this.dizzyUntil) return ["expanded", "confused"];
    if (alert) return ["expanded", alert.kind === "permission" ? "approval" : "question"];
    if (this.snap.sessions.some((s) => s.state === "finished")) return ["expanded", "finished"];
    if (this.userOpen) return ["expanded", this.diffStep ? "diff" : this.tab !== "code" ? "widget" : this.snap.sessions.length ? "overview" : "empty"];
    if (this.peeking || this.noteText) return ["peek", "empty"];
    if ((this.snap.sessions.length || this.widgets.activity() || this.widgets.privacy()) && !this.away()) return ["compact", "overview"];
    return ["hidden", "empty"];
  }

  private update() {
    const [mode, view] = this.compute();
    const focus = this.focus();
    const alert = this.snap.alerts[0];
    if (alert && alert.id !== this.q.alertId) this.q = { alertId: alert.id, index: 0, picks: [], other: "" };

    if (view !== this.view && mode === "expanded") {
      const cue: Partial<Record<View, SoundName>> = { approval: "approval", question: "question", finished: "finish", confused: "dizzy" };
      if (cue[view]) play(cue[view]!);
      else if (this.mode !== "expanded") play("open");
    }
    if (focus?.state === "error" && this.dango.state !== "error") play("error");
    if (mode === "peek" && this.mode === "hidden") play("peek");
    if (mode !== "expanded" && this.mode === "expanded") play("close");

    // mascot mood
    const st: MascotState = view === "confused" ? "dizzy" : focus ? focus.state : this.peeking ? "idle" : "sleeping";
    this.dango.setState(st);

    // bar (collapsed)
    // collapsed bar: a note, else the most urgent thing (volume HUD, timer, meeting soon), else the agent, else music
    const act = this.widgets.activity();
    const useAct = act && (!focus || !act.lead?.includes("eq"));
    this.bar.querySelector(".bar-label")!.textContent = this.noteText ||
      (useAct ? act.label : focus ? `${focus.name} · ${STATE_TEXT[focus.state]}` : mode === "peek" ? "All quiet" : "");
    this.setHtml(this.bar.querySelector(".bar-lead")!, !this.noteText && useAct ? act.lead ?? "" : "");
    this.setHtml(this.bar.querySelector(".privacy")!, this.widgets.privacy());
    this.syncMinis();

    // expanded content: re-render only when something visible changed
    const key = [view, alert?.id, focus?.id, focus?.state, focus?.steps.length, this.snap.sessions.map((s) => s.id + s.state).join(),
      this.q.index, this.q.picks.map((p) => p.join("|")).join(";"), this.diffStep?.at,
      view === "widget" ? this.widgets.key(this.tab) : "", this.codeMode, this.tab].join("/");
    if (mode === "expanded" && (key !== this.renderKey || view !== this.view)) {
      const html = this.render(view, focus, alert);
      if (view !== this.view || this.mode !== "expanded") this.swap(html); else this.content.innerHTML = html;
      this.renderKey = key;
    }
    if (mode !== this.mode && mode === "expanded") this.dango.showEmote("surprised", 300);
    this.widgets.live();
    this.widgets.attachCam();
    const shown = mode === "expanded" && view === "widget" ? this.tab : null;
    if (shown !== this.shownTab) { this.shownTab = shown; void this.widgets.visible(shown); }
    this.mode = mode;
    this.view = view;
    this.layout();
  }

  /** One small tinted Dango per running session (max 4) in the collapsed bar, showing that session's state. */
  private syncMinis() {
    const shown = this.snap.sessions.slice(0, 4);
    for (const [id, m] of this.minis) {
      if (!shown.some((s) => s.id === id)) { m.dango.stop(); m.el.remove(); this.minis.delete(id); }
    }
    const box = this.bar.querySelector(".minis")!;
    for (const s of shown) {
      let m = this.minis.get(s.id);
      if (!m) {
        const el = document.createElement("canvas");
        box.append(el);
        m = { el, dango: new Dango(el) };
        m.dango.tint = s.color;
        m.dango.start();
        this.minis.set(s.id, m);
      }
      m.dango.setState(s.state);
      m.el.setAttribute("aria-label", `${s.name}, ${STATE_TEXT[s.state]}`);
    }
  }

  /** innerHTML only when it changed, so running animations and images aren't restarted every update. */
  private setHtml(el: HTMLElement, html: string) {
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  private swap(html: string) {
    this.content.classList.add("leaving");
    setTimeout(() => {
      this.content.innerHTML = html;
      this.content.classList.remove("leaving");
      // start the fade-in from the "entering" style via a forced reflow (rAF is paused in background windows)
      this.content.classList.add("entering");
      void this.content.offsetWidth;
      this.content.classList.remove("entering");
      this.layout();
      this.content.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
      this.widgets.live();
      this.widgets.attachCam();
    }, this.mode === "expanded" ? 140 : 0);
  }

  private layout() {
    const m = this.mode;
    this.el.dataset.mode = m;
    const width = m === "peek" && this.noteText ? 460 : m === "compact" && this.widgets.activity() && !this.snap.sessions.length ? 340 : W[m];
    this.el.style.width = `${width}px`;
    let h = m === "hidden" ? 0 : BAR_H;
    let mx = 6, my = 3, size = 24;
    if (m === "expanded") {
      const card = this.content.querySelector<HTMLElement>(".card");
      const cardH = card?.offsetHeight ?? 120;
      h = 34 + cardH + 12;
      size = this.view === "approval" || this.view === "question" ? 76 : 88;
      const slot = card?.querySelector<HTMLElement>(".slot");
      if (slot) {
        mx = 10 + slot.offsetLeft + (slot.offsetWidth - size) / 2;
        my = 34 + slot.offsetTop + Math.min(cardH - size, slot.offsetHeight - size) / 2;
      } else {
        size = 26; mx = 14; my = 4; // no room in the card: Dango sits in the header's corner
      }
    }
    this.el.classList.toggle("mascot-corner", m === "expanded" && !this.content.querySelector(".card .slot"));
    this.el.style.height = `${h}px`;
    // hidden: a thin strip at the top edge stays live so hovering it can reveal the island
    const sw = width * this.scale, sh = m === "hidden" ? 4 : h * this.scale;
    const x = this.pos === "top-left" ? 0 : this.pos === "top-right" ? innerWidth - sw : (innerWidth - sw) / 2;
    this.onLayout?.({ x, y: this.pos === "bottom" ? innerHeight - sh : 0, w: sw, h: sh });
    this.canvas.style.transform = `translate(${mx}px, ${my}px) scale(${size / MASCOT})`;
  }

  // ---- views ----

  /** Icon tabs; the open one also shows its name. Code only while Code mode is on. */
  private tabs() {
    return TABS.filter((t) => t.id !== "code" || this.codeMode).map((t) => {
      const on = t.id === this.tab;
      return `<button class="tab icon-tab ${on ? "on" : ""}" data-act="tab" data-tab="${t.id}" role="tab" aria-selected="${on}"
        aria-label="${t.label}" title="${t.label}">${t.icon}${on ? `<span>${t.label}</span>` : ""}</button>`;
    }).join("");
  }

  private header(left = this.tabs()) {
    return `<div class="header"><div class="tabs" role="tablist">${left}</div>
      <div class="right">${this.codeMode && this.snap.sessions.length ? `<span>${this.snap.sessions.length} running</span>` : ""}${this.codeSwitch()}
        <button class="gear" data-act="settings" aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24" width="16" height="16" fill="none"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button></div></div>`;
  }

  /** Code mode switch: a tiny terminal. Off it's a dim </> chip; on, the knob becomes a prompt with a blinking
   *  caret and CODE types itself into a phosphor-lit track. */
  private codeSwitch() {
    return `<button class="code-switch" role="switch" aria-checked="${this.codeMode}" data-act="code"
        aria-label="Code mode" title="Code mode: watch your coding agents">
      <span class="cs-track"><span class="cs-word" aria-hidden="true">CODE</span><span class="cs-off" aria-hidden="true">off</span>
        <span class="cs-knob" aria-hidden="true"><span class="cs-tag">&lt;/&gt;</span><span class="cs-prompt">&gt;<i></i></span></span></span>
    </button>`;
  }

  private render(view: View, s: Session | undefined, alert: Alert | undefined): string {
    const who = s ? `<div class="who"><b>${esc(s.name)}</b><span class="faint">${agentName(s.agent)} · ${STATE_TEXT[s.state]}</span></div>` : "";
    switch (view) {
      case "empty":
        return `${this.header()}<div class="card row"><div class="slot"></div><div class="col">
          <p class="title">All quiet</p>
          <p class="muted">${this.codeMode ? "No agents are running. Start one in a terminal and I'll keep an eye on it."
            : "Code mode is off, so your coding agents ask in their terminal. Flip the switch to bring them here."}</p>
          ${this.codeMode ? this.widgets.usageLine() : ""}</div></div>`;
      case "widget": return `${this.header()}${this.widgets.render(this.tab)}`;
      case "overview": {
        const steps = s?.steps.slice(-3) ?? []; // 3 rows fit; the newest (current) sits at the bottom
        const rows = steps.map((st, i) => {
          const cur = i === steps.length - 1 ? "current" : "";
          const body = st.kind === "diff"
            ? `<button class="step" data-act="diff" data-at="${st.at}">${esc(st.label)} <span class="add">+${st.added}</span> <span class="del">−${st.removed}</span></button>`
            : esc(st.label);
          return `<li class="${cur}">${body}</li>`;
        }).join("") || `<li class="current muted">Waiting for the first step…</li>`;
        const pills = this.snap.sessions.map((x) =>
          `<button class="pill ${x.id === s?.id ? "on" : ""}" data-act="focus" data-id="${esc(x.id)}" style="--agent:${x.color}"
            aria-label="${esc(x.name)}, ${STATE_TEXT[x.state]}"><i></i>${esc(x.name)}</button>`).join("");
        return `${this.header()}<div class="card row" data-tone="${s?.state === "working" ? "working" : ""}">
          <div class="slot"></div><div class="col">${who}<div class="ticker"><ol data-n="${s?.steps.length ?? 0}">${rows}</ol></div>${this.widgets.usageLine()}</div>
          <div class="pills">${pills}</div></div>`;
      }
      case "approval": {
        if (alert?.kind !== "permission") return "";
        const n = this.snap.alerts.length;
        return `${this.header()}<div class="card row" data-tone="approval"><div class="slot"></div><div class="col">
          <div><p class="title">${esc(s?.name ?? "An agent")} wants to ${VERB[alert.tool] ?? `use ${esc(alert.tool)}`}</p>
          <span class="faint">${agentName(s?.agent ?? "claude")} · ${esc(alert.tool)}${n > 1 ? ` · 1 of ${n}` : ""}</span></div>
          <div class="code">${esc(alert.detail)}</div>
          <div class="row"><span class="spacer"></span>
            <button class="btn danger" data-act="deny">Deny <span class="kbd">N</span></button>
            ${alert.always ? `<button class="btn" data-act="always">Always allow</button>` : ""}
            <button class="btn primary" data-act="allow" data-autofocus>Allow <span class="kbd">Y</span></button></div>
        </div></div>`;
      }
      case "question": {
        if (alert?.kind !== "question") return "";
        const qs = alert.questions, k = this.q.index, q = qs[k];
        const picks = this.q.picks[k] ?? [];
        const opts = q.options.map((o, i) => `<button class="option" data-act="opt" data-i="${i}"
            ${q.multiSelect ? `aria-pressed="${picks.includes(o.label)}"` : `role="radio" aria-checked="${picks.includes(o.label)}"`}>
            <span class="kbd">${i + 1}</span> ${esc(o.label)}${o.description ? `<span class="desc">${esc(o.description)}</span>` : ""}</button>`).join("");
        const needsNext = q.multiSelect || qs.length > 1;
        return `${this.header()}<div class="card row" data-tone="question"><div class="slot"></div><div class="col">
          <p class="title">${esc(q.question)} ${qs.length > 1 ? `<span class="faint">${k + 1}/${qs.length}</span>` : ""}</p>
          <div class="options" role="${q.multiSelect ? "group" : "radiogroup"}" aria-label="${esc(q.question)}">${opts}</div>
          <input class="input" data-act="other" placeholder="Or type your own answer" aria-label="Your own answer" value="${esc(this.q.other)}" />
          <div class="row"><button class="btn ghost" data-act="terminal">Answer in the terminal</button><span class="spacer"></span>
            ${needsNext || this.q.other ? `<button class="btn primary" data-act="next">${k + 1 < qs.length ? "Next" : "Send"}</button>` : ""}</div>
        </div></div>`;
      }
      case "finished":
        return `${this.header()}<div class="card row" data-tone="finished"><div class="slot"></div><div class="col">
          ${who}<p class="muted clamp">${esc(s?.lastMessage || "Finished.")}</p>
          <div class="row"><span class="spacer"></span><button class="btn primary" data-act="ok">Nice</button></div></div></div>`;
      case "diff": {
        const d = this.diffStep!;
        const lines = (d.diff ?? []).map((l) => `<span class="line ${l.t === "+" ? "add" : l.t === "-" ? "del" : ""}">${esc(l.s) || " "}</span>`).join("");
        return `${this.header(`<button class="btn ghost" data-act="back" aria-label="Back">← Back</button>`)}
          <div class="card"><div class="row"><b>${esc(d.label.replace(/^\w+ /, ""))}</b>
          <span class="add">+${d.added}</span><span class="del">−${d.removed}</span></div>
          <div class="code diff tall">${lines}</div></div>`;
      }
      case "confused":
        return `${this.header()}<div class="card row" data-tone="dizzy"><div class="slot"></div><div class="col">
          <p class="title">Ow, ow, ow.</p><p class="muted">That's a lot of poking. Give me a few seconds to find my feet.</p></div></div>`;
    }
  }

  // ---- input ----

  private onAction(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!b) return;
    this.lastActivity = Date.now();
    const alert = this.snap.alerts[0];
    const act = b.dataset.act!;
    if (act === "allow" || act === "deny" || act === "always" || act === "terminal") {
      if (alert) this.store.decide(alert.id, { kind: act });
      if (act === "allow" || act === "always") play("allow");
      if (act === "deny") play("deny");
      if (act === "allow" || act === "always") this.dango.showEmote("happy", 900);
    } else if (act === "opt" && alert?.kind === "question") {
      const q = alert.questions[this.q.index];
      const label = q.options[Number(b.dataset.i)].label;
      const cur = this.q.picks[this.q.index] ?? [];
      this.q.picks[this.q.index] = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
      if (!q.multiSelect && alert.questions.length === 1) return this.answer(alert);
      this.update();
    } else if (act === "next" && alert?.kind === "question") {
      if (this.q.other) { this.q.picks[this.q.index] = [...(this.q.picks[this.q.index] ?? []), this.q.other]; this.q.other = ""; }
      if (this.q.index + 1 < alert.questions.length) { this.q.index++; this.update(); } else this.answer(alert);
    } else if (act === "diff") {
      this.diffStep = this.focus()?.steps.find((s) => String(s.at) === b.dataset.at) ?? null;
      this.update();
    } else if (act === "back") { this.diffStep = null; this.update(); }
    else if (act === "code") {
      this.codeMode = !this.codeMode;
      // flip in place so the switch animates; re-render (running count, empty text) once it has settled
      b.setAttribute("aria-checked", String(this.codeMode));
      b.classList.remove("flipping");
      void b.offsetWidth;
      b.classList.add("flipping");
      play(this.codeMode ? "allow" : "deny");
      this.onCodeMode?.(this.codeMode);
      setTimeout(() => { this.renderKey = ""; this.update(); }, 650);
    }
    else if (act === "settings") this.onSettings?.();
    else if (act === "tab") { this.tab = b.dataset.tab as Tab; this.update(); }
    else if (act === "w-seek") this.widgets.seek(b, (e as MouseEvent).clientX);
    else if (act.startsWith("w-")) this.widgets.action(act, b);
    else if (act === "focus") { this.focusId = b.dataset.id!; this.update(); }
    else if (act === "ok") { const s = this.focus(); if (s) this.store.remove(s.id); }
  }

  private answer(alert: Alert) {
    this.dango.showEmote("happy", 900);
    this.store.decide(alert.id, { kind: "answer", answers: this.q.picks.map((p) => p ?? []) });
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT" && e.key !== "Escape") return;
    if (e.key === "Escape") { if (this.diffStep) { this.diffStep = null; this.update(); } else this.close(); return; }
    if (this.view === "approval") {
      if (e.key === "y" || e.key === "Y") this.press("allow");
      if (e.key === "n" || e.key === "N") this.press("deny");
    }
    if (this.view === "question" && /^[1-9]$/.test(e.key)) this.press("opt", Number(e.key) - 1);
    if (this.view === "widget" && this.tab === "media" && e.key === " ") {
      const play = this.content.querySelector<HTMLElement>('[data-cmd="toggle"]');
      if (play) { e.preventDefault(); this.widgets.action("w-media", play); }
    }
    // arrows walk the tabs
    if ((this.view === "widget" || this.view === "overview" || this.view === "empty") && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const tabs = TABS.filter((t) => t.id !== "code" || this.codeMode).map((t) => t.id);
      const i = tabs.indexOf(this.tab) + (e.key === "ArrowRight" ? 1 : -1);
      this.show(tabs[(i + tabs.length) % tabs.length]);
    }
  }

  private onHoverEdge() {
    if (this.mode !== "hidden") return;
    this.peeking = true;
    this.dango.showEmote("happy", 1000);
    this.update();
    this.armOpen(650);
  }
  private onEnter() {
    clearTimeout(this.leaveTimer);
    if (this.mode === "compact") this.armOpen(200);
    if (this.mode === "peek") this.armOpen(650);
  }
  private onLeave() {
    clearTimeout(this.hoverTimer);
    if (this.mode === "peek") this.leaveTimer = window.setTimeout(() => { this.peeking = false; this.update(); }, 600);
  }
  private armOpen(ms: number) {
    clearTimeout(this.hoverTimer);
    this.hoverTimer = window.setTimeout(() => this.open(), ms);
  }

  private onMascotClick() {
    if (this.mode !== "expanded") return this.open();
    const now = Date.now();
    this.pokes = [...this.pokes.filter((t) => now - t < 1700), now];
    this.dango.poke();
    play("poke");
    if (this.pokes.length >= 3) { this.pokes = []; this.dizzyUntil = now + 3300; this.update(); }
  }

  private tick() {
    if (this.view === "confused" && Date.now() >= this.dizzyUntil) this.update();
    if (this.mode === "compact" && this.away()) this.update();
    const idle = Date.now() - this.lastActivity;
    const closable = this.mode === "expanded" && this.userOpen && !this.snap.alerts.length;
    const left = this.autoCloseMs - idle;
    this.countdown.style.width = closable && left < COUNTDOWN_MS ? `${Math.max(0, (left / COUNTDOWN_MS) * 160)}px` : "0px";
    if (closable && left <= 0) this.close();
  }
}
