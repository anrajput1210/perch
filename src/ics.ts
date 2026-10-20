// Minimal iCal reader for meeting alerts: upcoming events from a Google/Outlook "secret iCal" feed.
// Handles line folding, UTC / floating / TZID times (TZID is read as local time), all-day dates, EXDATE and
// DAILY/WEEKLY RRULEs with INTERVAL, BYDAY, UNTIL and COUNT.
// ponytail: TZID times are treated as this computer's zone and MONTHLY/YEARLY rules are skipped; use a real iCal
// library if meetings across time zones or monthly series show up wrong.

export interface CalEvent { title: string; start: Date; end: Date; allDay: boolean; join?: string; location?: string }

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const JOIN = /https:\/\/[^\s"<>\\]*(zoom\.us\/j|meet\.google\.com|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com|webex\.com|whereby\.com|around\.co)[^\s"<>\\]*/i;

function parseTime(v: string, params: string): { d: Date; allDay: boolean } {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return { d: new Date(NaN), allDay: false };
  const [, y, mo, d, h = "0", mi = "0", s = "0", z] = m;
  const n = [+y, +mo - 1, +d, +h, +mi, +s] as const;
  const allDay = params.includes("VALUE=DATE") || m[4] === undefined;
  return { d: z ? new Date(Date.UTC(...n)) : new Date(...n), allDay };
}

const unescape = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

/** Events overlapping [from, to), sorted by start. */
export function upcoming(ics: string, from: Date, to: Date): CalEvent[] {
  const lines = ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: CalEvent[] = [];
  let ev: Record<string, { v: string; p: string }[]> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { ev = {}; continue; }
    if (line === "END:VEVENT" && ev) { expand(ev, from, to, out); ev = null; continue; }
    if (!ev) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(";");
    (ev[name.toUpperCase()] ??= []).push({ v: line.slice(i + 1), p: params.join(";").toUpperCase() });
  }
  return out.sort((a, b) => +a.start - +b.start);
}

function expand(ev: Record<string, { v: string; p: string }[]>, from: Date, to: Date, out: CalEvent[]) {
  const get = (k: string) => ev[k]?.[0];
  const ds = get("DTSTART");
  if (!ds || get("STATUS")?.v === "CANCELLED") return;
  const { d: start, allDay } = parseTime(ds.v, ds.p);
  if (isNaN(+start)) return;
  const de = get("DTEND");
  const end = de ? parseTime(de.v, de.p).d : new Date(+start + (allDay ? 86_400_000 : 3_600_000));
  const len = +end - +start;
  const text = [get("URL")?.v, get("LOCATION")?.v, get("DESCRIPTION")?.v].filter(Boolean).map((s) => unescape(s!)).join(" ");
  const base = { title: unescape(get("SUMMARY")?.v ?? "Busy"), allDay, join: text.match(JOIN)?.[0], location: get("LOCATION") && unescape(get("LOCATION")!.v) };
  const skip = new Set((ev.EXDATE ?? []).flatMap((x) => x.v.split(",").map((v) => +parseTime(v, x.p).d)));
  const add = (s: Date) => {
    if (!skip.has(+s) && +s < +to && +s + len > +from) out.push({ ...base, start: s, end: new Date(+s + len) });
  };

  const rule = Object.fromEntries((get("RRULE")?.v ?? "").split(";").filter(Boolean).map((kv) => kv.split("=")));
  if (rule.FREQ !== "DAILY" && rule.FREQ !== "WEEKLY") return add(start);
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1));
  const until = rule.UNTIL ? parseTime(rule.UNTIL, "").d : null;
  const byday = rule.BYDAY ? (rule.BYDAY as string).split(",").map((d) => DAYS.indexOf(d.slice(-2))) : [start.getDay()];
  let count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  // walk day by day from DTSTART (keeps the wall-clock time across DST changes) until past the window
  const day = new Date(start);
  const weekStart = new Date(start); weekStart.setDate(start.getDate() - start.getDay());
  for (let n = 0; n < 3660 && count > 0 && +day < +to; n++, day.setDate(day.getDate() + 1)) {
    if (until && +day > +until) break;
    const weeks = Math.floor(Math.round((+day - +weekStart) / 86_400_000) / 7);
    const hit = rule.FREQ === "DAILY" ? n % interval === 0 : weeks % interval === 0 && byday.includes(day.getDay());
    if (!hit) continue;
    count--;
    add(new Date(day));
  }
}
