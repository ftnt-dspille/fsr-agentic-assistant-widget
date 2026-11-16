'use strict';
/**
 * fsrPbMarkdownService -- block-aware markdown -> safe HTML for assistant text.
 *
 * Moved out of view.controller.js with no behaviour change. The source is
 * HTML-escaped first, fenced code is pulled into placeholders (yaml fences are
 * dropped -- they surface in the YAML panel), then lines are walked into
 * headings, GFM tables, rules and ordered/unordered lists. The result is wrapped
 * in $sce.trustAsHtml, exactly as the controller's renderMarkdown always was.
 *
 * No scope, no DOM. The controller binds `$scope.renderMarkdown` to `render`.
 */
(function () {
    angular
        .module('cybersponse')
        .factory('fsrPbMarkdownService', fsrPbMarkdownService);

    fsrPbMarkdownService.$inject = ['$sce'];

    function fsrPbMarkdownService($sce) {
        // Inline span formatting, applied to already-HTML-escaped text only
        // (never to fenced code). Links are restricted to root-relative or
        // http(s) so we never emit javascript:/data: from model text.
        function _mdInline(s) {
            return s
                .replace(/\[([^\]]+)\]\((\/[^)\s]*|https?:\/\/[^)\s]+)\)/g,
                    '<a href="$2" target="_blank" rel="noopener" class="pb-link">$1</a>')
                .replace(/`([^`\n]+)`/g, '<code>$1</code>')
                .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        }

        function _mdRow(s) {
            return s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
                .map(function (c) { return c.trim(); });
        }
        // A GFM table separator row: |---|:--:|---| (≥1 cell, dashes, optional colons).
        function _mdIsTableSep(s) {
            return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(s);
        }

        var _MD_ITEM = /^(\s*)([-*]|\d+\.)\s+(\S.*)$/;
        // Parse a markdown list beginning at lines[start] (which matches
        // _MD_ITEM). Returns { html, next }. Indentation-aware (a more-indented
        // item opens a nested list under the current item -- e.g. a `- ` bullet
        // beneath a `1. ` step) and loose-list-aware (a blank line between items
        // of the same list does NOT end it, so numbering stays continuous). This
        // fixes the "1,2,1,2,1,2" renumbering seen when the model emits a loose
        // ordered list with nested bullets: the old loop decided ordered-ness
        // once, swept the nested `-` into the same <ol> as a sibling, and let a
        // blank line start a fresh <ol> back at 1.
        function _mdParseList(lines, start) {
            var first = _MD_ITEM.exec(lines[start]);
            var baseIndent = first[1].length;
            var ordered = /\d/.test(first[2]);
            var items = [];   // { text, children }
            var i = start;
            while (i < lines.length) {
                var raw = lines[i];
                if (raw.trim() === '') {
                    // Loose list: a blank line only ends the list when no further
                    // item at this indent (or deeper) follows.
                    var j = i + 1;
                    while (j < lines.length && lines[j].trim() === '') j++;
                    if (j < lines.length && _MD_ITEM.test(lines[j])
                        && _MD_ITEM.exec(lines[j])[1].length >= baseIndent) { i = j; continue; }
                    break;
                }
                var m = _MD_ITEM.exec(raw);
                if (m) {
                    var indent = m[1].length;
                    if (indent < baseIndent) break;              // belongs to an outer list
                    if (indent > baseIndent) {                   // nested list under current item
                        if (!items.length) items.push({ text: '', children: '' });
                        var sub = _mdParseList(lines, i);
                        items[items.length - 1].children += sub.html;
                        i = sub.next; continue;
                    }
                    items.push({ text: _mdInline(m[3]), children: '' });   // sibling item
                    i++; continue;
                }
                // Non-marker line more indented than the marker → wrapped
                // continuation of the current item; otherwise the list ends.
                if (/^(\s*)/.exec(raw)[1].length > baseIndent && items.length) {
                    items[items.length - 1].text += '<br/>' + _mdInline(raw.trim());
                    i++; continue;
                }
                break;
            }
            var tag = ordered ? 'ol' : 'ul';
            var html = '<' + tag + ' class="md-list">'
                + items.map(function (it) { return '<li>' + it.text + it.children + '</li>'; }).join('')
                + '</' + tag + '>';
            return { html: html, next: i };
        }

        // Block-aware markdown → safe HTML. Escape FIRST, pull fenced code out so
        // its `|`/`#` can't be parsed as table/heading, then walk lines into
        // headings, GFM tables, `---` rules, and ordered/unordered lists; loose
        // lines coalesce into <br/>-joined paragraphs. (Fix 5 of the live-updates
        // plan -- see KNOWLEDGEBASE.md §18.)
        function render(text) {
            if (!text) return $sce.trustAsHtml('');
            // Escape the full HTML-special set up front (S3). `&<>` neutralize
            // raw tags; `"'` are essential too -- a markdown link URL flows into
            // href="…" and a `"` in it would break out of the attribute and
            // inject an event handler (browsers parse href="x"onerror="y" as two
            // attributes). We generate all real quotes in markup ourselves, so
            // escaping quotes in the source text is loss-free.
            var src = String(text)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

            // 1. Extract fenced code into placeholders (yaml fences drop out --
            //    they're surfaced via the YAML panel).
            var codeBlocks = [];
            src = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, function (_m, lang, code) {
                if (/^ya?ml$/i.test(lang)) return '\u0000CODEDROP\u0000';
                var idx = codeBlocks.push('<pre class="md-code">' + code + '</pre>') - 1;
                return '\u0000CODE' + idx + '\u0000';
            });

            var lines = src.split('\n');
            var html = [];
            var para = [];
            function flushPara() {
                // Wrap each paragraph run in a block element. Every other block
                // (table/heading/list/hr/code) is already block-level, but a bare
                // paragraph was pushed as naked text, so `html.join('')` glued
                // consecutive paragraphs with no boundary -- "parameters.\n\nOnce"
                // rendered as "parameters.Once". A <p> gives the block break.
                if (para.length) { html.push('<p class="md-p">' + para.join('<br/>') + '</p>'); para = []; }
            }

            for (var i = 0; i < lines.length;) {
                var line = lines[i];
                // Fenced-code placeholder -- emit verbatim.
                if (/^\u0000CODE\d+\u0000$/.test(line.trim())) {
                    flushPara(); html.push(line.trim()); i++; continue;
                }
                if (line.trim() === '\u0000CODEDROP\u0000') { i++; continue; }
                // GFM table: header row with a pipe, followed by a separator row.
                if (/\|/.test(line) && i + 1 < lines.length && _mdIsTableSep(lines[i + 1])) {
                    var headers = _mdRow(line);
                    i += 2;
                    var rows = [];
                    while (i < lines.length && lines[i].trim() !== '' && /\|/.test(lines[i])
                           && !_mdIsTableSep(lines[i])) {
                        rows.push(_mdRow(lines[i])); i++;
                    }
                    var t = '<table class="md-table"><thead><tr>';
                    headers.forEach(function (h) { t += '<th>' + _mdInline(h) + '</th>'; });
                    t += '</tr></thead><tbody>';
                    rows.forEach(function (r) {
                        t += '<tr>';
                        headers.forEach(function (_h, ci) { t += '<td>' + _mdInline(r[ci] || '') + '</td>'; });
                        t += '</tr>';
                    });
                    t += '</tbody></table>';
                    flushPara(); html.push(t); continue;
                }
                // Horizontal rule on its own line.
                if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
                    flushPara(); html.push('<hr class="md-hr"/>'); i++; continue;
                }
                // ATX heading.
                var hm = /^\s*(#{1,6})\s+(.*\S)\s*$/.exec(line);
                if (hm) {
                    flushPara();
                    html.push('<div class="md-h md-h' + hm[1].length + '">' + _mdInline(hm[2]) + '</div>');
                    i++; continue;
                }
                // List run (unordered -/* or ordered N.) -- indentation- and
                // loose-list-aware (see _mdParseList).
                if (_MD_ITEM.test(line)) {
                    flushPara();
                    var lst = _mdParseList(lines, i);
                    html.push(lst.html);
                    i = lst.next;
                    continue;
                }
                // Blank line -- paragraph break.
                if (line.trim() === '') { flushPara(); i++; continue; }
                // Plain line.
                para.push(_mdInline(line)); i++;
            }
            flushPara();

            var rendered = html.join('')
                .replace(/\u0000CODE(\d+)\u0000/g, function (_m, n) { return codeBlocks[n] || ''; })
                .replace(/\u0000CODEDROP\u0000/g, '');
            return $sce.trustAsHtml(rendered);
        }

        return {
            render: render
        };
    }
})();
