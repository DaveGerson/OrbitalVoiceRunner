# Chunk 4 — Status Detection, Monitoring, Attention & Proactive Alerts — Simplicity & Clarity

**Score: 6/10** — The pure cores (`statusMachine.decideStatus`, `notificationStack`, the `statusProbe` parsers) are clean, well-factored, and a pleasure to read. The drag is the server-side glue: `handlePlansTrigger` is a deeply-nested ~150-line function, and the "push an AttentionItem + prune + broadcast" boilerplate is copy-pasted 4+ times verbatim with hand-rolled random ids each time.

## Findings

- `server.ts:364-513` `handlePlansTrigger` — The single biggest readability problem in this chunk: ~150 lines, nested `for → if running → if step matches → if expected transition → if next step exists → (4-way branch)`, reaching 6-7 indentation levels. The four branches (no-next-term / no-gate / gated-dispatch / completed) plus the error/exit branch each do their own attention-push + broadcast + announce. Extracting `advanceToNextStep(plan)` and a `pausePlan(plan, reason)` helper would flatten this dramatically.
- AttentionItem push boilerplate duplicated 4x verbatim: `server.ts:389-400`, `414-425`, `482-493`, `573-587`. Each hand-rolls `const itemID = "att_" + Math.random().toString(36).substring(2, 11)`, builds the same 7-field object literal (`id,type,terminalId,projectId,message,timestamp,dismissed`), calls `pruneAttention()`, then `broadcast({type:"attention_updated", queue: manager.attentionQueue})`. One `pushAttention({type, terminalId, message})` helper removes ~30 lines and the four copies of the random-id idiom.
- `server.ts:339-361` / `364-513` — `handleWatchRulesTrigger` and `handlePlansTrigger` both follow the same `let changed=false; for(...) {...changed=true} if(changed){ ledger.save(true); broadcast(...) }` shape and both call the private `ledger["save"](true)` via bracket access (reaching past `private`). The bracket-access into a private method (also at L510) is a smell that suggests `save` should be public or there should be a `commitLedger()` wrapper.
- `server.ts:515-597` `detectAndTriggerTransitions` — Reasonably clear. The build-failed / error keyword lists (L524-540) are long inline `lower.includes(...)` chains; moving them to named arrays (`BUILD_FAILED_MARKERS`, `ERROR_MARKERS`) in `statusConstants.ts` alongside `SHELL_PROMPT` would make the classifier data-driven and testable, and matches how the rest of the chunk pulls constants from there.
- `src/App.tsx` — `attentionQueue.filter(item => !item.dismissed)` is recomputed inline ~6+ times (L574, L595, L1730, L1781, L2329, L2367-2369). A single `const unreadAttention = useMemo(...)` (or derived value) would remove the repetition and the risk of the filter predicate drifting between call sites.
- `src/App.tsx:573-591` `handleTriggerSpokenDigest` — Self-contained and readable; the digest-string assembly is fine.
- `src/App.tsx:594-603` and `660-690` — Two separate `useEffect`s diff terminals/attention to drive earcons and `recentlyIdled`. Each keeps its own `prev...Ref` mirror; this manual prev-state diffing pattern recurs and is the kind of thing the `eventBus` was introduced to replace, but here it is acceptable and clear.
- `src/statusMachine.ts` — Clean pure reducer with small named helper constructors (`setRunning`/`setIdle`/`armIdleOnce`/`NO_CHANGE`). `DecideInputs.runtimeType` and `.recentTail` are documented as retained-but-unused on the contract (L30-40) — minor dead surface that could be dropped, but the comments are honest about it.
- `src/notificationStack.ts` / `src/statusProbe.ts` (parsers) — Well-factored; the probe parsers each reduce to a pure `parse*` + a shared `descendantSet` tree-walk. No simplification needed.

## Top fixes
1. Extract `pushAttention({type, terminalId, message})` (with id + prune + broadcast inside) and replace the 4 duplicated AttentionItem blocks (`server.ts:389,414,482,573`).
2. Decompose `handlePlansTrigger` (`server.ts:364-513`) into `advanceToNextStep` + `pausePlan(reason)` to flatten the 6-7 level nesting.
3. Add a single `unreadAttention` derived value in App.tsx and replace the ~6 inline `!item.dismissed` filters.
4. Move the build-failed/error keyword lists (`server.ts:524-540`) into named arrays in `statusConstants.ts`.
5. Replace the `ledger["save"](true)` private-bracket access (`server.ts:359,510`) with a public `commitLedger()` helper.
