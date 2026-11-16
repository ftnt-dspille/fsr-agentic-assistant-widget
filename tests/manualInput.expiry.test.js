"use strict";

// A manual_input step can carry its own timeout. When it lapses the run
// continues down its timeout branch and a later submit can NEVER land -- it
// retrieves as `{}` and nothing tells the analyst, so an abandoned gate reads
// as an accepted one. The connector has always sent the deadline
// (`expires_at` / `expires_in_seconds`); the widget read neither, so the only
// thing the analyst saw was a sentence baked into the question text that went
// stale the moment it rendered.
//
// Two halves are tested here:
//   * the pure clock (`manualInputExpiry`) -- which source wins, how a replayed
//     card is anchored, and that a gate with no deadline stays deadline-free;
//   * the gate itself -- submit and reject are refused past zero in the
//     CONTROLLER, not merely disabled in the template, because the deadline can
//     lapse between the click and the handler.

global.jasmine = global.jasmine || {};
require("angular");
require("angular-mocks");
angular.module("cybersponse", []); // eslint-disable-line no-undef

require("../widget/widgetAssets/js/fsrPbRender.js");
require("../widget/view.controller.js");
require("../widget/widgetAssets/js/fsrPbCards.service.js");
require("../widget/widgetAssets/js/fsrPbTranscript.service.js");
require("../widget/widgetAssets/js/fsrPbEntityCards.service.js");
require("../widget/widgetAssets/js/fsrPbHtml.service.js");
require("../widget/widgetAssets/js/fsrPbYaml.service.js");
require("../widget/widgetAssets/js/fsrPbExport.service.js");
require("../widget/widgetAssets/js/fsrPbMarkdown.service.js");

const R = require("../widget/widgetAssets/js/fsrPbRender.js");
const widgetInfo = require("../widget/info.json");
const viewCtrlName = `${widgetInfo.name}${widgetInfo.version.replace(/\./g, "")}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef

function boot(opts) {
  opts = opts || {};
  let $q, $rootScope, $controller, $timeout, $interval;
  const calls = [];
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "x", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "mock", mock_scenario: "manual_input_form" }),
    chatHistory: () => $q.when({ turns: opts.turns || [] }),
    listSessions: () => $q.when({ sessions: [] }),
    chatTurn: () => $q.defer().promise,
    chatPoll: () => $q.when({ frames: [] }),
    respondManualInput: (cfg, payload) => {
      calls.push(payload);
      return $q.when({ ok: true, transcript: [], stop_reason: "end_turn" });
    },
  };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", {});
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_, _$interval_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_;
    $timeout = _$timeout_; $interval = _$interval_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  return {
    $scope, calls,
    digest: () => $rootScope.$digest(),
    tick: (ms) => $interval.flush(ms),
  };
}

// The single manual_input gate on the timeline, wherever the controller put it.
function cardOnTimeline($scope) {
  const msgs = $scope.messages || [];
  for (let i = 0; i < msgs.length; i++) {
    const evs = (msgs[i] && msgs[i].events) || [];
    for (let j = 0; j < evs.length; j++) {
      if (evs[j] && evs[j].type === "manual_input") return evs[j];
    }
  }
  return null;
}

// A filled-in card, so nothing but the deadline can be what blocks a submit.
function manualCard(extra) {
  const fields = R.normalizeManualFields([
    { name: "note", label: "Note", type: "text", required: true },
  ]);
  const card = {
    type: "manual_input", inputId: "126",
    workflowRunIri: "/wf/api/workflows/2971/",
    fields: fields, values: R.seedFieldValues(fields),
    expiresAt: null, expiresInSeconds: null, _seenAtMs: 0,
    _resolved: false, _open: true,
  };
  card.values.note = "answered";
  return Object.assign(card, extra || {});
}

describe("manualInputExpiry -- the clock", () => {
  const NOW = Date.parse("2026-08-12T12:00:00Z");

  test("a gate with no deadline has no deadline -- not a zeroed one", () => {
    // The common case by far. A card without a timeout must render exactly as
    // it always has: no chip, no countdown, and above all no expired state.
    expect(R.manualInputExpiry(manualCard(), NOW)).toBeNull();
  });

  test("the absolute expires_at wins and counts down", () => {
    const e = R.manualInputExpiry(
      manualCard({ expiresAt: "2026-08-12T12:04:12Z", expiresInSeconds: 9999 }), NOW);
    expect(e.expired).toBe(false);
    expect(e.secondsLeft).toBe(252);
    expect(e.label).toBe("4m 12s");
  });

  test("expires_in_seconds is the fallback, anchored to when the card was SEEN", () => {
    // Not to now: the connector computed it when it built the frame. Anchoring
    // to now would restart the countdown on every rebuild of the card.
    const seen = NOW - 40000;   // card arrived 40s ago carrying "60s left"
    const e = R.manualInputExpiry(
      manualCard({ expiresInSeconds: 60, _seenAtMs: seen }), NOW);
    expect(e.secondsLeft).toBe(20);
    expect(e.label).toBe("20s");
  });

  test("past the deadline is expired, floored at zero, with no label to read", () => {
    const e = R.manualInputExpiry(
      manualCard({ expiresAt: "2026-08-12T11:59:00Z" }), NOW);
    expect(e.expired).toBe(true);
    expect(e.secondsLeft).toBe(0);
    expect(e.label).toBe("");
  });

  test("an hour-old replayed gate is expired, not freshly counting", () => {
    // The replay anchor correction: chat_history hands back a gate from an
    // hour ago. Anchoring its relative deadline to "now" would invite an answer
    // the run stopped waiting for long ago.
    const e = R.manualInputExpiry(
      manualCard({ expiresInSeconds: 60, _seenAtMs: NOW - 3600000 }), NOW);
    expect(e.expired).toBe(true);
  });

  test("an unparseable expires_at falls through to the relative value", () => {
    const e = R.manualInputExpiry(
      manualCard({ expiresAt: "not a timestamp", expiresInSeconds: 30, _seenAtMs: NOW }), NOW);
    expect(e.expired).toBe(false);
    expect(e.secondsLeft).toBe(30);
  });
});

describe("manual_input card -- the deadline reaches the card", () => {
  test("the renderer carries both halves of the deadline off the wire", () => {
    // The bug this closes: the keys shipped on every frame and the renderer
    // dropped them, so no downstream code could act on them.
    const msg = R.buildAssistantMessage([{
      type: "manual_input", id: "126", question: "Pick a source",
      expires_at: "2026-08-12T12:04:12Z", expires_in_seconds: 252,
      fields: [{ name: "note", type: "text" }],
    }], { now: () => 1755000000000 });
    const card = msg.events.filter((e) => e.type === "manual_input")[0];
    expect(card.expiresAt).toBe("2026-08-12T12:04:12Z");
    expect(card.expiresInSeconds).toBe(252);
    expect(card._seenAtMs).toBe(1755000000000);
  });

  test("a gate with no deadline carries nulls, so the clock stays silent", () => {
    const msg = R.buildAssistantMessage([{
      type: "manual_input", id: "127", question: "Pick a source",
      fields: [{ name: "note", type: "text" }],
    }], { now: () => 1755000000000 });
    const card = msg.events.filter((e) => e.type === "manual_input")[0];
    expect(card.expiresAt).toBeNull();
    expect(card.expiresInSeconds).toBeNull();
    expect(R.manualInputExpiry(card, 1755000000000)).toBeNull();
  });
});

describe("manual_input countdown -- it actually runs", () => {
  // The defect this guards against is the recurring one in this seam: a feature
  // that is present and inert. A countdown wired to nothing renders once with a
  // plausible number and then sits there while the gate lapses behind it.
  // A controllable wall clock. $interval.flush() advances Angular's timer queue
  // but NOT Date.now(), and the countdown is computed against the wall clock --
  // so both have to move together or the test proves only that the callback ran.
  const _realNow = Date.now;
  let _clock = 0;
  beforeEach(() => { _clock = _realNow(); Date.now = () => _clock; });
  afterEach(() => { Date.now = _realNow; });
  function advance(ms, tick) { _clock += ms; tick(ms); }

  const nowSec = () => Math.floor(Date.now() / 1000);

  function turnWithGate(wire) {
    return [{ user: "run it", ts: nowSec(),
      transcript: [Object.assign({
        type: "manual_input", id: "126", question: "Pick a source",
        workflow_run_iri: "/wf/api/workflows/2971/",
        fields: [{ name: "note", type: "text" }],
      }, wire)] }];
  }

  test("a replayed gate gets a live countdown that decreases with the clock", () => {
    const deadline = new Date(Date.now() + 120000).toISOString();
    const { $scope, tick } = boot({ turns: turnWithGate({ expires_at: deadline }) });
    const card = cardOnTimeline($scope);
    expect(card).not.toBeNull();
    expect(card._expiry).toBeTruthy();
    const before = card._expiry.secondsLeft;
    expect(before).toBeGreaterThan(100);

    advance(3000, tick);
    expect(card._expiry.secondsLeft).toBeLessThanOrEqual(before - 3);
  });

  test("the countdown reaches expired and the gate closes itself", () => {
    const deadline = new Date(Date.now() + 2000).toISOString();
    const { $scope, tick } = boot({ turns: turnWithGate({ expires_at: deadline }) });
    const card = cardOnTimeline($scope);
    expect($scope.manualInputExpired(card)).toBe(false);

    advance(4000, tick);
    expect($scope.manualInputExpired(card)).toBe(true);
  });

  test("an hour-old replayed gate with only a relative deadline is expired", () => {
    // The anchor correction in _replayTurns. `expires_in_seconds` is relative to
    // when the connector BUILT the frame; the renderer anchors it to "now"
    // because that is normally the same moment. On a history replay it is not,
    // and without the correction this hour-dead gate would open with a fresh
    // 60-second countdown and invite an answer the run stopped waiting for.
    const turns = [{ user: "run it", ts: nowSec() - 3600,
      transcript: [{
        type: "manual_input", id: "126", question: "Pick a source",
        expires_in_seconds: 60,
        fields: [{ name: "note", type: "text" }],
      }] }];
    const { $scope } = boot({ turns });
    const card = cardOnTimeline($scope);
    expect(card.expiresAt).toBeNull();
    expect($scope.manualInputExpired(card)).toBe(true);
  });

  test("a gate with no deadline never gets an expiry, so no ticker runs", () => {
    const { $scope } = boot({ turns: turnWithGate({}) });
    const card = cardOnTimeline($scope);
    expect(card).not.toBeNull();
    expect(card._expiry).toBeNull();
    expect($scope.manualInputExpired(card)).toBe(false);
  });
});

describe("manual_input submit -- the deadline is enforced, not just displayed", () => {
  test("a lapsed gate refuses submit in the CONTROLLER", () => {
    // Disabling the button is not enough: the gate can lapse between the click
    // and this handler, and an answer sent past zero is silently discarded by
    // the run -- which is the failure mode that reads as success.
    const { $scope, calls, digest } = boot();
    const card = manualCard({ expiresAt: "2000-01-01T00:00:00Z" });
    card._expiry = R.manualInputExpiry(card, Date.now());

    expect($scope.manualInputExpired(card)).toBe(true);
    $scope.submitManualInput(card);
    digest();

    expect(calls).toHaveLength(0);
    expect(card._resolved).toBeFalsy();
  });

  test("a lapsed gate refuses reject too -- it rides the same call", () => {
    const { $scope, calls, digest } = boot();
    const card = manualCard({ expiresAt: "2000-01-01T00:00:00Z" });
    card._expiry = R.manualInputExpiry(card, Date.now());

    $scope.rejectManualInput(card);
    digest();

    expect(calls).toHaveLength(0);
  });

  test("a gate still inside its window submits normally", () => {
    const { $scope, calls, digest } = boot();
    const card = manualCard({ expiresInSeconds: 600, _seenAtMs: Date.now() });
    card._expiry = R.manualInputExpiry(card, Date.now());

    expect($scope.manualInputExpired(card)).toBe(false);
    $scope.submitManualInput(card);
    digest();

    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual({ note: "answered" });
  });

  test("a gate with NO deadline is never treated as expired", () => {
    // The regression that would hurt most: every timeout-free manual_input
    // step -- the majority -- silently losing its buttons.
    const { $scope, calls, digest } = boot();
    const card = manualCard();
    card._expiry = R.manualInputExpiry(card, Date.now());

    expect($scope.manualInputExpired(card)).toBe(false);
    $scope.submitManualInput(card);
    digest();

    expect(calls).toHaveLength(1);
  });
});
