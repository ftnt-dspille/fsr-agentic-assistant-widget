"use strict";

// ─── History browser (browse + reopen previous conversations) ───────────────
//
// The widget remembers only its current session_id (localStorage); prior chats
// live in the connector store but were unreachable once "New conversation"
// minted a new id. The history browser lists all stored sessions
// (list_sessions) and reopens one (chat_history for the chosen id). These tests
// drive openHistory()/loadSession() with stubbed services.

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

let $controller, $rootScope, $timeout, listSessionsSpy, chatHistorySpy, rateSessionSpy;

const OTHER_TURNS = [
  { user: "what happened on host X?" },
  { transcript: [{ type: "text", text: "it was beaconing" }] },
];

beforeEach(() => {
  window.localStorage.clear();
  listSessionsSpy = jest.fn(() => resolved({ sessions: [] }));
  chatHistorySpy = jest.fn((cfg, sid) =>
    resolved({ turns: sid === "sess-other" ? OTHER_TURNS : [] }));

  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", {
      resolveConnector: () => resolved({ name: "x", version: "1", configId: "c1" }),
      chatHistory: chatHistorySpy,
      listSessions: listSessionsSpy,
      rateSession: (rateSessionSpy = jest.fn((cfg, sid, rating) =>
        resolved({ ok: true, session_id: sid,
                   rating: rating ? { rating: rating, note: null } : null }))),
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
  $timeout.flush(); // settle init (probe + empty rehydrate)
  return $scope;
}

describe(`${viewCtrlName} - history browser`, () => {
  test("openHistory loads and exposes the stored sessions", () => {
    listSessionsSpy.mockImplementation(() => resolved({ sessions: [
      { session_id: "sess-a", title: "block an ip", entries: 4, last_activity: 2 },
      { session_id: "sess-b", title: "triage alert", entries: 2, last_activity: 1 },
    ] }));
    const $scope = boot();
    $scope.openHistory();
    expect(listSessionsSpy).toHaveBeenCalled();
    expect($scope.historyOpen).toBe(true);
    expect($scope.historyLoading).toBe(false);
    expect($scope.sessions.map((s) => s.session_id)).toEqual(["sess-a", "sess-b"]);
  });

  test("openHistory surfaces an error without throwing", () => {
    listSessionsSpy.mockImplementation(() => rejected({ message: "connector down" }));
    const $scope = boot();
    $scope.openHistory();
    expect($scope.historyError).toBe("connector down");
    expect($scope.historyLoading).toBe(false);
    expect($scope.sessions).toEqual([]);
  });

  test("loadSession switches the active session, persists it, and replays its transcript", () => {
    const $scope = boot();
    expect($scope.messages.length).toBe(0);

    $scope.loadSession("sess-other");

    // chat_history fetched for the chosen session, timeline replayed.
    expect(chatHistorySpy).toHaveBeenCalledWith($scope.config, "sess-other");
    expect($scope.messages.length).toBe(2);
    expect($scope.messages[0].text).toBe("what happened on host X?");
    expect($scope.messages[1].role).toBe("assistant");
    // The new session id is persisted so a refresh reopens the same chat.
    expect(window.localStorage.getItem("fsrPbSession:triage")).toBe("sess-other");
    // Panel closes after a pick.
    expect($scope.historyOpen).toBe(false);
  });

  test("loadSession on the CURRENT session is a no-op (no reload/clear)", () => {
    const $scope = boot();
    const current = window.localStorage.getItem("fsrPbSession:triage");
    chatHistorySpy.mockClear();
    $scope.loadSession(current);
    expect(chatHistorySpy).not.toHaveBeenCalled();
    expect($scope.historyOpen).toBe(false);
  });

  test("isCurrentSession marks the active conversation", () => {
    const $scope = boot();
    const current = window.localStorage.getItem("fsrPbSession:triage");
    expect($scope.isCurrentSession(current)).toBe(true);
    expect($scope.isCurrentSession("sess-elsewhere")).toBe(false);
  });

  test("formatSessionDate renders a calendar label from epoch SECONDS", () => {
    const $scope = boot();
    // empty/zero → no label (don't render a bogus 1970 date)
    expect($scope.formatSessionDate(0)).toBe("");
    expect($scope.formatSessionDate(null)).toBe("");

    const nowSec = Math.floor(new Date().getTime() / 1000);
    expect($scope.formatSessionDate(nowSec)).toMatch(/^Today /);
    expect($scope.formatSessionDate(nowSec - 86400)).toMatch(/^Yesterday /);

    // An older timestamp shows a month/day label, not "Today"/"Yesterday".
    const older = $scope.formatSessionDate(nowSec - 86400 * 10);
    expect(older).not.toMatch(/^(Today|Yesterday) /);
    expect(older).not.toBe("");
  });
});

describe(`${viewCtrlName} - history search + rating`, () => {
  const SESSIONS = [
    { session_id: "sess-a", title: "block an ip on the firewall", entries: 4, last_activity: 3,
      initiator: { name: "Avery" }, rating: null },
    { session_id: "sess-b", title: "triage the phishing alert", entries: 2, last_activity: 2,
      initiator: { name: "Sam" }, rating: { rating: "down", note: "tools returned 0" } },
    { session_id: "sess-c", title: "summarize device steps", entries: 6, last_activity: 1,
      initiator: { name: "Avery" }, rating: { rating: "up", note: null } },
  ];

  function bootWithSessions() {
    listSessionsSpy.mockImplementation(() => resolved({ sessions: SESSIONS.map((s) => ({ ...s })) }));
    const $scope = boot();
    $scope.openHistory();
    return $scope;
  }

  test("a keyword runs a backend CONTENT search and renders its results + snippet", () => {
    const $scope = bootWithSessions();
    // A query hits list_sessions WITH the keyword (server greps transcript text
    // across ALL sessions), and the returned rows - each with a match snippet -
    // replace the recent list. This finds sessions the recent list wouldn't have.
    listSessionsSpy.mockImplementation((cfg, q) =>
      resolved({ query: q, sessions: [
        { session_id: "sess-x", title: "old buried conversation", snippet: "… left a FIXME here …",
          entries: 3, last_activity: 9, initiator: { name: "Avery" }, rating: null },
      ] }));
    $scope.historyUi.query = "FIXME";
    $rootScope.$digest();                       // fire the query $watch
    expect(listSessionsSpy).toHaveBeenCalledWith($scope.config, "FIXME");
    const rows = $scope.filteredSessions();
    expect(rows.map((s) => s.session_id)).toEqual(["sess-x"]);
    expect(rows[0].snippet).toContain("FIXME");
    // clearing the keyword returns to the recent list (no stale search rows)
    $scope.historyUi.query = "";
    $rootScope.$digest();
    expect($scope.searchResults).toBe(null);
    expect($scope.filteredSessions().length).toBe(3);
  });

  test("content search drops a stale response when the query changes fast", () => {
    const $scope = bootWithSessions();
    // First query's response is deferred; a second query lands first. The stale
    // (first) response must be ignored - the monotonic token guards it.
    let resolveFirst;
    listSessionsSpy.mockImplementation((cfg, q) => {
      if (q === "slow") return { then: (cb) => { resolveFirst = () => cb({ sessions: [
        { session_id: "STALE", title: "x", entries: 1, last_activity: 1 }] }); return resolved(); },
        catch: () => resolved() };
      return resolved({ sessions: [{ session_id: "FRESH", title: "y", entries: 1, last_activity: 2 }] });
    });
    $scope.historyUi.query = "slow"; $rootScope.$digest();
    $scope.historyUi.query = "fast"; $rootScope.$digest();   // supersedes "slow"
    resolveFirst();                                          // stale response arrives late
    expect($scope.filteredSessions().map((s) => s.session_id)).toEqual(["FRESH"]);
  });

  test("rating filter chips narrow to up / down / flagged", () => {
    const $scope = bootWithSessions();
    $scope.historyUi.filter = "down";
    expect($scope.filteredSessions().map((s) => s.session_id)).toEqual(["sess-b"]);
    $scope.historyUi.filter = "up";
    expect($scope.filteredSessions().map((s) => s.session_id)).toEqual(["sess-c"]);
    $scope.historyUi.filter = "flagged";  // any rating
    expect($scope.filteredSessions().map((s) => s.session_id)).toEqual(["sess-b", "sess-c"]);
    $scope.historyUi.filter = "all";
    expect($scope.filteredSessions().length).toBe(3);
  });

  test("rateSession sets a rating, persists it, and stops event propagation", () => {
    const $scope = bootWithSessions();
    const row = $scope.sessions[0];  // sess-a, unrated
    const ev = { stopPropagation: jest.fn(), preventDefault: jest.fn() };
    $scope.rateSession(row, "up", ev);
    expect(ev.stopPropagation).toHaveBeenCalled();
    expect(rateSessionSpy).toHaveBeenCalledWith($scope.config, "sess-a", "up", "");
    expect($scope.sessionRating(row)).toBe("up");
  });

  test("clicking the active rating clears it", () => {
    const $scope = bootWithSessions();
    const row = $scope.sessions[2];  // sess-c, already 'up'
    $scope.rateSession(row, "up", null);
    expect(rateSessionSpy).toHaveBeenCalledWith($scope.config, "sess-c", "", "");
    expect($scope.sessionRating(row)).toBe("");
  });

  test("a failed rate reverts the optimistic change", () => {
    const $scope = bootWithSessions();
    rateSessionSpy.mockImplementationOnce(() => rejected({ message: "down" }));
    const row = $scope.sessions[0];  // unrated
    $scope.rateSession(row, "down", null);
    expect($scope.sessionRating(row)).toBe("");  // reverted to prior (none)
  });
});

describe(`${viewCtrlName} - live-session rating`, () => {
  test("stays hidden until the session has an assistant turn", () => {
    const $scope = boot();
    expect($scope.canRateLiveSession()).toBe(false);   // empty conversation
    $scope.messages.push({ role: "user", text: "hi" });
    expect($scope.canRateLiveSession()).toBe(false);   // user-only still nothing to rate
    $scope.messages.push({ role: "assistant", text: "hello" });
    expect($scope.canRateLiveSession()).toBe(true);
  });

  test("rates the active session via rate_session and reflects it", () => {
    const $scope = boot();
    const current = window.localStorage.getItem("fsrPbSession:triage");
    const ev = { stopPropagation: jest.fn(), preventDefault: jest.fn() };
    $scope.rateThisSession("up", ev);
    expect(ev.stopPropagation).toHaveBeenCalled();
    expect(rateSessionSpy).toHaveBeenCalledWith($scope.config, current, "up", "");
    expect($scope.liveSessionRating()).toBe("up");
  });

  test("clicking the active live rating clears it", () => {
    const $scope = boot();
    $scope.rateThisSession("down", null);
    expect($scope.liveSessionRating()).toBe("down");
    $scope.rateThisSession("down", null);   // toggle off
    expect($scope.liveSessionRating()).toBe("");
  });

  test("a failed live rate reverts the optimistic change", () => {
    const $scope = boot();
    rateSessionSpy.mockImplementationOnce(() => rejected({ message: "boom" }));
    $scope.rateThisSession("up", null);
    expect($scope.liveSessionRating()).toBe("");   // reverted to prior (none)
  });

  test("+ New drops the live rating", () => {
    const $scope = boot();
    $scope.rateThisSession("up", null);
    expect($scope.liveSessionRating()).toBe("up");
    $scope.newConversation();
    expect($scope.liveSessionRating()).toBe("");
  });

  test("switching to a rated session seeds the live control from history", () => {
    listSessionsSpy.mockImplementation(() => resolved({ sessions: [
      { session_id: "sess-c", title: "summarize device steps", entries: 6,
        last_activity: 1, initiator: { name: "Avery" }, rating: { rating: "up", note: null } },
    ] }));
    const $scope = boot();
    $scope.openHistory();          // populates $scope.sessions with ratings
    $scope.loadSession("sess-c");  // switch → seed from the loaded row
    expect($scope.liveSessionRating()).toBe("up");
  });
});
