// One spring for every morph in Perch: damping ratio 0.82 overshoots by about 1%, then settles. CSS gets it as
// `--spring` (a linear() easing sampled from the real spring) with `--spring-ms`, so size, radius, colour, sliding
// highlights and switches all move with the same physics.

const ZETA = 0.82;
export const SPRING_MS = 520;

/** linear() easing sampled from a damped spring, cut where it's within 0.5% of rest. */
export function springEasing(zeta = ZETA, steps = 36): string {
  const wd = Math.sqrt(1 - zeta * zeta);
  const end = Math.log(200) / zeta; // e^(-ζt) = 0.5%
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * end;
    const x = i === steps ? 1 : 1 - Math.exp(-zeta * t) * (Math.cos(wd * t) + (zeta / wd) * Math.sin(wd * t));
    pts.push(x.toFixed(4));
  }
  return `linear(${pts.join(", ")})`;
}

export function installSpring() {
  const root = document.documentElement.style;
  root.setProperty("--spring", springEasing());
  root.setProperty("--spring-ms", `${SPRING_MS}ms`);
}

const lastInk = new Map<string, { x: number; y: number; w: number; h: number }>();

/** Slide a group's highlight (a `.ink` behind the selected child) from where it was to the selected item, even when
 *  the group was just re-rendered. The group must be position: relative. */
export function glide(group: HTMLElement | null, key: string) {
  if (!group) return;
  const on = group.querySelector<HTMLElement>(':scope > [aria-selected="true"], :scope > [aria-checked="true"]');
  let ink = group.querySelector<HTMLElement>(":scope > .ink");
  if (!ink) {
    ink = document.createElement("i");
    ink.className = "ink";
    ink.setAttribute("aria-hidden", "true");
    group.prepend(ink);
  }
  if (!on) { ink.style.opacity = "0"; lastInk.delete(key); return; }
  const to = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
  const put = (r: typeof to) => {
    ink!.style.transform = `translate(${r.x}px, ${r.y}px)`;
    ink!.style.width = `${r.w}px`;
    ink!.style.height = `${r.h}px`;
  };
  const from = lastInk.get(key);
  ink.style.opacity = "1";
  if (from) {
    ink.style.transition = "none";
    put(from);
    void ink.offsetWidth; // commit the old position, then spring to the new one
    ink.style.transition = "";
  }
  put(to);
  lastInk.set(key, to);
}
