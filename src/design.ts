// Primitives page: every component and every mascot state in isolation. Dev only.
import "./ui.css";
import { Dango, type MascotState, type Emote } from "./mascot";

const states: MascotState[] = ["idle", "working", "thinking", "approval", "question", "error", "finished", "ratelimit", "sleeping", "dizzy"];
const emotes: Exclude<Emote, null>[] = ["annoyed", "surprised", "happy", "love"];

const app = document.getElementById("app")!;
app.innerHTML = `
  <h2>Dango: states</h2><div class="grid" id="states"></div>
  <h2>Dango: emotes (click to poke)</h2><div class="grid" id="emotes"></div>
  <h2>Island: compact</h2>
  <div class="island" data-mode="compact" style="width:280px;height:30px;display:flex;align-items:center;padding:0 8px;gap:8px">
    <canvas id="compact" style="width:28px;height:28px"></canvas><span class="faint">2 running</span>
  </div>
  <h2>Island: approval (expanded)</h2>
  <div class="island" data-mode="expanded" style="width:640px;padding:0 10px 10px">
    <div class="header"><div class="tabs"><button class="btn ghost">Home</button></div>
      <div class="right"><span>2 running</span><button class="btn ghost" aria-label="Mute sounds">Sound</button></div></div>
    <div class="card row" data-tone="approval" style="gap:14px;align-items:flex-start">
      <canvas id="approval" style="width:84px;height:84px"></canvas>
      <div style="flex:1;display:grid;gap:8px">
        <div><p class="title">perch wants to run a command</p><span class="faint">Claude Code · Bash · 1 of 2</span></div>
        <div class="code">npm run build &amp;&amp; npm test -- --watch=false</div>
        <div class="row"><span class="spacer"></span>
          <button class="btn danger">Deny <span class="kbd">N</span></button>
          <button class="btn">Always allow</button>
          <button class="btn primary">Allow <span class="kbd">Y</span></button></div>
      </div>
    </div>
    <div class="countdown" style="width:90px;position:relative;margin:6px auto 0"></div>
  </div>
  <h2>Question options</h2>
  <div class="card" data-tone="question" style="width:640px;display:grid;gap:8px">
    <p class="title">Which test runner should I set up? <span class="faint">1/2</span></p>
    <div class="row" style="flex-wrap:wrap">
      <button class="option" aria-pressed="true">Vitest<span class="desc">fast, works with Vite</span></button>
      <button class="option" aria-pressed="false">Jest<span class="desc">the classic</span></button>
      <button class="option" aria-pressed="false">Something else…</button>
    </div>
    <input class="input" placeholder="Type your own answer" aria-label="Your own answer" />
    <div class="row"><button class="btn ghost">Answer in the terminal</button><span class="spacer"></span><button class="btn primary">Next</button></div>
  </div>
  <h2>Overview: ticker + pills</h2>
  <div class="card row" style="width:640px;gap:14px">
    <div style="flex:1">
      <div class="ticker"><ol>
        <li>Read package.json</li>
        <li class="current"><button class="step">Edit src/invoice.ts <span class="add">+3</span> <span class="del">−1</span></button></li>
        <li>Bash npm test</li>
        <li>Grep "TODO"</li>
      </ol></div>
    </div>
    <div style="display:grid;gap:8px">
      <span class="pill" style="--agent: var(--c-state-working)"><canvas id="p1"></canvas>perch</span>
      <span class="pill" style="--agent: #c792ea"><canvas id="p2"></canvas>codex · api</span>
      <span class="pill" style="--agent: #5fd3a6"><canvas id="p3"></canvas>a-very-long-project-name-that-keeps-going-on</span>
    </div>
  </div>
  <h2>Diff</h2>
  <div class="code diff" style="width:640px;max-height:none"><span class="line">export function total(items: Item[]) {</span><span class="line del">  const rate = 0.2</span><span class="line add">  const rate = taxRate(region)</span><span class="line">  return sum(items) * (1 + rate)</span></div>
  <h2>Buttons</h2>
  <div class="row"><button class="btn primary">Primary</button><button class="btn">Secondary</button>
    <button class="btn ghost">Ghost</button><button class="btn danger">Danger</button><button class="btn" disabled>Disabled</button></div>
`;

const all: { d: Dango; el: HTMLCanvasElement }[] = [];
const mk = (el: HTMLCanvasElement, s: MascotState, tint: string | null = null) => {
  const d = new Dango(el); d.setState(s); d.tint = tint; d.start(); all.push({ d, el }); return d;
};
for (const s of states) {
  const f = document.createElement("figure");
  f.innerHTML = `<canvas></canvas><figcaption>${s}</figcaption>`;
  document.getElementById("states")!.append(f);
  mk(f.querySelector("canvas")!, s);
}
for (const e of emotes) {
  const f = document.createElement("figure");
  f.innerHTML = `<canvas></canvas><figcaption>${e}</figcaption>`;
  document.getElementById("emotes")!.append(f);
  const d = mk(f.querySelector("canvas")!, "idle");
  d.showEmote(e, 1e9);
  f.onclick = () => d.poke();
}
const byId = (id: string) => document.getElementById(id) as HTMLCanvasElement;
mk(byId("compact"), "working");
mk(byId("approval"), "approval");
mk(byId("p1"), "working", "#4aa3ff");
mk(byId("p2"), "thinking", "#c792ea");
mk(byId("p3"), "idle", "#5fd3a6");

// eyes follow the mouse across the page
addEventListener("mousemove", (ev) => {
  for (const { d, el } of all) {
    const r = el.getBoundingClientRect();
    d.lookAt((ev.clientX - (r.left + r.width / 2)) / 260, (ev.clientY - (r.top + r.height / 2)) / 200);
  }
});
