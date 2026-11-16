"use strict";

// ─── Seed summary card: sanitize record HTML; strip it for the LLM seed ───────
//
// Record free-text fields (AWS GuardDuty etc.) carry HTML -- "<p>GuardDuty
// finding <b>…</b> on instance <b>i-0a1b2…</b>…</p>". The summary CARD renders
// that HTML sanitized (meaningful <b> emphasis kept; scripts/handlers/attributes
// stripped) so it reads like the native record. The connector's summary_seed is
// plain text (tags stripped) so the model gets clean prose, not tag noise.

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
const $state = { current: { name: "viewPanel.modulesDetail" }, params: { module: "alerts", id: "a-1" } };

let $controller, $rootScope, $timeout, $q, $sce;

function setup() {
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      chatHistory: () => $q.when({ turns: [] }),
      chatTurn: () => $q.when({ accepted: true, turn: 1 }),
      resume: () => $q.when({}),
      modeInfo: () => ({ mode: "mock" }),
      resolvePersona: () => $q.when(null),
    });
    $provide.value("config", { seedFromEntity: true, maxTurns: 8, opener: "off" });
    $provide.value("$state", $state);
  });
  ng.mock.inject((_$controller_, _$rootScope_, _$timeout_, _$q_, _$sce_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $timeout = _$timeout_; $q = _$q_; $sce = _$sce_;
  });
}

function boot(entity) {
  const $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
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
function textBlock(card) {
  return (card.blocks || []).find((b) => b.kind === "text");
}
const rendered = ($scope, t) => $sce.getTrustedHtml($scope.renderCardText(t));

const HTML_ALERT = {
  iri: "/api/3/alerts/a-1", module: "alerts",
  record: {
    "@id": "/api/3/alerts/a-1", module: "alerts",
    name: "Crypto Mining Activity - EC2 i-0a1b2c3d4e5f67890",
    severity: "Critical", status: "Open",
    description:
      "<p>GuardDuty finding <b>CryptoCurrency:EC2/BitcoinTool.B!DNS</b> on instance " +
      "<b>i-0a1b2c3d4e5f67890</b> (account 123456789012, us-east-1): the instance is " +
      "querying a known mining pool <b>xmr-eu1.nanopool.org</b>. Possible compromised " +
      "workload or leaked credentials on role <b>prod-app-ec2-role</b>.</p>",
  },
};

beforeEach(setup);

describe(`${viewCtrlName} -- seed card HTML sanitize/strip`, () => {
  test("the card renders sanitized HTML: <b> emphasis survives", () => {
    const $scope = boot(HTML_ALERT);
    const blk = textBlock(seedCard($scope));
    expect(blk).toBeTruthy();
    const html = rendered($scope, blk.text);
    expect(html).toContain("<b>CryptoCurrency:EC2/BitcoinTool.B!DNS</b>");
    expect(html).toContain("<b>i-0a1b2c3d4e5f67890</b>");
    expect(html).toContain("<b>xmr-eu1.nanopool.org</b>");
    // The card shows a lead, ending on a sentence; the rest of the
    // description (prod-app-ec2-role) is on the record page beside it.
    expect(html).not.toContain("prod-app-ec2-role");
  });

  test("renderCardText leaves no LIVE tag/handler (escape-first: dangerous markup is inert text)", () => {
    const $scope = boot(HTML_ALERT);
    const html = rendered(
      $scope,
      '<img src=x onerror="alert(1)"><b>ok</b>' +
      '<script>alert(2)</script><a href="javascript:alert(3)">link</a>' +
      '<b onclick="e()">bad</b>'
    );
    // A clean whitelisted tag (bare) still renders as real HTML.
    expect(html).toContain("<b>ok</b>");
    // Nothing dangerous survives as a LIVE tag -- all escaped to inert text.
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<a\b/i);                 // no live link (href stripped)
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i);  // no live tag carrying an on* handler
    // The attribute-carrying <b onclick> opener was NOT un-escaped (only bare tags are).
    expect(html).toContain('&lt;b onclick=');
  });

  test("the connector summary_seed is plain text (no tags)", () => {
    const $scope = boot(HTML_ALERT);
    const seed = $scope.entityContext.summary_seed;
    expect(seed).toBeTruthy();
    expect(seed).not.toMatch(/<[^>]+>/);
    expect(seed).toContain("GuardDuty finding");
    expect(seed).toContain("prod-app-ec2-role");
  });

  test("plain-text descriptions render unchanged (ampersand escaped, no over-processing)", () => {
    const plain = {
      iri: "/api/3/alerts/a-2", module: "alerts",
      record: { "@id": "/api/3/alerts/a-2", module: "alerts", name: "Plain alert",
        description: "A normal alert with no markup, just text & a stray ampersand." },
    };
    const $scope = boot(plain);
    const blk = textBlock(seedCard($scope));
    expect(rendered($scope, blk.text)).toContain("just text &amp; a stray ampersand.");
    expect($scope.entityContext.summary_seed).toContain("just text & a stray ampersand.");
  });

  // FortiSIEM styles every tag and puts the incident facts in a key/value
  // <table>. The sanitizer only re-enables BARE tags, so this showed as literal
  // `<p style="margin:0 0 8px 0">` / `<td style=…>` on the card.
  const SIEM_ALERT = {
    iri: "/api/3/alerts/a-3", module: "alerts",
    record: { "@id": "/api/3/alerts/a-3", module: "alerts", name: "Traffic to OpenPhish",
      description:
        '<p style="margin:0 0 8px 0"><b>Traffic to OpenPhish Malware URL List</b></p>' +
        '<table><tr><td style="padding:2px 12px 2px 0;white-space:nowrap">Incident</td>' +
        '<td style="padding:2px 0">39514</td></tr>' +
        '<tr><td style="padding:2px 12px 2px 0">Category</td><td>Security / Exfiltration</td></tr>' +
        '<tr><td>Severity</td><td>High &amp; rising</td></tr></table>' },
  };

  test("styled record HTML reads as text: no literal tags, table rows become Key: value", () => {
    const $scope = boot(SIEM_ALERT);
    const html = rendered($scope, textBlock(seedCard($scope)).text);
    expect(html).not.toMatch(/&lt;/);                     // no escaped markup shown
    expect(html).not.toMatch(/style=/);
    expect(html).toContain("<b>Traffic to OpenPhish Malware URL List</b>");
    expect(html).toContain("<b>Incident</b>: 39514");
    expect(html).toContain("<b>Category</b>: Security / Exfiltration");
    expect(html).toContain("<b>Severity</b>: High &amp; rising");
  });

  test("a long styled description is cut without leaving half a tag", () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      `<tr><td style="x">Key ${i}</td><td style="y">value ${i}</td></tr>`).join("");
    const big = { iri: "/api/3/alerts/a-4", module: "alerts",
      record: { "@id": "/api/3/alerts/a-4", module: "alerts", name: "Big",
        description: `<table>${rows}</table>` } };
    const $scope = boot(big);
    const text = textBlock(seedCard($scope)).text;
    expect(text.length).toBeLessThanOrEqual(601);
    expect(text).not.toMatch(/<[^>]*…$/);
    expect(rendered($scope, text)).not.toMatch(/&lt;/);
  });

  test("hostile record markup stays inert through the card path", () => {
    const evil = { iri: "/api/3/alerts/a-5", module: "alerts",
      record: { "@id": "/api/3/alerts/a-5", module: "alerts", name: "Evil",
        description: '<b onclick="e()">x</b><img src=x onerror="alert(1)">' +
                     '&lt;script&gt;alert(2)&lt;/script&gt;<a href="javascript:y">l</a>' } };
    const $scope = boot(evil);
    const html = rendered($scope, textBlock(seedCard($scope)).text);
    expect(html).toContain("<b>x</b>");                  // attributes dropped
    expect(html).not.toMatch(/<img|<script|<a\b|\son\w+=/i);
  });
});
