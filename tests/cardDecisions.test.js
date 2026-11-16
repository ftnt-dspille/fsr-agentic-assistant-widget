/**
 * A card answered somewhere else comes back answered. Live: a second analyst
 * opened a chat where the first had already approved an update, and still saw
 * Confirm & Execute on it. The connector's history now says who answered each
 * card; these cases check what the widget does with that.
 */
const R = require("../widget/widgetAssets/js/fsrPbRender");

function msgs() {
  return [
    { role: "assistant", events: [
      { type: "action_card", cardId: "c1", _resolved: false },
      { type: "approval_request", approvalId: "a1" },
      { type: "action_card", cardId: "c3" },
      { type: "action_card", cardId: "c4", _resolved: true, _resolutionText: "Confirmed", _resolvedBy: "me" },
    ] },
  ];
}

const DECISIONS = [
  { card_id: "c1", decision: "approve", actor: "Lead Analyst", decided_at: 1791918300.5 },
  { card_id: "a1", decision: "reject", actor: "Monitor queue", decided_at: 1791918310 },
  { card_id: "c4", decision: "reject", actor: "someone", decided_at: 1 },
];

test("an open card answered elsewhere is closed, saying by whom and when", () => {
  const m = msgs();
  const changed = R.applyCardDecisions(m, DECISIONS);
  const [c1, a1, c3, c4] = m[0].events;
  expect(changed).toEqual([c1, a1]);
  expect(c1).toMatchObject({ _resolved: true, _open: false, _decision: "approve", _outcome: "approve",
    _resolutionText: "Approved", _resolvedBy: "Lead Analyst", _resolvedAt: 1791918300500,
    _decidedElsewhere: true });
  expect(a1).toMatchObject({ _resolved: true, _decision: "reject", _outcome: "reject",
    _resolutionText: "Rejected", _resolvedBy: "Monitor queue" });
  // No decision for it: still open.
  expect(c3._resolved).toBeFalsy();
  // Already answered here: left exactly as this analyst's answer.
  expect(c4).toMatchObject({ _resolutionText: "Confirmed", _resolvedBy: "me" });
  expect(c4._decidedElsewhere).toBeUndefined();
});

test("an approved approval card reads as approved elsewhere, not as awaiting a result", () => {
  const m = [{ events: [{ type: "approval_request", approvalId: "a1" }] }];
  R.applyCardDecisions(m, [{ card_id: "a1", decision: "approve", actor: "Lead Analyst" }]);
  expect(m[0].events[0]._outcome).toBe("elsewhere");
});

test("a card being answered right now is left to that answer", () => {
  const m = [{ events: [{ type: "action_card", cardId: "c1", _submitting: true }] }];
  expect(R.applyCardDecisions(m, DECISIONS)).toEqual([]);
  expect(m[0].events[0]._resolved).toBeFalsy();
});

test.each([[undefined], [null], [[]], [[{ decision: "approve" }]], ["nope"]])(
  "no usable decisions (%p) changes nothing", (decisions) => {
    const m = msgs();
    expect(R.applyCardDecisions(m, decisions)).toEqual([]);
    expect(m[0].events[0]._resolved).toBe(false);
  });
