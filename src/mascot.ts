// Dango: Perch's mascot. A soft round dumpling with a two-leaf sprout that takes the colour of its state.
// Procedural Canvas 2D, one instance per canvas. Colours come from tokens.css.

export type MascotState =
  | "idle" | "working" | "thinking" | "approval" | "question"
  | "error" | "finished" | "ratelimit" | "sleeping" | "dizzy";
export type Emote = "annoyed" | "surprised" | "happy" | "love" | null;

// Token lookups are cached: getComputedStyle per draw call forces style recalcs and janks scrolling.
const tokenCache = new Map<string, string>();
const css = (name: string) => {
  let v = tokenCache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    tokenCache.set(name, v);
  }
  return v;
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (k: number) => 1 - Math.pow(1 - k, 3);

export class Dango {
  state: MascotState = "idle";
  tint: string | null = null; // agent colour for mini mascots
  private ctx: CanvasRenderingContext2D;
  private size = 0;
  private look = { x: 0, y: 0 };
  private lookTarget = { x: 0, y: 0 };
  private blinkAt = 0;
  private blinkT = -1;
  private squashT = -1;
  private stateSince = 0;
  private emote: Emote = null;
  private emoteUntil = 0;
  private raf = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    this.scheduleBlink(performance.now());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.size = this.canvas.clientWidth || this.canvas.width;
    this.canvas.width = Math.round(this.size * dpr);
    this.canvas.height = Math.round(this.size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setState(s: MascotState) {
    if (s !== this.state) { this.state = s; this.stateSince = performance.now(); }
  }

  /** Point to look at, in -1..1 units relative to the mascot (screen-space cursor mapped by the caller). */
  lookAt(x: number, y: number) { this.lookTarget = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) }; }

  poke() { this.squashT = performance.now(); this.showEmote("annoyed", 800); }

  showEmote(e: Emote, ms: number) { this.emote = e; this.emoteUntil = performance.now() + ms; }

  start() { const loop = (t: number) => { this.draw(t); this.raf = requestAnimationFrame(loop); }; this.raf = requestAnimationFrame(loop); }
  stop() { cancelAnimationFrame(this.raf); }

  private scheduleBlink(now: number) { this.blinkAt = now + 2000 + Math.random() * 3500; }

  draw(now: number) {
    const { ctx, size: S } = this;
    ctx.clearRect(0, 0, S, S);
    const R = S * 0.3;
    const age = (now - this.stateSince) / 1000;
    if (this.emote && now > this.emoteUntil) this.emote = null;

    // look follows target with lag; some states override it
    let tx = this.lookTarget.x, ty = this.lookTarget.y;
    if (this.state === "thinking") { tx = 0.6; ty = -0.7; }
    if (this.state === "working") { tx = Math.sin(now / 900) * 0.5; ty = 0.2; }
    this.look.x += (tx - this.look.x) * 0.12;
    this.look.y += (ty - this.look.y) * 0.12;

    // blink
    if (now >= this.blinkAt && this.blinkT < 0) this.blinkT = now;
    let blink = 1;
    if (this.blinkT >= 0) {
      const k = (now - this.blinkT) / 140;
      blink = k < 1 ? Math.abs(1 - 2 * k) : 1;
      if (k >= 1) { this.blinkT = -1; this.scheduleBlink(now); if (Math.random() < 0.2) this.blinkAt = now + 120; }
    }

    // body motion
    let bob = Math.sin(now / 700) * R * 0.025; // breathing
    let sx = 1 + Math.sin(now / 700) * 0.015, sy = 1 - Math.sin(now / 700) * 0.015;
    let rot = 0, shakeX = 0;
    if (this.state === "approval") bob -= Math.abs(Math.sin(now / 260)) * R * 0.14;
    if (this.state === "question") rot = 0.16;
    if (this.state === "error" && age < 0.5) shakeX = Math.sin(age * 60) * R * 0.08 * (1 - age / 0.5);
    if (this.state === "finished" && age < 0.9) { rot = ease(age / 0.9) * Math.PI * 2; bob -= Math.sin((age / 0.9) * Math.PI) * R * 0.3; }
    if (this.state === "dizzy") rot = Math.sin(now / 160) * 0.18;
    if (this.squashT >= 0) {
      const k = (now - this.squashT) / 380;
      if (k < 1) { const q = Math.sin(k * Math.PI) * (1 - k); sx += q * 0.35; sy -= q * 0.3; } else this.squashT = -1;
    }

    const cx = S / 2 + shakeX, cy = S * 0.56 + bob;
    const stateColor = this.tint ?? css(`--c-state-${this.state}`);

    // glow
    const g = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, R * 1.6);
    g.addColorStop(0, hexA(stateColor, this.state === "idle" ? 0.12 : 0.35));
    g.addColorStop(1, hexA(stateColor, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(sx, sy);

    this.drawSprout(R, now, stateColor);

    // body: slightly squat round dumpling with a flat-ish bottom
    ctx.beginPath();
    ctx.moveTo(-R, 0);
    ctx.bezierCurveTo(-R, -R * 1.05, R, -R * 1.05, R, 0);
    ctx.bezierCurveTo(R, R * 0.82, -R, R * 0.82, -R, 0);
    const body = ctx.createLinearGradient(0, -R, 0, R * 0.7);
    body.addColorStop(0, css("--c-mascot-body-top"));
    body.addColorStop(1, this.tint ? mix(css("--c-mascot-body-bottom"), this.tint, 0.45) : css("--c-mascot-body-bottom"));
    ctx.fillStyle = body;
    ctx.fill();
    // soft highlight
    ctx.beginPath();
    ctx.ellipse(-R * 0.38, -R * 0.42, R * 0.28, R * 0.14, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.fill();

    this.drawFace(R, blink, now);
    ctx.restore();

    this.drawExtras(cx, cy, R, now, stateColor);
  }

  private drawSprout(R: number, now: number, color: string) {
    const { ctx } = this;
    const droop = this.state === "error" || this.state === "sleeping" || this.state === "ratelimit" ? 0.9 : 0;
    const perk = this.state === "approval" ? -0.25 : 0;
    const sway = Math.sin(now / 600) * 0.12 + perk;
    ctx.save();
    ctx.translate(0, -R * 0.78);
    ctx.rotate(sway);
    ctx.strokeStyle = css("--c-mascot-sprout");
    ctx.lineWidth = R * 0.07;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(R * 0.04, -R * 0.2, 0, -R * 0.32);
    ctx.stroke();
    ctx.fillStyle = this.state === "idle" ? css("--c-mascot-sprout") : color;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(0, -R * 0.3);
      ctx.rotate(side * (0.9 + droop) );
      ctx.beginPath();
      ctx.ellipse(0, -R * 0.16, R * 0.09, R * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  private drawFace(R: number, blink: number, now: number) {
    const { ctx } = this;
    const ink = css("--c-mascot-ink");
    const fx = this.look.x * R * 0.22, fy = this.look.y * R * 0.16;
    const ex = R * 0.34, ey = -R * 0.08 + fy;
    const emote = this.emote;
    const s = this.state;

    // blush
    ctx.fillStyle = hexA(css("--c-mascot-blush"), emote === "love" || emote === "happy" ? 0.85 : 0.5);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * R * 0.56 + fx * 0.6, R * 0.16 + fy * 0.5, R * 0.13, R * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.lineCap = "round";
    ctx.lineWidth = R * 0.07;
    for (const side of [-1, 1]) {
      const x = side * ex + fx, y = ey;
      if (s === "dizzy") { spiral(ctx, x, y, R * 0.12, now / 120 * side); continue; }
      if (emote === "love") { heart(ctx, x, y, R * 0.13, css("--c-state-error")); ctx.fillStyle = ink; continue; }
      if (s === "sleeping" || emote === "happy" || s === "finished") {
        ctx.beginPath();
        const up = s === "sleeping" ? 1 : -1; // sleeping: closed arcs down, happy: ^ arcs
        ctx.arc(x, y + up * -R * 0.02, R * 0.09, up > 0 ? 0 : Math.PI, up > 0 ? Math.PI : Math.PI * 2);
        ctx.stroke();
        continue;
      }
      if (emote === "annoyed" || s === "error") {
        ctx.beginPath();
        ctx.moveTo(x - R * 0.1, y - side * R * 0.03 * (emote === "annoyed" ? -1 : 1));
        ctx.lineTo(x + R * 0.1, y + side * R * 0.03 * (emote === "annoyed" ? -1 : 1));
        ctx.stroke();
        continue;
      }
      const big = s === "approval" || emote === "surprised" ? 1.3 : 1;
      const tired = s === "ratelimit" ? 0.55 : 1;
      ctx.beginPath();
      ctx.ellipse(x, y, R * 0.075 * big, R * 0.11 * big * blink * tired, 0, 0, Math.PI * 2);
      ctx.fill();
      if (blink > 0.5) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x + R * 0.025, y - R * 0.04 * big, R * 0.025 * big, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = ink;
      }
    }

    // mouth
    ctx.lineWidth = R * 0.05;
    ctx.beginPath();
    const my = R * 0.14 + fy * 0.6, mx = fx * 0.8;
    if (s === "approval" || emote === "surprised" || s === "dizzy") {
      ctx.ellipse(mx, my + R * 0.02, R * 0.05, R * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (s === "error" || emote === "annoyed" || s === "ratelimit") {
      ctx.moveTo(mx - R * 0.07, my + R * 0.03);
      ctx.quadraticCurveTo(mx, my - R * 0.03, mx + R * 0.07, my + R * 0.03);
      ctx.stroke();
    } else {
      // little "w"
      ctx.moveTo(mx - R * 0.08, my);
      ctx.quadraticCurveTo(mx - R * 0.04, my + R * 0.06, mx, my);
      ctx.quadraticCurveTo(mx + R * 0.04, my + R * 0.06, mx + R * 0.08, my);
      ctx.stroke();
    }
  }

  private drawExtras(cx: number, cy: number, R: number, now: number, color: string) {
    const { ctx } = this;
    const s = this.state;
    // badge
    const glyph = s === "approval" ? "!" : s === "question" ? "?" : s === "working" || s === "thinking" ? "dots" : null;
    if (glyph) {
      const bx = cx + R * 0.82, by = cy - R * 0.7, br = R * 0.24;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = css("--c-on-accent");
      if (glyph === "dots") {
        for (let i = -1; i <= 1; i++) {
          const a = 0.4 + 0.6 * Math.max(0, Math.sin(now / 180 - i));
          ctx.globalAlpha = a;
          ctx.beginPath(); ctx.arc(bx + i * br * 0.42, by, br * 0.14, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.font = `700 ${br * 1.3}px ${css("--font-sans")}`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(glyph, bx, by + br * 0.05);
      }
    }
    // sleeping z's
    if (s === "sleeping") {
      ctx.fillStyle = css("--c-text-muted");
      for (let i = 0; i < 2; i++) {
        const k = ((now / 1600 + i * 0.5) % 1);
        ctx.globalAlpha = 1 - k;
        ctx.font = `600 ${R * (0.22 + k * 0.15)}px ${css("--font-sans")}`;
        ctx.fillText("z", cx + R * (0.7 + k * 0.4), cy - R * (0.8 + k * 0.7));
      }
      ctx.globalAlpha = 1;
    }
    // sweat drop
    if (s === "ratelimit") {
      const k = (now / 1400) % 1;
      ctx.fillStyle = hexA(css("--c-state-working"), 1 - k);
      drop(ctx, cx - R * 0.85, cy - R * 0.5 + k * R * 0.4, R * 0.09);
    }
    // finished sparkles
    if (s === "finished") {
      const age = (now - this.stateSince) / 1000;
      if (age < 1.6) {
        ctx.fillStyle = hexA(color, 1 - age / 1.6);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2, d = R * (1 + age * 0.6);
          star(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, R * 0.08);
        }
      }
    }
  }
}

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function mix(a: string, b: string, k: number) {
  const p = (h: string) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(",")})`;
}
function spiral(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, turn: number) {
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const a = turn + (i / 40) * Math.PI * 4, d = (i / 40) * r;
    i ? ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d) : ctx.moveTo(x, y);
  }
  ctx.lineWidth = r * 0.3; ctx.stroke();
}
function heart(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + r);
  ctx.bezierCurveTo(x - r * 1.4, y, x - r * 0.6, y - r * 1.1, x, y - r * 0.35);
  ctx.bezierCurveTo(x + r * 0.6, y - r * 1.1, x + r * 1.4, y, x, y + r);
  ctx.fill();
}
function drop(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r * 1.6);
  ctx.quadraticCurveTo(x + r, y, x, y + r);
  ctx.quadraticCurveTo(x - r, y, x, y - r * 1.6);
  ctx.fill();
}
function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2, d = i % 2 ? r * 0.35 : r;
    i ? ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d) : ctx.moveTo(x + d, y);
  }
  ctx.closePath(); ctx.fill();
}
