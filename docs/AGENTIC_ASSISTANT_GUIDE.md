---
title: Agentic Assistant -- Setup & Operation Guide
status: canonical
category: widget
topics: [agentic-assistant, agentic, setup, guardrails, connectors, mcp]
summary: How the Agentic Assistant widget is installed, configured, and
  operated; how its guardrails work; how it drives any configured FortiSOAR
  connector agentically; and how it ties into native FortiSOAR 8.0 MCP servers.
---

# Agentic Assistant -- Setup & Operation Guide

The **Agentic Assistant** is an in-product AI analyst for FortiSOAR. It
runs as an AngularJS **drawer widget** (`agenticAssistant`) that talks to
a **connector** (`connector-fsr-agentic-assistant`), which runs an agentic loop
(the `fsr-playbooks` framework) over an LLM and the live FortiSOAR appliance.

It can **triage and investigate** alerts, **hunt** across indicators, **build
and enhance playbooks**, and **run any configured connector operation** -- always
behind a human-in-the-loop approval model.

> **Using the assistant rather than setting it up?** Read the
> [User Guide](USER_GUIDE.md): investigating an alert, saving an investigation
> as a playbook, working in the playbook designer, and the Monitor queue.

---

## 1. Architecture at a glance

```
┌────────────────────────────────────────────────────────────────────┐
│ FortiSOAR UI                                                         │
│  ┌──────────────────────────┐                                       │
│  │ agenticAssistant   │  drawer widget (this repo)           │
│  │  • chat transcript + cards│  renders info/action/choice/ioc/…    │
│  └───────────┬──────────────┘                                       │
│              │  chat_turn (messages, intent, entity, session_id)    │
│  ┌───────────▼──────────────┐                                       │
│  │ connector-fsr-agentic-assistant│  operations.py :: chat_turn         │
│  │  • persona + intent scoping│                                     │
│  │  • _apply_mcp_allowlist    │                                     │
│  └───────────┬──────────────┘                                       │
│              │  run_agent_turn()                                     │
│  ┌───────────▼──────────────┐        ┌──────────────────────────┐   │
│  │ fsr_playbooks (framework) │  ────► │ LLM (OpenAI / Anthropic) │   │
│  │  • tool registry + tiers   │        └──────────────────────────┘   │
│  │  • dispatch / approval gate│                                       │
│  │  • MCP materializer        │                                       │
│  └───────────┬──────────────┘                                       │
│              │                                                        │
│      ┌───────┴────────┬─────────────────────┐                        │
│      ▼                ▼                     ▼                         │
│  /api/3 (records)  connector run_op   native MCP gateway (/mcp/…)     │
└────────────────────────────────────────────────────────────────────┘
```

Three shipping components, three repos:

| Component | Repo | What it owns |
|-----------|------|--------------|
| Widget    | `widgets-src/agenticAssistant` | The chat UI, card rendering, approval buttons |
| Connector | `connector-fsr-agentic-assistant` | `chat_turn` op, personas, intent scoping, MCP allow-list wiring |
| Framework | `fsr-playbooks` (`fsr_playbooks`) | The agent loop, tool registry, tier/approval gate, MCP materializer |

The widget is a thin client: it renders whatever cards the connector emits and
posts the analyst's replies back. All intelligence lives in the connector +
framework.

---

## 2. Where the widget appears

`info.json` `enableFor` mounts the drawer in three contexts:

| Context | Meaning |
|---------|---------|
| `main.modules.list`     | A module **list** view (e.g. the Alerts grid) |
| `viewPanel.modulesDetail` | A single **record detail** view (an alert/incident) |
| `main.playbookDetail`   | The **playbook designer** (build/enhance mode) |

A dashboard is **not** in `enableFor`, so the drawer icon is hidden there -- mount
the assistant from a record or the designer, not a dashboard.

When opened on a record, the widget passes that record as the `entity` of the
turn, so the agent starts already grounded on the alert/incident in view.

---

## 3. Setup

### 3.1 Install the connector

Ship/deploy `connector-fsr-agentic-assistant` to the appliance (the connector repo's
`make ship` handles bump → build → install → worker-recycle). Confirm all
workers report the new version.

### 3.2 Install the widget

Deploy `agenticAssistant` via the canonical widget pipeline
(`make ship-verify WIDGET=agenticAssistant SHIP_ENV=<box>`), which
lint → unit → mock-e2e → deploys.

### 3.3 Configure the connector

Create a connector **configuration** with, at minimum, an LLM provider:

| Field | Notes |
|-------|-------|
| **LLM Provider** (`llm_provider`) | `openai` or `anthropic` (required) |
| `openai_api_key` / `anthropic_api_key` | provider key (per provider) |
| `openai_base_url` / `openai_model` / `model` | provider endpoint + model |
| **Simulation Mode** (`simulation_mode`) | when on, the agent narrates actions without executing side effects -- safe for demos/training |
| **MCP Tool Allowlist** (`mcp_allowlist`) | see §7 -- enables native MCP tools |
| **MCP Service Account** (`soar_api_key` / `soar_username` / `soar_password`) | forwardable identity for the MCP gateway (see §7) |
| **Reviewer Roles** (`reviewer_roles`) | optional, comma-separated FortiSOAR role names allowed to decide other people's actions and close escalations. Empty = anyone can decide. See §6.1 |

You can keep multiple configurations (e.g. one per LLM). The chat uses the
connector's **default** configuration unless the caller selects another.

> **Secret round-trip note:** FortiSOAR re-encrypts secret fields with
> non-deterministic encryption on every save, so an LLM key's stored ciphertext
> *changes* after any config write even though the key still works. Don't treat a
> changed ciphertext as corruption -- verify with a real chat turn. Reading a
> config returns secrets as re-submittable ciphertext, so a read-modify-write of
> the config preserves the LLM key.

---

## 4. How a turn works

Each user message triggers the connector's `chat_turn`, which:

1. Resolves the **persona** and **intent** (`triage`, `build`, or `both`) -- this
   scopes which tools the agent may use.
2. Applies the **MCP allow-list** from the live config (per turn -- no worker
   recycle needed to pick up an allow-list change).
3. Runs the framework agent loop: the LLM is given the scoped tool set and the
   grounding (`entity`, prior transcript), and it calls tools until it produces a
   deliverable or halts on an approval card.
4. Streams back a **transcript** of text, tool calls/results, `usage`, and
   **cards**.

The turn ends with a `stop_reason` (`end_turn`, or an `awaiting_*` halt when a
card needs the analyst).

### Card types the widget renders

| Card | Purpose |
|------|---------|
| `info_card` | A consolidated deliverable (triage summary, hunt result) |
| `ioc_card` | Extracted indicators to review/act on |
| `action_card` | A proposed connector action awaiting **Approve/Reject**. Shows **Runs on** (the connector configuration it will use) and, when the connector has more than one configuration, a picker so the analyst can choose |
| `verdict` | The triage verdict: disposition, severity, confidence, and findings that each cite the tool call they came from |
| `escalation_card` | Auto-triage handing a record to the review queue, with its verdict and reasons |
| `choice_card` | A pick-one/pick-many decision for the analyst |
| `manual_input` | A form for a mid-playbook manual-input gate |
| `status_card` | Progress / state of a running action or playbook |
| `playbook_offer` | Offer to create a new playbook from the session |
| `enhancement_offer` | Offer to apply a verified edit to the **open** playbook |
| `capability_gap` | "I can't do X because Y isn't configured/available" |

Cards are how the agent stays **in the loop with the human**: anything with a
side effect surfaces as an `action_card`/`manual_input`/offer the analyst must
accept before it runs.

---

## 5. What it can do

Capabilities are gated by **intent** so build mode can't pivot records and
triage mode can't author playbooks:

**Triage / investigation** (`intent: triage`)
- Summarize an alert's severity, indicators, and next steps (`info_card`).
- Pull and enrich indicators; hunt/pivot across records and enrichment sources.
- Read any module record, search modules, and run **read-only** connector ops.
- Propose containment as an `action_card` (never auto-run).

**Build / enhance** (`intent: build`)
- Explain an open playbook step-by-step.
- Author a new playbook (grounded in the session's recorded action trace).
- Enhance/patch the **open** playbook (`enhancement_offer`).
- Diagnose why a run failed and propose a fix.

**NOC** (FortiManager / FortiAnalyzer device diagnostics)
- Read-only device/status/policy lookups via the dedicated `fmg_*` / `faz_*` tools.

---

## 6. Guardrails (how safety works)

Every tool the agent can call carries a **tier**. The framework's dispatch layer
gates on the tier *before* execution:

| Tier | Meaning | Behavior |
|------|---------|----------|
| 0 | Pure local compute (schema lookups, YAML compile) | auto-run |
| 1 | Read-only FSR API (get/search/list, read ops) | auto-run |
| 2 | Read-only **external** (third-party query) | auto-run + logged |
| 3 | FSR data mutation / unclassified | **approval card** |
| 4 | Third-party side-effect (remediation / containment) | **approval card + step-up** |

Key properties:

- **`run_op` tier is dynamic.** The connector op's tier is resolved per call from
  the op-safety catalog (`op_safety.safety` + `operations.category`). Remediation/
  containment/management → tier 3-4; query/investigation/enrichment → tier 2;
  unclassified → escalates to approval.
- **Name-based fail-safes.** If the safety catalog has no verdict, the op *name*
  is a fallback: a destructive verb (`isolate`, `block`, `quarantine`, …) escalates
  to tier 4 even when the catalog is silent -- so an unprobed containment op can
  never auto-run.
- **Unknown-connector bounce.** A `run_op` against a connector that isn't in the
  store returns a clean `unknown_connector` error (with a `find_connector`
  suggestion) instead of a misleading approval card -- the agent self-corrects
  rather than dead-ending.
- **Human-in-the-loop.** Tier ≥ approval-floor produces a `pending_approval`
  envelope → the widget renders an `action_card`; nothing executes until the
  analyst approves. Tier-4 actions additionally require step-up.
- **Persona allow-lists are advisory; the approval card is the real gate.** A
  persona can *auto-run* a specifically-allow-listed read-only validation
  playbook (tier 2, no card); everything else stays carded.
- **Simulation mode** narrates actions without executing them -- a hard off-switch
  for side effects, independent of tiers.
- **Decided once.** Each approval card, offer and escalation records one
  decision. A second answer (a double click, or a lead in the Monitor after the
  analyst in the chat) is refused with `already_decided`, naming who decided.
- **The analyst picks where an action runs.** The model may name a connector
  configuration in the card; the analyst can change it before approving, and the
  approved choice is what runs. An action bound to an on-prem FortiSOAR agent
  runs on that agent.

### 6.1 Who can decide (reviewer roles)

The connector runs as a service account, so it does not trust the `actor` the
widget sends. It reads the caller from the `X-User` header that the FortiSOAR
gateway adds to every connector call (the person's uuid). The gateway appends to
a client-sent `X-User` rather than replacing it, so the connector takes the last
value, and treats more than one value as a forged header and refuses.

With **Reviewer Roles** empty, nothing is checked (the original behavior). Once
it lists one or more role names:

| Decision | Allowed for |
|---|---|
| Approve / reject / accept / decline a card in a chat | the person who started that chat, or anyone holding a reviewer role |
| Approve / reject an auto-triage action | a reviewer role holder |
| Mark an escalation handled / dismissed | a reviewer role holder |

The decision records the verified person's name, not the widget's claim. If
the caller cannot be identified or their roles cannot be read, the decision is
refused (`not_authorized`) and the card stays open. Roles are read from
`/api/3/people/<uuid>` and matched by name against `/api/3/roles` (cached 60s).

> A new configuration field only appears after the connector is installed
> (released); a dev push of the code alone does not register it.

---

## 6a. Autonomy policy (shadow mode)

The autonomy policy is the path to actions that run without a click. It is an
admin-written JSON record in the Key Store under the key
**`fsr_autonomy_policy`**, re-read every 15 seconds, so an edit (including the
kill switch) takes effect on the next card without a restart.

**Today it only runs in shadow mode.** It never acts. Every action card gets a
`policy` entry saying whether the matching rule *would* have run it and which
condition failed, and the Monitor's **Autonomy** tab compares those decisions
with what reviewers actually decided. A rule is a candidate for enforcement
only when "would run it, rejected" stays at zero for a sustained period.

```json
{
  "version": 1,
  "enabled": true,
  "mode": "shadow",
  "protected": {"crown_jewels": ["198.51.100.10"]},
  "rules": [{
    "id": "block-external-ip",
    "action": {"connector": "fortigate-firewall", "op": "block_ip_new"},
    "when": {
      "verdict": {"disposition": ["true_positive"], "min_confidence": 0.9},
      "target": {"kind": "ip", "external_only": true, "not_in": "crown_jewels"},
      "evidence": {"cites_tool_kind": "enrichment"}
    },
    "limits": {"per_hour": 10, "per_target_per_day": 1}
  }]
}
```

| Field | Meaning |
|---|---|
| `enabled` | Kill switch. `false` = no rule matches anything |
| `mode` | `shadow` (record only). `enforce` is reserved and not yet acted on |
| `rules[].action` | Which action the rule covers (connector + operation, or a tool) |
| `when.verdict` | The delivered verdict must have one of these dispositions and at least this confidence |
| `when.target` | IP targets must be external and not in the named `protected` list |
| `when.evidence` | The verdict must cite at least one enrichment lookup |
| `limits` | Rate caps, counted across other conversations |

An invalid record is reported in the Autonomy tab and not applied. No record
means no policy: every action waits for a person.

---

## 6b. Auto-triage and the review queue

Run the connector action **Set Auto-Triage** to install an on-create playbook
for a module (alerts by default). Parameters: the connector configuration the
agent should use, optional `severities` and `sources` filters, `enabled`, and an
optional `notify_target` for escalations. Each new matching record is triaged
once, unattended, and ends with a verdict; anything that needs a person goes to
the Monitor's **Pending** tab as an escalation or an action awaiting approval.
`enabled: false` keeps the playbook but stops it triaging.

Recurring prompts use **Create Scheduled Agent Task** and appear in the
Monitor's **Scheduled** tab.

---

## 7. Driving any configured connector agentically

The assistant does **not** hardcode a fixed toolset per connector. It discovers
and drives whatever is installed/configured on the appliance:

- **Discovery tools** -- `list_configured_connectors`, `find_connector`,
  `find_operation`, `get_op_schema`, `find_containment_actions`,
  `find_enrichment_actions` -- let the agent learn what's available and what a
  step can call, at runtime.
- **Generic dispatch** -- `run_op(connector, op, params)` executes *any* operation
  of *any* configured connector. Its tier (and therefore whether it needs
  approval) is resolved from the op-safety catalog per §6.
- **Dedicated read-only wrappers** -- ergonomic tier-1 tools over common
  enrichment ops (`siem_search_ip`, `faz_search_ip`, `fmg_get_device_list`, …).
  These are thin wrappers over `run_op` against the underlying connector and
  return a clean `unknown_connector` error when that connector isn't configured.

**Practical implication:** to give the assistant a new capability, *configure the
connector on the appliance*. The agent will discover it and can call it (behind
the tier/approval gate) with no widget or connector change.

> If an enrichment pivot needs a connector that isn't configured (e.g. FortiSIEM),
> the agent should recognize it's unavailable and pivot to a configured source
> (e.g. FortiAnalyzer) or consolidate what it has -- rather than fabricating a call.

---

## 8. Tying into native FortiSOAR MCP servers

FortiSOAR 8.0 exposes **native MCP gateways** (e.g. the internal `soc` server at
`/mcp/soc/` with tools like `get_indicators`, `enrich_indicator`,
`hunt_ioc_siem`). The assistant can surface these as first-class agent tools via
a **dynamic tool-surface materializer** -- but it's **opt-in** and dormant by
default.

### 8.1 Enable it

Set two fields on the connector configuration:

1. **`mcp_allowlist`** (JSON) -- which server(s)/tool(s) to expose:
   ```json
   {
     "soc": { "tools": "*", "tier": "read_only" },
     "connector:fortinet-fortiedr": { "tools": ["get_device_details"], "tier": "read_only" }
   }
   ```
   The server key is a **built-in name** (`soc`, `utility`, `playbooks`) or
   `"connector:<name>"`. An empty/absent allow-list materializes nothing (the
   curated connector tools still work).

2. **MCP Service Account** -- a **forwardable identity** the gateway can replay on
   downstream `/api/3` calls: `soar_api_key` (an API key, preferred) or
   `soar_username`/`soar_password`. On-box CS-HMAC is URI-bound and **401s** on
   the gateway's header replay, so a static API key (or minted bearer) is what
   makes the `soc` tools actually execute.

Once set, the **next chat turn** materializes the allow-listed tools (the
connector applies the allow-list per turn -- no worker recycle). Materialized
tools appear to the agent as `mcp_<server>__<tool>` (e.g.
`mcp_soc__get_indicators`) and are tiered by the allow-list entry's `tier`
(`read_only` → non-mutating).

### 8.2 Minting the API key (operator)

Create an API-key user with a broad-enough role (so the gateway's downstream
`/api/3` replay isn't under-privileged), then write its key to `soar_api_key`.
Via pyfsr:

```python
u = client.api_users.create(api_key_validity=365)          # → {uuid, api_key.key}
client.api_keys.create(name="fsrpb-mcp", user_uuid=u["uuid"],
                       roles=["Full App Permissions"], teams=["SOC Team"])  # names, NOT IRIs
# then upsert soar_api_key = u["api_key"]["key"] + mcp_allowlist onto the config
```

The plaintext key is exposed **only at creation**; store it when you mint it.

### 8.3 Verify

- `probe_native_mcp` (connector op) reports `auth_mode`, `server`, and the tool
  count from the worker context -- the fastest check that the key + gateway work.
- A real chat turn asking the agent to call an MCP tool (e.g. "get the indicators
  for this IP") should show a `mcp_soc__get_indicators` tool call returning real
  data.

> **Gotcha:** the introspection op `list_agent_tools --include_mcp` may report 0
> MCP tools even when the chat path materializes them -- trust `probe_native_mcp`
> and an actual chat turn, not that op.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Chat shows no MCP (`mcp_*`) tools | `mcp_allowlist` empty/unset | Set it per §8 (+ the service account) |
| MCP tools 401 | Non-forwardable identity (HMAC only) | Set `soar_api_key` (or service creds) |
| A read-only pivot parks on an approval card | Target connector isn't configured/cataloged | Configure the connector; the agent should pivot to a configured source |
| Manual-input gate dead-ends after the first | (fixed 0.5.13/0.5.19) resume-loop | Ensure connector ≥ 0.5.19 |
| A manual-input pause renders as a red error | (fixed) `awaiting_input` mis-classified | Ensure widget renders it as the amber "waiting" chip |
| LLM key "changed" after a config write | Non-deterministic re-encryption (benign) | Verify with a chat turn; don't restore blindly |
| Actions run without prompting | Simulation mode off + tier too low | Check tiers/op-safety; enable simulation mode for demos |
| "Only reviewers can decide this" | `reviewer_roles` set and the caller holds none of them | Decide from the reviewer's account, or from the chat's own initiator |
| "Could not tell who is deciding" | No `X-User` header reached the connector (called outside the UI) | Decide from the FortiSOAR UI |
| Monitor Autonomy tab says "Could not load autonomy decisions" | The connector on the box predates the `list_shadow_decisions` operation | Install the newer connector release |
| Autonomy tab shows a policy error | `fsr_autonomy_policy` is not valid JSON or fails validation | Fix the Key Store record; it is re-read within 15s |

---

*This guide documents the widget + connector + framework as a system. Widget
lifecycle/packaging details live in the repo `KNOWLEDGEBASE.md`; the MCP
enablement procedure is also captured there.*
