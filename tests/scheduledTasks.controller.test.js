"use strict";

// ─── Scheduled Tasks panel + per-task run history drawer ─────────────────────
//
// The recurring-agent feature (scheduled-agent-tasks plan): a panel that
// manages cron-driven agent runs, plus a history drawer (plan §8.4) that lists
// each fire's outcome and hands a parked (HITL-gated) run to the chat history
// path (loadSession) so the analyst approves the gated action inline. These
// tests drive the controller logic with a stubbed service -- the DOM/template
// side is covered by the hermetic e2e spec.

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

const widgetInfo = require("../widget/info.json");
const versionSlug = widgetInfo.version.replace(/\./g, "");
const viewCtrlName = `${widgetInfo.name}${versionSlug}DevCtrl`;

const ng = window.angular; // eslint-disable-line no-undef

function resolved(val) {
  return {
    then: function (cb) { return resolved(cb ? cb(val) : val); },
    catch: function () { return resolved(val); },
  };
}
function rejected(err) {
  return {
    then: function (_cb, eb) { return eb ? resolved(eb(err)) : rejected(err); },
    catch: function (eb) { return resolved(eb(err)); },
  };
}

const $state = { current: { name: "main.modules.list" }, params: { module: "alerts" } };

// Spies are captured BY REFERENCE in the registered service, so a test can
// re-point a spy with mockImplementation AFTER boot and the controller's next
// call picks up the new return. (No re-registration of the module -- that
// would re-create the injector.)
const spies = {
  listScheduledTasks: jest.fn(() => resolved({ tasks: [] })),
  listScheduledTaskRuns: jest.fn(() => resolved({ ok: true, runs: [] })),
  createScheduledTask: jest.fn(() => resolved({ ok: true, name: "t" })),
  updateScheduledTask: jest.fn(() => resolved({ ok: true })),
  runScheduledTaskNow: jest.fn(() => resolved({ ok: true })),
  deleteScheduledTask: jest.fn(() => resolved({})),
};

let $controller, $rootScope, $timeout;

beforeEach(() => {
  window.localStorage.clear();
  Object.keys(spies).forEach((k) => spies[k].mockClear());

  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", Object.assign({
      resolveConnector: () => resolved({ name: "x", version: "1", configId: "c1" }),
      resolvePersona: () => resolved(null),
      chatHistory: () => resolved({ turns: [] }),
      listSessions: () => resolved({ sessions: [] }),
      listAgentTools: () => resolved({ ok: true, surfaces: [] }),
      execute: () => resolved({}),
      resume: () => resolved({}),
      chatTurn: () => resolved({}),
      chatPoll: () => resolved({}),
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
    }, spies));
    $provide.value("config", { seedFromEntity: false });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
    $timeout = _$timeout_;
  });
});

function boot() {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush(); // settle init
  return $scope;
}

describe(`${viewCtrlName} -- scheduled tasks panel`, () => {
  test("openScheduledTasks loads the list through the service", () => {
    spies.listScheduledTasks.mockImplementation(() => resolved({ tasks: [
      { name: "Bandwidth watch", cron: "0 9 * * 1", intent: "triage", prompt: "check FortiGate interfaces" },
    ] }));
    const $scope = boot();

    $scope.openScheduledTasks();
    expect($scope.scheduledOpen).toBe(true);
    expect(spies.listScheduledTasks).toHaveBeenCalled();
    $timeout.flush();
    expect($scope.scheduledTasks.map((t) => t.name)).toEqual(["Bandwidth watch"]);
    expect($scope.scheduledLoading).toBe(false);
  });

  test("openScheduledTasks surfaces a service error", () => {
    spies.listScheduledTasks.mockImplementation(() => rejected({ message: "boom" }));
    const $scope = boot();
    $scope.openScheduledTasks();
    $timeout.flush();
    expect($scope.scheduledError).toBe("boom");
    expect($scope.scheduledLoading).toBe(false);
  });

  test("saveScheduledTask rejects a draft missing required fields", () => {
    const $scope = boot();
    $scope.newScheduledTask();
    $scope.scheduledDraft = { name: "", cron: "0 9 * * 1", prompt: "" };
    $scope.saveScheduledTask();
    expect($scope.scheduledFormError).toMatch(/required/);
    expect(spies.createScheduledTask).not.toHaveBeenCalled();
  });

  test("saveScheduledTask creates then refreshes the list", () => {
    spies.createScheduledTask.mockImplementation(() => resolved({ ok: true, name: "Daily" }));
    spies.listScheduledTasks.mockImplementation(() => resolved({ tasks: [{ name: "Daily" }] }));
    const $scope = boot();

    $scope.newScheduledTask();
    $scope.scheduledDraft = {
      name: "Daily", cron: "0 9 * * 1", prompt: "review", intent: "triage",
      agent_config: "fsrpb-anthropic", allow_mutating: false, enabled: true,
    };
    $scope.saveScheduledTask();
    $timeout.flush();
    expect(spies.createScheduledTask).toHaveBeenCalled();
    expect($scope.scheduledEditing).toBe(false);
    expect($scope.scheduledTasks.map((t) => t.name)).toEqual(["Daily"]);
  });

  test("saveScheduledTask surfaces an ok:false envelope without throwing", () => {
    spies.createScheduledTask.mockImplementation(() => resolved({
      ok: false, error: { message: "cron invalid" },
    }));
    const $scope = boot();
    $scope.newScheduledTask();
    $scope.scheduledDraft = {
      name: "Daily", cron: "bad", prompt: "review", intent: "triage",
      agent_config: "fsrpb-anthropic", allow_mutating: false, enabled: true,
    };
    $scope.saveScheduledTask();
    $timeout.flush();
    expect($scope.scheduledFormError).toBe("cron invalid");
    expect($scope.scheduledSaving).toBe(false);
  });

  test("runScheduledTaskNow surfaces a trigger failure envelope", () => {
    spies.runScheduledTaskNow.mockImplementation(() => resolved({
      ok: false, error: { message: "beat down" },
    }));
    const $scope = boot();
    $scope.runScheduledTaskNow("Daily");
    $timeout.flush();
    expect($scope.scheduledError).toBe("beat down");
  });
});

describe(`${viewCtrlName} -- scheduled run history drawer`, () => {
  test("openScheduledHistory loads runs for the named task", () => {
    spies.listScheduledTaskRuns.mockImplementation(() => resolved({ ok: true, runs: [
      { session_id: "sched:Daily:u1", title: "run me", verdict: "all clear",
        stop_reason: "end_turn", parked: false, entries: 2, last_activity: 1700000000 },
    ] }));
    const $scope = boot();

    $scope.openScheduledHistory({ name: "Daily" });
    expect($scope.scheduledHistoryOpen).toBe(true);
    expect($scope.scheduledHistoryTask.name).toBe("Daily");
    expect(spies.listScheduledTaskRuns.mock.calls[0][1]).toBe("Daily");
    $timeout.flush();
    expect($scope.scheduledRuns.map((r) => r.session_id)).toEqual(["sched:Daily:u1"]);
    expect($scope.scheduledRunsLoading).toBe(false);
  });

  test("openScheduledHistory accepts a bare name string", () => {
    spies.listScheduledTaskRuns.mockImplementation(() => resolved({ ok: true, runs: [] }));
    const $scope = boot();
    $scope.openScheduledHistory("Daily");
    expect($scope.scheduledHistoryTask.name).toBe("Daily");
    expect(spies.listScheduledTaskRuns.mock.calls[0][1]).toBe("Daily");
  });

  test("an ok:false envelope sets the error, not an empty list", () => {
    spies.listScheduledTaskRuns.mockImplementation(() => resolved({
      ok: false, error: { message: "no such task" },
    }));
    const $scope = boot();
    $scope.openScheduledHistory({ name: "ghost" });
    $timeout.flush();
    expect($scope.scheduledRunsError).toBe("no such task");
    expect($scope.scheduledRuns).toEqual([]);
    expect($scope.scheduledRunsLoading).toBe(false);
  });

  test("closeScheduledHistory resets drawer state", () => {
    const $scope = boot();
    $scope.scheduledHistoryOpen = true;
    $scope.scheduledHistoryTask = { name: "Daily" };
    $scope.scheduledRuns = [{ session_id: "x" }];
    $scope.scheduledRunsError = "boom";
    $scope.closeScheduledHistory();
    expect($scope.scheduledHistoryOpen).toBe(false);
    expect($scope.scheduledHistoryTask).toBeNull();
    expect($scope.scheduledRuns).toEqual([]);
    expect($scope.scheduledRunsError).toBe("");
  });

  test("scheduledRunBadge maps outcome to a label + class", () => {
    const $scope = boot();
    const badge = (r) => $scope.scheduledRunBadge(r);
    expect(badge({ parked: true, stop_reason: "awaiting_action_card" }).label)
      .toBe("parked · resume");
    expect(badge({ parked: false, stop_reason: "end_turn" }).label).toBe("completed");
    expect(badge({ parked: false, stop_reason: "error" }).label).toBe("failed");
    expect(badge({ parked: false, stop_reason: "awaiting_choice" }).label)
      .toBe("waiting: choice");
    expect(badge(null).label).toBe("--");
  });

  test("openScheduledRun hands the session to the chat and closes both drawers", () => {
    const $scope = boot();
    const loaded = jest.fn();
    $scope.loadSession = loaded; // spy the chat history handoff
    $scope.scheduledHistoryOpen = true;
    $scope.scheduledOpen = true;
    $scope.scheduledHistoryTask = { name: "Daily" };

    $scope.openScheduledRun({ session_id: "sched:Daily:u1", parked: true });
    expect(loaded).toHaveBeenCalledWith("sched:Daily:u1");
    expect($scope.scheduledHistoryOpen).toBe(false);
    expect($scope.scheduledOpen).toBe(false);
  });

  test("openScheduledRun is a no-op without a session_id", () => {
    const $scope = boot();
    const loaded = jest.fn();
    $scope.loadSession = loaded;
    $scope.openScheduledRun({ parked: true });
    expect(loaded).not.toHaveBeenCalled();
  });
});
