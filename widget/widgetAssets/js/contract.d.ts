/* contract.d.ts -- typed source of truth for the fsr-agentic-assistant connector's
   chat wire protocol (contract_version 2.x). Ambient-only: NOTHING here emits
   runtime code -- the widget ships plain ES5 IIFEs, so these types exist purely
   to catch envelope/frame drift at build time (fsrPbRender.ts consumes them) and
   in the editor (JSDoc @type refs in fsrPbAgent.service.js / view.controller.js).

   Why this file exists: the recurring 8.0 breakages were all shape drift at the
   connector seam -- `status` becoming a string, the `done`/`cursor` envelope, the
   detached `{accepted}` ack vs the blocking transcript, and per-frame `type`
   renames. Encoding the contract once means a renamed frame type or a moved
   envelope field is a compile error in fsrPbRender.ts instead of a silent
   stuck-"sending" hang. Keep this in lockstep with the connector's contract.

   Evidence base: connector 0.4.12 live responses (chat_turn blocking + detached
   ack; chat_poll frames turn_start→…→usage→stream_end), the service unwrap in
   fsrPbAgent.service.js, and every `ev.type === …` branch in
   fsrPbRender.ts:buildAssistantMessage. */

declare namespace FsrPbChat {
  /* ── Raw integration envelope ────────────────────────────────────────────
     `POST /api/integration/execute` wraps every op result as
     {operation, status, message, data}. On 8.0 `status` is a STRING
     ("Success"/"finished"); the service's _unwrapEnvelope keys off
     `typeof resp.status === 'string'` to peel `.data`. Callers below receive the
     already-unwrapped `data`. */
  interface Envelope<T> {
    operation?: string;
    status: string;
    message?: string;
    data: T;
  }

  /* ── Wire events ─────────────────────────────────────────────────────────
     The per-event vocabulary the agent streams. These appear BOTH as loose
     poll `frames[]` (bracketed by turn_start/stream_end) and as the authoritative
     `transcript[]` on a blocking chat_turn return / stream_end terminal. All
     fields optional except the `type` discriminant -- the connector omits empties
     and the renderer defaults them. */
  type WireEventType =
    | 'text' | 'tool_use' | 'tool_result' | 'usage'
    | 'approval_request' | 'choice_card' | 'action_card' | 'capability_gap'
    | 'manual_input' | 'playbook_offer' | 'enhancement_offer' | 'persona_offer'
    | 'status_card' | 'info_card' | 'ioc_card' | 'verdict_card'
    | 'activity' | 'error' | 'unknown';

  interface TextEvent { type: 'text'; text?: string; }
  interface ToolUseEvent {
    type: 'tool_use';
    name?: string;
    id?: string;
    input?: unknown;
    /** approval tier of the tool (0-3); connector-side, unused by the renderer */
    tier?: number;
    /** the analyst's name for the call (connector tool_labels); absent for native MCP tools */
    label?: string;
  }
  interface ToolResultEvent {
    type: 'tool_result';
    tool_use_id?: string;
    tool?: string;
    content?: unknown;
    duration_ms?: number;
  }
  interface UsageEvent {
    type: 'usage';
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
    cache_read?: number;
    cache_write?: number;
    /** Every input token billed this round, cached ones included. */
    total_input?: number;
    /** total_input + output_tokens. */
    total_tokens?: number;
    /** The model's reasoning summary for this round (Anthropic summarized
        thinking), present only when the model emits one. The renderer folds
        every round's reasoning across a turn into one collapsed
        "How I worked this out" panel; never shown as inline prose. */
    thinking?: string;
  }
  interface ApprovalRequestEvent {
    type: 'approval_request';
    tool?: string;
    approval_id?: string;
    tool_use_id?: string;
    tier?: number;
    summary?: string;
    preview?: { args?: Record<string, unknown> };
    args_hash?: string;
    requires_step_up?: boolean;
    /** run_playbook only: the persona that would have asked and the playbook.
        Approving with `chat_resume` `remember: true` adds the playbook to that
        persona's run-without-asking list. Absent when it already runs freely. */
    always_allow?: { persona: string; playbook: string } | null;
  }
  interface ChoiceCardEvent {
    type: 'choice_card';
    id?: string;
    prompt?: string;
    options?: unknown[];
    multi?: boolean;
    min_select?: number;
    max_select?: number;
    /** Show a free-text answer box under the chips (single-pick cards). */
    allow_text?: boolean;
    /** tool_use_id of the last visible (non-emit_) tool call this card reports
        on, so the widget can nest the card under that tool's bubble. Absent on
        standalone cards or older buffered transcripts -- render flat. */
    preceding_tool_use_id?: string | null;
  }
  interface CapabilityGapEvent {
    type: 'capability_gap';
    id?: string;
    missing?: string;
    why?: string;
    fix_steps?: unknown[];
    resume?: { label?: string; value?: string };
    tips?: unknown[];
    alternatives?: unknown[];
    docs_url?: string | null;
    preceding_tool_use_id?: string | null;
  }
  /** One field of a mid-playbook manual_input gate. `type` selects the widget
      control (dynamic_list | checkbox/boolean | select | textarea | text; unknown
      degrades to text). `required` gates the card's submit button. */
  interface ManualInputField {
    name: string;
    label?: string;
    type?: string;
    tooltip?: string;
    required?: boolean;
    default?: unknown;
    options?: unknown[];
    groups?: unknown[];
  }
  /** `expires_at` / `expires_in_seconds` are the gate's DEADLINE, sent whenever
      the paused manual_input step carries a timeout. Once it lapses the run
      continues down its timeout branch and a submit can never land, so the card
      renders a live countdown and refuses to submit past zero. `expires_at` is
      absolute and authoritative; `expires_in_seconds` was computed when the
      connector built the frame and is a stale fallback. Both absent = no
      deadline, which is the common case. */
  interface ManualInputEvent {
    type: 'manual_input';
    id?: string;
    question?: string;
    workflow_run_iri?: string | null;
    fields?: ManualInputField[];
    /** The pause's own buttons in the playbook's order. `respond_manual_input`
        takes the chosen `label` as `option`. */
    buttons?: { label: string; primary: boolean }[];
    expires_at?: string | null;
    expires_in_seconds?: number | null;
    preceding_tool_use_id?: string | null;
  }
  interface PlaybookOfferEvent {
    type: 'playbook_offer';
    id?: string;
    summary?: string;
    ops_summary?: unknown[];
    draft_steps?: unknown;
    title_suggestion?: string;
    editable_title?: boolean;
    preceding_tool_use_id?: string | null;
  }
  /** One changed step in an enhancement's structural diff, as computed by the
      framework's `_diff_collections`. `before`/`after` are IR step projections
      ({type, arguments, next, branches, unlabeled_next, for_each, comment});
      exactly one side is null for an add or a remove. `changed_fields` names
      the differing projection keys, so the card can label a row without
      re-diffing. For the two playbook-level kinds, `step` is null and the
      populated side is `{steps: string[]}` rather than a projection. */
  interface EnhancementChange {
    playbook?: string;
    step?: string | null;
    kind: 'added' | 'removed' | 'modified' | 'renamed'
        | 'playbook_added' | 'playbook_removed';
    type?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    changed_fields?: string[];
  }
  /** Apply a VERIFIED edit to the playbook the analyst has OPEN -- the update
      counterpart of PlaybookOfferEvent, which creates a new playbook instead.
      Emitted by the framework `emit_enhancement_offer`.

      `final_yaml` is the exact text that `verify_enhancement` passed; the tool
      that emits this card takes a verified-id rather than YAML, so the card
      cannot carry anything the gate did not see. That binding exists because
      the previous delivery mechanism -- scraping the last ```yaml fence out of
      the model's prose -- applied text nobody had verified. On accept the widget
      resumes with the open playbook's `workflow_iri` and the connector writes
      via update_playbook (snapshot-then-PUT). */
  interface EnhancementOfferEvent {
    type: 'enhancement_offer';
    id?: string;
    summary?: string;
    /** Opaque handle to the verified body; echoed for traceability. */
    verified_id?: string;
    /** The verified bytes this card will apply. */
    final_yaml?: string;
    ops_summary?: unknown[];
    /** The framework's structural diff. The three name lists below are its
        flattened index; `changes` is the half that reads as an explanation,
        and is what the card body renders. */
    diff_summary?: {
      steps_added?: string[];
      steps_removed?: string[];
      steps_modified?: string[];
      unchanged?: number;
      changes?: EnhancementChange[];
    };
    steps_added?: string[];
    steps_removed?: string[];
    steps_modified?: string[];
    /** Hoisted off diff_summary by emit_enhancement_offer so the renderer does
        not have to reach through it. */
    changes?: EnhancementChange[];
    /** Non-blocking findings; ready_to_push tolerates these, so the card is the
        analyst's last look at them before the edit is saved. */
    warnings?: { message?: string; path?: string }[];
    preceding_tool_use_id?: string | null;
  }

  /** The persona builder's Save offer. The connector drafts a module-scoped
      persona (its standing memory for a kind of record) and emits this card;
      accepting it writes the Key Store persona. Emitted by the connector's
      deterministic author_persona turn (ops_persona_emit.build_persona_offer). */
  interface PersonaOfferEvent {
    type: 'persona_offer';
    id?: string;
    /** The module this persona mounts on. */
    module?: string;
    /** The drafted system prompt (the standing guide). The widget does NOT
        render this raw -- it is the assistant's own instructions. */
    value?: string;
    /** tools.allow / may_write / ui. The widget reads may_write (write scope)
        and ui.greeting only; it never renders tool names to the analyst. */
    jSONValue?: { [k: string]: unknown };
    label?: string;
    /** An analyst-safe one-line summary of what the persona grants. */
    summary?: string;
    preceding_tool_use_id?: string | null;
  }
  interface ActivityEvent { type: 'activity'; message?: string; phase?: string; }
  interface ErrorEvent { type: 'error'; message?: string; [k: string]: unknown; }
  /** Fallback the connector emits for an unrecognized fsr_playbooks event
      (_event_to_wire's final branch). Present so the wire union stays exhaustive
      and a strict poll-frame validator never rejects live output. */
  interface UnknownEvent { type: 'unknown'; repr?: string; }
  /* Verdict card: analyst review of a triage investigation outcome. Disposition
     enum values map to visual/colour treatment; evidence fields index into the
     transcript's tool_use ids for link-back to the investigation steps that
     produced them; unknowns are claims the agent could not verify with available
     tools or data. Recommended actions pre-populate the composer. */
  interface VerdictCardEvent {
    type: 'verdict_card';
    id?: string;
    disposition?: 'true_positive' | 'false_positive' | 'benign' | 'suspicious' | 'needs_more_info';
    severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
    confidence?: number;
    summary?: string;
    findings?: Array<{ claim: string; evidence: string[] }>;
    unknowns?: string[];
    /* Source labels the investigation actually queried (e.g. "FortiSIEM").
       Rendered as one plain "Checked: ..." line; the framework sends it on
       every verdict card. Unknowns still carry the "not checked" note. */
    sources_checked?: string[];
    /* X7: on an uncertain verdict only. Each entry is a sentence naming a
       missing or failed source and the verdict unknown it would settle. */
    what_would_help?: Array<{ kind: string; state: 'not_connected' | 'failed' | 'no_data';
                              line: string; unknown: string; sources: string[] }>;
    recommended_actions?: Array<{ label: string; tool?: string; args?: Record<string, unknown> }>;
    preceding_tool_use_id?: string | null;
  }
  /* Card variants are handed to normalizeActionCard / normalizeInfoCard, which
     read a broad, connector-defined field set -- kept open by an index signature
     so the normalizers stay the single place that knows their shape. */
  interface ActionCardEvent { type: 'action_card'; [k: string]: unknown; }
  interface StatusCardEvent { type: 'status_card'; [k: string]: unknown; }
  interface InfoCardEvent { type: 'info_card'; [k: string]: unknown; }
  interface IocCardEvent { type: 'ioc_card'; [k: string]: unknown; }

  type WireEvent =
    | TextEvent | ToolUseEvent | ToolResultEvent | UsageEvent
    | ApprovalRequestEvent | ChoiceCardEvent | ActionCardEvent | CapabilityGapEvent
    | ManualInputEvent | PlaybookOfferEvent | EnhancementOfferEvent | PersonaOfferEvent
    | StatusCardEvent | InfoCardEvent | IocCardEvent | VerdictCardEvent
    | ActivityEvent | ErrorEvent | UnknownEvent;

  /* ── Poll envelope frames ────────────────────────────────────────────────
     chat_poll `frames[]` is the wire events above, bracketed by these two.
     turn_start carries THIS turn's number (the widget's stale-frame fence keys
     off it); stream_end is the terminal and, in detached/poll-to-completion
     mode, carries the authoritative `transcript` the widget commits. */
  interface TurnStartFrame { type: 'turn_start'; turn?: number; }
  interface StreamEndFrame {
    type: 'stream_end';
    ok?: boolean;
    stop_reason?: string;
    turn_id?: string;
    transcript?: WireEvent[];
    contract_version?: string;
    last_assistant_yaml?: string | null;
    tags?: Record<string, unknown>;
    cursor?: number;
  }
  type PollFrame = TurnStartFrame | StreamEndFrame | WireEvent;

  /* ── chat_poll response (unwrapped `data`) ──────────────────────────────── */
  interface ChatPollResponse {
    ok?: boolean;
    session_id?: string;
    contract_version?: string;
    turn?: number;
    cursor?: number;
    frames?: PollFrame[];
    done?: boolean;
    stop_reason?: string;
    error?: string | null;
  }

  /* ── chat_turn / chat_resume response (unwrapped `data`) ─────────────────
     Two shapes on one op. A DETACHED turn (payload.detached, live mode) returns a
     fast ack with NO transcript and stop_reason "accepted"; the transcript then
     arrives via the chat_poll stream_end terminal. A non-detached (mock / <2.7.0)
     turn blocks and returns the full transcript inline. The widget MUST NOT commit
     a transcript off the ack -- see view.controller.js _detachedActive. */
  interface ChatTurnAck {
    ok?: boolean;
    accepted: true;
    session_id?: string;
    turn?: number;
    turn_id?: string;
    stop_reason?: 'accepted';
    contract_version?: string;
  }
  interface ChatTurnResult {
    ok?: boolean;
    accepted?: false;
    session_id?: string;
    turn?: number;
    turn_id?: string;
    stop_reason?: string;
    contract_version?: string;
    transcript?: WireEvent[];
    last_assistant_yaml?: string | null;
    tags?: Record<string, unknown>;
    error?: string | null;
  }
  type ChatTurnResponse = ChatTurnAck | ChatTurnResult;

  /* ── chat_history (rehydrate / session switch) ──────────────────────────── */
  /** Who sent/started a turn -- the widget-supplied SOAR user identity. */
  interface ChatActor { name: string; iri?: string; }
  interface HistoryTurn {
    user?: string;
    transcript?: WireEvent[];
    /** Original send time, epoch SECONDS (widget converts to ms for display). */
    ts?: number;
    /** Real sender of a user turn; absent on pre-actor rows. */
    author?: ChatActor;
    /** The analyst's answer to a choice card (value = option value(s) or typed
        text; label absent for typed text). Replay marks that card answered. */
    resume?: { choice_id: string; value?: unknown; label?: string };
  }
  interface ChatHistoryResponse {
    turns?: HistoryTurn[];
    /** The session's real initiator (opener actor), or null on pre-actor sessions. */
    initiator?: ChatActor | null;
  }
  interface SessionSummary { session_id?: string; title?: string; updated?: string; turn_count?: number; }
  interface ListSessionsResponse { sessions?: SessionSummary[]; }

  /* ── Service surface (fsrPbAgentService) ─────────────────────────────────
     Each method resolves to the UNWRAPPED payload (the service peels the
     integration envelope). `cfg` is the widget config passed through for mode
     resolution. Referenced from fsrPbAgent.service.js via a JSDoc @type. */
  interface AgentService {
    connectorName: string;
    modeInfo(cfg: unknown): { mode: 'mock' | 'live'; mock_scenario: string | null };
    resolveConnector(): PromiseLike<{ name: string; version: string; configId: string; configName?: string }>;
    chatTurn(cfg: unknown, payload: unknown): PromiseLike<ChatTurnResponse>;
    chatResume(cfg: unknown, payload: unknown): PromiseLike<ChatTurnResponse>;
    chatHistory(cfg: unknown, sessionId: string): PromiseLike<ChatHistoryResponse>;
    listSessions(cfg: unknown): PromiseLike<ListSessionsResponse>;
    chatPoll(cfg: unknown, sessionId: string, cursor: number, sinceTurn: number): PromiseLike<ChatPollResponse>;
  }
}
