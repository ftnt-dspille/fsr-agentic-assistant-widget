"use strict";

// ─── A3 triage-draft handoff + F .events.json sidecar ──────────────────────
//
// A3: the agent can author YAML in a triage session; the build-only YAML pane
//     hides it (view.html gates on uiIntent !== 'triage'). Rather than lose the
//     draft silently, hasTriageDraft() surfaces a CTA and openDraftInBuild()
//     flips intent to 'build' to reveal the existing pane.
//     Build UI is editor-only over a record: the stray-draft CTA now surfaces
//     ONLY inside the playbook designer (inPlaybookEditor). Over a module or
//     record an incidental ```yaml never flips the widget into build - build on
//     a record is reachable solely via the explicit triage→playbook handoff.
// F:  downloadExportJson() emits a machine-readable sidecar with a header
//     manifest (intent, per-tool counts, error count, finalYaml) so a reviewer
//     can see the failure shape without paging the 2,500-line markdown.

const fs = require("fs");
const path = require("path");

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
const chainable = { then: function () { return chainable; }, catch: function () { return chainable; } };
const PLATFORM_STUBS = {
  fsrPbAgentService: {
    execute: () => chainable,
    resume: () => chainable,
    chatHistory: () => chainable,
    modeInfo: () => ({ mode: "mock", mock_scenario: "demo" }),
  },
  config: {},
};

let $controller;
let $rootScope;

beforeEach(() => {
  ng.mock.module("cybersponse", ($provide) => {
    for (const [name, value] of Object.entries(PLATFORM_STUBS)) $provide.value(name, value);
  });
  ng.mock.inject((_$controller_, _$rootScope_) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
  });
});

function boot(extraLocals) {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, Object.assign({ $scope }, extraLocals || {}));
  return $scope;
}

describe(`${viewCtrlName} - A3 triage-draft handoff`, () => {
  test("hasTriageDraft is false with no YAML", () => {
    const $scope = boot();
    $scope.uiIntent = "triage";
    $scope.viewState = "idle";
    $scope.currentYaml = "";
    expect($scope.hasTriageDraft()).toBe(false);
  });

  test("hasTriageDraft is true when YAML is drafted in idle triage IN THE EDITOR", () => {
    const $scope = boot();
    $scope.inPlaybookEditor = true;
    $scope.uiIntent = "triage";
    $scope.viewState = "idle";
    $scope.currentYaml = "playbooks:\n  - name: x";
    expect($scope.hasTriageDraft()).toBe(true);
  });

  test("hasTriageDraft is FALSE over a record (build UI is editor-only)", () => {
    const $scope = boot();
    $scope.inPlaybookEditor = false;   // mounted over a module/record
    $scope.uiIntent = "triage";
    $scope.viewState = "idle";
    $scope.currentYaml = "playbooks:\n  - name: x";
    expect($scope.hasTriageDraft()).toBe(false);
  });

  test("hasTriageDraft is false while a turn is in flight", () => {
    const $scope = boot();
    $scope.uiIntent = "triage";
    $scope.viewState = "sending";
    $scope.currentYaml = "playbooks: []";
    expect($scope.hasTriageDraft()).toBe(false);
  });

  test("hasTriageDraft is false in build mode (the pane already shows there)", () => {
    const $scope = boot();
    $scope.uiIntent = "build";
    $scope.viewState = "idle";
    $scope.currentYaml = "playbooks: []";
    expect($scope.hasTriageDraft()).toBe(false);
  });

  test("openDraftInBuild flips uiIntent to build so the YAML pane reveals", () => {
    const $scope = boot();
    $scope.inPlaybookEditor = true;   // draft CTA is editor-only
    $scope.uiIntent = "triage";
    $scope.viewState = "idle";
    $scope.currentYaml = "playbooks: []";
    $scope.openDraftInBuild();
    expect($scope.uiIntent).toBe("build");
    // The pane gate (currentYaml && uiIntent !== 'triage') is now satisfied.
    expect($scope.currentYaml && $scope.uiIntent !== "triage").toBeTruthy();
  });

  test("openDraftInBuild is a no-op when there is no draft", () => {
    const $scope = boot();
    $scope.uiIntent = "triage";
    $scope.viewState = "idle";
    $scope.currentYaml = "";
    $scope.openDraftInBuild();
    expect($scope.uiIntent).toBe("triage");
  });
});

describe(`${viewCtrlName} - YAML pane copy + width swap`, () => {
  let $timeout;
  beforeEach(() => {
    ng.mock.inject((_$timeout_) => { $timeout = _$timeout_; });
  });

  test("toggleYamlWidth flips yamlWide", () => {
    const $scope = boot();
    expect($scope.yamlWide).toBe(false);
    $scope.toggleYamlWidth();
    expect($scope.yamlWide).toBe(true);
    $scope.toggleYamlWidth();
    expect($scope.yamlWide).toBe(false);
  });

  test("copyYaml sets yamlCopied feedback then clears it", () => {
    let written = null;
    const stubWindow = Object.create(window); // eslint-disable-line no-undef
    stubWindow.navigator = { clipboard: { writeText: (t) => { written = t; } } };
    const $scope = boot({ $window: stubWindow });
    $scope.currentYaml = "playbooks: []";
    $scope.copyYaml();
    expect(written).toBe("playbooks: []");
    expect($scope.yamlCopied).toBe(true);
    $timeout.flush(2000);
    expect($scope.yamlCopied).toBe(false);
  });

  test("copyYaml is a no-op (no feedback) with empty YAML", () => {
    const $scope = boot();
    $scope.currentYaml = "";
    $scope.copyYaml();
    expect($scope.yamlCopied).toBe(false);
  });
});

describe(`${viewCtrlName} - F .events.json sidecar`, () => {
  // Capture the blob content downloadExportJson would write by stubbing the
  // $window Blob/URL/anchor plumbing.
  function bootWithBlobCapture() {
    const captured = { text: null, name: null };
    const realWindow = window; // eslint-disable-line no-undef
    // Delegate everything (location, navigator, console, document…) to the real
    // jsdom window so construct-time code works; override only the download
    // plumbing so we can capture the blob payload.
    const stubWindow = Object.create(realWindow);
    stubWindow.Blob = function (parts) { captured.text = parts.join(""); };
    stubWindow.URL = { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} };
    const $scope = boot({ $window: stubWindow });
    return { $scope, captured };
  }

  test("manifest summarizes intent, tool counts, error count and finalYaml", () => {
    const { $scope, captured } = bootWithBlobCapture();
    $scope.uiIntent = "triage";
    $scope.currentYaml = "playbooks: []";
    $scope.messages = [
      {
        role: "assistant",
        events: [
          { type: "tool_call", name: "get_record", resultStatus: "ok" },
          { type: "tool_call", name: "get_record", resultStatus: "ok" },
          { type: "tool_call", name: "validate_yaml", resultStatus: "error" },
          { type: "error" },
        ],
      },
    ];
    $scope.downloadExportJson();
    expect(captured.text).toBeTruthy();
    const doc = JSON.parse(captured.text);
    expect(doc.manifest.intent).toBe("triage");
    expect(doc.manifest.toolCallCount).toBe(3);
    expect(doc.manifest.toolCallsByName.get_record).toBe(2);
    expect(doc.manifest.toolCallsByName.validate_yaml).toBe(1);
    // one tool_call with resultStatus 'error' + one standalone error event
    expect(doc.manifest.errorCount).toBe(2);
    expect(doc.manifest.finalYaml).toBe(true);
    expect(doc.messages.length).toBe(1);
    expect(doc.currentYaml).toBe("playbooks: []");
  });

  test("emits valid JSON even with an empty conversation", () => {
    const { $scope, captured } = bootWithBlobCapture();
    $scope.messages = [];
    $scope.currentYaml = "";
    $scope.downloadExportJson();
    const doc = JSON.parse(captured.text);
    expect(doc.manifest.toolCallCount).toBe(0);
    expect(doc.manifest.finalYaml).toBe(false);
    expect(doc.currentYaml).toBeNull();
  });
});

describe("fsrAgenticAssistant - A3/F template wiring (static)", () => {
  const viewHtml = fs.readFileSync(path.join(__dirname, "../widget/view.html"), "utf8");

  test("triage-draft CTA is gated on hasTriageDraft()", () => {
    expect(viewHtml).toMatch(/ng-if="hasTriageDraft\(\)"/);
    expect(viewHtml).toContain('data-testid="open-draft-in-build"');
    expect(viewHtml).toContain("openDraftInBuild()");
  });

  test("export modal exposes the .events.json download", () => {
    expect(viewHtml).toContain('data-testid="export-download-json"');
    expect(viewHtml).toContain("downloadExportJson()");
  });

  test("YAML pane has copy-feedback + width-swap controls wired", () => {
    expect(viewHtml).toContain('data-testid="yaml-copy"');
    expect(viewHtml).toMatch(/yamlCopied \? '✓ Copied' : 'Copy'/);
    expect(viewHtml).toContain('data-testid="yaml-width-toggle"');
    expect(viewHtml).toContain("toggleYamlWidth()");
    // the body flexes via a class on the parent, no :has() dependency
    expect(viewHtml).toMatch(/<div class="body" ng-class="\{'yaml-wide': yamlWide\}"/);
    expect(viewHtml).toContain(".body.yaml-wide .yaml-pane");
  });

  test("controller never hardcodes the info.json WIDGET version (footgun guard)", () => {
    // The widget version is derived from the served path at runtime; a literal
    // copy of info.json's version (even in a comment) drifts on bump and trips
    // the harness `stale-version-ref` lint, blocking bootstrap. Contract
    // versions (2.7.0 etc.) are intentionally pinned and out of scope here.
    // Retargeted: the controller's services (widgetAssets/js/*.service.js) hold
    // code moved out of the controller, so the guard scans all of them.
    const widgetJsDir = path.join(__dirname, "../widget/widgetAssets/js");
    const serviceFiles = fs.readdirSync(widgetJsDir).filter((f) => f.endsWith(".service.js"));
    const sources = [path.join(__dirname, "../widget/view.controller.js")]
      .concat(serviceFiles.map((f) => path.join(widgetJsDir, f)))
      .map((p) => fs.readFileSync(p, "utf8"));
    for (const src of sources) expect(src).not.toContain(widgetInfo.version);
    expect(serviceFiles.length).toBeGreaterThan(0);
  });
});
