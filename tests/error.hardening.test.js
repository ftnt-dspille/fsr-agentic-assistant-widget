"use strict";

// ─── Fix 4: error-banner sanitize/cap + secret scrub ───
//
// A gateway 404/5xx echoes the request back - including the live
// `Authorization: Bearer <JWT>` and Websocket-SessionID. _handleError must map
// that to a friendly, bounded, secret-free banner; the export builder must
// scrub the same secrets out of any downloaded .md. We drive the REAL
// controller (no browser) and assert on $scope.

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
const viewCtrlName = `${widgetInfo.name}${widgetInfo.version.replace(/\./g, "")}DevCtrl`;
const ng = window.angular; // eslint-disable-line no-undef

const NGINX_404 =
  "<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n" +
  "<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n" +
  "</body>\r\n</html>\r\n--- echoed request ---\r\n" +
  "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0" +
  "NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c\r\n" +
  "Websocket-SessionID: ws-abc123def456\r\n";

function makeHarness() {
  let turnDeferred;
  let $q, $timeout, $rootScope, $controller;

  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => $q.when({ name: "fsr-playbook-builder", version: "1", configId: "c" }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => $q.when({ turns: [] }),
    chatTurn: () => { turnDeferred = $q.defer(); return turnDeferred.promise; },
    chatPoll: () => $q.when({ contract_version: "2.6.0", turn: 1, cursor: 0, done: false, frames: [] })
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
  return {
    $scope, $timeout,
    rejectTurn: (err) => { turnDeferred.reject(err); $rootScope.$apply(); }
  };
}

describe("fsrAgenticAssistant - Fix 4 error hardening", () => {
  test("nginx 404 body → friendly bounded banner, no HTML, no Bearer/JWT", () => {
    const h = makeHarness();
    h.$scope.form.inputText = "build it";
    h.$scope.sendMessage();
    h.rejectTurn({ message: NGINX_404, status: 404 });

    const msg = h.$scope.errorMessage;
    expect(h.$scope.viewState).toBe("error");
    expect(msg).toMatch(/connector did not respond \(HTTP 404\)/i);
    expect(msg).not.toMatch(/<html|nginx|404 Not Found/);
    expect(msg).not.toMatch(/Bearer|eyJ/);
    expect(msg.length).toBeLessThan(300);
  });

  test.each([[502, /timed out/i], [503, /unavailable/i], [504, /timed out/i]])(
    "HTTP %i maps to timeout/unavailable wording",
    (status, re) => {
      const h = makeHarness();
      h.$scope.form.inputText = "x";
      h.$scope.sendMessage();
      h.rejectTurn({ message: "<html>nginx</html>", status });
      expect(h.$scope.errorMessage).toMatch(re);
    }
  );

  test("a plain non-HTML error is scrubbed of bearer tokens and capped", () => {
    const h = makeHarness();
    const longTail = "x".repeat(2000);
    h.$scope.form.inputText = "x";
    h.$scope.sendMessage();
    h.rejectTurn({ message: "Boom failed Authorization: Bearer eyJabc.def.ghi token=supersecret " + longTail });

    const msg = h.$scope.errorMessage;
    expect(msg).toContain("Boom failed");
    expect(msg).not.toMatch(/eyJabc|supersecret/);
    expect(msg).toMatch(/Bearer \[REDACTED\]/);
    expect(msg).toMatch(/truncated/);
    expect(msg.length).toBeLessThanOrEqual(620);
  });

  test("export markdown scrubs Bearer JWT / session id from a tool_result blob", () => {
    const h = makeHarness();
    // Seed a committed assistant message carrying a leaky tool_result.
    h.$scope.messages.push({
      role: "assistant", ts: Date.now(), text: "",
      events: [{
        type: "tool_call", name: "get_record", resultStatus: "ok",
        inputDisplay: '{"iri":"/x"}',
        resultDisplay: 'OK Authorization: Bearer eyJleak.payload.sig\nWebsocket-SessionID: ws-zzz token: hunter2'
      }]
    });
    h.$scope.openExport();
    const md = h.$scope.form.exportText;
    expect(md).not.toMatch(/eyJleak|ws-zzz|hunter2/);
    expect(md).toMatch(/Bearer \[REDACTED\]/);
    expect(md).toMatch(/Websocket-SessionID":?=?\s*\[REDACTED\]|Websocket-SessionID: \[REDACTED\]/);
  });

  test("S6: a standard-base64 JWT (with + / =) is redacted in full, not truncated", () => {
    const h = makeHarness();
    // A JWT whose payload/signature use standard-base64 chars (+ / =) that the
    // old base64url-only charset stopped at, leaking the tail.
    const jwt = "eyJhbGci+iJSUzI1/jkiIn0.cGF5bG9hZA+Zm9vL2Jhcg==.c2ln+bmF0/dXJl==";
    h.$scope.form.inputText = "x";
    h.$scope.sendMessage();
    h.rejectTurn({ message: "boom Authorization: Bearer " + jwt });
    const msg = h.$scope.errorMessage;
    expect(msg).toMatch(/Bearer \[REDACTED\]/);
    // No fragment of the token past the first +// survives.
    expect(msg).not.toMatch(/iJSUzI1|Zm9vL2Jhcg|c2ln|bmF0/);
    expect(msg).not.toContain("+");
    expect(msg).not.toContain("/");
  });
});
