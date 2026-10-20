// Session/alert state fed by agent hook events. In the browser preview the demo feeds it; in the app the Rust
// core will own this and send snapshots, with the same shapes.

export type SessionState = "idle" | "thinking" | "working" | "approval" | "question" | "error" | "finished" | "ratelimit";
export type DiffLine = { t: " " | "+" | "-"; s: string };
export interface Step { kind: "prompt" | "tool" | "diff"; label: string; added?: number; removed?: number; diff?: DiffLine[]; at: number }
export interface Session { id: string; agent: string; name: string; state: SessionState; steps: Step[]; color: string; lastMessage?: string }
export interface Option { label: string; description?: string }
export interface Question { header?: string; question: string; multiSelect: boolean; options: Option[] }
export type Alert =
  | { id: number; sessionId: string; ref?: number; kind: "permission"; tool: string; detail: string; always: boolean }
  | { id: number; sessionId: string; ref?: number; kind: "question"; questions: Question[] };
export type Decision = { kind: "allow" | "deny" | "always" | "terminal" } | { kind: "answer"; answers: string[][] };
export interface HookEvent {
  hook_event_name: string; session_id: string; agent?: string; cwd?: string; prompt?: string;
  tool_name?: string; tool_input?: Record<string, unknown>; last_assistant_message?: string;
  permission_suggestions?: unknown[];
}
export interface Snapshot { sessions: Session[]; alerts: Alert[] }

const PALETTE = ["#4aa3ff", "#c792ea", "#5fd3a6", "#ffb86b", "#ff8fc7", "#7dd3fc"];
const basename = (p = "") => p.split(/[\\/]/).filter(Boolean).pop() ?? "session";
const firstLine = (s = "") => s.split("\n").map((l) => l.replace(/[#*_`>]/g, "").trim()).find(Boolean) ?? "";

// Gemini CLI's tool names, mapped to the Claude Code tools with the same inputs.
const GEMINI_TOOLS: Record<string, string> = {
  run_shell_command: "Bash", replace: "Edit", write_file: "Write", read_file: "Read",
  glob: "Glob", search_file_content: "Grep", web_fetch: "WebFetch",
};

export function toolLabel(tool: string, input: Record<string, unknown> = {}): string {
  if (tool === "Bash") return `Bash ${String(input.command ?? "").split("\n")[0]}`.trim();
  const target = String(input.file_path ?? input.pattern ?? input.url ?? "");
  return `${tool} ${target.split(/[\\/]/).pop()}`.trim();
}

// ponytail: trims the common prefix/suffix instead of a real LCS; Edit's old/new strings are small
export function lineDiff(oldS: string, newS: string): DiffLine[] {
  const a = oldS ? oldS.split("\n") : [], b = newS ? newS.split("\n") : [];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return [
    ...a.slice(0, p).map((x) => ({ t: " " as const, s: x })),
    ...a.slice(p, a.length - s).map((x) => ({ t: "-" as const, s: x })),
    ...b.slice(p, b.length - s).map((x) => ({ t: "+" as const, s: x })),
    ...a.slice(a.length - s).map((x) => ({ t: " " as const, s: x })),
  ];
}

export class Store {
  private sessions = new Map<string, Session>();
  private alerts: Alert[] = [];
  private waiters = new Map<number, (d: Decision) => void>();
  private nextId = 1;
  private colorIx = 0;
  private listeners = new Set<(s: Snapshot) => void>();

  subscribe(fn: (s: Snapshot) => void) { this.listeners.add(fn); fn(this.snapshot()); }
  snapshot(): Snapshot { return { sessions: [...this.sessions.values()], alerts: [...this.alerts] }; }
  private emit() { const s = this.snapshot(); this.listeners.forEach((f) => f(s)); }

  reset() {
    for (const id of [...this.sessions.keys()]) this.remove(id);
    this.colorIx = 0;
  }

  private session(ev: HookEvent): Session {
    let s = this.sessions.get(ev.session_id);
    if (!s) {
      s = { id: ev.session_id, agent: ev.agent ?? "claude", name: basename(ev.cwd), state: "idle", steps: [],
            color: PALETTE[this.colorIx++ % PALETTE.length] };
      this.sessions.set(s.id, s);
    }
    return s;
  }

  private push(s: Session, step: Omit<Step, "at">) {
    s.steps.push({ ...step, at: Date.now() });
    if (s.steps.length > 50) s.steps.shift();
  }

  /** Feed one hook event. Blocking events (permission, question) return the user's decision.
   *  `ref` ties the alert to the waiting hook connection so cancelRef can drop it. */
  event(ev: HookEvent, ref?: number): Promise<Decision> | undefined {
    const name = ev.hook_event_name;
    if (ev.tool_name) ev = { ...ev, tool_name: GEMINI_TOOLS[ev.tool_name] ?? ev.tool_name };
    if (name === "SessionEnd") { this.remove(ev.session_id); return; }
    const s = this.session(ev);
    const input = ev.tool_input ?? {};
    switch (name) {
      case "SessionStart": s.state = "idle"; break;
      case "UserPromptSubmit": s.state = "thinking"; this.push(s, { kind: "prompt", label: firstLine(ev.prompt) }); break;
      case "PreToolUse":
        if (ev.tool_name === "AskUserQuestion") {
          s.state = "question";
          return this.ask(s, { kind: "question", questions: (input.questions ?? []) as Question[] }, ref);
        }
        s.state = "working";
        this.push(s, { kind: "tool", label: toolLabel(ev.tool_name ?? "Tool", input) });
        break;
      case "PostToolUse":
        if (["Edit", "MultiEdit", "Write"].includes(ev.tool_name ?? "")) {
          const diff = lineDiff(String(input.old_string ?? ""), String(input.new_string ?? input.content ?? ""));
          const step: Step = { kind: "diff", label: toolLabel(ev.tool_name!, input), diff, at: Date.now(),
            added: diff.filter((l) => l.t === "+").length, removed: diff.filter((l) => l.t === "-").length };
          const last = s.steps[s.steps.length - 1];
          if (last?.kind === "tool" && last.label === step.label) s.steps[s.steps.length - 1] = step;
          else this.push(s, step);
        }
        s.state = "working";
        break;
      case "PermissionRequest": {
        s.state = "approval";
        const detail = String(input.command ?? input.file_path ?? input.url ?? JSON.stringify(input));
        return this.ask(s, { kind: "permission", tool: ev.tool_name ?? "Tool", detail, always: !!ev.permission_suggestions?.length }, ref);
      }
      case "Stop":
        s.state = "finished";
        s.lastMessage = firstLine(ev.last_assistant_message);
        setTimeout(() => { if (this.sessions.get(s.id)?.state === "finished") this.remove(s.id); }, 5200);
        break;
      case "StopFailure": s.state = "error"; break;
    }
    this.emit();
  }

  private ask(s: Session, a: { kind: "permission"; tool: string; detail: string; always: boolean } | { kind: "question"; questions: Question[] }, ref?: number) {
    const id = this.nextId++;
    this.alerts.push({ ...a, id, ref, sessionId: s.id } as Alert);
    this.emit();
    return new Promise<Decision>((res) => this.waiters.set(id, res));
  }

  /** Answer an alert. A stale id (already answered, session gone) is ignored. */
  decide(id: number, d: Decision) {
    const w = this.waiters.get(id);
    if (!w) return;
    this.waiters.delete(id);
    const a = this.alerts.find((x) => x.id === id)!;
    this.alerts = this.alerts.filter((x) => x.id !== id);
    const s = this.sessions.get(a.sessionId);
    if (s) s.state = d.kind === "deny" ? "idle" : "working";
    this.emit();
    w(d);
  }

  /** The agent stopped waiting (answered in the terminal, timed out, cancelled): drop its card. */
  cancelRef(ref: number) {
    const a = this.alerts.find((x) => x.ref === ref);
    if (a) this.decide(a.id, { kind: "terminal" });
  }

  remove(id: string) {
    this.sessions.delete(id);
    for (const a of this.alerts.filter((x) => x.sessionId === id)) {
      this.waiters.get(a.id)?.({ kind: "terminal" });
      this.waiters.delete(a.id);
    }
    this.alerts = this.alerts.filter((x) => x.sessionId !== id);
    this.emit();
  }
}
