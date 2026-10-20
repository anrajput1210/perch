// Self-check for the hook reply formats and the store's alert flow. Run: node scripts/check.ts
import assert from "node:assert/strict";
import { Store, lineDiff, toolLabel } from "../src/store.ts";
import { hookReply } from "../src/reply.ts";
import { upcoming } from "../src/ics.ts";

const perm = { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Bash", tool_input: { command: "rm -rf dist" },
  permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf dist" }], behavior: "allow", destination: "localSettings" }] };
assert.deepEqual(JSON.parse(hookReply(perm, { kind: "allow" })), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
assert.equal(JSON.parse(hookReply(perm, { kind: "deny" })).hookSpecificOutput.decision.behavior, "deny");
assert.deepEqual(JSON.parse(hookReply(perm, { kind: "always" })).hookSpecificOutput.decision.updatedPermissions, perm.permission_suggestions);
assert.equal(hookReply(perm, { kind: "terminal" }), "");

const qs = [{ question: "Which?", header: "H", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }];
const ask = { hook_event_name: "PreToolUse", session_id: "s", tool_name: "AskUserQuestion", tool_input: { questions: qs } };
const out = JSON.parse(hookReply(ask, { kind: "answer", answers: [["A", "B"]] })).hookSpecificOutput;
assert.equal(out.permissionDecision, "allow");
assert.deepEqual(out.updatedInput, { questions: qs, answers: { "Which?": "A, B" } });

assert.equal(toolLabel("Edit", { file_path: "C:\\x\\src\\a.ts" }), "Edit a.ts");
assert.deepEqual(lineDiff("a\nb\nc", "a\nB\nc").map((l) => l.t).join(""), " -+ ");

// store: queue order, stale decisions ignored, cancel drops the card
const s = new Store();
const p1 = s.event(perm, 11)!;
const p2 = s.event({ ...perm, session_id: "t" }, 12)!;
const [a1, a2] = s.snapshot().alerts;
assert.equal(a1.ref, 11);
s.decide(a1.id, { kind: "allow" });
s.decide(a1.id, { kind: "deny" }); // stale, ignored
assert.equal((await p1).kind, "allow");
s.cancelRef(12);
assert.equal((await p2).kind, "terminal");
assert.equal(s.snapshot().alerts.length, 0);
assert.ok(a2);
assert.equal(a1.kind === "permission" && a1.always, true); // suggestions present -> "Always allow" offered
s.event({ ...perm, session_id: "g", permission_suggestions: [] }, 13);
const g = s.snapshot().alerts[0];
assert.equal(g.kind === "permission" && g.always, false);
s.event({ hook_event_name: "PreToolUse", session_id: "g", tool_name: "run_shell_command", tool_input: { command: "ls" } });
assert.equal(s.snapshot().sessions.find((x) => x.id === "g")!.steps.at(-1)!.label, "Bash ls");
// iCal: weekly series (Mon+Wed, one Wednesday cancelled), UTC one-off with a Meet link in a folded line, all-day
const ics = [
  "BEGIN:VCALENDAR", "BEGIN:VEVENT", "SUMMARY:Standup", "DTSTART;TZID=Europe/London:20261005T093000", "DTEND;TZID=Europe/London:20261005T094500",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "EXDATE;TZID=Europe/London:20261021T093000", "END:VEVENT",
  "BEGIN:VEVENT", "SUMMARY:Design review", "DTSTART:20261020T150000Z", "DTEND:20261020T160000Z",
  "DESCRIPTION:Join: https://meet.google", " .com/abc-defg-hij", "END:VEVENT",
  "BEGIN:VEVENT", "SUMMARY:Holiday", "DTSTART;VALUE=DATE:20261023", "END:VEVENT", "END:VCALENDAR",
].join("\r\n");
const evs = upcoming(ics, new Date(2026, 9, 19), new Date(2026, 9, 26));
assert.deepEqual(evs.map((e) => `${e.title} ${e.start.getDate()}`), ["Standup 19", "Design review 20", "Holiday 23"]);
assert.equal(evs[1].join, "https://meet.google.com/abc-defg-hij");
assert.equal(evs[0].start.getHours(), 9);
assert.ok(evs[2].allDay);

console.log("check: ok");
process.exit(0); // Stop's removal timer would otherwise keep node alive
