// Scripted demo: two fake agent sessions sent through the real Store as Claude-style hook events.
// If nobody answers an approval or question within a few seconds, the demo answers it itself.
import type { Decision, HookEvent, Store } from "./store";
import type { Island } from "./island";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const A = { session_id: "demo-1", cwd: "C:\\code\\invoice-app" };
const B = { session_id: "demo-2", cwd: "C:\\code\\api-server", agent: "codex" };

/** `once`: play a single round (the tray's "Play the demo"); otherwise loop until token.stop. */
export function runDemo(store: Store, island: Island, token: { stop: boolean }, once = false) {
  const ev = (base: Partial<HookEvent>, hook_event_name: string, extra: Partial<HookEvent> = {}) =>
    store.event({ ...base, ...extra, hook_event_name } as HookEvent);
  const step = async (ms: number) => { await wait(ms); if (token.stop) throw new Error("stopped"); };
  const autopilot = async (p: Promise<Decision> | undefined, act: string, i?: number) => {
    const t = setTimeout(() => island.press(act, i), 5500);
    await p;
    clearTimeout(t);
  };

  return (async () => {
    while (!token.stop) {
      await step(1500);
      ev(A, "SessionStart");
      await step(1200);
      ev(A, "UserPromptSubmit", { prompt: "Charge the right tax for the buyer's region on every invoice" });
      await step(1600);
      ev(A, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "src/invoice.ts" } });
      await step(1200);
      ev(A, "PreToolUse", { tool_name: "Grep", tool_input: { pattern: "taxRate" } });
      await step(1200);
      island.press("open");
      await step(900);
      ev(A, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: "src/invoice.ts" } });
      await step(700);
      ev(A, "PostToolUse", { tool_name: "Edit", tool_input: {
        file_path: "src/invoice.ts",
        old_string: "export function total(items: Item[]) {\n  const rate = 0.2\n  return sum(items) * (1 + rate)\n}",
        new_string: "export function total(items: Item[], region: Region) {\n  const rate = taxRate(region)\n  const net = sum(items)\n  return round2(net * (1 + rate))\n}",
      } });
      await step(1400);
      ev(B, "SessionStart");
      ev(B, "UserPromptSubmit", { prompt: "Add tests for the /orders endpoint" });
      await step(1300);
      ev(A, "PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test -- invoice" } });
      await step(1500);
      await autopilot(ev(A, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm install tax-tables@2 --save" },
        permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm install:*" }], behavior: "allow", destination: "localSettings" }] }), "allow");
      await step(1100);
      ev(B, "PreToolUse", { tool_name: "Write", tool_input: { file_path: "tests/orders.test.ts" } });
      await step(900);
      await autopilot(ev(A, "PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [{
        header: "Rates", multiSelect: false, question: "Where should the regional rates come from?",
        options: [
          { label: "A JSON file in the repo", description: "simple, reviewed with the code" },
          { label: "The tax-tables package", description: "kept current for you" },
          { label: "An environment variable", description: "set per deployment" },
        ],
      }] } }), "opt", 1);
      await step(1200);
      island.press("diff-last");
      await step(3200);
      island.press("back");
      await step(1500);
      ev(A, "Stop", { last_assistant_message: "Invoices now use the buyer's regional rate from tax-tables. All 14 tests pass." });
      await step(6500);
      ev(B, "Stop", { last_assistant_message: "Added 6 tests for /orders. They all pass." });
      await step(6500);
      island.close();
      if (once) break;
      await step(3000);
    }
  })().catch(() => {});
}
