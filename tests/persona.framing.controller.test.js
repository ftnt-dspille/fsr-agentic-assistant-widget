"use strict";

// ─── Persona-aware opener framing (controller) ───────────────────────────────
//
// When a module declares an assistant persona, the widget must drop SOC-triage
// framing: the greeting card reads in the persona's voice, the composer
// placeholder + quick-action deck come from the persona, and the SOC deck /
// "Build playbook" handoff are suppressed. With no persona, everything is
// byte-unchanged. This drives the controller through resolvePersona and asserts
// each framing helper.

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
const $state = { current: { name: "viewPanel.modulesDetail" }, params: { module: "ztpf_templates", id: "tpl-1" } };

let $controller, $rootScope, $timeout, $q, $httpBackend, personaResult;

function setup() {
  personaResult = null;
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      chatHistory: () => $q.when({ turns: [] }),
      chatTurn: () => $q.when({ accepted: true, turn: 1 }),
      resume: () => $q.when({}),
      modeInfo: () => ({ mode: "mock" }),
      resolvePersona: () => $q.when(personaResult),
    });
    $provide.value("config", { seedFromEntity: true, maxTurns: 8, opener: "off" });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_, _$q_, _$httpBackend_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $timeout = _$timeout_;
    $q = _$q_; $httpBackend = _$httpBackend_;
  });
}

function boot(persona, entity) {
  personaResult = persona;
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  // A populated drawer record so the seed renders synchronously off e.record.
  $scope.entityContext = entity;
  $timeout.flush(0);
  $rootScope.$digest();
  try { $timeout.flush(); } catch (e) { /* no more timers */ }
  $rootScope.$digest();
  return $scope;
}

function seedCard($scope) {
  const m = $scope.messages.find((mm) => mm._seeded && (mm.events || []).some((e) => e.type === "info_card"));
  return m && m.events.find((e) => e.type === "info_card");
}

const TPL_ENTITY = {
  iri: "/api/3/ztpf_templates/tpl-1", module: "ztpf_templates",
  record: { "@id": "/api/3/ztpf_templates/tpl-1", module: "ztpf_templates", name: "Branch Onboarding" },
};
const CASE_ENTITY = {
  iri: "/api/3/cases/case-1", module: "cases",
  record: { "@id": "/api/3/cases/case-1", module: "cases", name: "Suspicious login", severity: "High" },
};

beforeEach(setup);

describe(`${viewCtrlName} -- persona framing`, () => {
  test("persona with a full ui block reframes greeting, placeholder, deck; hides SOC framing", () => {
    const $scope = boot({
      found: true, label: "ZTPF Template Author",
      greeting: "Authoring {module}: {name}",
      subtitle: "Ask me to render, check, or edit this template.",
      placeholder: "Describe the template you want…",
      buildHint: "Describe the template you want and I'll write it.",
      quickActions: [{ key: "explain", label: "Explain", sub: "walk through it", prompt: "Explain this template." }],
      footer: null,
    }, TPL_ENTITY);

    expect($scope.personaUi).toBeTruthy();
    // Greeting card in the persona voice (module interpolated to its singular).
    const card = seedCard($scope);
    expect(card.title).toContain("Authoring");
    expect(card.title).toContain("Branch Onboarding");
    expect(card.title).not.toContain("Triaging");
    // Composer + deck from the persona.
    expect($scope.composerPlaceholder()).toBe("Describe the template you want…");
    expect($scope.personaQuickActions().length).toBe(1);
    expect($scope.showPersonaQuickActions()).toBe(true);
    // Empty-hero copy in the persona voice -- heading via greeting, subtitle via
    // ui.subtitle, build hint via ui.buildHint. No SOC-triage clothing.
    expect($scope.heroHeading()).toContain("Authoring");
    expect($scope.heroHeading()).not.toContain("Triaging");
    expect($scope.heroSub()).toBe("Ask me to render, check, or edit this template.");
    expect($scope.heroSub().toLowerCase()).not.toContain("containment");
    expect($scope.buildHintSub()).toBe("Describe the template you want and I'll write it.");
    expect($scope.buildHintSub()).not.toContain("FortiSOC");
    // SOC framing suppressed.
    expect($scope.showQuickActions()).toBe(false);
    expect($scope.canBuildFromTriage()).toBe(false);
  });

  test("persona WITHOUT a ui block ⇒ neutral best-effort framing (no SOC voice)", () => {
    const $scope = boot({ found: true, label: null, greeting: null, placeholder: null, quickActions: null, footer: null }, TPL_ENTITY);
    const card = seedCard($scope);
    expect(card.title).toContain("Working on");
    expect(card.title).not.toContain("Triaging");
    expect($scope.composerPlaceholder()).toBe("Describe what you want to do…");
    // Hero + build hint fall to the neutral persona line, not the SOC default.
    expect($scope.heroHeading()).toContain("Working on");
    expect($scope.heroHeading()).not.toContain("Triaging");
    expect($scope.heroSub()).toBe("Ask me to explain, edit, or work on this record.");
    expect($scope.heroSub().toLowerCase()).not.toContain("containment");
    expect($scope.buildHintSub()).toBe("Describe what you want to build and I'll generate the YAML.");
    expect($scope.buildHintSub()).not.toContain("FortiSOC");
    // No persona deck (no actions) AND no SOC deck.
    expect($scope.showPersonaQuickActions()).toBe(false);
    expect($scope.showQuickActions()).toBe(false);
    expect($scope.canBuildFromTriage()).toBe(false);
  });

  test("no persona ⇒ triage framing byte-unchanged", () => {
    const $scope = boot(null, CASE_ENTITY);
    expect($scope.personaUi).toBeNull();
    const card = seedCard($scope);
    expect(card.title).toContain("Triaging");
    expect($scope.composerPlaceholder()).toBe("Paste the FortiSOC AI summary here, or describe what you want to do…");
    // Hero + build hint SOC copy. No "--" dash substitute in analyst-facing
    // text (the widget bans em dashes, so "--" read as unfinished copy).
    expect($scope.heroHeading()).toContain("Triaging");
    expect($scope.heroSub()).toBe("I'll suggest containment actions (block, isolate, disable), or build a re-runnable hunt and respond playbook for this case.");
    expect($scope.buildHintSub()).toBe("Describe the playbook you want, or paste a FortiSOC summary, and I'll generate the YAML.");
    expect($scope.heroSub()).not.toContain(" -- ");
    expect($scope.buildHintSub()).not.toContain(" -- ");
    expect($scope.showQuickActions()).toBe(true);
    expect($scope.showPersonaQuickActions()).toBe(false);
  });

  test("pull-page-details button: triage says 'Case context'; persona says 'Record context' (no case wording)", () => {
    // Triage: the historical wording is preserved byte-for-byte.
    const triage = boot(null, CASE_ENTITY);
    expect(triage.pageDetailsLabel()).toBe("⊕ Case context");
    expect(triage.pageDetailsTitle()).toBe("Pull in details from the case I'm looking at");

    // Persona (no override): neutral, no "case" language leaking onto a ztpf record.
    const persona = boot({ found: true, label: "ZTPF Authoring", greeting: null, placeholder: null, quickActions: null, footer: null }, TPL_ENTITY);
    expect(persona.pageDetailsLabel()).toBe("⊕ Record context");
    expect(persona.pageDetailsTitle()).toBe("Pull in details from this record");
    expect(persona.pageDetailsLabel().toLowerCase()).not.toContain("case");

    // Persona can override the label/hint via its ui block.
    const custom = boot({ found: true, label: "ZTPF Authoring", pullLabel: "This template", pullHint: "Pull in this template's fields", greeting: null, placeholder: null, quickActions: null, footer: null }, TPL_ENTITY);
    expect(custom.pageDetailsLabel()).toBe("⊕ This template");
    expect(custom.pageDetailsTitle()).toBe("Pull in this template's fields");
  });
});

describe("playbook designer framing", () => {
  const PB = { iri: "/api/3/workflows/pb-1", module: "workflows",
               record: { "@id": "/api/3/workflows/pb-1", name: "Enrich IP" } };

  function inDesigner() {
    const $scope = boot(null, PB);
    $scope.inPlaybookEditor = true;
    $scope.entityContext = PB;
    return $scope;
  }

  test("the composer asks for a change, not a FortiSOC summary", () => {
    const $scope = inDesigner();
    expect($scope.composerPlaceholder()).toBe("Describe a change to this playbook…");
    $scope.entityContext = null;
    expect($scope.composerPlaceholder()).toBe("Describe the playbook you want…");
  });

  test("'Apply to designer' needs YAML that differs from the open playbook", () => {
    const $scope = inDesigner();
    $scope.playbookYaml = "collection: x\n";
    $scope.currentYaml = "";
    expect($scope.yamlHasChanges()).toBe(false);
    // The pane is seeded with the open playbook itself: nothing to apply yet.
    $scope.currentYaml = "collection: x";
    expect($scope.yamlHasChanges()).toBe(false);
    $scope.currentYaml = "collection: y\n";
    expect($scope.yamlHasChanges()).toBe(true);
  });

  test("outside the designer any YAML is a new playbook to create", () => {
    const $scope = boot(null, CASE_ENTITY);
    $scope.currentYaml = "collection: x\n";
    expect($scope.yamlHasChanges()).toBe(true);
  });
});

describe("opener record card", () => {
  function lead(description) {
    const $scope = boot(null, {
      iri: "/api/3/alerts/a-1", module: "alerts",
      record: { "@id": "/api/3/alerts/a-1", module: "alerts", name: "Beacon", description },
    });
    const block = seedCard($scope).blocks.find((b) => b.kind === "text");
    return block.text;
  }

  test("shows a lead, not the whole description the record page already shows", () => {
    const text = lead("First finding is here. " + "More detail follows in the alert body. ".repeat(20));
    expect(text.length).toBeLessThanOrEqual(280);
  });

  test("ends on a sentence when one finishes late enough", () => {
    const first = "A".repeat(150) + " was captured in the alert.";
    const text = lead(first + " " + "Then more words keep going ".repeat(20));
    expect(text).toBe(first);
  });

  test("otherwise ends on a whole word, never mid-word", () => {
    const text = lead("captured in the alert " + "word ".repeat(80) + "alerting");
    expect(text.endsWith("word…")).toBe(true);
  });
});

describe("opener record card rows", () => {
  test("a row the lead already states is not repeated under it", () => {
    const $scope = boot(null, {
      iri: "/api/3/alerts/a-2", module: "alerts",
      record: { "@id": "/api/3/alerts/a-2", module: "alerts", name: "Beacon",
                description: "Category: Exfiltration\\nStatus: Open", status: "Open",
                source: "Fortinet FortiSIEM" },
    });
    const rows = seedCard($scope).blocks.find((b) => b.kind === "rows").rows;
    expect(rows.map((r) => r.label)).toEqual(["Source"]);
  });
});
