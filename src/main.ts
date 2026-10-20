import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./ui.css";
import { installSpring } from "./motion";
installSpring();
import "./island.css";
import { Store } from "./store";
import { Island } from "./island";
import type { Invoke, Media, Sys } from "./widgets";
import { runDemo } from "./demo";
import type { BlockingEvent } from "./reply";
import { configureSound } from "./sound";

const inTauri = "__TAURI_INTERNALS__" in window;
const invoke: Invoke | undefined = inTauri ? (await import("@tauri-apps/api/core")).invoke : undefined;
const store = new Store();
const island = new Island(document.getElementById("app")!, store, invoke);

type Settings = { sound: boolean; volume: number; auto_close_s: number; away_min: number; start_with_windows: boolean; code_mode: boolean;
  position: string; monitor: number; theme: string; opacity: number; scale: number; calendar_url: string };

/** Theme and see-through level apply to the whole page (both are CSS custom properties in island.css). */
function appearance(s: Pick<Settings, "theme" | "opacity">) {
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.style.setProperty("--alpha", String(s.opacity));
}

if (invoke) {
  // Real app: hook events arrive from the Rust hook server; blocking ones get our answer back.
  const { listen } = await import("@tauri-apps/api/event");
  const { hookReply } = await import("./reply");
  type Hook = { id: number; blocking: boolean; payload: BlockingEvent & { perch_agent?: string } };
  let settings: Settings;
  await listen<Hook>("hook", async ({ payload: { id, blocking, payload } }) => {
    // Code mode off: Perch stays out of the way and the agent asks in its terminal.
    if (!settings.code_mode) { if (blocking) invoke("reply", { id, output: "" }); return; }
    const ev = { ...payload, agent: payload.perch_agent ?? payload.agent };
    const answer = store.event(ev, blocking ? id : undefined);
    if (blocking) invoke("reply", { id, output: hookReply(ev, answer ? await answer : { kind: "terminal" }) });
  });
  await listen<number>("hook-cancel", (e) => store.cancelRef(e.payload));
  await listen<[number, number]>("cursor", (e) => island.look(e.payload[0], e.payload[1]));
  await listen("open", () => island.open());
  const w = island.widgets;
  await listen<Media | null>("media", (e) => w.setMedia(e.payload));
  await listen<number>("level", (e) => w.setLevel(e.payload));
  await listen<Sys>("sys", (e) => w.setSys(e.payload));
  await listen<string>("clip", (e) => w.addClip(e.payload));
  // files dragged onto the island land on the shelf; dragging over it opens the shelf as a bigger target
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "enter") island.show("shelf");
    if (e.payload.type === "drop" && e.payload.paths.length) w.addFiles(e.payload.paths);
  });
  await listen<string>("note", (e) => island.note(e.payload));
  const apply = (s: Settings) => {
    if (!s.code_mode) store.reset(); // pending approvals go back to the terminal
    settings = s;
    configureSound(s);
    appearance(s);
    island.configure(s);
  };
  island.onSettings = () => { invoke("open_settings"); };
  island.onCodeMode = (on) => { invoke("set_settings", { settings: { ...settings, code_mode: on } }).catch(() => {}); };
  apply(await invoke<Settings>("get_settings"));
  await listen<Settings>("settings", (e) => apply(e.payload));
  let demo = { stop: true };
  await listen("demo", () => {
    demo.stop = true;
    demo = { stop: false };
    runDemo(store, island, demo, true);
  });
  island.onLayout = (rect) => { invoke("set_hit_rect", { rect }); };
  island.close(); // re-runs layout so the hit area is reported once
} else {
  // Browser preview: fake desktop, demo loop, a few controls.
  document.body.classList.add("preview");
  addEventListener("mousemove", (e) => island.look(e.clientX, e.clientY));
  let token = { stop: false };
  runDemo(store, island, token);
  const panel = document.createElement("div");
  panel.className = "preview-panel";
  panel.innerHTML = `
    <p><b>Perch preview</b> · the demo plays by itself and answers for you after a few seconds.</p>
    <p class="faint">Try: hover the top edge of the page, click Dango (three quick clicks makes him dizzy), Y / N on an approval, Esc to close.</p>
    <div class="row"><button class="btn primary" data-a="replay">Replay demo</button>
      <button class="btn" data-a="stop">Stop demo</button><button class="btn" data-a="poke">Poke Dango</button></div>`;
  panel.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
    if (a === "replay" || a === "stop") {
      token.stop = true;
      store.reset();
      island.close();
      token = { stop: false };
      if (a === "replay") runDemo(store, island, token);
    }
    if (a === "poke") { island.open(); setTimeout(() => island.poke(), 400); }
  });
  document.body.append(panel);
  // fake system/media/clipboard feeds so every widget can be seen without the app
  appearance({ theme: new URLSearchParams(location.search).get("theme") ?? "oled", opacity: 1 });
  const w = island.widgets;
  let pos = 42, vol = 40;
  w.setMedia({ title: "Late Night Drive", artist: "Perch Radio", app: "Spotify", playing: true, position: pos, duration: 215 });
  w.addClip("npm run tauri dev");
  w.addClip("https://github.com/tauri-apps/tauri");
  w.addClip("The island now shows media, timers, a shelf and your clipboard.");
  setInterval(() => {
    pos = (pos + 1) % 215;
    w.setMedia({ title: "Late Night Drive", artist: "Perch Radio", app: "Spotify", playing: true, position: pos, duration: 215 });
    w.setSys({ battery: 76, charging: false, cpu: 12 + Math.round(Math.random() * 20), ram: 58, volume: vol, muted: false, camera: [], mic: [] });
  }, 1000);
  setInterval(() => w.setLevel(Math.random() * 0.6), 66);
  (window as unknown as { perch: unknown }).perch = { island, store, volume: (v: number) => (vol = v) };
  island.onSettings = () => window.open("/settings.html", "_blank");
  island.onCodeMode = (on) => {
    token.stop = true;
    store.reset();
    token = { stop: false };
    if (on) runDemo(store, island, token);
  };
}
