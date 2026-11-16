/**
 * Every chat event sits in a step row; most event types draw their own card, so
 * the row must not frame them too. The template used to list the self-framed
 * types by hand, and the approval and choice cards were missing: each drew its
 * card inside the row's box ("why do some cards have boxes around them and
 * others don't"). The template now asks stepFrame(); this checks every type the
 * template renders against what its own block draws.
 */
const fs = require("fs");
const path = require("path");
const R = require("../widget/widgetAssets/js/fsrPbRender");

const html = fs.readFileSync(path.join(__dirname, "../widget/view.html"), "utf8");

// Each event block in the timeline: <div ng-if="ev.type === 'x'" class="...">
// (attribute order varies, so read the whole opening tag).
function eventBlocks() {
  const out = {};
  const re = /<div\b[^>]*ng-if="ev\.type === '([a-z_]+)'"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const cls = (/class="([^"]*)"/.exec(m[0]) || [])[1] || "";
    (out[m[1]] = out[m[1]] || []).push(cls);
  }
  return out;
}

const SELF_FRAMED = /\b(pb-card|approval-card|tool-call)\b/;

test("a type whose block draws its own card gets no step frame", () => {
  const blocks = eventBlocks();
  expect(Object.keys(blocks).length).toBeGreaterThan(10);
  for (const [type, classes] of Object.entries(blocks)) {
    if (type === "text") continue;
    const drawsCard = classes.some((c) => SELF_FRAMED.test(c));
    if (drawsCard) expect([type, R.stepFrame(type)]).toEqual([type, "bare"]);
  }
});

test("the approval and choice cards are not boxed twice", () => {
  expect(R.stepFrame("approval_request")).toBe("bare");
  expect(R.stepFrame("choice_card")).toBe("bare");
  expect(R.stepFrame("error")).toBe("framed");
  expect(R.stepFrame("text")).toBe("text");
});

test("the template asks stepFrame instead of keeping its own list", () => {
  expect(html).toMatch(/'pb-step-bare': stepFrame\(ev\) === 'bare'/);
  expect(html).not.toMatch(/'pb-step-bare': ev\.type ===/);
});
