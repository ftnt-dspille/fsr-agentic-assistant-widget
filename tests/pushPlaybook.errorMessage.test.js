"use strict";

// ─── pushPlaybook error rendering ───
//
// A failed push returns {ok:false, error:{code, message, ...}} (the connector's
// `_err()` shape). The old code did `res.error || JSON.stringify(res)`, and
// since an object is truthy, string-concatenation coerced it to the useless
// literal "[object Object]" instead of falling through to a readable message
// (found live: local-dev-loop push_playbook against a box with no crudhub
// bridge returns exactly this shape). Assert the real message/code surfaces.

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
const viewCtrlName = `${widgetInfo.name}${widgetInfo.version.replace(/\./g, "")}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef

function makeHarness(pushResult) {
  let $q, $rootScope, $controller, $timeout;

  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when({ contract_version: "2.6.0", turn: 1, stop_reason: "end_turn", transcript: [] }),
    chatPoll: () => $q.when({ contract_version: "2.6.0", turn: 1, cursor: 0, done: false, frames: [] }),
    pushPlaybook: () => $q.when(pushResult)
  };

  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", {});
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
  });

  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  $scope.currentYaml = "playbooks:\n  - name: x\n    steps: []\n";
  return { $scope, $rootScope };
}

describe("fsrAgenticAssistant -- pushPlaybook error rendering", () => {
  test("connector _err() shape ({code,message}) renders the real message, not [object Object]", () => {
    const h = makeHarness({
      ok: false,
      error: { code: "crudhub_unavailable", message: "integrations.crudhub.make_request is only available inside a FortiSOAR runtime." }
    });
    h.$scope.pushPlaybook();
    h.$rootScope.$apply();

    const sysMsgs = h.$scope.messages.filter((m) => m.role === "system");
    const last = sysMsgs[sysMsgs.length - 1];
    expect(last.text).toContain("Create failed:");
    expect(last.text).toContain("integrations.crudhub.make_request is only available inside a FortiSOAR runtime.");
    expect(last.text).not.toContain("[object Object]");
  });

  test("error with only a code (no message) falls back to the code", () => {
    const h = makeHarness({ ok: false, error: { code: "push_no_record" } });
    h.$scope.pushPlaybook();
    h.$rootScope.$apply();

    const sysMsgs = h.$scope.messages.filter((m) => m.role === "system");
    expect(sysMsgs[sysMsgs.length - 1].text).toBe("Create failed: push_no_record");
  });

  test("the save guard's refusal names the step in plain words, never its internal path", () => {
    // The live fsr159 envelope (N7): a hand edit that dropped the step "Upd".
    const h = makeHarness({ ok: false, error: {
      code: "would_drop_fields",
      message: "refusing to save: 1 field(s) present in the live playbook are missing from what you are about to write:\n  - collection.workflows[_prewrite_wf].steps[Upd]\nIf a deletion IS what was asked for, re-issue the save with those paths in `acknowledged_drops`",
      dropped: ["collection.workflows[_prewrite_wf].steps[Upd]"],
    } });
    h.$scope.pushPlaybook();
    h.$rootScope.$apply();

    const sysMsgs = h.$scope.messages.filter((m) => m.role === "system");
    const text = sysMsgs[sysMsgs.length - 1].text;
    expect(text).toContain('would delete the step "Upd"');
    expect(text).toContain("ask me to remove it");
    expect(text).not.toMatch(/_prewrite_wf|acknowledged_drops|failed:/);
    expect(h.$scope.viewState).toBe("idle");
  });

  test("string error still renders as-is", () => {
    const h = makeHarness({ ok: false, error: "plain string failure" });
    h.$scope.pushPlaybook();
    h.$rootScope.$apply();

    const sysMsgs = h.$scope.messages.filter((m) => m.role === "system");
    expect(sysMsgs[sysMsgs.length - 1].text).toBe("Create failed: plain string failure");
  });
});
