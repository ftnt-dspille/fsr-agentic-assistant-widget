"use strict";

// ─── Each $scope function is assigned once per controller ───────────────────
// A second `$scope.fn = function ...` later in a controller silently replaces
// the first, so the earlier block reads as live code and is dead (this hid a
// duplicated scrollToToolCall / applyRecommendedAction pair in view.controller.js
// for months). Structural guard: parse the controller source and assert no
// function-valued $scope name is assigned twice. Plain state reassignments
// (`$scope.x = null` then `$scope.x = []`) are not functions and are not flagged.

const fs = require("fs");
const path = require("path");

const WIDGET = path.join(__dirname, "..", "widget");
const CONTROLLERS = ["view.controller.js", "edit.controller.js"];
const FN_ASSIGN = /\$scope\.([A-Za-z_$][\w$]*)\s*=\s*function\b/g;

function functionAssignments(source) {
  const seen = new Map();
  let m;
  FN_ASSIGN.lastIndex = 0;
  while ((m = FN_ASSIGN.exec(source)) !== null) {
    const line = source.slice(0, m.index).split("\n").length;
    seen.set(m[1], (seen.get(m[1]) || []).concat(line));
  }
  return seen;
}

describe("controller $scope functions are assigned once", () => {
  for (const file of CONTROLLERS) {
    test(`${file}: no $scope function is defined twice`, () => {
      const source = fs.readFileSync(path.join(WIDGET, file), "utf8");
      const dupes = [];
      for (const [name, lines] of functionAssignments(source)) {
        if (lines.length > 1) dupes.push(`$scope.${name} at lines ${lines.join(", ")}`);
      }
      expect(dupes).toEqual([]);
    });
  }

  test("the guard sees real assignments (it is not vacuously empty)", () => {
    const source = fs.readFileSync(path.join(WIDGET, "view.controller.js"), "utf8");
    const seen = functionAssignments(source);
    expect(seen.size).toBeGreaterThan(100);
    expect(seen.has("scrollToToolCall")).toBe(true);
    expect(seen.has("applyRecommendedAction")).toBe(true);
  });
});
