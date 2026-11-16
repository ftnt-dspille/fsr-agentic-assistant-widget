/**
 * What a write changes, line by line. Live: an update to a long Jinja output
 * template showed the whole old value struck through, an arrow, and the whole
 * new value, with the field named "outputtemplatejson". The card now shows the
 * lines that change, with context, under a one-line summary.
 */
const R = require("../widget/widgetAssets/js/fsrPbRender");

const OLD = [
  "{%- set ints = data.dvmdb_ints | default([]) -%}",
  "{%- set table = [] -%}",
  "{%- for d in ints %}",
  "{%- set ip_addr = d.ip[0] -%}",
  "{%- set ip_mask = d.ip[1] -%}",
  "{%- set ip = (ip_addr ~ '/' ~ ip_mask) | ipaddr('host/prefix') -%}",
  "{%- set network = (ip_addr ~ '/' ~ ip_mask) | ipaddr('network/prefix') -%}",
  "{%- do table.append({'name': d.name, 'ip': ip, 'ip_network': network}) -%}",
  "{%- endfor %}",
  "{{ table | tojson }}",
].join("\n");
const NEW = OLD
  .replace("{%- set ip = (ip_addr ~ '/' ~ ip_mask) | ipaddr('host/prefix') -%}",
           "{%- set ip = ip_addr -%}")
  .replace("'ip': ip, 'ip_network'", "'ip': ip, 'ip_mask': ip_mask, 'ip_network'");

function card(changes) {
  return R.normalizeActionCard({ type: "action_card", id: "c", tool: "update_record",
    args: {}, target: { module: "ztpf_automation_actions", uuid: "a1" }, changes });
}

test("a long field shows only the changed lines, with context and a summary", () => {
  const [row] = card([{ field: "outputTemplateJSON", before: OLD, after: NEW }]).changes;
  expect(row.label).toBe("Output template JSON");
  const d = row.diff;
  expect(d.summary).toBe("2 lines changed: 2 added, 2 removed");
  const changed = d.lines.filter((l) => l.op !== "ctx" && l.op !== "gap");
  expect(changed).toEqual([
    { op: "del", text: "{%- set ip = (ip_addr ~ '/' ~ ip_mask) | ipaddr('host/prefix') -%}" },
    { op: "add", text: "{%- set ip = ip_addr -%}" },
    { op: "del", text: "{%- do table.append({'name': d.name, 'ip': ip, 'ip_network': network}) -%}" },
    { op: "add", text: "{%- do table.append({'name': d.name, 'ip': ip, 'ip_mask': ip_mask, 'ip_network': network}) -%}" },
  ]);
  // Unchanged lines far from a change fold into one "N unchanged lines" row.
  expect(d.lines[0]).toEqual({ op: "gap", text: "3 unchanged lines" });
  expect(d.lines.some((l) => l.text === "{%- set ints = data.dvmdb_ints | default([]) -%}")).toBe(false);
  expect(row._open).toBe(true);
});

test("a short value keeps the inline old -> new row", () => {
  const [row] = card([{ field: "severity", before: "Low", after: "Critical" }]).changes;
  expect(row.diff).toBeUndefined();
});

test("a template written on one line still diffs by statement", () => {
  const one = (t) => t.replace(/\n/g, "");
  const [row] = card([{ field: "outputTemplateJSON", before: one(OLD), after: one(NEW) }]).changes;
  // Split at statement and comma boundaries, the new `ip_mask` key is one
  // inserted piece and the `ip` line one replaced piece.
  expect(row.diff.lines.filter((l) => l.op === "add").map((l) => l.text))
    .toEqual(["{%- set ip = ip_addr -%}", "'ip_mask': ip_mask,"]);
  expect(row.diff.removed).toBe(1);
  expect(row.diff.lines.length).toBeLessThan(20);
});

test("a new long value is all additions", () => {
  const [row] = card([{ field: "outputTemplateHTML", after: NEW }]).changes;
  expect(row.diff.summary).toBe("New value, 10 lines");
  expect(row.diff.lines.every((l) => l.op === "add")).toBe(true);
});

test("a very long diff starts collapsed and is capped", () => {
  const big = Array.from({ length: 900 }, (_, i) => "line " + i).join("\n");
  const [row] = card([{ field: "script", before: "", after: big }]).changes;
  expect(row._open).toBe(false);
  expect(row.diff.lines.length).toBe(401);
  expect(row.diff.lines[400]).toEqual({ op: "gap", text: "500 more lines not shown" });
});
