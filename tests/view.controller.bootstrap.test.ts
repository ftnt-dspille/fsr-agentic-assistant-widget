// ─── Layer 0: static + DI bootstrap guard for fsrAgenticAssistant ───────────
//
// Sub-second checks that catch the cheapest-to-catch failure classes WITHOUT a
// browser (SOAR_TEST_KIT_DESIGN.md §3). The class of bug this exists to catch:
//
//   • controller-name ↔ info.json version desync - the 1.0.30 vs "…1029DevCtrl"
//     break that today surfaced only as a 15s browser-bootstrap timeout.
//   • a `data-ng-controller` left on the view.html root - publish rewrites
//     "…DevCtrl"→"…Ctrl" but not the attribute, creating a dead parallel scope.
//     (memory: soar_widget_text_interpolation_stripped)
//   • a $inject naming a service that isn't registered at controller-construct
//     time (e.g. a widgetAssets/js/<x>.js not <script>-tagged from view.html):
//     AngularJS throws "Unknown provider: …" and this fails with the offender.
//
// Approach mirrors widgets-src/c3charts/tests/edit.controller.bootstrap.test.js.

import fs = require("fs");
import path = require("path");

(global as any).jasmine = (global as any).jasmine || {}; // angular-mocks lifecycle gate

require("angular");
require("angular-mocks");

// `cybersponse` is the module widgets register against. Create it before any
// widget IIFE runs so their .controller()/.factory() calls land here.
(angular as any).module("cybersponse", []); // eslint-disable-line no-undef

const WIDGET_DIR = path.resolve(__dirname, "../widget");
const widgetInfo: { name: string; version: string } = require("../widget/info.json");

// Derive the registered controller name from info.json so a version bump only
// touches info.json - the test follows automatically. SOAR's harness suffixes
// "Dev"; the version dots are stripped (1.0.30 -> 1030). The VIEW controller is
// "<name><slug>DevCtrl"; the EDIT controller is "edit<Cap><slug>DevCtrl".
const versionSlug = widgetInfo.version.replace(/\./g, "");
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const viewCtrlName = `${widgetInfo.name}${versionSlug}DevCtrl`;
const editCtrlName = `edit${cap(widgetInfo.name)}${versionSlug}DevCtrl`;

// ─── Static guards (no Angular needed) ──────────────────────────────────────

describe("fsrAgenticAssistant - static guards (Layer 0)", () => {
  const viewSrc = fs.readFileSync(path.join(WIDGET_DIR, "view.controller.js"), "utf8");
  const editSrc = fs.readFileSync(path.join(WIDGET_DIR, "edit.controller.js"), "utf8");
  const viewHtml = fs.readFileSync(path.join(WIDGET_DIR, "view.html"), "utf8");

  test(`view.controller.js registers exactly "${viewCtrlName}" (matches info.json ${widgetInfo.version})`, () => {
    expect(viewSrc).toContain(`.controller('${viewCtrlName}'`);
  });

  test(`edit.controller.js registers exactly "${editCtrlName}"`, () => {
    expect(editSrc).toContain(`.controller('${editCtrlName}'`);
  });

  test("no controller name carries a STALE version slug", () => {
    // Any "<...>NNNNDevCtrl" / "<...>NNNNCtrl" token whose digit run differs
    // from the current version slug is a leftover from a past version bump -
    // exactly the 1029-vs-1030 break. Sweep both controller sources.
    const offenders: string[] = [];
    const re = /([A-Za-z]+)(\d{2,})(Dev)?Ctrl\b/g;
    for (const [label, src] of [["view", viewSrc], ["edit", editSrc]] as [string, string][]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        if (m[2] !== versionSlug) offenders.push(`${label}: ${m[0]} (slug ${m[2]} != ${versionSlug})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("view.html root element carries NO ng-controller (publish would orphan it)", () => {
    // The widget root is the .fsr-pb-widget div. SOAR/harness wraps the
    // ng-include with the dev controller itself; a controller on the root makes
    // a dead parallel scope after publish rewrites the name.
    const rootLine = viewHtml.split("\n").find((l) => /class="fsr-pb-widget"/.test(l));
    expect(rootLine).toBeTruthy();
    expect(rootLine).not.toMatch(/ng-controller/);
  });

  test("the extracted render module exists under widgetAssets/js", () => {
    // The harness AND real SOAR auto-load every widgetAssets/**/*.js before the
    // controller boots - view.html carries NO <script> tags (server.js: "We
    // don't require a <script> tag … the harness loads every .js under
    // widgetAssets/"). So the render module just has to live here for its
    // browser global ($window.FsrPbRender) to be present at runtime. If it ever
    // goes missing, the controller's _appendAssistantMessage throws on turn 1.
    expect(fs.existsSync(path.join(WIDGET_DIR, "widgetAssets/js/fsrPbRender.js"))).toBe(true);
  });

  test("the controller delegates the render pipeline to the render module", () => {
    // Guards the wiring: if someone re-inlines the pipeline or renames the
    // global, this catches it before a browser run does.
    expect(viewSrc).toContain("$window.FsrPbRender.buildAssistantMessage");
    expect(viewSrc).toContain("$window.FsrPbRender.normalizeInfoCard");
  });

  test("view.html carries no <script> tags (harness/SOAR auto-loads JS)", () => {
    // A stray <script> here would double-load (auto-load + tag) and re-register
    // factories - keep the widget's load model consistent with the platform's.
    expect(viewHtml).not.toMatch(/<script\b/);
  });
});

// ─── DI bootstrap (real $injector instantiation) ────────────────────────────

// The render module is a browser global the controller delegates to; require it
// so $window.FsrPbRender resolves during construction (it attaches to window).
require("../widget/widgetAssets/js/fsrPbRender.js");
// Side-effect require - registers the view controller on cybersponse.
require("../widget/view.controller.js");
require("../widget/widgetAssets/js/fsrPbCards.service.js");
require("../widget/widgetAssets/js/fsrPbTranscript.service.js");
require("../widget/widgetAssets/js/fsrPbEntityCards.service.js");
require("../widget/widgetAssets/js/fsrPbHtml.service.js");
require("../widget/widgetAssets/js/fsrPbYaml.service.js");
require("../widget/widgetAssets/js/fsrPbExport.service.js");
require("../widget/widgetAssets/js/fsrPbMarkdown.service.js");

const ng = (window as any).angular; // eslint-disable-line no-undef
const ngModule = ng.mock.module;
const ngInject = ng.mock.inject;

// Allowlist of what the widget's <script>-loaded services + platform provide at
// runtime, stubbed so the injector can satisfy the controller's $inject. If the
// controller injects anything NOT on this list (and not core ng), AngularJS
// throws "Unknown provider: …" and the bootstrap test fails naming the offender
// - that's the contract we enforce. (Mirrors c3charts' bootstrap allowlist.)
const chainable: any = { then: function () { return chainable; }, catch: function () { return chainable; } };
const PLATFORM_STUBS: Record<string, any> = {
  // The widget's own agent bridge (loaded via view.html <script>). Execute is
  // chainable so a construct-time opener turn doesn't blow up.
  fsrPbAgentService: { execute: () => chainable, resume: () => chainable },
  config: {},
};

let $controller: any;
let $rootScope: any;

beforeEach(() => {
  ngModule("cybersponse", ($provide: any) => {
    for (const [name, value] of Object.entries(PLATFORM_STUBS)) {
      $provide.value(name, value);
    }
  });
  ngInject((_$controller_: any, _$rootScope_: any) => {
    $controller = _$controller_;
    $rootScope = _$rootScope_;
  });
});

describe(`${viewCtrlName} - DI bootstrap`, () => {
  test("instantiates against the cybersponse injector with only $scope passed as a local", () => {
    // Every dependency except $scope MUST resolve through the injector
    // (ngMock provides the core ng services; fsrPbAgentService is the widget's
    // own registered factory). If $inject names anything unregistered, this
    // throws "Unknown provider: …Provider <- …".
    let instance: any;
    expect(() => {
      instance = $controller(viewCtrlName, { $scope: $rootScope.$new() });
    }).not.toThrow();
    expect(instance).toBeDefined();
  });

  test("boot wires the baseline scope state", () => {
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope: $scope });
    expect($scope.viewState).toBe("idle");
    expect(Array.isArray($scope.messages)).toBe(true);
    // The controller reaches the render module global it delegates to.
    expect((window as any).FsrPbRender).toBeDefined(); // eslint-disable-line no-undef
    expect(typeof (window as any).FsrPbRender.buildAssistantMessage).toBe("function"); // eslint-disable-line no-undef
  });
});

// ─── Theme handling (light/dark auto-support) ───────────────────────────────

describe(`${viewCtrlName} - theme handling`, () => {
  test("defaults to dark when the platform exposes no theme", () => {
    const $scope = $rootScope.$new();
    delete $rootScope.theme;
    $controller(viewCtrlName, { $scope: $scope });
    expect($scope.currentTheme).toBe("dark");
  });

  test("picks up the active theme from $rootScope.theme at construct time", () => {
    $rootScope.theme = { id: "light" };
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope: $scope });
    expect($scope.currentTheme).toBe("light");
  });

  test("treats space/steel as a non-light theme (stays on dark base - no light overrides)", () => {
    // Only "light" toggles the override class; "steel"/"space" are dark variants.
    $rootScope.theme = { id: "steel" };
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope: $scope });
    expect($scope.currentTheme).toBe("steel");
    expect($scope.currentTheme).not.toBe("light");
  });

  test("reacts to a live theme switch ($rootScope.theme flips at runtime)", () => {
    $rootScope.theme = { id: "dark" };
    const $scope = $rootScope.$new();
    $controller(viewCtrlName, { $scope: $scope });
    expect($scope.currentTheme).toBe("dark");
    $rootScope.theme = { id: "light" };
    $rootScope.$digest();
    expect($scope.currentTheme).toBe("light");
  });
});

// ─── Theme wiring static guards (template + stylesheet) ─────────────────────

describe("fsrAgenticAssistant - theme wiring (static)", () => {
  const viewHtml = fs.readFileSync(path.join(WIDGET_DIR, "view.html"), "utf8");

  test("root element toggles the theme-light class off currentTheme", () => {
    expect(viewHtml).toMatch(/data-ng-class="\{'theme-light': currentTheme === 'light'[,}]/);
  });

  test("root element takes SOAR's panel surface on themes where it is opaque", () => {
    expect(viewHtml).toMatch(/data-ng-class="\{[^"]*'soar-panel-surface': usesPanelSurface\(\)/);
    expect(viewHtml).toContain(".fsr-pb-widget.soar-panel-surface {");
  });

  test("stylesheet ships a .theme-light override block", () => {
    expect(viewHtml).toContain(".fsr-pb-widget.theme-light {");
    // It must re-point the theme inputs every surface and text token derives
    // from, or nothing flips outside SOAR (inside SOAR the theme's own
    // variables drive them: see soarTheme.spec.js).
    const lightBlock = viewHtml.slice(viewHtml.indexOf(".fsr-pb-widget.theme-light {"));
    expect(lightBlock).toMatch(/--soar-bg:/);
    expect(lightBlock).toMatch(/--soar-fg:/);
    expect(viewHtml).toMatch(/--bg-0: var\(--soar-bg\)/);
    expect(viewHtml).toMatch(/--text: var\(--soar-fg\)/);
  });
});
