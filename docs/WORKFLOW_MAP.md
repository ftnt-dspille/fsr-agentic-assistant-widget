# agenticAssistant -- triage + build workflow map

Ground-truth map of how the agentic triage + build workflow actually works end-to-end, across the
three repos, reconstructed by reading the code (not from memory). This is the widget-side reference;
the durable design assessment + backlog live in the framework repo:

- Design review (seams + case-state proposal): `fsr-playbook-framework/docs/plans/AGENTIC_WORKFLOW_COHERENCE_REVIEW.md`
- Itemized bug backlog (§A-§H, §4.6/§4.7): `fsr-playbook-framework/docs/plans/AGENT_HARDENING_PLAN.md`
- Connector plan (resume-here TODOs): `ConnectorsV2/fsr-playbook-builder/PLAN.md`

Line numbers are point-in-time -- re-verify before editing.

---

## The three repos

| Repo | Role |
|------|------|
| `fsr_all_widgets` (this) | The **widget** -- thin chat front-end. `widget/view.controller.js`, `widget/view.html`, `widget/widgetAssets/js/{fsrPbAgent.service.js, fsrPbRender.js, contract.d.ts}` |
| `ConnectorsV2/fsr-playbook-builder/connector-fsr-agentic-assistant` | The **connector** -- chat ops, session storage, HITL, triage grounding (`operations.py`, `storage.py`, `fsr_soc_triage/`) |
| `fsr-playbook-framework/fsr_playbooks` | The **framework** (vendored into the connector via `scripts/build.sh`) -- agent loop, tool registry, guards, compiler/validator |

Wire contract: `fortisoar-widget-harness/FSR_PLAYBOOK_BUILDER_CONNECTOR_CONTRACT.md` (v2.x).

## The intended pipeline

```
record drawer ─▶ intent=triage ─▶ preflight: normalize → classify → scenario prompt   (per record)
                                   ─▶ guarded hunt loop: hunt-floor(3) · call-once · forbidden-pivot
                                   ─▶ records every run_op into a SkillTrace
                                   ─▶ emit_action_card  (HITL, tiered, HMAC-durable)
                                   ─▶ emit_playbook_offer
   accept ─▶ connector build_playbook_from_trace ─▶ compile_yaml ─▶ push_playbook   (model writes no YAML)
```

## Widget → connector calls

`widget/widgetAssets/js/fsrPbAgent.service.js` wraps `executeAction(cfg, <op>, payload)`:
- `chatTurn` → connector `chat_turn` -- a user message (blocking or detached ack, contract 2.7.0).
- `chatResume` → connector `chat_resume` -- resume a paused turn (approval / choice / card / offer).
- `respondManualInput`, `pushPlaybook` -- direct tool passthroughs.

Widget builds the payload in `view.controller.js`:
- Sends `intent: $scope.uiIntent` on every turn (`:1946`, `:3186`). `uiIntent = inPlaybookEditor ? 'build' : 'triage'` (`:203`), re-pinned to `'triage'` at `:2951`/`:3126`, flipped to `'build'` by the build-from-triage CTA (`:3083`, `:406`). **On a record drawer, every message is `intent='triage'`.**
- Resume routers: `_runResumeChoice` (`:1988`, capability-gap + choice cards), `_runResumeAction` (`:1998`, action cards), `_runResumeOffer` (`:2012`, playbook offers), `_runResumeManualInput` (`:2024`).

## Widget rendering of connector events

`widget/widgetAssets/js/fsrPbRender.js` `buildAssistantMessage(events)` maps connector event types to
cards. Event types seen: `text`, `tool_call`, `info_card`, `capability_gap`, `choice_card`,
`action_card`, `manual_input`, `playbook_offer`. Each `pb-step` wrapper is bare for cards that draw
their own box (`view.html:1468` `pb-step-bare` -- includes `capability_gap` after the recent fix).
- **Deploy button** renders from a `playbook_offer` card (`view.html:1056` `.playbook-offer-card`;
  `view.controller.js:953` accept / `:997` decline) OR a populated `$scope.currentYaml` (`:678`,
  toolbar push gated at `:1199` on `currentYaml && uiIntent!=='triage'`).

## Connector turn lifecycle

- `chat_turn` (`operations.py:1979`) → resolve intent (`_resolve_intent:1738`) → resolve system prompt
  (`_resolve_system_prompt:1814`) → tool slice (`_tools_for_intent:1789`) → `run_agent_turn`
  (`framework run_turn.py:194`), `MAX_TOOL_TURNS=16` (`_loop_helpers.py:166`).
- `chat_resume` (`operations.py:2385`): tier-3 approval / action-card execute / playbook-offer accept /
  generic conversational resume (`_resume_conversation:2971`).
- **Intent** = `triage|build` only (`:1664`); sticky per session (`set_session_intent:2076` / read on
  resume `:3011`); triage drops `_BUILD_ONLY_TOOLS` (`:1692`).

## Triage grounding (per record)

`fsr_soc_triage/triage_preflight.py:triage_preflight()` -- fetch record → backfill SIEM incident id →
`normalize → classify → scenario`. Produces a 3-layer prompt: static base (`system_prompt_triage.md`)
+ "what we know" record block + scenario block (`triage_scenarios.py`: `c2_exfil`, `device_down`,
`generic`). Runs on **every** triage turn today (no per-session reuse).

## Guards (framework `_loop_helpers.py:322` TriageDiscipline)

Instantiated **fresh per turn** inside the provider `stream()` (`anthropic_provider.py:312`) -- so
counters reset each turn:
- **hunt_floor** (`:384`) -- block `emit_action_card`/`find_containment_actions` until 3 investigation
  tools run. Counter `invest_attempts` -- **per-turn (in-memory), not persisted.**
- **call_once** (`:366`) -- block a repeated `find_*_actions` for the same target_type.
- **forbidden_pivot** (`:344`) -- block TI enrichment of an internal-only IP.
All return `ok:false` (render as `status=error`).

## Session state (connector `storage.py`)

Persisted: `session_conversation`, `session_intent`, `session_cards`, `session_trace` (SkillTrace),
`session_transcript`, `chat_turns`, `turn_progress`, `suspended_sessions` (HMAC-bound). **Not
persisted: guard counters, grounding, connector-availability.**

## Triage → build handoff

Triage records every `run_op` into a SkillTrace (`_session_trace_scope:1707`). On `emit_playbook_offer`
+ resume `decision=accept`, the **connector** (not model) calls `build_playbook_from_trace` → compile →
push (`_resume_playbook_offer_accept:2831`). The model never writes YAML on this path.

---

## Known seams (why it can feel "not intelligent") -- see the coherence review for the full analysis

1. **No persistent case state** -- grounding re-runs each turn, resume uses the static prompt, guard
   counters reset per turn → capability-gap click and follow-up commands ("block ip …") re-trigger a
   full triage. (§4.6, §4.7, §D)
2. **Intent is a 2-way page-pinned switch** -- a containment command inside triage re-triages; no
   per-turn "act vs investigate" notion.
3. **Two build-completion paths** -- the trace→offer→accept path deploys cleanly; a free-form "design a
   playbook" turn dead-ends in prose with **no deploy button** (`currentYaml` never set). (§A)
4. **Guards are error-shaped + ephemeral** -- steering reads as failure and doesn't carry across turns. (§D)
5. **Inconsistent platform catalogs** -- jinja-filter validation vs discovery vs the real Ansible
   superset disagree → false-positive `unknown_jinja_filter`; silent-zero searches; `[]` discovery. (§G/§H)
6. **Tool outputs not budgeted** -- 47KB `verify_playbook`, ~40KB duplicate enrichment. (§B/§C)

**Direction (proposed, pending decision):** a persisted per-session **case-state** object (grounding +
investigation progress + capability facts + phase) that turns read/update -- collapses seams 1/2/4;
plus unify build completion (seam 3), one authoritative capability model (seam 5), budget tool outputs
(seam 6). Open decisions tracked in the coherence review.
