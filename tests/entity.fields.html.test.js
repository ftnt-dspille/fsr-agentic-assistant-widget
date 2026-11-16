"use strict";

// ─── entity.fields free-text is HTML-stripped ────────────────────────────────
//
// FortiSIEM/FortiGate (and many detectors) put a styled <div>/<table> block in
// the alert `description`. _buildEntityFields ships the record's substantive
// fields in the chat_turn `entity.fields` map; without stripping, the raw
// `<div class=…>`/`<table>` markup lands there -- it shows as literal tag noise
// in the widget (the model echoes it into an answer rendered by renderMarkdown)
// and is pure tag noise to the model. _cleanFieldText must strip it to readable
// text, the same treatment the summary_seed already gets. Regression for the
// "I see a div class in the widget" report on the IPS-exploit demo alert.

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

const HTML_DESC =
  '<div class="incident-header" style="padding:8px">\n' +
  '  <h4 style="margin:0">High Severity Outbound Permitted IPS Exploit</h4>\n' +
  '</div>\n' +
  '<table style="width:60%;border-collapse:collapse" class="detail">\n' +
  '  <tbody>\n' +
  '    <tr><th style="width:25%;padding:8px">Incident Source</th>' +
  '<td style="padding:8px">Fortinet FortiSIEM</td></tr>\n' +
  '    <tr><th>Source IP</th><td>198.51.100.2</td></tr>\n' +
  '  </tbody>\n' +
  '</table>';

function makeHarness() {
  let $q, $timeout, $rootScope, $controller;
  const sent = [];
  const agentStub = {
    connectorName: "connector-fsr-agentic-assistant",
    resolveConnector: () => $q.when({ name: "connector-fsr-agentic-assistant", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    resolvePersona: () => $q.when(null),
    chatTurn: (cfg, payload) => { sent.push(payload); return $q.defer().promise; },
    chatPoll: () => $q.defer().promise,
  };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", { seedFromEntity: true, opener: "off" });
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$q_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $q = _$q_; $timeout = _$timeout_;
  });
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  $timeout.flush();
  $rootScope.$digest();
  return { $scope, sent, $rootScope };
}

describe(`${viewCtrlName} -- entity.fields HTML stripping`, () => {
  test("a <div>/<table> description ships as readable text, not raw markup", () => {
    const { $scope, sent, $rootScope } = makeHarness();
    $scope.entityContext = {
      iri: "/api/3/alerts/e94dc2dc", module: "alerts",
      record: {
        "@id": "/api/3/alerts/e94dc2dc", module: "alerts",
        name: "High Severity IPS Exploit", severity: "High", status: "Open",
        description: HTML_DESC,
      },
    };
    $rootScope.$digest();
    $scope.viewState = "idle";
    $scope.connectorReady = true;
    $scope.form.inputText = "Triage this alert.";
    $scope.sendMessage();

    expect(sent).toHaveLength(1);
    const fields = sent[0].entity && sent[0].entity.fields;
    expect(fields).toBeTruthy();
    const desc = fields.description;
    expect(desc).toBeTruthy();
    // No raw HTML tags survive.
    expect(desc).not.toMatch(/<[^>]+>/);
    expect(desc).not.toContain("class=");
    expect(desc).not.toContain("style=");
    // The meaningful cell text does survive.
    expect(desc).toContain("Incident Source");
    expect(desc).toContain("Fortinet FortiSIEM");
    expect(desc).toContain("198.51.100.2");
  });
});
