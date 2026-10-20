// What perch-hook prints back to the agent for a blocking event. Empty string = no decision: the agent asks in
// its terminal as usual. Formats: Claude Code hooks docs (PermissionRequest decision; PreToolUse + updatedInput
// with `answers` for AskUserQuestion).
import type { Decision, HookEvent, Question } from "./store";

export type BlockingEvent = HookEvent & { permission_suggestions?: unknown[] };

export function hookReply(ev: BlockingEvent, d: Decision): string {
  if (d.kind === "terminal") return "";
  if (ev.hook_event_name === "PermissionRequest") {
    const decision =
      d.kind === "deny" ? { behavior: "deny", message: "Denied from Perch." }
      : d.kind === "always" && ev.permission_suggestions?.length
        ? { behavior: "allow", updatedPermissions: ev.permission_suggestions }
        : { behavior: "allow" };
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  }
  if (ev.hook_event_name === "PreToolUse" && ev.tool_name === "AskUserQuestion" && d.kind === "answer") {
    const questions = (ev.tool_input?.questions ?? []) as Question[];
    const answers = Object.fromEntries(questions.map((q, i) => [q.question, (d.answers[i] ?? []).join(", ")]));
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...ev.tool_input, answers } },
    });
  }
  return "";
}
