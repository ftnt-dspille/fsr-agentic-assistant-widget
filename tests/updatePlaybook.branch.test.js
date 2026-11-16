"use strict";

// ─── pushPlaybook create-vs-update branch (Track C2) ───
//
// The Create/Save button (controller.pushPlaybook) now picks modify-in-place
// vs create by whether an open-playbook workflow IRI is seeded on entityContext:
//   - in the playbook designer over a `workflows` IRI → updatePlaybook (PUT in place)
//   - no open playbook (dashboard / triage-derived build) → pushPlaybook (create collection)
// One entry point, branched on the seeded entity. Asserts both branches and the
// module guard (an alert/case IRI over the designer is NOT treated as an update target).

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

function makeHarness(opts) {
  let $q, $rootScope, $controller, $timeout;
  const calls = { push: 0, update: 0, updateIri: null, updateSession: undefined };

  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => $q.when({ contract_version: "2.6.0", turn: 1, stop_reason: "end_turn", transcript: [] }),
    chatPoll: () => $q.when({ contract_version: "2.6.0", turn: 1, cursor: 0, done: false, frames: [] }),
    pushPlaybook: function () { calls.push++; return $q.when(opts.createResult); },
    updatePlaybook: function (cfg, yaml, iri, sessionId, o) {
      calls.update++; calls.updateIri = iri; calls.updateSession = sessionId;
      calls.updateOpts = o;
      return $q.when(opts.updateResult);
    }
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
  return { $scope, $rootScope, calls };
}

const OK_CREATE = {
  ok: true, collection_uuid: "coll-1",
  workflow_uuids: ["wf-1"], raw: { name: "New PB" }
};
const OK_UPDATE = {
  ok: true, workflow_iri: "/api/3/workflows/wf-9", workflow_uuid: "wf-9",
  method: "put", raw: { name: "Edited PB" }
};

describe("fsrAgenticAssistant -- pushPlaybook create-vs-update branch (C2)", () => {
  test("no open playbook → pushPlaybook (create)", () => {
    const h = makeHarness({ createResult: OK_CREATE, updateResult: OK_UPDATE });
    h.$scope.inPlaybookEditor = false;
    h.$scope.entityContext = null;

    h.$scope.pushPlaybook();
    h.$rootScope.$apply();

    expect(h.calls.push).toBe(1);
    expect(h.calls.update).toBe(0);
    const last = h.$scope.messages.filter((m) => m.role === "system").slice(-1)[0];
    expect(last.text).toContain("Created playbook");
    expect(h.$scope.playbookLink).toBe("/playbooks/wf-1");
  });

  test("open workflows IRI in the designer routes to updatePlaybook (modify in place)", () => {
    const h = makeHarness({ createResult: OK_CREATE, updateResult: OK_UPDATE });
    h.$scope.inPlaybookEditor = true;
    h.$scope.entityContext = { iri: "/api/3/workflows/wf-9", module: "workflows" };

    h.$scope.pushPlaybook();
    h.$rootScope.$apply();

    expect(h.calls.update).toBe(1);
    expect(h.calls.updateIri).toBe("/api/3/workflows/wf-9");
    expect(h.calls.push).toBe(0);
    const last = h.$scope.messages.filter((m) => m.role === "system").slice(-1)[0];
    expect(last.text).toContain("Updated playbook");
    expect(h.$scope.playbookLink).toBe("/playbooks/wf-9");
  });

  test("an update carries the session id, so its restore point is attributable", () => {
    // The connector snapshots the playbook into its Versions tab before it
    // writes, noting "ai-pre-edit <session_id>". Without the id the rollback
    // point still exists but can't be traced to the chat that caused it.
    const h = makeHarness({ createResult: OK_CREATE, updateResult: OK_UPDATE });
    h.$scope.inPlaybookEditor = true;
    h.$scope.entityContext = { iri: "/api/3/workflows/wf-9", module: "workflows" };

    h.$scope.pushPlaybook();
    h.$rootScope.$apply();

    expect(h.calls.update).toBe(1);
    // The id sent must be THIS chat's live session -- not a fresh or empty one,
    // or the snapshot note points at a conversation that never happened.
    // (`sessionId` is exposed on the widget's test probe, not on $scope.)
    const liveSession = window.__agenticAssistant__.sessionId;
    expect(liveSession).toBeTruthy();
    expect(h.calls.updateSession).toBe(liveSession);
  });

  test("module guard: an alert/case IRI over the designer is NOT an update target", () => {
    const h = makeHarness({ createResult: OK_CREATE, updateResult: OK_UPDATE });
    h.$scope.inPlaybookEditor = true;
    // A mis-seed: the entity is an alert, not a workflow. Must fall back to create,
    // not PUT to /api/3/workflows/<alert-uuid>.
    h.$scope.entityContext = { iri: "/api/3/alerts/123", module: "alerts" };

    h.$scope.pushPlaybook();
    h.$rootScope.$apply();

    expect(h.calls.push).toBe(1);
    expect(h.calls.update).toBe(0);
  });

  test("update failure renders the update-specific verb + the real error", () => {
    const h = makeHarness({
      createResult: OK_CREATE,
      // There is no import_jobs fallback any more -- a PUT failure IS the result.
      updateResult: { ok: false, error: { code: "update_failed", message: "PUT 405 Method Not Allowed" } }
    });
    h.$scope.inPlaybookEditor = true;
    h.$scope.entityContext = { iri: "/api/3/workflows/wf-9", module: "workflows" };

    h.$scope.pushPlaybook();
    h.$rootScope.$apply();

    const last = h.$scope.messages.filter((m) => m.role === "system").slice(-1)[0];
    expect(last.text).toContain("Update failed:");
    expect(last.text).toContain("PUT 405 Method Not Allowed");
  });
});

// With the designer open, a PUT behind the canvas stays invisible until a page
// reload (and the analyst's next Save overwrites it with the stale canvas), so
// the button stages instead: the change lands in the canvas as unsaved edits.
describe("pushPlaybook in the open designer stages into the canvas", () => {
  let detailEl, detail;
  beforeEach(() => {
    detail = { entity: { "@id": "/api/3/workflows/wf-9", uuid: "wf-9", name: "Edited PB", steps: [] },
               details: { $dirty: false }, emitted: [],
               $emit(...args) { this.emitted.push(args); } };
    detailEl = document.createElement("div");
    detailEl.setAttribute("data-cs-designer-detail", "playbook");
    document.body.appendChild(detailEl);
    ng.element(detailEl).data("$isolateScope", detail);
  });
  afterEach(() => detailEl.remove());

  const STAGED = { ok: true, staged: true, workflow_iri: "/api/3/workflows/wf-9",
                   workflow_uuid: "wf-9", version_uuid: "v-1",
                   workflow: { steps: [{ name: "Start" }, { name: "Note" }], routes: [] } };

  test("asks the connector to stage, then loads the result into the designer", () => {
    const h = makeHarness({ createResult: OK_CREATE, updateResult: STAGED });
    h.$scope.inPlaybookEditor = true;
    h.$scope.entityContext = { iri: "/api/3/workflows/wf-9", module: "workflows" };
    expect(h.$scope.hasOpenPlaybook()).toBe(true);

    h.$scope.pushPlaybook();
    h.$rootScope.$apply();

    expect(h.calls.updateOpts).toEqual({ stage: true });
    expect(detail.emitted).toHaveLength(1);
    const [evt, merged, second] = detail.emitted[0];
    expect(evt).toBe("designerDetail:entityUpdated");
    expect(second).toBe(true);
    expect(merged.steps.map((s) => s.name)).toEqual(["Start", "Note"]);
    expect(merged["@id"]).toBe("/api/3/workflows/wf-9");   // designer identity kept
    expect(detail.details.$dirty).toBe(true);              // Save is armed
    const last = h.$scope.messages.filter((m) => m.role === "system").slice(-1)[0];
    expect(last.text).toContain("in the designer");
    expect(last.text).not.toContain("Updated playbook");
  });

  test("with no open playbook the button still creates, and says so", () => {
    const h = makeHarness({ createResult: OK_CREATE, updateResult: STAGED });
    h.$scope.inPlaybookEditor = false;
    h.$scope.entityContext = null;
    expect(h.$scope.hasOpenPlaybook()).toBe(false);
    h.$scope.pushPlaybook();
    h.$rootScope.$apply();
    expect(h.calls.push).toBe(1);
    expect(detail.emitted).toHaveLength(0);
  });
});

