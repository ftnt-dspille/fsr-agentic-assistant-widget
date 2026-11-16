"use strict";

// ─── Fix 5: block-aware renderMarkdown (headings, tables, ---, lists) ───────
//
// renderMarkdown was bold/italic/code/links only - headings, GFM tables, rules
// and lists leaked as literal `##` / `|` / `-`. We drive the real controller and
// read back $sce.getTrustedHtml() on what renderMarkdown produced. Escape-first
// and no javascript:/data: links are part of the contract, so the adversarial
// cases assert no script/handler survives.

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

let $scope, $sce;
beforeEach(() => {
  const agentStub = {
    connectorName: "fsr-playbook-builder",
    resolveConnector: () => ({ then: () => {} }),
    modeInfo: () => ({ mode: "live", mock_scenario: null }),
    chatHistory: () => ({ then: () => {} }),
    chatTurn: () => ({ then: () => {}, catch: () => {} }),
    chatPoll: () => ({ then: () => {} })
  };
  ng.mock.module("cybersponse", ($provide) => {
    $provide.value("fsrPbAgentService", agentStub);
    $provide.value("config", {});
  });
  let $controller, $rootScope, $timeout;
  ng.mock.inject((_$controller_, _$rootScope_, _$sce_, _$timeout_) => {
    $controller = _$controller_; $rootScope = _$rootScope_; $sce = _$sce_; $timeout = _$timeout_;
  });
  $scope = $rootScope.$new();
  $controller(viewCtrlName, { $scope });
  try { $timeout.flush(); } catch (e) { /* nothing queued */ }
});

const render = (md) => $sce.getTrustedHtml($scope.renderMarkdown(md));

describe("fsrAgenticAssistant - renderMarkdown blocks (Fix 5)", () => {
  test("ATX headings become md-h elements, not literal ##", () => {
    const h = render("## Attack Timeline\n### Details");
    expect(h).toMatch(/<div class="md-h md-h2">Attack Timeline<\/div>/);
    expect(h).toMatch(/<div class="md-h md-h3">Details<\/div>/);
    expect(h).not.toContain("##");
  });

  test("GFM pipe table becomes a <table>, no literal pipes leak", () => {
    const md = [
      "| Time | Event |",
      "|------|-------|",
      "| 02:17 | get_record |",
      "| 02:18 | search |"
    ].join("\n");
    const h = render(md);
    expect(h).toContain('<table class="md-table">');
    expect(h).toContain("<th>Time</th>");
    expect(h).toContain("<th>Event</th>");
    expect(h).toContain("<td>02:17</td>");
    expect(h).toContain("<td>get_record</td>");
    expect(h).not.toContain("|---");
    expect(h).not.toMatch(/\| Time \|/);
  });

  test("--- on its own line becomes <hr>", () => {
    const h = render("above\n\n---\n\nbelow");
    expect(h).toContain('<hr class="md-hr"/>');
  });

  test("unordered and ordered lists render as ul/ol", () => {
    expect(render("- one\n- two")).toMatch(/<ul class="md-list"><li>one<\/li><li>two<\/li><\/ul>/);
    expect(render("1. first\n2. second")).toMatch(/<ol class="md-list"><li>first<\/li><li>second<\/li><\/ol>/);
  });

  test("loose ordered list (blank lines between items) stays ONE <ol>, not renumbered", () => {
    // Regression: a blank line between items used to start a fresh <ol> back at
    // 1, so the model's "1,2,3" rendered as "1, 1, 1".
    const h = render("1. first\n\n2. second\n\n3. third");
    expect((h.match(/<ol class="md-list">/g) || []).length).toBe(1);
    expect(h).toMatch(/<ol class="md-list"><li>first<\/li><li>second<\/li><li>third<\/li><\/ol>/);
  });

  test("ordered list with nested bullets nests, not flattens or restarts (the ZTPF-persona case)", () => {
    // The reported bug: `1. **Title**:` + an indented `- desc` sub-bullet, with
    // blank lines between steps, rendered as 1,2,1,2,1,2. Now: ONE <ol> with
    // three items, each carrying a nested <ul> - numbering stays 1,2,3.
    const md = [
      "1. **Create**:",
      "   - begins by configuring",
      "",
      "2. **Query**:",
      "   - queries interfaces",
      "",
      "3. **New**:",
      "   - creates the interface",
    ].join("\n");
    const h = render(md);
    expect((h.match(/<ol class="md-list">/g) || []).length).toBe(1);        // single ordered list
    expect((h.match(/<li>/g) || []).length).toBe(6);                        // 3 steps + 3 nested
    expect((h.match(/<ul class="md-list">/g) || []).length).toBe(3);        // one nested list per step
    expect(h).toContain("<li><strong>Create</strong>:<ul class=\"md-list\"><li>begins by configuring</li></ul></li>");
  });

  test("wrapped continuation line joins its list item (not a new paragraph)", () => {
    const h = render("1. first line\n   continues here\n2. second");
    expect((h.match(/<ol class="md-list">/g) || []).length).toBe(1);
    expect(h).toContain("<li>first line<br/>continues here</li>");
  });

  test("two paragraphs separated by a blank line don't glue at the boundary", () => {
    // Regression: bare paragraphs were `html.push`ed as naked text and joined
    // with '' , so "…parameters.\n\nOnce you provide…" rendered as the glued
    // "parameters.Once you provide". Each paragraph now gets its own <p> block.
    const h = render("required input parameters.\n\nOnce you provide the action, I'll look up.");
    expect((h.match(/<p class="md-p">/g) || []).length).toBe(2);
    expect(h).toContain('<p class="md-p">required input parameters.</p>');
    expect(h).toContain('<p class="md-p">Once you provide the action');
    // The two sentences must not be stuck together.
    expect(h).not.toContain("parameters.Once");
  });

  test("a single paragraph is wrapped once, softbreaks stay <br/> within it", () => {
    expect(render("just one line")).toBe('<p class="md-p">just one line</p>');
    expect(render("line a\nline b")).toBe('<p class="md-p">line a<br/>line b</p>');
  });

  test("inline emphasis/code/links still work and dashes inside words are not lists", () => {
    const h = render("Use **block_ip** with `ip` and [docs](https://x.io/y) - get-record stays inline");
    expect(h).toContain("<strong>block_ip</strong>");
    expect(h).toContain("<code>ip</code>");
    expect(h).toContain('<a href="https://x.io/y"');
    expect(h).toContain("get-record stays inline");
  });

  test("fenced non-yaml code survives as md-code; yaml fences are dropped", () => {
    // Quotes are HTML-escaped (S3) so the raw `"` becomes &quot; inside the
    // <pre>; the browser renders it back as a literal quote.
    expect(render("```json\n{\"a\":1}\n```")).toMatch(/<pre class="md-code">[\s\S]*&quot;a&quot;:1[\s\S]*<\/pre>/);
    const y = render("before\n```yaml\nkey: val\n```\nafter");
    expect(y).not.toContain("key: val");
    expect(y).toContain("before");
    expect(y).toContain("after");
  });

  test("adversarial: scripts/handlers are escaped and javascript: links are not linkified", () => {
    const h = render("<script>alert(1)</script>\n[x](javascript:alert(1))\n## <img onerror=1>");
    expect(h).not.toMatch(/<script>/);
    expect(h).toContain("&lt;script&gt;");
    // javascript: link must NOT become an <a href>
    expect(h).not.toMatch(/<a [^>]*href="javascript:/);
    expect(h).not.toMatch(/<img onerror/);
  });

  test("adversarial: a quote in a link URL cannot break out of href to inject a handler", () => {
    // Browsers parse href="x"onmouseover="y" as two attributes, so a `"` in a
    // whitelisted http(s) URL would be an event-handler injection if unescaped.
    const h = render('[click](https://evil.example/a"onmouseover="alert(1))');
    // No unescaped closing-quote-then-handler sequence survives...
    expect(h).not.toMatch(/"\s*onmouseover/i);
    // ...the quote is escaped and stays inside the href value.
    expect(h).toContain("&quot;onmouseover");
  });

  test("adversarial: single-quote and double-quote are escaped in body text", () => {
    const h = render(`He said "hi" and it's fine`);
    expect(h).toContain("&quot;hi&quot;");
    expect(h).toContain("it&#39;s");
    expect(h).not.toMatch(/"hi"/);
  });

  test("pipes inside inline code are not parsed as a table", () => {
    const h = render("see `a | b | c` here");
    expect(h).toContain("<code>a | b | c</code>");
    expect(h).not.toContain("<table");
  });
});
