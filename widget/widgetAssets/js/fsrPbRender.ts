/**
 * fsrPbRender -- the pure, framework-free render pipeline for fsrAgenticAssistant.
 *
 * This module owns the transcript -> render-model mapping that the view
 * controller used to inline: turning a connector transcript (text / tool_use /
 * tool_result / *_card / error events) into the `messages[]` render model the
 * template iterates, and normalizing the informational-card block vocabulary.
 *
 * It deliberately has ZERO Angular/DOM dependency so the whole render pipeline
 * can be replayed in node (jest) against the same fixtures the browser uses --
 * see SOAR_TEST_KIT_DESIGN.md (Layer 1). The controller delegates to it via the
 * `FsrPbRender` browser global; behavior is identical.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

type Severity = 'ok' | 'warning' | 'error' | 'info' | null;
type ControlKind = 'select' | 'multiselect' | 'checkbox' | 'integer' | 'number' | 'json' | 'textarea' | 'password' | 'text';

interface RenderOptions {
  now?: () => number;
  collapseThreshold?: number;
  interleaveText?: boolean;
}

interface Block {
  kind: 'rows' | 'table' | 'tags' | 'score' | 'text' | 'link';
  rows?: Array<{ label: string; value: string; severity?: Severity }>;
  columns?: unknown[];
  tags?: Array<{ label: string; severity?: Severity } | string>;
  label?: string;
  value?: unknown;
  max?: number;
  pct?: number | null;
  text?: string;
  url?: string;
  severity?: Severity;
}

interface Field {
  name: string;
  label: string;
  type: ControlKind;
  required: boolean;
  editable: boolean;
  schemaVisible: boolean;
  default: unknown;
  options: Array<{ value: unknown; label: string }>;
  description: string;
  tooltip: string;
  placeholder: string;
}

interface ActionCard {
  type: 'action_card';
  cardId: string;
  connector: string;
  operation: string;
  summary: string;
  args: Record<string, unknown>;
  editableFields: string[];
  paramSchema: Field[];
  paramIndex: Record<string, Field>;
  visibility: { always: string[]; when: Record<string, string[]> } | null;
  legacyFields: Field[];
  // Record-WRITE cards (create/update/delete_record) carry the target and a
  // per-field diff, so the analyst approves a described change instead of an
  // args blob -- and whether that target is the record they have open. Every
  // other action_card leaves these empty and renders exactly as before.
  target: { module: string; uuid: string; name: string; label: string } | null;
  changes: WriteChange[];
  // 'same' | 'different' | 'unknown'. UNKNOWN IS NOT SAME: an unanchored
  // session cannot tell, and the card must not render reassurance the
  // connector never earned.
  contextMatch: string;
  // Batched approval: the other writes the assistant proposed in the same
  // breath, which this one decision also covers (a seven-step profile build is
  // one card, not seven). Empty for a single-call card.
  batch: Array<{ label: string; changes: Array<{ field: string; after: unknown }> }>;
  /** "Approve all 7" when the card covers a batch, else the usual label. */
  confirmLabel: string;
  /** "This approval also covers 6 more changes:" -- empty with no batch. */
  batchHeading: string;
  /** Where the approved action runs. Null on a card from a connector that
      sends no config: the action runs on the connector's default, as before. */
  runsOn: CardConfig | null;
  /** The configurations the analyst may switch to (2+), else empty. */
  configOptions: CardConfig[];
  /** The picked configuration id -- sent with the approval. */
  configId: string;
  /** Several configurations and none is the one: Approve waits for a pick. */
  configRequired: boolean;
  _open: boolean;
  _resolved: boolean;
  _outcome: unknown;
  display: string;
}

/** One step of an enhancement_offer's structural diff, rendered as the card's
    default body. `beforeText`/`afterText` are the wire's IR projections
    flattened for display (see `_projectionText`); one side is empty for an add
    or a remove. */
interface EnhancementDiffRow {
  kind: string;
  /** add | mod | del -- selects the existing `.eo-badge` colour. */
  badge: string;
  playbook: string;
  step: string;
  stepType: string;
  changedFields: string[];
  changedFieldsText: string;
  beforeText: string;
  afterText: string;
  /** U6: the row's New / Changed / Removed tag. */
  tag: string;
  /** U6: display label of the connector an added/removed connector step runs. */
  connectorLabel: string;
  /** U6: the configuration an added/removed connector step runs with, as written. */
  configName: string;
  /** U6: one "Label is now X (was Y)" sentence per changed value of a modified
      step; configuration names and template expressions appear as written. */
  valueChanges: string[];
}

interface InfoCard {
  type: 'info_card';
  cardId: string;
  variant: string;
  severity: Severity;
  severityLabel: string;
  title: string;
  blocks: Block[];
  actions: unknown[];
  display: string;
}

interface ToolCall {
  type: 'tool_call';
  name: string;
  // What the call did, for the row heading. `name` stays for matching.
  label: string;
  _toolUseId: string | null;
  inputDisplay: string | null;
  resultDisplay: string | null;
  resultStatus: string;
  // "25 of 140" when the tool returned only part of what matched, else null.
  partialLabel: string | null;
  durationMs: number | null;
  durationLabel: string | null;
  _startedAt: number | null;
  _open: boolean;
  _inputOpen: boolean;
  _resultOpen: boolean;
}

interface ApprovalArgRow {
  key: string;
  label: string;
  value: string;
  complex: boolean;
}

interface ApprovalRequest {
  type: 'approval_request';
  name: string;
  approvalId: string;
  // The gating tier the connector resolved for this action, and whether its
  // confirm_mode is `step_up` (tier >= 4) rather than plain `approve`. Both
  // have been on the wire since approvals existed -- five captures on two
  // boxes carry them -- and nothing rendered either, so a tier-4 remediation
  // asked for consent in the same words as a tier-2 write.
  tier: number;
  /** The tier in words ("Changes data", "High impact"); '' below tier 3. */
  tierLabel: string;
  requiresStepUp: boolean;
  alwaysAllow: { persona: string; playbook: string } | null;
  // What this playbook has been doing lately, from the connector's `context`
  // block. "It has run 16 times and last finished cleanly" is decision-relevant
  // before authorising another run; "never run" doubly so.
  runContext: {
    lastRun: string; lastStatus: string; runs24h: number | null;
    runsTotal: number | null; neverRun: boolean;
  } | null;
  display: string;
  summary: string;
  argRows: ApprovalArgRow[];
  rawArgs: string;
  // Deep link to the playbook a run_playbook approval would run, so the
  // analyst can read what is being proposed before approving it.
  playbookUrl: string;
  _rawOpen: boolean;
  _open: boolean;
}

interface ChoiceCard {
  type: 'choice_card';
  choiceId: string;
  prompt: string;
  options: unknown[];
  multi: boolean;
  minSelect: number;
  maxSelect: number | null;
  allowText: boolean;
  _typed: string;
  _open: boolean;
  _resolved: boolean;
  _picked: unknown;
  display: string;
}

interface CapabilityGap {
  type: 'capability_gap';
  choiceId: string;
  missing: string;
  why: string;
  fixSteps: string[];
  resume: { label: string; value: string };
  tips: Array<{ text: string; hint: string }>;
  alternatives: Array<{ label: string; value: string; hint: string }>;
  docsUrl: string | null;
  _open: boolean;
  _resolved: boolean;
  _picked: unknown;
  _resolutionText: unknown;
  display: string;
}

interface ManualInputButton {
  label: string;
  primary: boolean;
}

interface ManualInput {
  type: 'manual_input';
  inputId: string;
  question: string;
  workflowRunIri: string | null;
  fields: unknown[];
  values: Record<string, unknown>;
  /* The pause's own buttons, in the playbook's order. Two or more render one
     button each and the chosen label rides back as `option`; fewer keep the
     generic Approve / Reject pair. */
  buttons: ManualInputButton[];
  expiresAt: string | null;
  expiresInSeconds: number | null;
  /* When this card was first built, in ms. The anchor for a relative
     `expires_in_seconds`, which the connector computed at frame-build time and
     which is therefore already stale by the time we render it. */
  _seenAtMs: number;
  _open: boolean;
  _resolved: boolean;
  _outcome: unknown;
  display: string;
}

/* What a manual_input card's deadline looks like right now. Null when the gate
   carries no deadline at all -- most manual_input steps don't set a timeout,
   and a card without one must render exactly as it always has. */
interface ManualInputExpiry {
  deadlineMs: number;
  secondsLeft: number;
  expired: boolean;
  /* "4m 12s" while the gate is open; '' once it has lapsed. */
  label: string;
}

interface SetupNotice {
  message: string;
  steps: string[];
}

interface PlaybookOffer {
  type: 'playbook_offer';
  offerId: string;
  summary: string;
  // Track U: what the collapsed card shows (plain words, no field keys or ids).
  plainSummary: string;
  plainSteps: Array<{ text: string }>;
  safetyLine: { tone: string; text: string };
  triggerText: string;
  thingsToKnow: string[];
  techWarnings: string[];
  _detailsOpen: boolean;
  _renaming: boolean;
  _yamlOpen: boolean;
  opsSummary: unknown[];
  draftSteps: unknown[];
  hasDraft: boolean;
  stepCount: number;
  titleSuggestion: string;
  finalYaml: string;
  /* Connectors the offered playbook needs that are not usable yet (not set up,
     or not shared with the analyst's teams). A warning, never a gate. */
  runsAfterSetup: SetupNotice[];
  warnings: Array<{ message: string; step: string; inChange: boolean }>;
  editableTitle: boolean;
  title: string;
  _draftOpen: boolean;
  _open: boolean;
  _resolved: boolean;
  _outcome: unknown;
  _resolutionText: unknown;
  display: string;
}

interface Activity {
  type: 'activity';
  lines: Array<{ phase: string; message: string }>;
}

interface ErrorEvent {
  type: 'error';
  name: string;
  display: string;
  _open: boolean;
}

interface VerdictFinding {
  claim: string;
  evidence: Array<{ id: string; missing: boolean; label?: string }>;
}

interface VerdictCard {
  type: 'verdict_card';
  cardId: string;
  disposition: 'true_positive' | 'false_positive' | 'benign' | 'suspicious' | 'needs_more_info';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  // Words for the badges: the enum values above are CSS classes, not copy.
  dispositionLabel: string;
  severityLabel: string;
  confidenceLabel: string;
  confidence: number;
  summary: string;
  findings: VerdictFinding[];
  unknowns: string[];
  // One plain line naming the sources the investigation checked; '' when none.
  sourcesLine: string;
  // X7: what would help an uncertain verdict, at most three lines. The framework
  // computes them from missing source types, failed sources and empty searches;
  // `unknown` is the verdict unknown the line answers (shown under Details).
  whatWouldHelp: Array<{ line: string; unknown: string; sources: string[] }>;
  // Phase 2 step 3a (advisory only): plain lines about the subject's records the
  // investigation did not read or that conflict with the verdict. Never changes
  // the verdict or what may run; [] when the framework says nothing.
  advisoryLines: string[];
  recommendedActions: Array<{ label: string; tool?: string; args?: Record<string, unknown> }>;
  display: string;
}

type RenderEvent = ToolCall | ApprovalRequest | ChoiceCard | ActionCard | CapabilityGap | ManualInput | PlaybookOffer | InfoCard | VerdictCard | Activity | ErrorEvent | { type: 'text'; text: string };

interface AssistantMessage {
  role: 'assistant';
  text: string;
  events: RenderEvent[];
  ts: number;
  toolTotalMs?: number | null;
  toolTotalLabel?: string | null;
  slowestTool?: { name: string; label: string; durationMs: number; durationLabel: string | null } | null;
  /** The model's reasoning summary for each round that emitted one (Anthropic
      summarized thinking), in order. Folded into one collapsed "How I worked
      this out" panel; null when the model emitted none (standard models, the
      OpenAI/FortiAI proxy) so the panel never shows empty. */
  _reasoning?: string[] | null;
  /** Analyst's open/closed choice for the reasoning panel; carried across the
      live preview rebuilds by _mergeUiState so the panel doesn't snap shut. */
  _reasoningOpen?: boolean;
}

interface FsrPbRenderAPI {
  formatDuration: (ms: unknown) => string | null;
  troubleshootFromResult: (raw: unknown, opts?: { cardId?: string }) => any | null;
  seedFieldValues: (fields: unknown) => Record<string, unknown>;
  normalizeManualFields: (fields: unknown) => any[];
  normalizeManualButtons: (buttons: unknown) => ManualInputButton[];
  manualInputComplete: (card: any) => boolean;
  manualInputExpiry: (card: any, nowMs: number) => ManualInputExpiry | null;
  dynamicListItems: (field: any, group: unknown) => string[];
  normalizeSeverity: (s: unknown) => Severity;
  normalizeBlocks: (blocks: unknown) => Block[];
  normalizeInfoCard: (ev: unknown, opts?: RenderOptions) => InfoCard;
  normalizeActionCard: (ev: unknown, opts?: RenderOptions) => ActionCard;
  normalizeVerdictCard: (ev: unknown, opts?: RenderOptions) => VerdictCard;
  appendStreamFrame: (frames: any[], f: any) => void;
  narrationText: (text: unknown, fallback: string) => string;
  toolCallLabel: (name: unknown, input?: unknown) => string;
  mcpToolLabel: (name: unknown) => string;
  toolPartialLabel: (content: unknown) => string | null;
  dropRefusalText: (dropped: unknown) => string;
  plainDashes: (text: unknown) => string;
  dropRepeatedLines: (text: unknown) => string;
  _offerTrigger: (raw: unknown) => { label: string; manual: boolean } | null;
  _plainText: (raw: unknown) => string;
  resolveActionFields: (card: ActionCard | null, args?: Record<string, unknown>) => Field[];
  actionCardComplete: (card: ActionCard | null, args?: Record<string, unknown>) => boolean;
  actionCardNeedsConfig: (card: ActionCard | null) => boolean;
  applyConfigChoices: (card: ActionCard | null, raw: unknown) => boolean;
  actionCardBranchLabel: (card: ActionCard | null, args?: Record<string, unknown>) => string;
  actionCardArgSummary: (
    card: ActionCard | null,
    args?: Record<string, unknown>
  ) => Array<{ name: string; label: string; value: string }>;
  inferToolStatus: (s: unknown) => string;
  buildAssistantMessage: (events: unknown, opts?: RenderOptions) => AssistantMessage;
  applyCardDecisions: (messages: unknown, decisions: unknown) => any[];
  changeDiff: (after: unknown, before: unknown, hasBefore: boolean) => ChangeDiff | null;
  stepFrame: (type: unknown) => 'text' | 'framed' | 'bare';
}

// ─── Implementation ────────────────────────────────────────────────────────

// Canonical collapse length (chars): a tool result larger than this starts
// collapsed. The controller passes the same value explicitly
// (view.controller.js COLLAPSE_THRESHOLD); keep the two in sync -- they
// drifted (400 vs 600) and this is the fallback when no opts.collapseThreshold
// is passed.
const DEFAULT_COLLAPSE_THRESHOLD = 400;

function _now(opts?: RenderOptions): number {
  return (opts && typeof opts.now === 'function') ? opts.now() : Date.now();
}

function _copy(v: unknown): unknown {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/* The run card's "always allow" offer: `{persona, playbook}` with both set,
   else null. */
function _alwaysAllow(v: unknown): { persona: string; playbook: string } | null {
  const o = (v && typeof v === 'object') ? v as any : null;
  if (!o || typeof o.persona !== 'string' || !o.persona
      || typeof o.playbook !== 'string' || !o.playbook) return null;
  return { persona: o.persona, playbook: o.playbook };
}

/* A manual_input card's buttons: `{label, primary}` with a non-empty label,
   in the playbook's order. Anything else on the wire is dropped. */
function normalizeManualButtons(buttons: unknown): ManualInputButton[] {
  return (Array.isArray(buttons) ? buttons : []).filter(function (b: any) {
    return b && typeof b === 'object' && typeof b.label === 'string' && b.label.trim();
  }).map(function (b: any) {
    return { label: b.label, primary: !!b.primary };
  });
}

/* Normalize a connector manual_input field into the shape the card template
   renders. Adds `control` (the widget control kind) and, for a dynamic_list
   (the generic FortiSOAR two-level dependent picker -- a group with nested
   items), the `groups` list. Unknown types degrade to a text box. */
function normalizeManualFields(fields: unknown): any[] {
  return (fields as any[] || []).map(function (f) {
    f = (f && typeof f === 'object') ? f : {};
    const name = f.name;
    const base: any = {
      name: name,
      label: f.label || name,
      tooltip: f.tooltip || '',
      required: f.required === true,
      default: f.default
    };
    switch (String(f.type || '').toLowerCase()) {
      case 'dynamic_list': {
        base.control = 'dynamic_list';
        base.groups = Array.isArray(f.groups) ? f.groups : [];
        break;
      }
      case 'checkbox':
      case 'boolean':
        base.control = 'checkbox';
        break;
      case 'select':
        base.control = 'select';
        base.options = f.options || [];
        break;
      case 'textarea':
        base.control = 'textarea';
        break;
      default:
        base.control = 'text';
    }
    return base;
  }).filter(function (f) { return f.name != null; });
}

/* Whether a manual_input card's REQUIRED fields are all satisfied -- the gate
   for its submit button (parity with actionCardComplete). Values live on
   card.values; a dynamic_list is satisfied only when BOTH its dependent selects
   (name__group / name__item helper keys) are chosen, a required checkbox must be
   checked, and every other required control needs a non-empty value. Optional
   fields never block. */
function manualInputComplete(card: any): boolean {
  const fields = (card && card.fields) || [];
  const values = (card && card.values) || {};
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f || !f.required) continue;
    if (f.control === 'dynamic_list') {
      if (!values[f.name + '__group'] || !values[f.name + '__item']) return false;
    } else if (f.control === 'checkbox') {
      if (values[f.name] !== true) return false;
    } else {
      const v = values[f.name];
      if (v == null || String(v).trim() === '') return false;
    }
  }
  return true;
}

/* The deadline on a manual_input gate, resolved against `nowMs`. Returns null
   when the gate has no deadline -- most manual_input steps set no timeout, and
   those cards must render exactly as they always have.

   A manual_input step CAN carry its own timeout (the metadata-source playbook:
   one minute). Once it lapses the run continues down its timeout branch and a
   later submit can never land -- it retrieves as `{}` and the analyst is told
   nothing, so the gate reads as accepted when it was abandoned. The connector
   sends both halves of the deadline and, until now, the widget read neither.

   Prefer the ABSOLUTE `expires_at`: `expires_in_seconds` was computed when the
   connector built the frame, so by the time this card renders -- and especially
   when it is rebuilt from history on a reload -- it is already stale. The
   relative value is the fallback, and it is anchored to when the card was first
   seen (`_seenAtMs`) rather than to now, so a replayed card does not silently
   restart its own countdown. */
function manualInputExpiry(card: any, nowMs: number): ManualInputExpiry | null {
  if (!card) return null;
  const now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
  let deadlineMs: number | null = null;
  const at = card.expiresAt;
  if (at != null && at !== '') {
    const parsed = Date.parse(String(at));
    if (!isNaN(parsed)) deadlineMs = parsed;
  }
  if (deadlineMs == null) {
    const left = card.expiresInSeconds;
    if (typeof left === 'number' && isFinite(left)) {
      const anchor = (typeof card._seenAtMs === 'number' && isFinite(card._seenAtMs))
        ? card._seenAtMs : now;
      deadlineMs = anchor + (left * 1000);
    }
  }
  if (deadlineMs == null) return null;
  const secondsLeft = Math.max(0, Math.floor((deadlineMs - now) / 1000));
  const expired = secondsLeft <= 0;
  return {
    deadlineMs: deadlineMs,
    secondsLeft: secondsLeft,
    expired: expired,
    label: expired ? '' : _countdownLabel(secondsLeft)
  };
}

/* "4m 12s" / "48s" -- a countdown the analyst reads at a glance. Deliberately
   not formatDuration(): that one describes how long a tool TOOK. */
function _countdownLabel(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

/* The items offered for the group currently picked in a dynamic_list field --
   the dependent second select. Returns [] until a group is chosen. */
function dynamicListItems(field: any, group: unknown): string[] {
  const groups = (field && field.groups) || [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const v = (g && typeof g === 'object') ? g.value : g;
    if (v === group) return (g && Array.isArray(g.options)) ? g.options : [];
  }
  return [];
}

function seedFieldValues(fields: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  (fields as any[] || []).forEach(function (f) {
    if (!f || typeof f !== 'object' || (f as any).name == null) return;
    const name = (f as any).name;
    const ctrl = String((f as any).control || (f as any).type || '').toLowerCase();
    if (ctrl === 'checkbox' || ctrl === 'boolean') {
      out[name] = (f as any).default != null ? (f as any).default : false;
    } else if (ctrl === 'dynamic_list') {
      // Two helper keys drive the dependent selects; the submit path collapses
      // them into values[name] = [group, item]. Seed both empty.
      out[name + '__group'] = '';
      out[name + '__item'] = '';
    } else {
      out[name] = (f as any).default != null ? (f as any).default : '';
    }
  });
  return out;
}

function _paramControl(t: unknown): ControlKind {
  switch (String(t || '').toLowerCase()) {
    case 'select': return 'select';
    case 'multiselect': return 'multiselect';
    case 'checkbox':
    case 'boolean':
    case 'bool': return 'checkbox';
    case 'integer': return 'integer';
    case 'number': return 'number';
    case 'json':
    case 'object': return 'json';
    case 'textarea':
    case 'bigtext':
    case 'richtext': return 'textarea';
    case 'password': return 'password';
    default: return 'text';
  }
}

function _parseDefault(v: unknown): unknown {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return '';
    try { return JSON.parse(s); } catch (e) { return v; }
  }
  return v;
}

function _normalizeOptions(raw: unknown): Array<{ value: unknown; label: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map(function (o) {
    if (o && typeof o === 'object') {
      return { value: (o as any).value != null ? (o as any).value : (o as any).label, label: (o as any).label != null ? (o as any).label : (o as any).value };
    }
    return { value: o, label: o };
  });
}

function _visibilityFromGroups(groups: unknown): { always: string[]; when: Record<string, string[]> } {
  const when: Record<string, string[]> = {};
  Object.keys(groups || {}).forEach(function (sel) {
    const g = (groups as any)[sel] || {};
    Object.keys(g).forEach(function (opt) {
      if (opt.charAt(0) === '_') return;
      const branch = g[opt] || {};
      const params = branch.params || [];
      if (params.length) when[sel + '=' + opt] = params.slice();
      const nested = branch.nested_selects || {};
      Object.keys(nested).forEach(function (childSel) {
        const byOpt = nested[childSel] || {};
        Object.keys(byOpt).forEach(function (childOpt) {
          when[childSel + '=' + childOpt] = (byOpt[childOpt] || []).slice();
        });
      });
    });
  });
  return { always: [], when: when };
}

/** Connector param help (description/tooltip/placeholder) is authored for the
 *  playbook designer, not the analyst, so it carries paths and ids the house
 *  rule keeps out of analyst-facing text. Keep the readable sentence, strip the
 *  machine bits: record IRIs become "the X record" (`_derecord`), Jinja
 *  expressions and bare /api/3/ paths are removed. Deliberately conservative --
 *  it does not touch dotted prose, only unambiguous path/template tokens. */
function _cleanParamHelp(text: unknown): string {
  let s = _derecord(text);
  s = s.replace(/\{\{[^}]*\}\}/g, '');                 // {{ vars.input.records }}
  s = s.replace(/\/?api\/3\/[A-Za-z0-9_\/-]+/g, '');   // /api/3/alerts, bare paths
  return s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

function _normalizeParam(p: unknown): Field {
  const param = (p && typeof p === 'object') ? p as any : {};
  const name = param.name || param.param_name;
  const ctrl = _paramControl(param.type);
  return {
    name: name,
    // A connector-supplied `title` is already analyst-facing; without one, show
    // a humanized key ("Time to live"), never the raw `time_to_live` param id.
    label: param.title || _humanizeArgKey(name),
    type: ctrl,
    required: !!param.required,
    editable: param.editable !== false,
    schemaVisible: param.visible !== false && param.visible !== 0,
    default: _parseDefault(param['default'] != null ? param['default'] : param.default_value),
    options: (ctrl === 'select' || ctrl === 'multiselect') ? _normalizeOptions(param.options || param.options_json) : [],
    description: _cleanParamHelp(param.description),
    tooltip: _cleanParamHelp(param.tooltip),
    placeholder: _cleanParamHelp(param.placeholder)
  };
}

function normalizeActionCard(ev: unknown, opts?: RenderOptions): ActionCard {
  const event = (ev as any) || {};
  const args = _copy(event.args || {}) as Record<string, unknown>;
  const rawSchema = Array.isArray(event.param_schema) ? event.param_schema
    : (Array.isArray(event.params) ? event.params : null);
  const editable = Array.isArray(event.editable_fields) ? event.editable_fields : null;

  const paramSchema: Field[] = [];
  const paramIndex: Record<string, Field> = {};
  (rawSchema || []).forEach(function (p: unknown) {
    const f = _normalizeParam(p);
    if (!f.name) return;
    paramSchema.push(f);
    paramIndex[f.name] = f;
  });

  let visibility: { always: string[]; when: Record<string, string[]> } | null = event.visibility && (event.visibility.always || event.visibility.when)
    ? { always: (event.visibility.always || []).slice(), when: event.visibility.when || {} }
    : (event.param_groups_by_select ? _visibilityFromGroups(event.param_groups_by_select) : null);

  if (paramSchema.length && !visibility) {
    visibility = {
      always: paramSchema.filter(function (f) { return f.schemaVisible; }).map(function (f) { return f.name; }),
      when: {}
    };
  }

  const legacyNames: string[] = [];
  (editable || (paramSchema.length ? [] : Object.keys(args))).forEach(function (k: string) {
    if (!paramIndex[k]) legacyNames.push(k);
  });
  const legacyReq = (Array.isArray(event.required_fields) && event.required_fields.length)
    ? event.required_fields : (paramSchema.length ? [] : legacyNames);
  const legacyReqSet: Record<string, boolean> = {};
  legacyReq.forEach(function (n: string) { legacyReqSet[n] = true; });
  const legacyFields = legacyNames.map(function (k: string) {
    return {
      name: k, label: _humanizeArgKey(k), type: 'text' as ControlKind, required: !!legacyReqSet[k],
      options: [], description: '', tooltip: '', placeholder: '', editable: true,
      schemaVisible: true, default: undefined
    };
  });

  const configOptions = _cardConfigOptions(event.config_options);
  const runsOn = _cardConfig(event.config);

  return {
    type: 'action_card',
    cardId: event.id || ('action-' + _now(opts)),
    connector: event.connector || '',
    operation: event.operation || '',
    summary: _cleanActionSummary(event.summary, event.connector || '', event.operation || ''),
    args: args,
    editableFields: editable || Object.keys(args),
    paramSchema: paramSchema,
    paramIndex: paramIndex,
    visibility: visibility,
    legacyFields: legacyFields,
    target: _writeTarget(event.target),
    changes: _writeChanges(event.changes),
    contextMatch: _contextMatch(event.context_match),
    batch: _cardBatch(event.batch),
    confirmLabel: _batchConfirmLabel(event.batch),
    batchHeading: _batchHeading(event.batch),
    runsOn: runsOn,
    configOptions: configOptions,
    configId: runsOn ? runsOn.id : '',
    configRequired: event.config_required === true && !runsOn,
    _open: true,
    _resolved: false,
    _outcome: null,
    display: event.summary || ''
  };
}

// --- where an approved action runs ------------------------------------------
//
// A connector configuration, as the card offers it. An agent-bound config runs
// the action on a FortiSOAR agent (it reaches targets the master cannot), and
// that is slower: the card says so before the analyst approves.

interface CardConfig {
  id: string;
  name: string;
  runsOnAgent: boolean;
  agentName: string;
  isDefault: boolean;
  /** "Lab FortiGate (on agent fsr-agent-80)" -- what the picker and the line show. */
  label: string;
}

function _cardConfig(raw: unknown): CardConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as any;
  const id = String(c.id || '');
  if (!id) return null;
  const name = String(c.name || id);
  const agentName = String(c.agent_name || '');
  const runsOnAgent = !!c.runs_on_agent;
  let label = name;
  if (runsOnAgent && name.indexOf(agentName) === -1) {
    label = name + ' (on agent ' + (agentName || 'a FortiSOAR agent') + ')';
  } else if (runsOnAgent && agentName) {
    label = name + ' (FortiSOAR agent)';
  }
  return { id: id, name: name, runsOnAgent: runsOnAgent, agentName: agentName,
           isDefault: !!c.default, label: label };
}

function _cardConfigOptions(raw: unknown): CardConfig[] {
  if (!Array.isArray(raw)) return [];
  const out = raw.map(_cardConfig).filter(function (c): c is CardConfig { return !!c; });
  return out.length > 1 ? out : [];
}

// The connector refused an approval that named no configuration and sent the
// ones it would take. Re-show the picker with them and keep the card open.
// Returns false when the choices name nothing the analyst could pick.
function applyConfigChoices(card: ActionCard | null, raw: unknown): boolean {
  if (!card || !Array.isArray(raw)) return false;
  const opts = raw.map(_cardConfig).filter(function (c): c is CardConfig { return !!c; });
  if (!opts.length) return false;
  card.configOptions = opts;
  card.configRequired = true;
  card.configId = '';
  return true;
}

// True while the card must be given a configuration and has none.
function actionCardNeedsConfig(card: ActionCard | null): boolean {
  return !!card && card.configRequired === true && !card.configId;
}

// --- run context on a run_playbook approval --------------------------------
//
// The connector has always carried this structurally AND appended a slice of it
// to the summary text, with a comment saying the append exists because no card
// layout rendered the structured form. This is that layout, so the append is
// now duplication -- stripped here rather than in the connector, because
// removing it there would blank the line on every widget older than this one.
// Once every box is on a widget that renders `runContext`, the connector can
// stop appending and this strip becomes a no-op.

function _runContext(raw: unknown): ApprovalRequest['runContext'] {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as any;
  const lastRun = String(c.last_run || '');
  const runsTotal = typeof c.runs_total === 'number' ? c.runs_total : null;
  const runs24h = typeof c.runs_24h === 'number' ? c.runs_24h : null;
  // Nothing to say is not the same as "never run" -- a context block with no
  // counts at all (an older connector, or a lookup that failed) must render
  // nothing rather than assert a history it does not have.
  if (!lastRun && runsTotal === null && runs24h === null) return null;
  return {
    lastRun: lastRun,
    lastStatus: String(c.last_status || ''),
    runs24h: runs24h,
    runsTotal: runsTotal,
    // The connector writes the literal string "never" when no historical run
    // exists. Treat a zero total the same way.
    neverRun: lastRun === 'never' || runsTotal === 0
  };
}

function _summaryWithoutRunContext(summary: string, raw: unknown): string {
  if (!summary || !raw || typeof raw !== 'object') return summary;
  // Only the two segments the connector appends, anchored to the ' \u00b7 '
  // separator it joins with -- never a general trim, or a summary that happens
  // to discuss a last run would lose its own words.
  return summary
    .replace(/\s*\u00b7\s*Last run:[^\u00b7]*/i, '')
    .replace(/\s*\u00b7\s*\d+\s+runs?\s+in\s+the\s+last\s+24h/i, '')
    .trim();
}

// --- record-write shaping (connector #78/#120) -----------------------------
//
// The connector ships `target` / `changes` / `context_match` on create/update/
// delete_record approvals so the analyst reads WHICH RECORD and WHAT CHANGES
// instead of a uuid in an args dump. The widget dropped all three on the floor
// for as long as they have been sent -- the producer was live and the consumer
// did not exist, which reads from either side as the feature being absent.
//
// Normalized here rather than in the template for the reason every other
// normalizer in this file exists: the template assumes a shape, and a connector
// that sends a bare string or omits a key renders blank rather than wrong,
// which is the harder bug to see.

/** What a call parked on an action card is doing until the analyst decides. */
const _PROPOSED_LABELS: Record<string, string> = {
  update_record: 'Proposed a record update',
  create_record: 'Proposed a new record',
  delete_record: 'Proposed deleting a record',
};

function _writeTarget(raw: unknown): ActionCard['target'] {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as any;
  const module = String(t.module || '');
  if (!module) return null;   // a target with no module identifies nothing
  // `label` is what the card prints. `module` and `uuid` are ids: kept for the
  // widget's own use, never shown (live, a card printed "alerts" and the full
  // uuid under the record's name). An older connector sends no module_label.
  const label = String(t.module_label || '') || _humanizeArgKey(_singular(module));
  return { module: module, uuid: String(t.uuid || ''), name: String(t.name || ''), label: label };
}

function _singular(mod: string): string {
  return /s$/i.test(mod) && !/ss$/i.test(mod) ? mod.slice(0, -1) : mod;
}

/** A change's value as the card prints it. The connector resolves record IRIs
 *  to labels; an older one sent the new value raw ("High -> /api/3/picklists/
 *  <uuid>"), so a bare IRI that still arrives says what kind of value it is. */
function _changeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(_changeValue);
  if (typeof v !== 'string') return v;
  const m = /^\/?api\/3\/([a-z][a-z_]*)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(v.trim());
  if (!m) return v;
  return m[1].toLowerCase() === 'picklists' ? 'an unknown picklist option' : 'an unknown related record';
}

function _writeChanges(raw: unknown): ActionCard['changes'] {
  if (!Array.isArray(raw)) return [];
  const out: ActionCard['changes'] = [];
  raw.forEach(function (c: any) {
    if (!c || typeof c !== 'object' || !c.field) return;
    const row: WriteChange = { field: String(c.field), label: _humanizeArgKey(c.field), after: _changeValue(c.after) };
    // `before` is absent on creates and MAY be absent on updates. Distinguish
    // "no prior value" from "prior value was empty" -- rendering "" -> "x" as
    // if we knew the old value is a claim about the record we cannot make.
    const hasBefore = Object.prototype.hasOwnProperty.call(c, 'before');
    if (hasBefore) row.before = _changeValue(c.before);
    const diff = changeDiff(row.after, hasBefore ? row.before : undefined, hasBefore);
    if (diff) {
      row.diff = diff;
      row._open = diff.lines.length <= DIFF_OPEN_MAX;
    }
    out.push(row);
  });
  return out;
}

// --- what a write changes, line by line ---------------------------------------
//
// Live: an update to a 3,000-character Jinja template showed the whole old value
// struck through, an arrow, and the whole new value -- unreadable, and the
// field named "outputtemplatejson". A long or multi-line value now shows the
// lines that change with two lines of context around them, and a one-line
// summary ("4 lines changed: 3 added, 1 removed"). Short values keep the
// old -> new line.

interface DiffLine { op: 'ctx' | 'add' | 'del' | 'gap'; text: string }
interface ChangeDiff { lines: DiffLine[]; added: number; removed: number; summary: string }
interface WriteChange {
  field: string; label: string; before?: unknown; after: unknown;
  diff?: ChangeDiff; _open?: boolean;
}

/** A value shorter than this, on one line, keeps the inline old -> new row. */
const DIFF_INLINE_MAX = 80;
/** Lines of unchanged text kept around each change. */
const DIFF_CONTEXT = 2;
/** A diff this short or shorter starts open; a longer one starts collapsed. */
const DIFF_OPEN_MAX = 40;
/** Rendered lines past this are summarized. */
const DIFF_LINES_MAX = 400;
/** Past this many cells the line matcher falls back to "all replaced". */
const DIFF_CELLS_MAX = 250000;

function _diffText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
}

function _diffOps(a: string[], b: string[]): DiffLine[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre
         && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const mid: DiffLine[] = [];
  if (am.length * bm.length > DIFF_CELLS_MAX) {
    am.forEach(function (t) { mid.push({ op: 'del', text: t }); });
    bm.forEach(function (t) { mid.push({ op: 'add', text: t }); });
  } else {
    // Longest common subsequence, then walk it.
    const n = am.length, m = bm.length;
    const L: number[][] = [];
    for (let i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i][j] = am[i] === bm[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { mid.push({ op: 'ctx', text: am[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { mid.push({ op: 'del', text: am[i++] }); }
      else { mid.push({ op: 'add', text: bm[j++] }); }
    }
    while (i < n) mid.push({ op: 'del', text: am[i++] });
    while (j < m) mid.push({ op: 'add', text: bm[j++] });
  }
  const out: DiffLine[] = [];
  a.slice(0, pre).forEach(function (t) { out.push({ op: 'ctx', text: t }); });
  mid.forEach(function (l) { out.push(l); });
  a.slice(a.length - suf).forEach(function (t) { out.push({ op: 'ctx', text: t }); });
  return out;
}

/** Keep DIFF_CONTEXT unchanged lines around each change; fold the rest. */
function _foldContext(ops: DiffLine[]): DiffLine[] {
  const keep = ops.map(function () { return false; });
  ops.forEach(function (l, i) {
    if (l.op === 'ctx') return;
    for (let k = Math.max(0, i - DIFF_CONTEXT); k <= Math.min(ops.length - 1, i + DIFF_CONTEXT); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  ops.forEach(function (l, i) {
    if (keep[i]) {
      if (skipped) out.push({ op: 'gap', text: skipped + ' unchanged line' + (skipped === 1 ? '' : 's') });
      skipped = 0;
      out.push(l);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ op: 'gap', text: skipped + ' unchanged line' + (skipped === 1 ? '' : 's') });
  return out;
}

/** Split long one-line text at JSON/Jinja boundaries so a diff has lines to
 *  work with: a template saved on one line is still many statements. */
function _diffLines(t: string): string[] {
  const lines = t.split(/\r?\n/);
  if (lines.length > 1 || t.length <= DIFF_INLINE_MAX) return lines;
  return t.replace(/(%\}|\}\}|[,;])\s*/g, '$1\n').split('\n')
    .filter(function (x) { return x !== ''; });
}

/**
 * The line diff for one written field, or null when the inline old -> new row
 * reads fine (both values short and on one line). `hasBefore` false means the
 * record had no prior value to compare (a create): every line is new.
 */
function changeDiff(after: unknown, before: unknown, hasBefore: boolean): ChangeDiff | null {
  const b = _diffText(after);
  const a = hasBefore ? _diffText(before) : '';
  const short = function (t: string) { return t.length <= DIFF_INLINE_MAX && t.indexOf('\n') === -1; };
  if (short(b) && short(a)) return null;
  const ops = hasBefore && a !== '' ? _diffOps(_diffLines(a), _diffLines(b))
    : _diffLines(b).map(function (t) { return { op: 'add' as const, text: t }; });
  const added = ops.filter(function (l) { return l.op === 'add'; }).length;
  const removed = ops.filter(function (l) { return l.op === 'del'; }).length;
  let lines = _foldContext(ops);
  if (lines.length > DIFF_LINES_MAX) {
    const more = lines.length - DIFF_LINES_MAX;
    lines = lines.slice(0, DIFF_LINES_MAX).concat([{ op: 'gap', text: more + ' more lines not shown' }]);
  }
  const plural = function (n: number, w: string) { return n + ' ' + w + (n === 1 ? '' : 's'); };
  let summary: string;
  if (!hasBefore || a === '') summary = 'New value, ' + plural(added, 'line');
  else if (!added && !removed) summary = 'No change';
  else summary = plural(Math.max(added, removed), 'line') + ' changed: '
    + added + ' added, ' + removed + ' removed';
  return { lines: lines, added: added, removed: removed, summary: summary };
}

// --- batched approval -------------------------------------------------------
//
// The connector lists the gated calls the model emitted together on ONE card
// (`batch`: {tool, args, summary, target, changes}). Each row is labelled by
// the record's own name when it has one: the connector's summary for all seven
// rows of a profile build is the same "Create <module>" line, which tells the
// analyst nothing about which step is which.

function _batchRows(raw: unknown): any[] {
  return Array.isArray(raw) ? raw.filter(function (b: any) { return b && typeof b === 'object'; }) : [];
}

function _cardBatch(raw: unknown): ActionCard['batch'] {
  return _batchRows(raw).map(function (b: any) {
    const changes = _writeChanges(b.changes);
    const named = changes.filter(function (c) { return c.field === 'name'; })[0];
    const label = named && named.after != null && String(named.after) !== ''
      ? String(named.after) : String(b.summary || b.tool || 'Change');
    return {
      label: label,
      changes: changes.filter(function (c) { return c.field !== 'name'; })
        .map(function (c) { return { field: c.field, after: c.after }; })
    };
  });
}

function _batchConfirmLabel(raw: unknown): string {
  const n = _batchRows(raw).length;
  return n ? 'Approve all ' + (n + 1) : 'Confirm & Execute';
}

function _batchHeading(raw: unknown): string {
  const n = _batchRows(raw).length;
  if (!n) return '';
  return 'This approval also covers ' + n + ' more change' + (n === 1 ? '' : 's') + ':';
}

function _contextMatch(raw: unknown): string {
  const v = String(raw == null ? '' : raw);
  // Anything we do not recognise is 'unknown', never 'same'. A future value the
  // widget has not learned yet must not fall through into reassurance.
  return (v === 'same' || v === 'different') ? v : 'unknown';
}

// capability_gap normalizers (C2). The connector may send tips/alternatives/
// fix_steps either as bare strings or as objects; the template assumes object
// shapes (tip.text/.hint, alt.label/.value/.hint), so an un-normalized bare
// string rendered BLANK and an alternative with no `value` resumed the turn with
// `undefined`. Normalize every shape into the template's contract here.
function _capgapFixSteps(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).map(function (s: any) {
    if (s == null) return '';
    if (typeof s === 'string') return s;
    return String(s.text || s.label || s.value || '');
  }).filter(function (s) { return s !== ''; });
}
function _capgapTips(raw: unknown): Array<{ text: string; hint: string }> {
  return (Array.isArray(raw) ? raw : []).map(function (t: any) {
    if (t == null) return { text: '', hint: '' };
    if (typeof t === 'string') return { text: t, hint: '' };
    return { text: String(t.text || t.label || t.value || ''), hint: String(t.hint || '') };
  }).filter(function (t) { return t.text !== '' || t.hint !== ''; });
}
function _capgapAlternatives(raw: unknown): Array<{ label: string; value: string; hint: string }> {
  return (Array.isArray(raw) ? raw : []).map(function (a: any) {
    if (a == null) return null;
    if (typeof a === 'string') return { label: a, value: a, hint: '' };
    const label = String(a.label || a.value || '');
    const value = String(a.value != null ? a.value : (a.label != null ? a.label : ''));
    // Drop an alternative with no usable value -- a button that resumes with an
    // empty/undefined value is worse than not offering it.
    if (value === '') return null;
    return { label: label || value, value: value, hint: String(a.hint || '') };
  }).filter(function (a): a is { label: string; value: string; hint: string } { return a !== null; });
}
function _capgapResume(raw: unknown): { label: string; value: string } {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, any>;
    return {
      label: String(r.label || 'Re-check & continue'),
      value: String(r.value != null && r.value !== '' ? r.value : 'recheck')
    };
  }
  if (typeof raw === 'string' && raw !== '') return { label: raw, value: raw };
  return { label: 'Re-check & continue', value: 'recheck' };
}

const _APPROVAL_MAX = 2000;
function _capApprovalText(s: unknown): string {
  let str = String(s == null ? '' : s);
  if (str.length <= _APPROVAL_MAX) return str;
  return str.slice(0, _APPROVAL_MAX) + '\n… [+' + (str.length - _APPROVAL_MAX) + ' chars truncated]';
}

// Enhancement diff rows are read by an analyst deciding whether to Apply, so
// they print the step the way the designer thinks about it: indented
// `key: value` lines (never JSON inside YAML), empty keys dropped, and every
// string held to one short line. Live, a connector step's stored `mock_result`
// is a 20k-char JSON string of escaped WHOIS text; printed raw it buried the
// one line that changed.
const _DIFF_VALUE_MAX = 120;
const _DIFF_LINES_MAX = 40;

function _isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

// A record IRI anywhere in a string reads as the kind of record ("People
// record"); a bare uuid reads as "an item". The ids stay in Show YAML.
function _scrubIds(s: string): string {
  return s
    .replace(/\/api\/3\/([a-z][a-z0-9_]*)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      function (_m: string, mod: string): string { return _humanizeArgKey(mod) + ' record'; })
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'an item');
}

function _diffScalar(v: unknown): string {
  if (typeof v !== 'string') return String(v);
  const one = _scrubIds(v).replace(/\s+/g, ' ').trim();
  if (one.length <= _DIFF_VALUE_MAX) return one;
  return one.slice(0, _DIFF_VALUE_MAX - 1) + '… (' + v.length + ' chars)';
}

function _yamlLines(v: unknown, pad: string, out: string[]): void {
  if (Array.isArray(v)) {
    v.forEach(function (item) {
      if (item !== null && typeof item === 'object') {
        const sub: string[] = [];
        _yamlLines(item, '', sub);
        sub.forEach(function (ln, i) { out.push(pad + (i === 0 ? '- ' : '  ') + ln); });
      } else {
        out.push(pad + '- ' + _diffScalar(item));
      }
    });
    return;
  }
  const obj = v as Record<string, unknown>;
  Object.keys(obj).forEach(function (k) {
    const val = obj[k];
    if (_isEmptyValue(val)) return;
    if (typeof val === 'object') {
      out.push(pad + k + ':');
      _yamlLines(val, pad + '  ', out);
    } else {
      out.push(pad + k + ': ' + _diffScalar(val));
    }
  });
}

function _capLines(lines: string[]): string {
  if (lines.length <= _DIFF_LINES_MAX) return lines.join('\n');
  return lines.slice(0, _DIFF_LINES_MAX).join('\n')
    + '\n… ' + (lines.length - _DIFF_LINES_MAX) + ' more lines';
}

// A whole step (an add or a remove) as readable text.
function _projectionText(proj: unknown): string {
  if (proj === null || proj === undefined) return '';
  if (typeof proj !== 'object') return String(proj);
  const lines: string[] = [];
  _yamlLines(proj, '', lines);
  return _capLines(lines);
}

// A step input as the analyst reads it, never as JSON: a list is its items
// joined by "; ", a chat message is "role: text", any other object is
// "Label: value" pairs. A string that is itself a JSON list or object is read
// the same way. Anything else is the scalar reading.
function _plainValue(v: unknown, depth?: number): string {
  const d = depth || 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (d < 3 && (t.charAt(0) === '[' || t.charAt(0) === '{')) {
      try {
        const parsed = JSON.parse(t);
        if (parsed !== null && typeof parsed === 'object') return _plainValue(parsed, d + 1);
      } catch (e) { /* a template such as {{ x }}, not JSON: keep as written */ }
    }
    return _scrubIds(v);
  }
  if (v === null || typeof v !== 'object') return _approvalValue(v);
  if (d >= 3) return '(nested details)';
  if (Array.isArray(v)) {
    return v.filter(function (x) { return !_isEmptyValue(x); })
      .map(function (x) { return _plainValue(x, d + 1); }).join('; ');
  }
  const o = v as Record<string, unknown>;
  if (typeof o.role === 'string' && o.content !== undefined && Object.keys(o).length === 2) {
    return o.role + ': ' + _plainValue(o.content, d + 1);
  }
  return Object.keys(o).filter(function (k) { return !_isEmptyValue(o[k]); })
    .map(function (k) { return _humanizeArgKey(k) + ': ' + _plainValue(o[k], d + 1); }).join(', ');
}

/* U6 naming rule: a connector id ("fortinet-fortiguard-threat-intelligence")
   is never shown. The catalog display label wins: the offer's `connector_labels`
   map (id -> label), or a `connector_label` on the row. With neither, the id is
   humanized: "fortinet-fortiguard-threat-intelligence" reads "Fortinet Fortiguard
   Threat Intelligence". Configuration names and template expressions are not
   ids; they are the substance of a change and stay as written. */
type ConnLabels = Record<string, string>;
function _connectorLabel(id: unknown, labels?: ConnLabels): string {
  const raw = String(id == null ? '' : id).trim();
  if (!raw) return '';
  const hit = labels && labels[raw];
  if (typeof hit === 'string' && hit.trim()) return hit.trim();
  return raw.split(/[-_\s]+/).filter(function (w: string) { return w.length > 0; })
    .map(function (w: string) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
}
function _connLabelsOf(offer: any, rows: any[]): ConnLabels {
  const out: ConnLabels = {};
  const m = offer && offer.connector_labels;
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    Object.keys(m).forEach(function (k) { if (typeof m[k] === 'string') out[k] = m[k]; });
  }
  rows.forEach(function (r: any) {
    ['before', 'after'].forEach(function (side: string) {
      const a = r && r[side] && r[side].arguments;
      if (a && typeof a.connector === 'string' && typeof a.connector_label === 'string' && a.connector_label.trim()) {
        out[a.connector] = a.connector_label.trim();
      }
    });
    if (r && typeof r.connector === 'string' && typeof r.connector_label === 'string' && r.connector_label.trim()) {
      out[r.connector] = r.connector_label.trim();
    }
  });
  return out;
}

// A whole added or removed step as the analyst reads it, not as YAML: what it
// does, which connection it uses, its inputs as labelled lines, and what runs
// next. The exact YAML stays behind Show YAML. A projection this does not
// recognise (playbook-level rows, unknown shapes) falls back to
// `_projectionText`, so no row ever renders empty.
function _plainStepText(proj: unknown, labels?: ConnLabels): string {
  if (!proj || typeof proj !== 'object' || Array.isArray(proj)) return _projectionText(proj);
  const p = proj as Record<string, any>;
  if (typeof p.type !== 'string') return _projectionText(proj);
  const a: Record<string, any> = (p.arguments && typeof p.arguments === 'object') ? p.arguments : {};
  const lines: string[] = [];
  const val = function (v: unknown): string {
    return _diffScalar(_plainValue(v));
  };
  const inputs = function (obj: unknown, skip: string[]): void {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    Object.keys(obj as Record<string, unknown>).forEach(function (k) {
      const v = (obj as Record<string, unknown>)[k];
      if (skip.indexOf(k) >= 0 || _isEmptyValue(v)) return;
      lines.push(_humanizeArgKey(k) + ': ' + val(v));
    });
  };
  const t = p.type;
  if (t === 'connector') {
    lines.push('Runs ' + _humanizeArgKey(a.operation || 'an action').toLowerCase()
      + (a.connector ? ' on ' + _connectorLabel(a.connector, labels) : ''));
    if (!_isEmptyValue(a.config)) lines.push('Configuration: ' + val(a.config));
    inputs(a.params, []);
  } else if (t === 'set_variable') {
    const list = Array.isArray(a.arg_list) ? a.arg_list
      : Object.keys(a).filter(function (k) { return k !== 'step_variables'; })
        .map(function (k) { return { name: k, value: a[k] }; });
    list.forEach(function (it: any) {
      if (it && it.name) lines.push('Saves ' + it.name + ' as ' + val(it.value));
    });
  } else if (/^start/.test(t)) {
    if (a.button_label) lines.push('Button: ' + val(a.button_label));
    if (a.module) lines.push('On: ' + _humanizeArgKey(a.module).toLowerCase());
    inputs(a, ['button_label', 'module', 'step_variables']);
  } else if (t === 'create_record' || t === 'update_record') {
    lines.push((t === 'create_record' ? 'Creates' : 'Updates') + ' a record'
      + (a.module ? ' in ' + _humanizeArgKey(a.module).toLowerCase() : ''));
    inputs(a.resource, []);
    inputs(a, ['module', 'resource', 'step_variables']);
  } else {
    inputs(a, ['step_variables']);
  }
  if (p.for_each) lines.push('Repeats for each item');
  const br = (p.branches && typeof p.branches === 'object') ? p.branches : {};
  Object.keys(br).forEach(function (label) {
    lines.push('If ' + label + ', then: ' + _humanizeArgKey(br[label]));
  });
  if (p.next) lines.push('Then: ' + _humanizeArgKey(p.next));
  return lines.length ? _capLines(lines) : _projectionText(proj);
}

// Every scalar leaf of a projection, keyed by its path ("arguments.params.ip",
// "next", "branches[0].target").
function _leaves(v: unknown, path: string, out: Record<string, unknown>): void {
  if (Array.isArray(v)) {
    v.forEach(function (item, i) { _leaves(item, path + '[' + i + ']', out); });
    return;
  }
  if (v !== null && typeof v === 'object') {
    Object.keys(v as Record<string, unknown>).forEach(function (k) {
      _leaves((v as Record<string, unknown>)[k], path ? path + '.' + k : k, out);
    });
    return;
  }
  if (!_isEmptyValue(v)) out[path] = v;
}

// A projection path as the analyst reads it: "arguments.params.ip_addresses"
// is "IP addresses", "next" is "Then", "branches[0].target" is "Branches 1
// target". The path itself stays in Show YAML.
function _pathLabel(path: string): string {
  if (path === 'next') return 'Then';
  if (path === 'arguments.config') return 'Configuration';
  const trimmed = path.replace(/^arguments\./, '').replace(/^params\./, '')
    .replace(/\[(\d+)\]/g, function (_m: string, n: string): string { return '.' + (Number(n) + 1); });
  return _humanizeArgKey(trimmed);
}

// A modified step: only the values that changed, one `path: value` line per
// side. A key that exists on one side only reads as "(not set)" on the other.
function _modifiedText(before: unknown, after: unknown, labels?: ConnLabels): { before: string; after: string } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  _leaves(before, '', b);
  _leaves(after, '', a);
  const paths: string[] = [];
  Object.keys(b).concat(Object.keys(a)).forEach(function (p) {
    if (paths.indexOf(p) < 0 && String(b[p]) !== String(a[p])) paths.push(p);
  });
  const side = function (m: Record<string, unknown>): string {
    return _capLines(paths.map(function (p) {
      const isStep = p === 'next' || /(^|\.)target$/.test(p);
      const shown = !(p in m) ? '(not set)'
        : p === 'arguments.connector' ? _connectorLabel(m[p], labels)
        : isStep ? _humanizeArgKey(m[p]) : _diffScalar(_plainValue(m[p]));
      return _pathLabel(p) + ': ' + shown;
    }));
  };
  return paths.length ? { before: side(b), after: side(a) } : { before: '', after: '' };
}

// `diff_summary.changes` → the card's diff rows. The three name lists stay the
// header index; these rows are the half an analyst can actually read, which is
// the whole point: an Apply button over a YAML dump asks for approval of
// something nobody read.
const _EO_BADGE: Record<string, string> = {
  added: 'add', removed: 'del', modified: 'mod', renamed: 'mod',
  playbook_added: 'add', playbook_removed: 'del'
};
// One warning line for the enhancement card: the framework's plain sentence
// under the step it is about. The raw compiler message and JSON path stay out
// of the card; they are the model's to read, not the analyst's.
// What starts the playbook, as the offer card states it. The framework writes
// the sentence from the playbook's trigger step; the card shows it so the
// analyst approves the trigger along with the steps (an "on create" request
// came back as a manual button, and nothing on the card said so).
function _offerTrigger(raw: any): { label: string; manual: boolean } | null {
  if (!raw || typeof raw !== 'object' || !raw.label) return null;
  return { label: String(raw.label), manual: raw.manual === true };
}

/* Track U: the offer card's collapsed text is for the analyst. A sentence that
   still carries a field key, a template, or a record/step id is dropped from
   the collapsed view (it stays in Details); known field keys become words. */
const _PLAIN_FIELD_WORDS: Record<string, string> = {
  sourceIp: 'source IP', sourceIP: 'source IP',
  destinationIp: 'destination IP', destinationIP: 'destination IP'
};
function _hasTechToken(s: string): boolean {
  return /\{\{|\}\}|\{%|\b(?:toolu|call|offer|pb|pbo)_\w+|\b[0-9a-f]{8}-[0-9a-f]{4}-|\b[a-z0-9]+_[a-z0-9_]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(s);
}
function _plainText(raw: unknown): string {
  let t = String(raw == null ? '' : raw).replace(/`([^`]*)`/g, '$1');
  Object.keys(_PLAIN_FIELD_WORDS).forEach(function (k) { t = t.split(k).join(_PLAIN_FIELD_WORDS[k]); });
  const sentences = t.match(/[^.!?]+[.!?]*/g) || [];
  return sentences.map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0 && !_hasTechToken(s); }).join(' ');
}
/* A step or title label as words: "siem_search src" -> "Siem search src".
   Author wording (a host name, a capitalised label) is kept as sent. */
function _plainLabel(raw: unknown): string {
  const t = String(raw == null ? '' : raw).replace(/\{\{.*?\}\}/g, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}
/* A step label as a plain phrase: "Containment Target Present" -> "containment
   target present". Acronyms ("IP") and camel-case names keep their capitals. */
function _humanWords(raw: unknown): string {
  return _plainLabel(raw).split(' ').filter(function (w) { return w.length > 0; }).map(function (w) {
    const keep = (w.length > 1 && w === w.toUpperCase()) || /[A-Z]/.test(w.slice(1));
    return keep ? w : w.toLowerCase();
  }).join(' ');
}
/* The collapsed "What it does" list: plain steps only. Start, End and every
   set_variable are plumbing; a confirm step reads as a question to the analyst. */
function _plainSteps(ops: any[]): Array<{ text: string }> {
  const out: Array<{ text: string }> = [];
  ops.forEach(function (o: any) {
    if (o.stepType === 'start' || o.stepType === 'end' || o.stepType === 'set_variable') return;
    let text = o.plainLabel || '';
    if (o.stepType === 'manual_input') {
      text = /confirm|approve/i.test(o.label || '') ? 'Asks you to confirm' : 'Asks you to choose';
    } else if (o.stepType === 'decision') {
      text = o.label ? 'Checks whether ' + _humanWords(o.label) + '.' : '';
    }
    if (text) out.push({ text: text });
  });
  return out;
}
/* The safety row. A write (has_mutating_action, or an update/create/delete
   step) is "Changes"; the confirm wording comes from the presence of a confirm
   step. Otherwise it is read only. */
const _WRITE_VERBS: Record<string, boolean> = {
  block: true, unblock: true, quarantine: true, revoke: true, suspend: true, isolate: true,
  disable: true, enable: true, delete: true, remove: true, update: true, create: true, add: true,
  kill: true, terminate: true, reset: true, ban: true, blacklist: true, whitelist: true,
  write: true, change: true, set: true, send: true, submit: true, assign: true, close: true
};
/* A connector step is a write when its operation or label names a write verb
   (block_ip_new -> block). The framework flag can miss one: a stored offer
   with has_mutating_action false blocks an IP. Read steps (siem_search) stay read. */
function _connectorWrites(o: any): boolean {
  if (o.stepType !== 'connector') return false;
  return String((o.operation || '') + ' ' + (o.label || '')).toLowerCase()
    .split(/[^a-z]+/).some(function (tok) { return _WRITE_VERBS[tok] === true; });
}
function _safetyLine(ev: any, ops: any[]): { tone: string; text: string } {
  const writes = ops.some(function (o: any) {
    return o.stepType === 'update_record' || o.stepType === 'create_record' || o.stepType === 'delete_record'
      || _connectorWrites(o);
  });
  const confirm = ops.some(function (o: any) { return o.stepType === 'manual_input'; });
  return _safetyText(ev.has_mutating_action === true || writes, confirm);
}
function _safetyText(changes: boolean, confirm: boolean): { tone: string; text: string } {
  if (changes) {
    return { tone: 'warn', text: 'Changes things. ' + (confirm
      ? 'It waits for you to confirm before it changes anything.'
      : 'It runs without asking you first.') };
  }
  return { tone: 'safe', text: 'Read only. ' + (confirm
    ? 'It waits for your choice before it continues.'
    : 'It does not change the alert or block anything.') };
}

/* U5: the framework's `plain` block for a YAML offer (built from the verified
   YAML): what it does, changes, asks to confirm, and a capped summary. Each
   sentence goes through the same filter as the rest of the collapsed card. */
function _offerPlain(raw: any): { steps: Array<{ text: string }>; changes: boolean; askConfirm: boolean; summary: string } | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps.map(function (s: unknown) { return { text: _plainText(s) }; })
    .filter(function (s: { text: string }) { return s.text.length > 0; });
  return {
    steps: steps,
    changes: raw.changes === true,
    askConfirm: raw.asks_confirm === true,
    summary: _plainText(raw.summary)
  };
}

function _eoWarnings(raw: any, inChange: boolean): any[] {
  return (Array.isArray(raw) ? raw : []).map(function (w: any) {
    w = (w && typeof w === 'object') ? w : { message: String(w) };
    return {
      message: w.plain || w.message || '',
      step: w.step_name || '',
      inChange: w.in_change !== false
    };
  }).filter(function (w: any) { return w.message && w.inChange === inChange; });
}

/* runs_after_setup from the framework: [{connector, reason, message, setup_steps}].
   The connector id and reason enum are for the machine; the analyst reads the
   framework's plain message and the steps, so only those are kept. */
function _runsAfterSetup(raw: any): SetupNotice[] {
  return (Array.isArray(raw) ? raw : []).map(function (r: any): SetupNotice {
    r = (r && typeof r === 'object') ? r : {};
    return {
      message: typeof r.message === 'string' ? r.message : '',
      steps: (Array.isArray(r.setup_steps) ? r.setup_steps : [])
        .filter(function (s: any) { return typeof s === 'string' && s; })
    };
  }).filter(function (n: SetupNotice) { return n.message; });
}

/* U6: the change card's collapsed body. "What changes" is Adds / Changes /
   Removes lines read off the same rows the Details diff draws (so the lines
   cannot disagree with it); a card that carries no rows falls back to the
   framework's step-name lists. Step names go through _plainLabel, so no
   template, snake_case id or connection name reaches the collapsed text. */
const _EO_TAG: Record<string, string> = {
  added: 'New', playbook_added: 'New', removed: 'Removed', playbook_removed: 'Removed',
  modified: 'Changed', renamed: 'Changed'
};
const _EO_TYPE_PHRASE: Record<string, string> = {
  connector: 'runs an action', manual_input: 'asks you to confirm or choose',
  decision: 'checks a condition', set_variable: 'saves a value',
  workflow_reference: 'calls another playbook', create_record: 'creates a record',
  update_record: 'updates a record', delete_record: 'deletes a record',
  find_record: 'looks up records', code_snippet: 'runs a code snippet'
};
const _EO_FIELD_PHRASE: Record<string, string> = {
  arguments: 'its inputs', params: 'its inputs', next: 'what runs next',
  branches: 'its branches', for_each: 'how often it repeats', type: 'what kind of step it is'
};
interface ChangeLine { text: string; kind: 'add' | 'mod' | 'del'; }
function _eoFieldsPhrase(fields: string[]): string {
  const out: string[] = [];
  fields.forEach(function (f: string) {
    const ph = _EO_FIELD_PHRASE[String(f).split('.')[0]];
    if (ph && out.indexOf(ph) < 0) out.push(ph);
  });
  if (out.length < 2) return out.join('');
  return out.slice(0, -1).join(', ') + ' and ' + out[out.length - 1];
}
function _changeLines(rows: EnhancementDiffRow[], added: string[], modified: string[],
    removed: string[], playbooksAdded: string[]): ChangeLine[] {
  const lines: ChangeLine[] = [];
  const seen: Record<string, boolean> = {};
  const push = function (kind: 'add' | 'mod' | 'del', text: string): void {
    if (!text || seen[kind + text]) return;
    seen[kind + text] = true;
    lines.push({ text: text, kind: kind });
  };
  const addLine = function (name: string, type: string, conn?: string, cfg?: string): void {
    let ph = _EO_TYPE_PHRASE[type];
    if (ph && conn) ph += ' on ' + conn + (cfg ? ', using configuration ' + cfg : '');
    push('add', 'Adds the step "' + _plainLabel(name) + '"' + (ph ? ' (' + ph + ')' : '') + '.');
  };
  const modLine = function (name: string, fields: string[], values?: string[]): void {
    const ph = _eoFieldsPhrase(fields);
    const vs = (values || []).slice(0, 3);
    const more = (values || []).length - vs.length;
    push('mod', 'Changes the step "' + _plainLabel(name) + '"' + (ph ? ': ' + ph : '') + '.'
      + (vs.length ? ' ' + vs.join('; ') + (more > 0 ? '; and ' + more + ' more' : '') + '.' : ''));
  };
  const delLine = function (name: string): void {
    push('del', 'Removes the step "' + _plainLabel(name) + '".');
  };
  const pbLine = function (kind: 'add' | 'del', name: string): void {
    push(kind, kind === 'add'
      ? 'Adds the playbook "' + _plainLabel(name) + '", which this playbook calls. Apply saves it too.'
      : 'Removes the playbook "' + _plainLabel(name) + '".');
  };
  if (rows.length) {
    rows.forEach(function (r: EnhancementDiffRow) {
      if (r.kind === 'playbook_added') pbLine('add', r.step);
      else if (r.kind === 'playbook_removed') pbLine('del', r.step);
      else if (r.kind === 'added') addLine(r.step, r.stepType, r.connectorLabel, r.configName);
      else if (r.kind === 'removed') delLine(r.step);
      else modLine(r.step, r.changedFields, r.valueChanges);
    });
  } else {
    added.forEach(function (n: string) { addLine(n, ''); });
    modified.forEach(function (n: string) { modLine(n, []); });
    removed.forEach(function (n: string) { delLine(n); });
  }
  playbooksAdded.forEach(function (n: string) { pbLine('add', n); });
  return lines;
}
/* How to undo. Both Apply paths take a restore point first (the Versions tab),
   and nothing runs: Apply edits the playbook, it does not execute it. */
function _changeSafety(playbooksAdded: string[]): { tone: string; text: string } {
  let t = 'Changes this playbook only, and nothing runs when you apply it. '
    + 'To undo, restore the previous version from the Versions tab; a restore point is saved first.';
  if (playbooksAdded.length) {
    t += ' The new playbook' + (playbooksAdded.length > 1 ? 's are' : ' is') + ' saved too; delete '
      + (playbooksAdded.length > 1 ? 'them' : 'it') + ' to undo that part.';
  }
  return { tone: 'warn', text: t };
}

/* The changed values of a modified step as sentences. Wiring (what runs next,
   branch targets) is the phrase "what runs next", not a value, so it is left out. */
function _valueChanges(before: unknown, after: unknown, labels: ConnLabels): string[] {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  _leaves(before, '', b);
  _leaves(after, '', a);
  const paths: string[] = [];
  Object.keys(b).concat(Object.keys(a)).forEach(function (p) {
    if (paths.indexOf(p) < 0 && String(b[p]) !== String(a[p])) paths.push(p);
  });
  const show = function (m: Record<string, unknown>, p: string): string {
    if (!(p in m)) return '';
    return p === 'arguments.connector' ? _connectorLabel(m[p], labels) : _diffScalar(_plainValue(m[p]));
  };
  const out: string[] = [];
  paths.forEach(function (p: string) {
    if (p === 'next' || /(^|\.)target$/.test(p) || /^branches/.test(p)) return;
    const now = show(a, p);
    const was = show(b, p);
    if (!now && !was) return;
    out.push(_pathLabel(p) + (now ? ' is now ' + now : ' is removed') + (was && now ? ' (was ' + was + ')' : ''));
  });
  return out;
}

function _enhancementChanges(raw: unknown, labels?: ConnLabels): EnhancementDiffRow[] {
  const labs: ConnLabels = labels || {};
  const list = Array.isArray(raw) ? raw : [];
  return list.map(function (c: any): EnhancementDiffRow {
    c = (c && typeof c === 'object') ? c : {};
    const kind = String(c.kind || 'modified');
    const fields: string[] = Array.isArray(c.changed_fields)
      ? c.changed_fields.map(String) : [];
    const sides = (kind === 'modified' && c.before && c.after)
      ? _modifiedText(c.before, c.after, labs)
      : { before: _plainStepText(c.before, labs), after: _plainStepText(c.after, labs) };
    const stepArgs: any = (c.after && c.after.arguments) || (c.before && c.before.arguments) || {};
    const isConn = String(c.type || '') === 'connector';
    return {
      kind: kind,
      badge: _EO_BADGE[kind] || 'mod',
      playbook: String(c.playbook || ''),
      // The playbook-level kinds carry no step; label them by playbook so no
      // row is ever nameless.
      step: String(c.step || c.playbook || ''),
      stepType: String(c.type || ''),
      changedFields: fields,
      // Empty string lets the template drop the element rather than render an
      // orphaned label.
      changedFieldsText: fields.join(', '),
      beforeText: sides.before,
      afterText: sides.after,
      tag: _EO_TAG[kind] || 'Changed',
      connectorLabel: isConn ? _connectorLabel(stepArgs.connector, labs) : '',
      configName: isConn && typeof stepArgs.config === 'string' ? stepArgs.config : '',
      valueChanges: (kind === 'modified' && c.before && c.after) ? _valueChanges(c.before, c.after, labs) : []
    };
  }).filter(function (c) {
    // A row with neither side is nothing to show.
    return c.beforeText !== '' || c.afterText !== '';
  });
}

// Tool args arrive as wire keys (`indicator_type`, `collectorId`). An approval
// card is read by an analyst under time pressure, so label them like a form:
// snake_case and camelCase → "Indicator type", "Collector id". A small override
// map covers the acronyms title-casing would mangle.
const _ARG_LABEL_OVERRIDES: Record<string, string> = {
  ip: 'IP', url: 'URL', ioc: 'IOC', uuid: 'UUID', id: 'ID', ai: 'AI',
  iri: 'IRI', dns: 'DNS', md5: 'MD5', sha1: 'SHA1', sha256: 'SHA256',
  json: 'JSON', html: 'HTML', cidr: 'CIDR'
};

// --- approval card wording ----------------------------------------------------
//
// Live, a playbook approval read "Approval required: run_playbook  tier 3",
// then "Record /api/3/ztpf_automation_actions/<uuid>", "Follow true",
// "Timeout 180": the tool's name, its tier number, a record path and its
// execution knobs. The analyst decides whether to run a playbook on a record;
// the exact arguments stay behind "Show details".

/** Arguments a tool takes for how it runs, not what it does. */
const _APPROVAL_HIDDEN_ARGS: Record<string, string[]> = {
  run_playbook: ['follow', 'timeout'],
  resume_playbook: ['follow', 'timeout']
};

/** "Changes data" / "High impact" for the tier the connector resolved. */
function _tierLabel(tier: unknown): string {
  if (typeof tier !== 'number' || tier < 3) return '';
  return tier >= 4 ? 'High impact' : 'Changes data';
}

/** Security acronyms that stay uppercase in a humanized op title. A small
 *  stable constant mirroring the connector's _OP_ACRONYMS, not a per-op map. */
const _OP_ACRONYMS: { [k: string]: boolean } = {
  ip: true, url: true, uri: true, ioc: true, iocs: true, dns: true, id: true,
  ids: true, edr: true, api: true, uuid: true, cve: true, md5: true, sha: true,
  sha1: true, sha256: true, http: true, https: true, siem: true, soar: true,
  ueba: true, fqdn: true, mac: true, os: true, vm: true, ad: true, csv: true,
  json: true, xml: true
};

/** `isolate_collector` -> `Isolate collector`, `block_ip` -> `Block IP`: a
 *  readable action-card title so the header never shows a raw
 *  connector.operation id. Backstops the connector's own _clean_run_op_summary. */
function _humanizeOp(op: unknown): string {
  const raw = String(op == null ? '' : op);
  const words = raw.replace(/[_\-.]+/g, ' ').split(/\s+/).filter(function (w) { return w.length > 0; });
  if (words.length === 0) return raw;
  return words.map(function (w, i) {
    if (_OP_ACRONYMS[w.toLowerCase()]) return w.toUpperCase();
    if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1);
    return w;
  }).join(' ');
}

/** Strip a record IRI or bare path (`alerts/<uuid>`, `/api/3/alerts/<uuid>`)
 *  from display text -> "the alert record". Display-only, not intent parsing. */
function _derecord(text: unknown): string {
  return String(text == null ? '' : text).replace(
    /\/?(?:api\/3\/)?([a-z][a-z_]*)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    function (_m: string, mod: string): string {
      const singular = mod.toLowerCase().endsWith('s') ? mod.slice(0, -1) : mod;
      return 'the ' + singular + ' record';
    }).replace(
    // The short form an older connector titled record writes with:
    // "Update alerts/e94dc2dc".
    /\b([a-z][a-z_]*)\/[0-9a-f]{8}\b(?!-)/gi,
    function (_m: string, mod: string): string {
      return 'this ' + _singular(mod).replace(/_/g, ' ');
    });
}

/** The action-card summary the analyst reads: humanized fallback, no record
 *  IRI, a bare connector.operation token rewritten to the readable verb. */
function _cleanActionSummary(summary: unknown, connector: string, operation: string): string {
  const human = _humanizeOp(operation);
  if (!summary) return human;
  // Only a real connector.operation token is rewritten: a record write has
  // neither, and splitting on a bare '.' stripped every dot from its title
  // ("198.51.100.2" became "1010088102").
  const text = _derecord(String(summary));
  const cleaned = connector && operation ? text.split(connector + '.' + operation).join(human) : text;
  return cleaned.trim() || human;
}

/** A scalar argument as the analyst reads it: yes/no for a flag, the kind of
 *  record for a record path (the path itself is in Show details). */
function _approvalValue(v: unknown): string {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  const s = String(v);
  const m = /^\/api\/3\/([a-z0-9_]+)\/[0-9a-f-]{8,}$/i.exec(s.trim());
  if (m) return _humanizeArgKey(m[1]) + ' record';
  return s;
}

function _humanizeArgKey(k: unknown): string {
  const words = String(k == null ? '' : k)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // camelCase → camel Case
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return String(k || '');
  return words.map(function (w, i) {
    const over = _ARG_LABEL_OVERRIDES[w.toLowerCase()];
    if (over) return over;
    return i === 0
      ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      : w.toLowerCase();
  }).join(' ');
}

function _matchesOption(actual: unknown, optionToken: string): boolean {
  if (actual == null) return false;
  if (typeof actual === 'boolean') return String(actual) === optionToken || (actual && optionToken === 'true');
  return String(actual) === optionToken;
}

function resolveActionFields(card: ActionCard | null, args?: Record<string, unknown>): Field[] {
  if (!card) return [];
  args = args || card.args || {};
  const fields: Field[] = [];

  if (card.paramSchema && card.paramSchema.length && card.visibility) {
    const visible: Record<string, boolean> = {};
    const seed = function (name: string): boolean {
      const f = card!.paramIndex && card!.paramIndex[name];
      if (!f || f.default === undefined || args![name] !== undefined) return false;
      args![name] = f.type === 'checkbox' ? !!f.default : f.default;
      return true;
    };
    const reveal = function (name: string): boolean {
      if (visible[name]) return false;
      visible[name] = true;
      seed(name);
      return true;
    };
    let changed = false;
    (card.visibility.always || []).forEach(function (n: string) { if (reveal(n)) changed = true; });

    const when = card.visibility.when || {};
    let guard = 0;
    changed = true;
    while (changed && guard++ < 50) {
      changed = false;
      Object.keys(when).forEach(function (key: string) {
        const eq = key.indexOf('=');
        if (eq < 0) return;
        const parent = key.slice(0, eq), option = key.slice(eq + 1);
        if (!visible[parent]) return;
        if (!_matchesOption(args![parent], option)) return;
        (Array.isArray(when[key]) ? when[key] : []).forEach(function (child: string) {
          if (reveal(child)) changed = true;
        });
      });
    }

    card.paramSchema.forEach(function (f: Field) {
      if (visible[f.name] && f.schemaVisible) fields.push(f);
    });
  }

  (card.legacyFields || []).forEach(function (f: Field) { fields.push(f); });
  return fields;
}

function actionCardBranchLabel(card: ActionCard | null, args?: Record<string, unknown>): string {
  if (!card || !card.visibility || !card.paramSchema) return '';
  args = args || card.args || {};
  const when = card.visibility.when || {};
  const always = card.visibility.always || [];
  for (let i = 0; i < always.length; i++) {
    const f = card.paramIndex && card.paramIndex[always[i]];
    if (!f || f.type !== 'select') continue;
    const gates = Object.keys(when).some(function (k: string) { return k.indexOf(f.name + '=') === 0; });
    if (!gates) continue;
    const val = args![f.name];
    if (val == null || val === '') continue;
    return f.label + ': ' + val;
  }
  return '';
}

// #129 -- once a card is resolved the editable arg form is dead weight: every
// input is disabled and the analyst only wants to know WHAT ran. This is the
// collapsed rendering of that -- one row per visible field that actually
// carried a value, formatted for reading rather than editing. Empty/blank
// fields are dropped (an unset optional arg is noise in a receipt), and
// password fields are masked -- they are masked in the form, and un-masking
// them at rest would be a regression.
function actionCardArgSummary(
  card: ActionCard | null,
  args?: Record<string, unknown>
): Array<{ name: string; label: string; value: string }> {
  args = args || (card && card.args) || {};
  const rows: Array<{ name: string; label: string; value: string }> = [];
  // A record write's receipt already shows each field as before -> after; the
  // args behind it are IRIs ("Severity /api/3/picklists/<uuid>" printed under
  // an approved card live), so those fields are not repeated here.
  const inChanges: Record<string, boolean> = {};
  ((card && card.changes) || []).forEach(function (c: WriteChange) { inChanges[c.field] = true; });
  resolveActionFields(card, args).forEach(function (f: Field) {
    const v = args![f.name];
    if (v == null || inChanges[f.name]) return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      rows.push({ name: f.name, label: f.label || f.name, value: v.join(', ') });
      return;
    }
    if (typeof v === 'boolean') {
      rows.push({ name: f.name, label: f.label || f.name, value: v ? 'yes' : 'no' });
      return;
    }
    const s = String(_changeValue(v));
    if (!s.trim()) return;
    rows.push({
      name: f.name,
      label: f.label || f.name,
      value: f.type === 'password' ? '••••••••' : s
    });
  });
  return rows;
}

function actionCardComplete(card: ActionCard | null, args?: Record<string, unknown>): boolean {
  args = args || (card && card.args) || {};
  const visible = resolveActionFields(card, args);
  for (let i = 0; i < visible.length; i++) {
    const f = visible[i];
    const v = args![f.name];
    const empty = v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
    if (f.required && empty) return false;
    if (f.type === 'json' && !empty && typeof v === 'string') {
      try { JSON.parse(v); } catch (e) { return false; }
    }
  }
  return true;
}

// Icon class for a step type (view.html renders <i class="ic {{icon}}">).
function _stepTypeIcon(t: unknown): string {
  switch (String(t || '').toLowerCase()) {
    case 'connector': return 'ic-plug';
    case 'decision': return 'ic-branch';
    case 'manual_input': return 'ic-hand';
    case 'set_variable': return 'ic-variable';
    case 'reference': return 'ic-link';
    default: return 'ic-dot';
  }
}

function _draftRow(label: string, stepType?: string, verified?: unknown, wiringLabel?: string): any {
  return {
    label: label || '',
    plainLabel: _plainLabel(label),
    techLine: '',
    stepType: stepType || 'connector',
    icon: _stepTypeIcon(stepType),
    wiringLabel: wiringLabel || '',
    verified: verified === true,
    hasVerified: typeof verified === 'boolean',
    // U3: only an unwired connector value is a fill box. A confirm step is a
    // step the analyst answers at run time, not a form to complete now.
    needsInput: verified === false,
    promptDraft: ''
  };
}

function _buildDraftSteps(rawSteps: unknown, opEntries: any[]): any[] {
  const byLabel: Record<string, any> = {};
  opEntries.forEach(function (o) { byLabel[o.label] = o; });
  const rowFor = function (label: string, stepType?: string, verified?: unknown, wiring?: string) {
    return byLabel[label] || _draftRow(label, stepType, verified, wiring);
  };
  if (Array.isArray(rawSteps) && rawSteps.length) {
    return rawSteps.map(function (s: any) {
      s = s || {};
      const node: string = s.node || s.name || '';
      const stepType: string = s.step_type || 'connector';
      if (s.branches && typeof s.branches === 'object' && !Array.isArray(s.branches)) {
        const branches = Object.keys(s.branches).map(function (key) {
          return {
            key: key,
            keyDraft: key,
            rows: (s.branches[key] || []).map(function (lbl: string) { return rowFor(lbl); })
          };
        });
        return {
          kind: 'fork', node: node, stepType: stepType,
          icon: _stepTypeIcon(stepType), verified: s.verified === true,
          branches: branches
        };
      }
      return { kind: 'node', node: node, row: rowFor(node, stepType, s.verified, s.wiring_label) };
    });
  }
  const enriched = opEntries.some(function (o) {
    return o.skillId || o.wiringLabel || o.hasVerified || o.stepType;
  });
  if (!enriched) return [];
  return opEntries.map(function (o) { return { kind: 'node', node: o.label, row: o }; });
}

function normalizeSeverity(s: unknown): Severity {
  return (s === 'ok' || s === 'warning' || s === 'error' || s === 'info') ? s as Severity : null;
}

// A row label reads as words: a field key (`source_ip`, `mitre`) becomes
// "Source ip" / "Mitre". A label that already has capitals or spaces is the
// author's wording and stays as sent.
function _rowLabel(label: unknown): string {
  if (label == null) return '';
  const t = String(label);
  return /^[a-z0-9_]+$/.test(t) ? _sentence(t) : t;
}

function normalizeBlocks(blocks: unknown): Block[] {
  return (Array.isArray(blocks) ? blocks : []).map(function (b: any) {
    b = b || {};
    if (b.kind === 'table') {
      // Pad short rows / clip long ones to columns.length so a ragged
      // row never shifts cells under the wrong header (or renders a
      // stray trailing <td> with no th above it).
      const cols = Array.isArray(b.columns) ? b.columns : [];
      const width = cols.length;
      const rows = (Array.isArray(b.rows) ? b.rows : []).map(function (r: any) {
        const cells = Array.isArray(r) ? r.slice(0, width) : [];
        while (cells.length < width) cells.push('');
        return cells;
      });
      return { kind: 'table' as const, columns: cols, rows: rows };
    }
    if (b.kind === 'tags') {
      return {
        kind: 'tags' as const, tags: (b.tags || []).map(function (t: any) {
          if (typeof t === 'string') return { label: t, severity: null };
          t = t || {};
          return { label: t.label != null ? t.label : '', severity: normalizeSeverity(t.severity) };
        })
      };
    }
    if (b.kind === 'score') {
      const max = (typeof b.max === 'number' && b.max > 0) ? b.max : null;
      const pct = (max && typeof b.value === 'number') ? Math.max(0, Math.min(100, (b.value / max) * 100)) : null;
      return { kind: 'score' as const, label: b.label || '', value: b.value, max: max, pct: pct, severity: normalizeSeverity(b.severity) };
    }
    if (b.kind === 'text') {
      return { kind: 'text' as const, text: b.text || '' };
    }
    if (b.kind === 'link') {
      const url = String(b.url || '');
      const safe = /^\/(?!\/)/.test(url) || /^https?:\/\//i.test(url);
      return { kind: 'link' as const, label: b.label || url, url: safe ? url : '' };
    }
    // Explicit rows, or any block that carries a rows[] array (older cards omit
    // the kind and lean on the default).
    if (b.kind === 'rows' || Array.isArray(b.rows)) {
      return {
        kind: 'rows' as const, rows: (b.rows || []).map(function (r: any) {
          r = (r && typeof r === 'object') ? r : {};
          return { label: _rowLabel(r.label), value: r.value != null ? r.value : '', severity: normalizeSeverity(r.severity) };
        })
      };
    }
    // C1 -- an UNKNOWN block kind used to collapse to an empty rows block and
    // render blank (a whole block silently vanished). Instead surface whatever
    // content it carries as text, and if it has none, dump the raw block so the
    // analyst at least sees that something arrived rather than nothing.
    const textish = (b.text != null ? b.text : (b.label != null ? b.label : b.value));
    if (textish != null && (typeof textish === 'string' || typeof textish === 'number')) {
      return { kind: 'text' as const, text: String(textish) };
    }
    return { kind: 'text' as const, text: _rawBlockText(b) };
  });
}

// A bounded, safe stringification of an unrecognized info-card block for the C1
// fallback. JSON when possible (drops functions/circular), else String().
function _rawBlockText(b: unknown): string {
  try {
    const s = JSON.stringify(b);
    if (s == null || s === '{}' || s === 'null') return String(b);
    return s.length > 800 ? s.slice(0, 800) + '…' : s;
  } catch (e) {
    return String(b);
  }
}

function normalizeInfoCard(ev: unknown, opts?: RenderOptions): InfoCard {
  const event = (ev as any) || {};
  let blocks;
  if (event.type === 'status_card') {
    blocks = [];
    if (event.summary) blocks.push({ kind: 'text', text: event.summary });
    if (Array.isArray(event.details) && event.details.length) blocks.push({ kind: 'rows', rows: event.details });
  } else {
    blocks = event.blocks;
  }
  return {
    type: 'info_card',
    cardId: event.id || ('card-' + _now(opts)),
    variant: event.variant || event.type,
    severity: normalizeSeverity(event.severity) || 'info',
    severityLabel: event.severity_label || '',
    title: event.title || '',
    blocks: normalizeBlocks(blocks),
    actions: (Array.isArray(event.actions) ? event.actions : []),
    display: event.title || event.summary || ''
  };
}

const _DISPOSITION_LABELS: Record<VerdictCard['disposition'], string> = {
  true_positive: 'True positive',
  false_positive: 'False positive',
  benign: 'Benign',
  suspicious: 'Suspicious',
  needs_more_info: 'Needs more info'
};

function _sentence(s: string): string {
  const t = String(s || '').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

// ─── Tool-call labels ─────────────────────────────────────────────────────
// A tool row used to read "Used tool search_module_records": the function
// name, which is the model's vocabulary. The heading now says what the call
// did, from its name and the arguments that make it specific. Tools with no
// entry fall back to their name in words ("find_jinja_filter" -> "Find jinja
// filter"), so a new tool is never unlabeled; the raw name stays in the
// row's tooltip and input for anyone debugging.
const _TOOL_PHRASES: Record<string, string> = {
  analyze_playbook: 'Read the playbook',
  build_playbook_from_trace: 'Drafted a playbook from this investigation',
  compile_yaml: 'Compiled the playbook',
  connector_health: 'Checked connector health',
  edit_playbook: 'Edited the playbook',
  faz_search: 'Searched FortiAnalyzer',
  find_connector: 'Looked up connectors',
  find_containment_actions: 'Looked up containment actions',
  find_enrichment_actions: 'Looked up enrichment actions',
  find_record_actions: 'Looked up record actions',
  get_op_schema: 'Read an operation\'s inputs',
  healthcheck_connector: 'Checked connector health',
  list_configured_connectors: 'Listed configured connectors',
  list_module_playbooks: 'Listed playbooks',
  list_playbook_runs: 'Listed playbook runs',
  push_playbook: 'Saved the playbook',
  search_playbooks: 'Searched playbooks',
  siem_search: 'Searched FortiSIEM',
  validate_yaml: 'Validated the playbook',
  verify_enhancement: 'Checked the edit',
  verify_playbook: 'Checked the playbook',
  why_did_playbook_fail: 'Diagnosed a playbook run'
};

const _TOOL_LABEL_MAX = 90;

function _clip(s: string): string {
  return s.length > _TOOL_LABEL_MAX ? s.slice(0, _TOOL_LABEL_MAX - 1).replace(/\s+$/, '') + '…' : s;
}

function _str(v: unknown): string {
  return (typeof v === 'string' || typeof v === 'number') ? String(v).trim() : '';
}

// Spaced em/en dashes become commas, outside code. The model is told not to
// write them and does anyway; this is typographic, not a rewrite of meaning.
function plainDashes(text: unknown): string {
  const t = typeof text === 'string' ? text : (text == null ? '' : String(text));
  if (t.indexOf('\u2014') < 0 && t.indexOf('\u2013') < 0) return t;
  return t.split(/(```[\s\S]*?```|`[^`\n]*`)/).map(function (part, i) {
    if (i % 2) return part;
    // Spaced em/en dash: a clause break or parenthetical -> comma.
    part = part.replace(/[ \t]+[\u2014\u2013][ \t]+/g, ', ');
    // Any remaining (unspaced) em/en dash -- a range or compound like
    // "Jun-Sep" or "2019-2024" -> a plain hyphen. Analyst-facing prose
    // carries no em/en dashes (the box is latin-1; the chat UI bans them).
    part = part.replace(/[\u2014\u2013]/g, '-');
    return part;
  }).join('');
}

// A line of prose the model wrote twice in a row shows once. Live: one round's
// reply was the same paragraph twice, newline-joined. Long lines only (a
// repeated list item can be meant) and never inside code.
function dropRepeatedLines(text: unknown): string {
  const t = typeof text === 'string' ? text : (text == null ? '' : String(text));
  if (t.indexOf('\n') < 0) return t;
  return t.split(/(```[\s\S]*?```)/).map(function (part, i) {
    if (i % 2) return part;
    const out: string[] = [];
    let last = '';
    let dropped = false;
    part.split('\n').forEach(function (line) {
      const key = line.trim();
      if (key.length >= 40 && key === last) { dropped = true; return; }
      if (key) last = key;
      out.push(line);
    });
    // The separator before a dropped repeat stays for what follows it, but
    // must not dangle at the end of the reply.
    if (dropped && !/\n\s*$/.test(part)) {
      while (out.length > 1 && out[out.length - 1].trim() === '') out.pop();
    }
    return out.join('\n');
  }).join('');
}

// The same polish on a card's human-readable fields. Live, the model's action
// card summaries carry the dashes its prose was already cleaned of ("on
// FGT_Edge \u2014 quarantine-based"). Named fields only: ids, args, YAML and
// `display` blobs are data, not prose.
const _CARD_TEXT_KEYS = ['summary', 'title', 'lead', 'prompt', 'question', 'why',
  'missing', 'description'];
function _plainCardText(e: any): void {
  _CARD_TEXT_KEYS.forEach(function (k) {
    if (typeof e[k] === 'string') e[k] = plainDashes(e[k]);
  });
  if (Array.isArray(e.findings)) {
    e.findings.forEach(function (f: any) {
      if (f && typeof f.claim === 'string') f.claim = plainDashes(f.claim);
    });
  }
  if (Array.isArray(e.unknowns)) {
    e.unknowns = e.unknowns.map(function (u: unknown) {
      return typeof u === 'string' ? plainDashes(u) : u;
    });
  }
}

function _firstParagraph(text: string): string {
  const paras = String(text || '').trim().split(/\n\s*\n/);
  return (paras[0] || '').trim();
}

// A native-MCP tool arrives as `mcp_<server>__<tool>`. The analyst reads the
// server's product name and the tool in words: "SOC Framework: get alert".
const _MCP_SERVER_LABELS: Record<string, string> = {
  soc: 'SOC Framework', playbooks: 'Playbooks', modules: 'Modules',
  utility: 'Utility', fortisiem: 'FortiSIEM'
};
function mcpToolLabel(name: unknown): string {
  const m = /^mcp_(.+?)__(.+)$/.exec(_str(name));
  if (!m) return '';
  const server = m[1].indexOf('connector:') === 0 ? m[1].slice(10) : m[1];
  const label = _MCP_SERVER_LABELS[server] || server;
  const words = _humanizeArgKey(m[2]);
  return label + ': ' + words.charAt(0).toLowerCase() + words.slice(1);
}
// `wireLabel` is the connector's name for the call (every tool it registers has
// one). It wins over the local phrase table, which is a hand copy that drifted:
// a new tool showed as its raw name. The argument-aware labels above it stay,
// because they add what the connector cannot know statically (which record).
function toolCallLabel(name: unknown, input?: unknown, wireLabel?: unknown): string {
  const n = _str(name);
  const a: any = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  if (!n) return 'Tool call';
  const mcp = mcpToolLabel(n);
  if (mcp) return _clip(mcp);
  if (n === 'run_op' || n === 'execute_action') {
    const conn = _str(a.connector);
    // run_op's argument is `op`; reading only `operation` made every
    // connector call render as "Run op".
    const op = _sentence(_str(a.op) || _str(a.operation)).toLowerCase();
    if (conn && op) return _clip('Ran ' + conn + ': ' + op);
  }
  if (n === 'search_module_records') {
    const mod = _str(a.module) || 'records';
    const q = _str(a.q) || _str(a.search) || _str(a.query);
    return _clip('Searched ' + mod + (q ? ' for ' + q : ''));
  }
  if (n === 'get_record') {
    const mod = _str(a.module);
    return mod ? _clip('Read a record from ' + mod) : 'Read the record';
  }
  if (n === 'list_related_records') return 'Listed related records';
  if (n === 'run_playbook') {
    // A run is async: the row can sit with a "running" pill while the playbook
    // is still executing, so "Started" never contradicts the live status the
    // way the old past-tense "Ran" did.
    const pb = _str(a.playbook) || _str(a.name);
    return pb ? _clip('Started playbook "' + pb + '"') : 'Started a playbook';
  }
  if (n === 'find' && _str(a.kind)) {
    return _clip('Looked up ' + _sentence(_str(a.kind)).toLowerCase()
      + (_str(a.query) ? ': ' + _str(a.query) : ''));
  }
  const wl = _str(wireLabel);
  if (wl) return _clip(wl);
  if (_TOOL_PHRASES[n]) return _TOOL_PHRASES[n];
  // `connector.operation` names (per-connector tool surfaces) and plain
  // snake_case both read as words.
  const dot = n.indexOf('.');
  if (dot > 0) return _clip(n.slice(0, dot) + ': ' + _sentence(n.slice(dot + 1)).toLowerCase());
  return _clip(_sentence(n));
}

// Live preview: consecutive text frames are one prose run, so they fold into a
// single text frame (one row and one markdown pass per poll, not one per token
// chunk). Other frame types stay separate, so the tool timeline is unchanged.
function appendStreamFrame(frames: any[], f: any): void {
  const last: any = frames.length ? frames[frames.length - 1] : null;
  if (f && f.type === 'text' && typeof f.text === 'string'
      && last && last.type === 'text' && typeof last.text === 'string') {
    frames[frames.length - 1] = { type: 'text', text: last.text + f.text };
    return;
  }
  frames.push(f);
}

// Status text is analyst-facing: a snake_case identifier (a tool name, a call
// id) never reaches it. Such a line becomes the plain fallback instead.
const _SNAKE_IDENT_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;
function narrationText(text: unknown, fallback: string): string {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return '';
  return _SNAKE_IDENT_RE.test(s) ? fallback : s;
}

// sources_checked is a list of source labels ("FortiSIEM", "FortiEDR"). Anything
// that is not a non-empty string is dropped, and a non-list yields no line.
function _sourcesLine(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const names = raw
    .filter(function (s: unknown) { return typeof s === 'string' && s.trim() !== ''; })
    .map(function (s: unknown) { return (s as string).trim(); });
  return names.length ? 'Checked: ' + names.join(', ') : '';
}

// X7: only an uncertain verdict shows "What would help"; a confident verdict
// never does, even if a stray list arrives. Lines are plain strings; anything
// without text is dropped; three at most.
function _whatWouldHelp(raw: unknown, disposition: string): VerdictCard['whatWouldHelp'] {
  if (disposition !== 'needs_more_info' || !Array.isArray(raw)) return [];
  const out: VerdictCard['whatWouldHelp'] = [];
  raw.forEach(function (h: any) {
    if (!h || typeof h !== 'object' || typeof h.line !== 'string' || !h.line.trim()) return;
    out.push({
      line: h.line.trim(),
      unknown: typeof h.unknown === 'string' ? h.unknown.trim() : '',
      sources: Array.isArray(h.sources) ? h.sources.filter(function (x: unknown) { return typeof x === 'string' && x !== ''; }) : []
    });
  });
  return out.slice(0, 3);
}

// Step 3a: the framework names a record kind and a state per entry
// ({kind: 'asset'|'change', state: 'unread'|'conflict'}); the card words it.
// Unknown kinds or states are dropped, repeats collapse, two lines at most.
const _ADVISORY_LINES: { [key: string]: string } = {
  'change/unread': 'A change record for this host exists that this investigation did not read.',
  'asset/unread': 'An asset record for this host exists that this investigation did not read.',
  'change/conflict': 'A change record for this host conflicts with this verdict.',
  'asset/conflict': 'The asset record for this host conflicts with this verdict.'
};
function _advisoryLines(premise: unknown): string[] {
  const raw = premise && typeof premise === 'object' ? (premise as any).advisory : null;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  raw.forEach(function (a: any) {
    if (!a || typeof a !== 'object') return;
    const line = _ADVISORY_LINES[String(a.kind) + '/' + String(a.state)];
    if (line && out.indexOf(line) < 0) out.push(line);
  });
  return out.slice(0, 2);
}

function normalizeVerdictCard(ev: unknown, opts?: RenderOptions): VerdictCard {
  const event = (ev as any) || {};
  const conf = typeof event.confidence === 'number'
    ? Math.max(0, Math.min(1, event.confidence))
    : 0.5;
  const findings = (Array.isArray(event.findings) ? event.findings : []).map(function (f: any) {
    f = (f && typeof f === 'object') ? f : {};
    return {
      claim: typeof f.claim === 'string' ? f.claim : '',
      evidence: (Array.isArray(f.evidence) ? f.evidence : []).map(function (eid: unknown) {
        return { id: String(eid), missing: false };
      })
    };
  });
  const disposition = (event.disposition && /^(true_positive|false_positive|benign|suspicious|needs_more_info)$/.test(String(event.disposition)))
    ? String(event.disposition) as VerdictCard['disposition']
    : 'needs_more_info';
  const severity = (event.severity && /^(critical|high|medium|low|info)$/.test(String(event.severity)))
    ? String(event.severity) as VerdictCard['severity']
    : 'info';
  return {
    type: 'verdict_card',
    cardId: event.id || ('verdict-' + _now(opts)),
    disposition: disposition,
    severity: severity,
    dispositionLabel: _DISPOSITION_LABELS[disposition],
    severityLabel: severity === 'info' ? 'Informational' : _sentence(severity) + ' severity',
    confidenceLabel: Math.round(conf * 100) + '% confidence',
    confidence: conf,
    summary: typeof event.summary === 'string' ? event.summary : '',
    findings: findings,
    unknowns: (Array.isArray(event.unknowns) ? event.unknowns : []).map(function (u: unknown) {
      return typeof u === 'string' ? u : String(u);
    }),
    sourcesLine: _sourcesLine(event.sources_checked),
    whatWouldHelp: _whatWouldHelp(event.what_would_help, disposition),
    advisoryLines: _advisoryLines(event.premise),
    recommendedActions: (Array.isArray(event.recommended_actions) ? event.recommended_actions : []).map(function (a: any) {
      a = (a && typeof a === 'object') ? a : {};
      return {
        label: typeof a.label === 'string' ? a.label : '',
        tool: typeof a.tool === 'string' ? a.tool : undefined,
        args: (a.args && typeof a.args === 'object' && !Array.isArray(a.args)) ? a.args : {}
      };
    }),
    display: typeof event.summary === 'string' ? event.summary : String(event.disposition || 'verdict')
  };
}

// A guard is the framework declining to run a call it knows is pointless (a
// repeat of one already made, a forbidden pivot, a call-once tool). It carries
// `ok: false` + an `error` string so the MODEL treats it as a hard stop -- but
// to a human it is the safety rail working, not a failure. Rendering it as a
// red ERROR made a healthy investigation look broken: a live GA session showed
// 7 red badges, 2 of which were guards firing exactly as designed.
// Checked before the error branch, since every guard also matches it.
const GUARD_KEYS = [
  'repeated_call_guard', 'call_once_guard', 'forbidden_pivot_guard',
  'hunt_floor_guard'
];

function isGuardResult(t: string): boolean {
  if (/"kind"\s*:\s*"guard_redirect"/.test(t)) return true;
  return GUARD_KEYS.some(k => new RegExp('"' + k + '"\\s*:\\s*true').test(t));
}

function inferToolStatus(s: unknown): string {
  if (!s) return 'unknown';
  const t = String(s).toLowerCase();
  if (/"status"\s*:\s*"(success|ok|approved|completed)"/.test(t) || /"ok"\s*:\s*true/.test(t)) return 'success';
  if (isGuardResult(t)) return 'guard';
  // A playbook paused on a manual-input step returns `ok:false` + a benign
  // `code:"awaiting_input"` (or `status:"awaiting"`) -- a resumable WAIT, not a
  // failure. Catch it BEFORE the error rule below, which `ok:false` would match.
  if (/"code"\s*:\s*"awaiting_input"/.test(t) || /"status"\s*:\s*"awaiting"/.test(t)) return 'awaiting';
  if (/"status"\s*:\s*"(error|failed|rejected)"/.test(t) || /"ok"\s*:\s*false/.test(t) || /"error"\s*:/.test(t)) return 'error';
  return 'ok';
}

// A capped result, said on the row itself. The tool's `message` tells the model
// to relay a partial view, and the model does not reliably do it: an answer
// built on page 1 of 6 reads exactly like a complete one. So the row carries
// it, from the result's own fields -- never from the prose.
function _num(v: unknown): number | null {
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
// The save guard's refusal (`would_drop_fields`), for the analyst. Its message
// is written for the agent -- semantic paths like
// `collection.workflows[_prewrite_wf].steps[Upd]` and "re-issue with
// acknowledged_drops", which nobody at the widget can do. Name the steps; the
// way to delete one on purpose is to ask, since a requested deletion is
// verified and acknowledged by the edit path.
function dropRefusalText(dropped: unknown): string {
  const paths = Array.isArray(dropped) ? dropped.map(String) : [];
  const steps: string[] = [];
  let other = 0;
  paths.forEach(function (p) {
    const m = /\.steps\[([^\]]+)\]$/.exec(p);
    if (m) {
      if (steps.indexOf(m[1]) < 0) steps.push(m[1]);
    } else {
      other++;
    }
  });
  const quoted = steps.map(function (n) { return '"' + n + '"'; });
  const named = quoted.length > 1
    ? quoted.slice(0, -1).join(', ') + ' and ' + quoted[quoted.length - 1]
    : (quoted[0] || '');
  const parts: string[] = [];
  if (named) parts.push((steps.length > 1 ? 'the steps ' : 'the step ') + named);
  if (other) parts.push(other + (other > 1 ? ' other parts' : ' other part') + ' of the playbook');
  const what = parts.length ? parts.join(', plus ') : 'part of the playbook';
  const it = (steps.length === 1 && !other) || !parts.length ? 'it' : 'them';
  return 'Nothing was saved: this version would delete ' + what + '. If removing '
    + it + ' is what you want, ask me to remove ' + it + ' and I will apply that '
    + 'as a checked edit. Otherwise put ' + it + ' back in the YAML and apply again.';
}

// "9823" -> "9,823": live totals run to thousands. Fixed format, not the
// viewer's locale, so the label and its tests agree everywhere.
function _grouped(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function toolPartialLabel(content: unknown): string | null {
  let obj: any = content;
  if (typeof content === 'string') {
    try { obj = JSON.parse(content); } catch (e) { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.truncated !== true && obj.truncated !== 'true') return null;
  const page = _num(obj.page), pages = _num(obj.pages);
  if (page != null && pages != null && page > 1) return 'Page ' + _grouped(page) + ' of ' + _grouped(pages);
  const total = _num(obj.total), showing = _num(obj.showing);
  if (total != null && showing != null) return _grouped(showing) + ' of ' + _grouped(total);
  const found = _num(obj.total_found), count = _num(obj.count);
  if (found != null && count != null) return _grouped(count) + ' of ' + _grouped(found);
  if (obj.summarized === true) return 'Summarized';
  return 'Partial';
}

function formatDuration(ms: unknown): string | null {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return Math.round(ms) + 'ms';
  const secs = ms / 1000;
  if (secs < 60) {
    return (secs < 10 ? secs.toFixed(1) : String(Math.round(secs))) + 's';
  }
  const m = Math.floor(secs / 60);
  let s = Math.round(secs % 60);
  if (s === 60) { return (m + 1) + 'm00s'; }
  return m + 'm' + (s < 10 ? '0' + s : s) + 's';
}

const _INTERNAL_KEYS: Record<string, boolean> = { suggested_card: true, message: true };
// On a FAILING result `message` is not internal -- it is the whole diagnosis, so
// only `suggested_card` is stripped there.
const _INTERNAL_KEYS_ON_FAILURE: Record<string, boolean> = { suggested_card: true };
function _stripInternalFields(s: unknown): string {
  try {
    const obj = JSON.parse(s as string);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      // `message` on a SUCCESSFUL result is model-facing steering text and is
      // noise in the analyst's transcript. On a failure it is the only field
      // that says WHY. Stripping it unconditionally rendered every failed tool
      // as an opaque {ok:false, code:...}: live on 206 a resume_playbook
      // failure displayed just {ok, code, run_pk} while the wire carried
      // "Select a valid choice. That choice is not one of the available
      // choices." -- the one fact that explained it. Read as "nothing happens".
      const internal = (obj as any).ok === false
        ? _INTERNAL_KEYS_ON_FAILURE : _INTERNAL_KEYS;
      let stripped = false;
      const out: Record<string, unknown> = {};
      Object.keys(obj).forEach(function (k: string) {
        if (internal[k]) { stripped = true; } else { out[k] = (obj as any)[k]; }
      });
      if (stripped) return JSON.stringify(out, null, 2);
    }
  } catch (e) { }
  return s as string;
}

/* U7: the troubleshoot card. It renders from a why_did_playbook_fail result:
   what happened (each step, the failing one in plain words), the fix as
   numbered actions, a safety line, one primary action, and the run log and raw
   error behind Details. Note: the framework returns ok:false for a FAILED run
   too (with step_diagnostics), so the card keys on step_diagnostics, not on ok.
   A resolution failure (no diagnostics) gives no card; the generic row shows it. */
const _TS_RENDER_CODES: Record<string, boolean> = {
  render_error: true, render_threw: true, empty_render: true
};
const _TS_REASON: Record<string, string> = {
  render_error: 'an input could not be filled in',
  render_threw: 'an input could not be filled in',
  empty_render: 'an input came out empty'
};
function troubleshootFromResult(raw: unknown, opts?: { cardId?: string }): any | null {
  let r: any = raw;
  if (typeof raw === 'string') {
    try { r = JSON.parse(raw); } catch (e) { return null; }
  }
  if (!r || typeof r !== 'object' || !Array.isArray(r.step_diagnostics)) return null;
  const diags: any[] = r.step_diagnostics.filter(function (d: any) { return d && typeof d === 'object'; });
  const stepOrder: string[] = [];
  const failsByStep: Record<string, any[]> = {};
  diags.forEach(function (d: any) {
    const key = _str(d.step);
    if (!key) return;
    if (stepOrder.indexOf(key) < 0) stepOrder.push(key);
    if (d.ok === false) (failsByStep[key] = failsByStep[key] || []).push(d);
  });
  const failing = diags.filter(function (d: any) { return d.ok === false; });
  const runFailed = String(r.run_status || '').toLowerCase() === 'failed';
  if (!failing.length && !runFailed) return null;   // nothing failed: nothing to troubleshoot
  const needsChange = failing.some(function (d: any) { return _TS_RENDER_CODES[d.code] === true; });
  const failingLabel = failing.length ? _plainLabel(failing[0].step) : '';

  const whatHappened: Array<{ text: string; failed: boolean }> = [];
  const runLog: Array<{ step: string; status: string; detail: string }> = [];
  stepOrder.forEach(function (key) {
    const label = _plainLabel(key);
    const fails = failsByStep[key] || [];
    if (fails.length) {
      const reason = _TS_REASON[fails[0].code] || 'did not complete';
      whatHappened.push({ text: label + ': failed, ' + reason + '.', failed: true });
      runLog.push({ step: label, status: 'Failed',
        detail: fails.map(function (d: any) { return _str(d.code) + ': ' + _str(d.message); }).join('\n') });
    } else {
      whatHappened.push({ text: label + ': inputs filled in', failed: false });
      runLog.push({ step: label, status: 'Inputs filled in', detail: '' });
    }
  });
  if (runFailed && !failing.length) {
    whatHappened.push({ text: 'The run ended as failed, but no step has a bad input. The reason is in the connector error (see Details).', failed: true });
  }

  const fix: string[] = needsChange
    ? ['Fix the input of step "' + failingLabel + '" so it gets a value.',
       'Run the playbook again on the same alert.']
    : ['Check the connection the failing step uses (its address and credentials).',
       'Run the playbook again on the same alert.'];
  const safety = needsChange
    ? { tone: 'warn', text: 'Playbook change needed. An input for this step is empty or broken.' }
    : { tone: 'safe', text: 'No playbook change needed. The inputs filled in correctly.' };
  safety.text += ' This check only reads: nothing was run or changed by it.';
  const primary = needsChange
    ? { label: 'Fix the playbook', ask: 'Fix the input of step "' + failingLabel
        + '" in this playbook so it gets a value, then run it again on the same alert.' }
    : { label: 'Run again', ask: 'Run the playbook again on the same alert.' };

  const errLines: string[] = failing.map(function (d: any) { return _str(d.message); })
    .filter(function (m: string) { return m.length > 0; });
  (Array.isArray(r.hints) ? r.hints : []).forEach(function (h: unknown) { errLines.push(_str(h)); });
  const headline = r.playbook_name ? 'Why "' + _str(r.playbook_name) + '" failed' : 'Why this run failed';
  return {
    type: 'troubleshoot_card',
    cardId: (opts && opts.cardId) || 'troubleshoot-' + _now(),
    headline: headline,
    sub: 'Diagnosed from the failed run. Diagnosing did not run anything.',
    whatHappened: whatHappened,
    failingStep: failingLabel,
    fix: fix,
    safety: safety,
    primary: primary,
    runLog: runLog,
    rawError: errLines.join('\n'),
    rawJson: JSON.stringify(r, null, 2)
  };
}

function buildAssistantMessage(events: unknown, opts?: RenderOptions): AssistantMessage {
  const COLLAPSE_THRESHOLD = (opts && typeof opts.collapseThreshold === 'number')
    ? opts.collapseThreshold : DEFAULT_COLLAPSE_THRESHOLD;
  const interleaveText = !!(opts && opts.interleaveText);
  const msg: AssistantMessage = { role: 'assistant', text: '', events: [], ts: _now(opts) };
  const emitToolIds: Record<string, boolean> = {};
  // The model's reasoning summary per round (usage frames), collected across
  // the whole turn and folded into one collapsed panel after the loop.
  const reasoningRounds: string[] = [];

  // Visually tie a card to the tool_call bubble it reports on (by
  // preceding_tool_use_id), instead of leaving it a disconnected-looking
  // later sibling. Cards still render in normal timeline order (so nothing
  // changes about when/how they appear) -- we just mark both sides of the
  // pair so the template can render them as one attached unit (no gap,
  // matching accent) when a match is found. No match (older buffered
  // transcripts pre-dating this field, or a genuinely standalone card) is a
  // silent no-op: the card renders exactly as it did before this fix.
  function pushCard(cardEvent: any, precedingToolUseId?: string | null): void {
    if (precedingToolUseId) {
      for (let i = msg.events.length - 1; i >= 0; i--) {
        const evt = msg.events[i] as any;
        if (evt.type === 'tool_call' && evt._toolUseId === precedingToolUseId) {
          evt._hasAttachedCard = true;
          cardEvent._attachedToToolCall = true;
          // A call parked on an action card has not done anything yet: its
          // past-tense label ("Updated the record") and "running" chip both
          // claimed otherwise while the card waited for the analyst.
          if (cardEvent.type === 'action_card' && cardEvent.cardId) {
            evt._awaitsCardId = cardEvent.cardId;
            evt.proposedLabel = _PROPOSED_LABELS[evt.name] || 'Proposed an action';
          }
          break;
        }
      }
    }
    msg.events.push(cardEvent);
  }

  function appendText(t: string): void {
    if (!interleaveText) { msg.text += t; return; }
    const last = msg.events[msg.events.length - 1] as any;
    if (last && last.type === 'text') last.text += t;
    else msg.events.push({ type: 'text', text: t } as any);
  }

  // Typed against the connector wire contract (contract.d.ts): the `ev.type`
  // discriminant is now checked against FsrPbChat.WireEventType, so a frame type
  // the connector renames/drops (or a typo'd branch here) is a compile error
  // rather than a silently-unrendered frame.
  ((events as FsrPbChat.WireEvent[]) || []).forEach(function (ev: FsrPbChat.WireEvent) {
    if (ev.type === 'text') {
      appendText(ev.text || '');
    } else if (ev.type === 'tool_use') {
      if (ev.name && /^emit_/.test(ev.name)) {
        if (ev.id) emitToolIds[ev.id] = true;
        return;
      }
      // The connector sends a tool's chip twice under one id: early, when the
      // model starts the call (no arguments yet), then at dispatch with the full
      // input. Two entries with one id crash the timeline's ng-repeat
      // (ngRepeat:dupes), which renders the WHOLE reply bubble empty: live, a
      // block ask staged its action card behind a blank message. Update the
      // first entry in place instead.
      if (ev.id) {
        const seen = (msg.events as any[]).find(function (e: any) {
          return e.type === 'tool_call' && e._toolUseId === ev.id;
        });
        if (seen) {
          if (ev.name) seen.name = ev.name;
          seen.label = toolCallLabel(ev.name || seen.name, ev.input, ev.label);
          if (ev.input && Object.keys(ev.input).length) {
            seen.inputDisplay = JSON.stringify(ev.input, null, 2);
          }
          return;
        }
      }
      msg.events.push({
        type: 'tool_call',
        name: ev.name,
        label: toolCallLabel(ev.name, ev.input, ev.label),
        _toolUseId: ev.id || null,
        inputDisplay: JSON.stringify(ev.input || {}, null, 2),
        resultDisplay: null,
        resultStatus: 'pending',
        partialLabel: null,
        durationMs: null,
        durationLabel: null,
        _startedAt: _now(opts),
        _open: false,
        _inputOpen: false,
        _resultOpen: false
      } as any);
    } else if (ev.type === 'tool_result') {
      if (ev.tool_use_id && emitToolIds[ev.tool_use_id]) return;
      const rRaw = (typeof ev.content === 'string')
        ? ev.content
        : JSON.stringify(ev.content == null ? '' : ev.content, null, 2);
      const rDisplay = _stripInternalFields(rRaw == null ? '' : String(rRaw));
      const matchId = ev.tool_use_id || null;
      const matchName = ev.tool || '';
      const durMs = (typeof ev.duration_ms === 'number') ? ev.duration_ms : null;
      let pair: any = null;
      if (matchId) {
        for (let i = msg.events.length - 1; i >= 0; i--) {
          const evt = msg.events[i] as any;
          if (evt.type === 'tool_call'
            && evt._toolUseId === matchId
            && evt.resultDisplay === null) {
            pair = evt; break;
          }
        }
      }
      if (!pair && matchName) {
        for (let j = msg.events.length - 1; j >= 0; j--) {
          const evt = msg.events[j] as any;
          if (evt.type === 'tool_call'
            && evt.name === matchName
            && evt.resultDisplay === null) {
            pair = evt; break;
          }
        }
      }
      if (!pair) {
        for (let k = msg.events.length - 1; k >= 0; k--) {
          const evt = msg.events[k] as any;
          if (evt.type === 'tool_call'
            && evt.resultDisplay === null) {
            pair = evt; break;
          }
        }
      }
      if (pair) {
        pair.resultDisplay = rDisplay;
        pair.resultStatus = inferToolStatus(rDisplay);
        pair.partialLabel = toolPartialLabel(rRaw);
        pair._resultOpen = rDisplay.length < COLLAPSE_THRESHOLD;
        if (durMs != null) {
          pair.durationMs = durMs;
          pair.durationLabel = formatDuration(durMs);
        }
      } else {
        msg.events.push({
          type: 'tool_call',
          name: matchName,
          label: toolCallLabel(matchName),
          _toolUseId: matchId,
          inputDisplay: null,
          resultDisplay: rDisplay,
          resultStatus: inferToolStatus(rDisplay),
          partialLabel: toolPartialLabel(rRaw),
          durationMs: durMs,
          durationLabel: (durMs != null) ? formatDuration(durMs) : null,
          _startedAt: null,
          _open: false,
          _inputOpen: false,
          _resultOpen: rDisplay.length < COLLAPSE_THRESHOLD
        } as any);
      }
      if (matchName === 'why_did_playbook_fail') {
        const _tc = troubleshootFromResult(rRaw, { cardId: 'troubleshoot-' + (matchId || _now(opts)) });
        if (_tc) pushCard(_tc, matchId);
      }
    } else if (ev.type === 'approval_request') {
      const _pArgs = ev.preview && ev.preview.args;
      const _disp = ev.summary
        ? String(ev.summary)
        : (_pArgs && typeof _pArgs === 'object' && Object.keys(_pArgs).length
          ? _capApprovalText(JSON.stringify(_pArgs, null, 2))
          : 'This action will write to FortiSOAR. Approve to run it.');
      // The card used to render ONLY `display` -- a raw `JSON.stringify` dump in
      // a <pre>. What a human approving a containment action needs is "which
      // indicator, on which device", not a brace-matched blob. Carry the args as
      // ordered label/value rows so the template can show a readable table and
      // keep the JSON behind a "show raw" toggle. `display` stays for export and
      // the no-args fallback.
      const _rows: ApprovalArgRow[] = [];
      const _hidden = _APPROVAL_HIDDEN_ARGS[String(ev.tool || '')] || [];
      if (_pArgs && typeof _pArgs === 'object' && !Array.isArray(_pArgs)) {
        Object.keys(_pArgs).forEach(function (k) {
          // Internal sentinels are plumbing, never analyst-facing.
          if (k.charAt(0) === '_' || _hidden.indexOf(k) !== -1) return;
          const v = (_pArgs as Record<string, unknown>)[k];
          const scalar = (v === null || typeof v !== 'object');
          _rows.push({
            key: k,
            label: _humanizeArgKey(k),
            value: scalar ? _approvalValue(v) : JSON.stringify(v),
            complex: !scalar
          });
        });
      }
      msg.events.push({
        type: 'approval_request',
        name: ev.tool || '',
        // "Run playbook", not the function name `run_playbook`.
        title: mcpToolLabel(ev.tool) || _humanizeArgKey(ev.tool || ''),
        tierLabel: _tierLabel((ev as any).tier),
        approvalId: ev.approval_id || '',
        runContext: _runContext((ev as any).context),
        tier: typeof (ev as any).tier === 'number' ? (ev as any).tier : 0,
        // Trust the connector's own flag when it sends one; fall back to the
        // tier it also sent. Deriving it ONLY from the tier would silently
        // disagree with the connector the day that threshold moves.
        requiresStepUp: typeof (ev as any).requires_step_up === 'boolean'
          ? (ev as any).requires_step_up
          : (typeof (ev as any).tier === 'number' && (ev as any).tier >= 4),
        display: _disp,
        summary: _summaryWithoutRunContext(
          ev.summary ? String(ev.summary) : '', (ev as any).context),
        argRows: _rows,
        rawArgs: _pArgs && Object.keys(_pArgs || {}).length
          ? _capApprovalText(JSON.stringify(_pArgs, null, 2)) : '',
        // Only ever an absolute http(s) URL the connector built from the
        // configured appliance -- never interpolated from model output.
        playbookUrl: (typeof (ev as any).playbook_url === 'string'
          && /^https?:\/\//.test((ev as any).playbook_url))
          ? String((ev as any).playbook_url) : '',
        // Present only on a run_playbook card whose persona would have asked:
        // "Approve & always allow" adds the playbook to that persona's
        // run-without-asking list. Null hides the button.
        alwaysAllow: _alwaysAllow((ev as any).always_allow),
        _rawOpen: false,
        _open: true
      } as any);
    } else if (ev.type === 'choice_card') {
      pushCard({
        type: 'choice_card',
        choiceId: ev.id || ('choice-' + _now(opts)),
        prompt: ev.prompt || 'Choose one:',
        options: ev.options || [],
        multi: !!ev.multi,
        minSelect: ev.min_select || (ev.multi ? 1 : 1),
        maxSelect: ev.max_select || null,
        // An answer-in-your-own-words box under the chips (single-pick
        // cards only; the connector's emit sets it for open questions).
        allowText: !!(ev as any).allow_text && !ev.multi,
        _typed: '',
        _open: true,
        _resolved: false,
        _picked: ev.multi ? [] : null,
        display: ev.prompt || ''
      } as any, ev.preceding_tool_use_id);
    } else if (ev.type === 'action_card') {
      pushCard(normalizeActionCard(ev, opts), (ev as any).preceding_tool_use_id);
    } else if (ev.type === 'capability_gap') {
      pushCard({
        type: 'capability_gap',
        choiceId: ev.id || ('capgap-' + _now(opts)),
        missing: ev.missing || 'unknown capability',
        why: ev.why || '',
        fixSteps: _capgapFixSteps(ev.fix_steps),
        resume: _capgapResume(ev.resume),
        tips: _capgapTips(ev.tips),
        alternatives: _capgapAlternatives(ev.alternatives),
        docsUrl: ev.docs_url || null,
        _open: true,
        _resolved: false,
        _picked: null,
        _resolutionText: null,
        display: ev.missing || ''
      } as any, ev.preceding_tool_use_id);
    } else if (ev.type === 'manual_input') {
      const _miFields = normalizeManualFields(ev.fields || []);
      pushCard({
        type: 'manual_input',
        inputId: ev.id || ('mi-' + _now(opts)),
        question: ev.question || 'Confirm to continue',
        workflowRunIri: ev.workflow_run_iri || null,
        fields: _miFields,
        values: seedFieldValues(_miFields),
        buttons: normalizeManualButtons(ev.buttons),
        expiresAt: ev.expires_at || null,
        expiresInSeconds: (typeof ev.expires_in_seconds === 'number') ? ev.expires_in_seconds : null,
        _seenAtMs: _now(opts),
        _open: true,
        _resolved: false,
        _outcome: null,
        display: ev.question || ''
      } as any, ev.preceding_tool_use_id);
    } else if (ev.type === 'playbook_offer') {
      const _editable = (ev.editable_title !== false);
      const _ops = (ev.ops_summary || []).map(function (o: any) {
        o = (o && typeof o === 'object') ? o : {};
        const _label = o.label || _humanizeOp(o.operation);
        return {
          connector: o.connector || '',
          operation: o.operation || '',
          // Analyst-facing: never fall back to a raw connector.operation id.
          // The humanized operation is the affordance the analyst reads (the
          // raw id, if ever needed, lives in Details), and this label is
          // what the exported transcript prints too.
          label: _label,
          plainLabel: _plainLabel(_label),
          techLine: o.connector ? (o.connector + '.' + (o.operation || '')) : '',
          skillId: o.skill_id || '',
          stepType: o.step_type || '',
          icon: _stepTypeIcon(o.step_type),
          wiringLabel: o.wiring_label || '',
          verified: o.verified === true,
          hasVerified: typeof o.verified === 'boolean',
          // U3: a confirm step is not an unfinished form (see _draftRow).
          needsInput: o.verified === false,
          branch: o.branch || '',
          promptDraft: ''
        };
      });
      const _draftSteps = _buildDraftSteps(ev.draft_steps, _ops);
      const _trigger = _offerTrigger((ev as any).trigger);
      const _plain = _offerPlain((ev as any).plain);
      const _safety = _plain ? _safetyText(_plain.changes, _plain.askConfirm) : _safetyLine(ev, _ops);
      pushCard({
        type: 'playbook_offer',
        offerId: ev.id || ('pb-offer-' + _now(opts)),
        summary: ev.summary || 'Save this investigation as a repeatable playbook?',
        // Track U: the collapsed card reads these; the raw fields stay for Details.
        plainSummary: (_plain && _plain.summary) || _plainText(ev.summary) || 'Saves this investigation as a playbook you can run again.',
        plainSteps: (_plain && _plain.steps.length) ? _plain.steps : _plainSteps(_ops),
        safetyLine: _safety,
        triggerText: (_trigger && _plainText(_trigger.label)) || 'Runs when you start it',
        thingsToKnow: _eoWarnings((ev as any).warnings, true).map(function (w: any) { return _plainText(w.message); })
          .filter(function (m: string) { return m.length > 0; }),
        techWarnings: _eoWarnings((ev as any).warnings, true).map(function (w: any) { return w.message; }),
        // The connector's own flag, kept on the card; the safety row also
        // checks write verbs because a hand-built offer once sent false.
        hasMutatingAction: (ev as any).has_mutating_action === true,
        // Where the offer came from (e.g. built from YAML, not a trace). A
        // technical note, so it is shown only inside Details.
        advisory: (ev as any).advisory ? String((ev as any).advisory) : '',
        opsSummary: _ops,
        draftSteps: _draftSteps,
        hasDraft: _draftSteps.length > 0,
        stepCount: _ops.length || _draftSteps.length,
        titleSuggestion: ev.title_suggestion || '',
        trigger: _trigger,
        // The verified bytes, kept so a reload restores THEM rather than a
        // prose snippet (see _rehydrateBuildState). Empty on a trace-built offer.
        finalYaml: (ev as any).final_yaml || '',
        runsAfterSetup: _runsAfterSetup((ev as any).runs_after_setup),
        warnings: _eoWarnings((ev as any).warnings, true),
        editableTitle: _editable,
        title: ev.title_suggestion || '',
        _draftOpen: false,
        _open: true,
        _resolved: false,
        _outcome: null,
        _resolutionText: null,
        display: ev.summary || ''
      } as any, ev.preceding_tool_use_id);
    // enhancement_offer -- playbook_offer's UPDATE counterpart. Applies a
    // verified edit to the playbook the analyst already has OPEN, rather than
    // creating a new one, so it renders a change summary (what was
    // added/removed/modified) instead of a whole draft tree, and its CTA reads
    // Apply rather than Save.
    //
    // Before this card existed, enhance mode delivered edits by having the
    // model print YAML and relying on the widget's _extractLastYamlFence() to
    // scrape it. That silently applied text no gate had verified. The card
    // carries the verified bytes, so an accepted edit is exactly the edit that
    // passed verification.
    } else if ((ev as any).type === 'enhancement_offer') {
      const _e = ev as any;
      const _added: string[] = (_e.steps_added || []).slice();
      const _removed: string[] = (_e.steps_removed || []).slice();
      const _modified: string[] = (_e.steps_modified || []).slice();
      // Prefer the hoisted `changes`; fall back to the one inside diff_summary
      // so a card built by an older connector still renders its diff.
      const _diff = (_e.diff_summary && typeof _e.diff_summary === 'object')
        ? _e.diff_summary : {};
      const _rawChanges: any[] = Array.isArray(_e.changes) ? _e.changes : (_diff.changes || []);
      const _changes = _enhancementChanges(_rawChanges, _connLabelsOf(_e, Array.isArray(_rawChanges) ? _rawChanges : []));
      const playbooksAddedList: string[] = (Array.isArray(_e.playbooks_added) ? _e.playbooks_added : [])
        .filter(function (n: any) { return typeof n === 'string' && n; });
      pushCard({
        type: 'enhancement_offer',
        offerId: _e.id || ('enh-offer-' + _now(opts)),
        summary: _e.summary || 'Apply this change to the open playbook?',
        verifiedId: _e.verified_id || '',
        finalYaml: _e.final_yaml || '',
        trigger: _offerTrigger(_e.trigger),
        // Playbooks the edit ADDS beside the open one (a reusable child it
        // calls). Apply saves them on the spot -- they cannot sit on the canvas
        // as unsaved changes -- so the card says so before the click.
        playbooksAdded: playbooksAddedList,
        stepsAdded: _added,
        stepsRemoved: _removed,
        stepsModified: _modified,
        changeCount: _added.length + _removed.length + _modified.length,
        // The readable half of the diff. When the payload carries none (older
        // framework, or an unparseable before_yaml) the card falls back to the
        // name lists plus the YAML toggle, which is what it always showed.
        changes: _changes,
        // U6: the collapsed body. Lines read off the same rows as the diff.
        plainSummary: _plainText(_e.summary) || 'Changes this playbook.',
        changeLines: _changeLines(_changes, _added, _modified, _removed, playbooksAddedList),
        safetyLine: _changeSafety(playbooksAddedList),
        thingsToKnow: _eoWarnings(_e.warnings, true).map(function (w: any) { return _plainText(w.message); })
          .filter(function (m: string) { return m.length > 0; }),
        _detailsOpen: false,
        opsSummary: (_e.ops_summary || []).map(function (o: any) {
          o = (o && typeof o === 'object') ? o : {};
          return {
            label: o.label || '',
            stepType: o.step_type || '',
            icon: _stepTypeIcon(o.step_type),
            // Flag the steps this edit actually touches so the analyst can see
            // the change against the whole playbook rather than re-reading
            // every step.
            changed: _added.indexOf(o.label) >= 0
              || _modified.indexOf(o.label) >= 0,
            added: _added.indexOf(o.label) >= 0
          };
        }),
        // verify_enhancement lets warnings through to ready_to_push, so this is
        // the analyst's last look at them before the edit becomes their
        // saved playbook.
        //
        // verify_playbook lints the whole document, so the list also holds
        // every issue the playbook already had. The framework tags each one
        // with its step and whether this edit touched it (`in_change`); the
        // edit's own lead, the rest fold into a count. An untagged warning
        // (older framework) counts as the edit's, which is what it always was.
        warnings: _eoWarnings(_e.warnings, true),
        otherWarnings: _eoWarnings(_e.warnings, false),
        runsAfterSetup: _runsAfterSetup(_e.runs_after_setup),
        _otherWarningsOpen: false,
        _yamlOpen: false,
        _open: true,
        _resolved: false,
        _outcome: null,
        _resolutionText: null,
        display: _e.summary || ''
      } as any, (ev as any).preceding_tool_use_id);
    // persona_offer: the assistant drafted a standing way to handle a kind of
    // record (its "memory" for that module) and offers to save it. Save teaches
    // the assistant; the card shows WHAT it will do in plain words -- never tool
    // names, enum values or JSON (analyst-facing text policy). The grant that
    // matters is the write scope, so that is the line the analyst reads.
    } else if ((ev as any).type === 'persona_offer') {
      const _po = ev as any;
      const _jv = (_po.jSONValue && typeof _po.jSONValue === 'object') ? _po.jSONValue : {};
      const _mayWrite: string[] = Array.isArray(_jv.may_write)
        ? _jv.may_write.filter(function (m: any) { return typeof m === 'string' && m; })
        : [];
      const _mod = _po.module || 'these';
      pushCard({
        type: 'persona_offer',
        offerId: _po.id || ('persona-offer-' + _now(opts)),
        module: _po.module || '',
        label: _po.label || _jv.label || 'this kind of record',
        headline: 'Remember how to handle ' + _mod + ' records',
        // Plain-language scope -- the one thing the analyst is granting. Derived
        // from write scope only; a persona always reads, and may write when
        // may_write names its module.
        scopeLine: _mayWrite.length
          ? 'It will investigate ' + _mod + ' records, and can update them when you approve each change.'
          : 'It will read and investigate ' + _mod + ' records, and never change them on its own.',
        // An analyst-safe one-liner the drafter set (never the raw prompt, which
        // is the assistant\'s own instructions).
        greeting: (_jv.ui && _jv.ui.greeting) || '',
        _outcome: null,
        _resolved: false,
        _open: true,
      } as any, (ev as any).preceding_tool_use_id);
    } else if (ev.type === 'status_card' || ev.type === 'info_card' || ev.type === 'ioc_card') {
      pushCard(normalizeInfoCard(ev, opts), (ev as any).preceding_tool_use_id);
    } else if (ev.type === 'verdict_card') {
      const _vc = normalizeVerdictCard(ev, opts);
      // Resolve evidence ids against the tool_call blocks already in msg.events
      _vc.findings.forEach(function (f: any) {
        f.evidence.forEach(function (e: any) {
          let found = false;
          for (let i = msg.events.length - 1; i >= 0; i--) {
            const evt = msg.events[i] as any;
            if (evt.type === 'tool_call' && evt._toolUseId === e.id) {
              found = true;
              // The chip names the call it cites, not its opaque id.
              e.label = evt.label || toolCallLabel(evt.name);
              break;
            }
          }
          e.missing = !found;
        });
      });
      pushCard(_vc, (ev as any).preceding_tool_use_id);
    } else if (ev.type === 'activity') {
      const msgTxt = ev.message || ev.phase || '';
      if (!msgTxt) return;
      const lastEv = msg.events[msg.events.length - 1] as any;
      if (lastEv && lastEv.type === 'activity') {
        lastEv.lines.push({ phase: ev.phase || '', message: msgTxt });
      } else {
        msg.events.push({
          type: 'activity',
          lines: [{ phase: ev.phase || '', message: msgTxt }]
        } as any);
      }
    } else if (ev.type === 'error') {
      // Show the human message the connector sent, never the raw JSON envelope.
      const emsg = (ev && typeof ev.message === 'string' && ev.message.trim())
        ? plainDashes(ev.message.trim())
        : 'The request could not be completed. Please try again.';
      msg.events.push({
        type: 'error',
        name: 'Request error',
        display: emsg,
        _open: true
      } as any);
    } else if (ev.type === 'usage') {
      // A usage frame carries the round's reasoning summary when the model
      // emits one. Collect it for the collapsed panel; the frame itself draws
      // nothing in the timeline (tokens/cost live elsewhere).
      const think = typeof ev.thinking === 'string' ? ev.thinking.trim() : '';
      if (think) reasoningRounds.push(think);
    }
  });

  // One "How I worked this out" panel per turn, de-dashed like the prose. Null
  // (not []) when the model emitted no reasoning, so the template never shows
  // an empty panel.
  msg._reasoning = reasoningRounds.length
    ? reasoningRounds.map(function (r) { return dropRepeatedLines(plainDashes(r)); })
    : null;

  // Stamp a STABLE, unique per-event key so the timeline ng-repeat can
  // `track by ev._key` instead of `(ev._toolUseId || $index)`. Only tool_calls
  // carry a natural id; info_card / activity / text / cards had none and fell
  // back to positional $index -- and because the streaming preview rebuilds this
  // whole events array from scratch every ~700ms poll, a positional key lets
  // Angular reuse one card's DOM node/scope for a different event as tool frames
  // interleave between polls, so a card visually overwrites another slot
  // (the "info_card shows up at odd times / overwrites other tools" bug).
  //
  // The build is deterministic and append-only over a growing frame list, so an
  // event's position among same-typed events is stable across rebuilds; keying
  // on `type + ':' + <that ordinal>` (or the tool_use id when present) is stable
  // for existing events while staying unique within a build. Idless info-cards
  // also get their volatile `cardId` (was `card-<now>`, regenerated each
  // rebuild) pinned to the stable key so their testids/identity stop churning.
  const _typeSeq: Record<string, number> = {};
  msg.events.forEach(function (e: any) {
    if (e.type === 'tool_call' && e._toolUseId) { e._key = 'tu:' + e._toolUseId; return; }
    const n = (_typeSeq[e.type] = (_typeSeq[e.type] || 0) + 1);
    e._key = e.type + ':' + n;
    if (e.type === 'info_card' && /^card-\d+$/.test(String(e.cardId || ''))) {
      e.cardId = e._key;
    }
  });

  // Prose polish that does not depend on the model following its prompt
  // (live, it did not): spaced em/en dashes read as commas, and a write-up the
  // verdict card already carries folds to its first paragraph.
  msg.text = dropRepeatedLines(plainDashes(msg.text));
  let _verdictAt = -1;
  msg.events.forEach(function (e: any, i: number) {
    if (e.type === 'text') e.text = dropRepeatedLines(plainDashes(e.text));
    else if (e.type !== 'tool_call') _plainCardText(e);
    if (e.type === 'verdict_card' && _verdictAt < 0) _verdictAt = i;
  });
  msg.events.forEach(function (e: any, i: number) {
    if (e.type !== 'text' || _verdictAt < 0 || i > _verdictAt) return;
    const lead = _firstParagraph(e.text);
    if (lead && lead.length < e.text.trim().length) {
      e.lead = lead;
      e._folded = true;
    }
  });

  let _total = 0, _measured = 0, _slowest: any = null;
  msg.events.forEach(function (e: any) {
    if (e.type !== 'tool_call' || typeof e.durationMs !== 'number') return;
    _total += e.durationMs;
    _measured++;
    if (!_slowest || e.durationMs > _slowest.durationMs) {
      _slowest = { name: e.name, label: e.label || toolCallLabel(e.name), durationMs: e.durationMs };
    }
  });
  msg.toolTotalMs = _measured ? _total : null;
  msg.toolTotalLabel = _measured ? formatDuration(_total) : null;
  msg.slowestTool = (_measured > 1 && _slowest)
    ? { name: _slowest.name, label: _slowest.label, durationMs: _slowest.durationMs, durationLabel: formatDuration(_slowest.durationMs) }
    : null;
  return msg;
}

// ─── Step frames ──────────────────────────────────────────────────────────
//
// Every event sits in a step row. Most event types draw their own card, so the
// row adds no frame; the template used to list those types by hand, and the
// approval and choice cards were missing from it: they drew a card inside the
// row's box ("why do some cards have boxes around them and others don't").
// Here the frame is the exception. tests/stepFrame.test.js checks every type
// the template renders against it.

/** Event types the step row frames: the rest draw their own card. */
const _FRAMED_STEP_TYPES = ['error', 'activity'];

function stepFrame(type: unknown): 'text' | 'framed' | 'bare' {
  if (type === 'text') return 'text';
  return _FRAMED_STEP_TYPES.indexOf(String(type)) !== -1 ? 'framed' : 'bare';
}

// ─── Card decisions ───────────────────────────────────────────────────────
//
// The connector records who answered each card (chat_history
// `card_decisions`). A card answered elsewhere -- another analyst, another
// tab, the Monitor queue, an always-allow grant -- used to keep its buttons in
// this chat until someone clicked one and got "already decided". Apply the
// decisions to the cards on screen: an action card (keyed by its id) or an
// approval card (keyed by its approval id) that is still open becomes
// answered, by whom and when. Returns the cards it changed.

function applyCardDecisions(messages: unknown, decisions: unknown): any[] {
  const byId: Record<string, any> = {};
  (Array.isArray(decisions) ? decisions : []).forEach(function (d: any) {
    if (d && typeof d.card_id === 'string' && d.card_id) byId[d.card_id] = d;
  });
  const changed: any[] = [];
  if (!Object.keys(byId).length || !Array.isArray(messages)) return changed;
  messages.forEach(function (m: any) {
    ((m && m.events) || []).forEach(function (ev: any) {
      if (!ev || ev._resolved || ev._submitting) return;
      const id = ev.type === 'action_card' ? ev.cardId
        : ev.type === 'approval_request' ? ev.approvalId : null;
      const d = id ? byId[id] : null;
      if (!d) return;
      const approved = d.decision === 'approve';
      ev._resolved = true;
      ev._open = false;
      ev._decision = approved ? 'approve' : 'reject';
      ev._outcome = approved ? (ev.type === 'approval_request' ? 'elsewhere' : 'approve') : 'reject';
      ev._resolutionText = approved ? 'Approved' : d.decision === 'reject' ? 'Rejected' : 'Answered';
      ev._resolvedBy = typeof d.actor === 'string' ? d.actor : '';
      ev._resolvedAt = typeof d.decided_at === 'number' ? Math.round(d.decided_at * 1000) : null;
      ev._decidedElsewhere = true;
      changed.push(ev);
    });
  });
  return changed;
}

// ─── Export API ───────────────────────────────────────────────────────────

const api: FsrPbRenderAPI = {
  formatDuration: formatDuration,
  seedFieldValues: seedFieldValues,
  normalizeManualFields: normalizeManualFields,
  normalizeManualButtons: normalizeManualButtons,
  manualInputComplete: manualInputComplete,
  manualInputExpiry: manualInputExpiry,
  dynamicListItems: dynamicListItems,
  normalizeSeverity: normalizeSeverity,
  normalizeBlocks: normalizeBlocks,
  normalizeInfoCard: normalizeInfoCard,
  normalizeActionCard: normalizeActionCard,
  normalizeVerdictCard: normalizeVerdictCard,
  toolCallLabel: toolCallLabel,
  mcpToolLabel: mcpToolLabel,
  toolPartialLabel: toolPartialLabel,
  dropRefusalText: dropRefusalText,
  plainDashes: plainDashes,
  dropRepeatedLines: dropRepeatedLines,
  _offerTrigger: _offerTrigger,
  _plainText: _plainText,
  resolveActionFields: resolveActionFields,
  actionCardComplete: actionCardComplete,
  actionCardNeedsConfig: actionCardNeedsConfig,
  applyConfigChoices: applyConfigChoices,
  actionCardBranchLabel: actionCardBranchLabel,
  actionCardArgSummary: actionCardArgSummary,
  inferToolStatus: inferToolStatus,
  appendStreamFrame: appendStreamFrame,
  narrationText: narrationText,
  buildAssistantMessage: buildAssistantMessage,
  applyCardDecisions: applyCardDecisions,
  changeDiff: changeDiff,
  troubleshootFromResult: troubleshootFromResult,
  stepFrame: stepFrame
};

if (typeof window !== 'undefined') {
  (window as any).FsrPbRender = api;
}

// Node/jest consumers pick the API up via `require()`. We hand-roll a GUARDED
// `module.exports` rather than `export = api` because this same file also loads
// in the browser via <script>, where `module` is undefined -- and `export =`
// compiles to a bare `module.exports = api` that throws "ReferenceError: module
// is not defined" on every page (harness backlog #4; the sibling widgetAssets
// services dodge it with an IIFE). The guard keeps the CJS tail a no-op in the
// browser while node still gets the export. Do NOT restore `export =` -- a raw
// `tsc` rebuild would reintroduce the unguarded throw.
declare var module: any;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
