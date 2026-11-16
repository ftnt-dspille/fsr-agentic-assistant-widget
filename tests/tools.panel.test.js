"use strict";

// ─── Tools panel + overflow menu ────────────────────────────────────────────
//
// A read-only "what can the agent do on this module?" list, opened from the
// overflow menu. It calls list_agent_tools ALWAYS with triage intent (this UI
// never lists build-authoring tools) and the mounted module, and renders the
// resulting triage surface. The connector applies the module's persona slice
// when one exists (persona_applied). These tests drive openTools()/the menu
// toggles with a stubbed service.

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

let $controller, $rootScope, $timeout, listAgentToolsSpy;

const TRIAGE_SURFACE = {
  ok: true,
  module: "ztpf_devices",
  persona_applied: true,
  surfaces: [
    { intent: "triage", count: 3, tools: [
      { name: "get_record", tier: 1, confirm_mode: "auto", source: "safe", description: "Fetch one record." },
      { name: "create_record", tier: 3, confirm_mode: "approve", source: "safe", description: "Create a record." },
      { name: "mcp_soc__get_alert", tier: 2, confirm_mode: "approve", source: "mcp:soc", description: "Native MCP." },
    ] },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  listAgentToolsSpy = jest.fn(() => resolved(TRIAGE_SURFACE));

  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => resolved({ name: "x", version: "1", configId: "c1" }),
      resolvePersona: () => resolved(null),
      chatHistory: () => resolved({ turns: [] }),
      listSessions: () => resolved({ sessions: [] }),
      listAgentTools: listAgentToolsSpy,
      execute: () => resolved({}),
      resume: () => resolved({}),
      modeInfo: () => ({ mode: "live", mock_scenario: null }),
    });
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

describe(`${viewCtrlName} - overflow menu`, () => {
  test("menu is closed by default and toggles", () => {
    const $scope = boot();
    expect($scope.menuOpen).toBe(false);
    $scope.toggleMenu();
    expect($scope.menuOpen).toBe(true);
    $scope.closeMenu();
    expect($scope.menuOpen).toBe(false);
  });
});

describe(`${viewCtrlName} - tools panel`, () => {
  test("openTools always requests triage intent for the mounted module", () => {
    const $scope = boot();
    $scope.entityContext = { module: "ztpf_devices" };
    $scope.menuOpen = true;
    $scope.openTools();

    const [, payload] = listAgentToolsSpy.mock.calls[0];
    expect(payload.intent).toBe("triage"); // never 'build'
    expect(payload.module).toBe("ztpf_devices");
    // Opening a panel closes the menu it was launched from.
    expect($scope.menuOpen).toBe(false);
    expect($scope.toolsOpen).toBe(true);
  });

  test("maps the triage surface, persona flag, and module", () => {
    const $scope = boot();
    $scope.entityContext = { module: "ztpf_devices" };
    $scope.openTools();

    expect($scope.toolsLoading).toBe(false);
    expect($scope.tools.map((t) => t.name)).toEqual([
      "get_record", "create_record", "mcp_soc__get_alert",
    ]);
    expect($scope.toolsPersonaApplied).toBe(true);
    expect($scope.toolsModule).toBe("ztpf_devices");
    expect($scope.toolsError).toBe("");
  });

  test("picks the triage surface even when build is also returned", () => {
    listAgentToolsSpy.mockImplementation(() => resolved({
      ok: true, persona_applied: false,
      surfaces: [
        { intent: "build", tools: [{ name: "compile_yaml", tier: 0 }] },
        { intent: "triage", tools: [{ name: "get_record", tier: 1 }] },
      ],
    }));
    const $scope = boot();
    $scope.openTools();
    expect($scope.tools.map((t) => t.name)).toEqual(["get_record"]);
  });

  test("toolIsWrite flags tier>=3 (approval-gated writes) only", () => {
    const $scope = boot();
    expect($scope.toolIsWrite({ tier: 3 })).toBe(true);
    expect($scope.toolIsWrite({ tier: 4 })).toBe(true);
    expect($scope.toolIsWrite({ tier: 1 })).toBe(false);
    expect($scope.toolIsWrite({ tier: 0 })).toBe(false);
    expect($scope.toolIsWrite(null)).toBe(false);
  });

  test("surfaces an error without throwing and clears the list", () => {
    listAgentToolsSpy.mockImplementation(() => rejected({ message: "connector down" }));
    const $scope = boot();
    $scope.openTools();
    expect($scope.toolsError).toBe("connector down");
    expect($scope.toolsLoading).toBe(false);
    expect($scope.tools).toEqual([]);
  });

  test("empty surface yields no tools and no error", () => {
    listAgentToolsSpy.mockImplementation(() => resolved({
      ok: true, persona_applied: false, surfaces: [{ intent: "triage", tools: [] }],
    }));
    const $scope = boot();
    $scope.openTools();
    expect($scope.tools).toEqual([]);
    expect($scope.toolsError).toBe("");
    expect($scope.toolsPersonaApplied).toBe(false);
  });

  test("closeTools hides the panel", () => {
    const $scope = boot();
    $scope.openTools();
    expect($scope.toolsOpen).toBe(true);
    $scope.closeTools();
    expect($scope.toolsOpen).toBe(false);
  });
});

describe(`${viewCtrlName} - tools filter`, () => {
  test("empty filter returns the full list", () => {
    const $scope = boot();
    $scope.openTools();
    $scope.toolsSearch.q = "";
    expect($scope.filteredTools().map((t) => t.name)).toEqual([
      "get_record", "create_record", "mcp_soc__get_alert",
    ]);
  });

  test("filters case-insensitively on name", () => {
    const $scope = boot();
    $scope.openTools();
    $scope.toolsSearch.q = "CREATE";
    expect($scope.filteredTools().map((t) => t.name)).toEqual(["create_record"]);
  });

  test("filters on description text too", () => {
    const $scope = boot();
    $scope.openTools();
    $scope.toolsSearch.q = "native mcp";
    expect($scope.filteredTools().map((t) => t.name)).toEqual(["mcp_soc__get_alert"]);
  });

  test("a non-matching filter yields an empty list (no throw)", () => {
    const $scope = boot();
    $scope.openTools();
    $scope.toolsSearch.q = "zzz-nope";
    expect($scope.filteredTools()).toEqual([]);
  });

  test("openTools resets a stale filter, and clearToolsFilter empties it", () => {
    const $scope = boot();
    $scope.toolsSearch.q = "leftover";
    $scope.openTools();
    expect($scope.toolsSearch.q).toBe("");
    $scope.toolsSearch.q = "get";
    $scope.clearToolsFilter();
    expect($scope.toolsSearch.q).toBe("");
  });
});
