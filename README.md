# Event Auditor (prototype)

A working, dependency-free JSONL event logger + report generator for a
Copilot-style coding session, matching this schema:

```
{"event_type":"SESSION_STARTED","session_id":"...","timestamp":"..."}
{"event_type":"USER_PROMPT","session_id":"...","timestamp":"..."}
{"event_type":"LLM_CALL","session_id":"...","model":"...","input_tokens":1200,"output_tokens":430}
{"event_type":"TOOL_CALL","session_id":"...","tool_name":"terminal","latency_ms":842}
{"event_type":"FILE_CHANGE","session_id":"...","file_path":"src/auth.js","change_count":1,"changes":[{"range":{"start":{"line":4,"character":0},"end":{"line":4,"character":8}},"addedChars":20,"removedChars":8}]}
{"event_type":"SKILL_CALL","session_id":"...","skill_name":"code-review","skill_source":"explicit","success":true}
{"event_type":"TEST_RUN","session_id":"...","passed":18,"failed":0}
{"event_type":"SESSION_ENDED","session_id":"...","timestamp":"..."}
```

## Files

- `auditor.js` — `EventAuditor` class. Call its methods (`sessionStarted`,
   `userPrompt`, `llmCall`, `toolCall`, `fileChange`, `skillCall`, `testRun`,
   `sessionEnded`, `error`) and
  it appends a timestamped JSON line to a log file.
- `report.js` — reads a `.jsonl` log and prints total tokens, model switches,
  per-tool call counts/latency, test results, and session duration. Also
  usable as a library (`summarize(events)`) if you want the numbers, not text.
- `demo.js` — simulates a full session (prompts, a model switch, tool calls,
  a test run) with mock data, then prints the report. Run it with:

```bash
node demo.js
```

This is the "working model" — right now every number is mock data you (or
the demo) pass in explicitly.

## Wiring it to real events later

The event schema doesn't need to change. What changes is *who calls* the
`EventAuditor` methods. Realistically, for a Copilot/VS Code setup:

1. **`SESSION_STARTED` / `SESSION_ENDED`**
   Call these from your extension's `activate()`/`deactivate()`, or from a
   VS Code Chat Participant's session lifecycle if you build one
   (`vscode.chat.createChatParticipant`).

2. **`USER_PROMPT`**
   If you build a Chat Participant, its request handler receives the user's
   message directly — call `auditor.userPrompt(request.prompt)` there.
   Note: this only sees prompts sent to *your* `@auditor` participant, not
   Copilot's own built-in chat, since Copilot doesn't expose that stream to
   third-party extensions. To produce `LLM_CALL` records, send the request
   through `@auditor` rather than the built-in Copilot chat participant.

3. **`LLM_CALL`** (real token counts)
   Use VS Code's Language Model API (`vscode.lm.selectChatModels` +
   `model.sendRequest`) instead of calling a model directly. The response
   stream gives you the model id, and you can call `model.countTokens()`
   before/after to log real input/output token counts and latency.
   This only covers calls *you* make through this API — it can't observe
   Copilot's own internal calls to its model, which aren't exposed.

4. **`TOOL_CALL`** (real, and this one *can* observe Copilot itself)
   Register a **Language Model Tool** (`vscode.lm.registerTool` +
   a `languageModelTools` contribution in `package.json`). If the tool is
   enabled, Copilot itself can invoke it during a chat session. The included
   extension wraps every registered tool, records latency and success
   (including thrown failures), and writes the `TOOL_CALL` event automatically.
   This is the most realistic hook for "what got called."

5. **`TEST_RUN`**
   Hook into VS Code's Testing API (`vscode.tests`) or listen for a test
   task's completion (`vscode.tasks.onDidEndTaskProcess` on a "test" task)
   and log the pass/fail counts from there.

6. **Model switches**
   These fall out of `report.js` automatically once `LLM_CALL` events carry
   real model ids — no extra logic needed, it already diffs consecutive
   calls.

### The one hard limit worth knowing up front
Copilot's own internal orchestration (which model it picks, its own token
usage, its own tool-call decisions inside the base chat) isn't exposed to
third-party extensions today. The two things you *can* observe for real are
(a) calls you make yourself via `vscode.lm`, and (b) invocations of tools
*you* register that Copilot chooses to call. That's enough to build a
genuinely useful auditor — it just audits "the parts of the session that
touch your extension," not Copilot's black box.

## Extending the prototype now (no real APIs needed yet)

- `FILE_CHANGE` events are captured automatically by the VS Code extension.
   They include the workspace-relative file, changed ranges, added/removed
   character counts, line counts, and undo/redo reason when available. File
   contents are intentionally not stored.
- `SKILL_CALL` is available for integrations that explicitly know which skill
   ran. Copilot's internal skills and orchestration are not exposed to
   third-party extensions. The included skill tools automatically write both a
   `TOOL_CALL` and a linked `SKILL_CALL` event using the same `call_id`.
- The extension includes three auditable skills that can be referenced by
   Copilot: `checkAuditLog`, `summarizeFileChanges`, and `renderAuditReport`.
   Each returns rendered text and records a `SKILL_CALL` event with its result
   metadata. Run `node demo.js` to exercise the same event path with mock data.
- `AGENT_CALL` records invocations of the extension's `@auditor` participant.
   Copilot's internal agents remain unavailable to third-party extensions.
- Point multiple sessions at the same log file (or separate files per
  session) — `report.js` already groups by nothing but you could easily
  filter by `session_id` in `loadEvents()` if you want a multi-session view.
- Swap `demo.js` for a small CLI harness that reads a script of "fake events"
  from a JSON file, if you want to test different session shapes without
  editing code.
