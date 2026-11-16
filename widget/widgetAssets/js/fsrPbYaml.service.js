'use strict';
/**
 * fsrPbYamlService -- playbook YAML extraction and value-patch helpers.
 *
 * Moved verbatim out of view.controller.js (no behaviour change). Pure string
 * and object work: no scope, no DOM, no closure state. The controller re-binds
 * the original names to these functions, so the call sites are unchanged.
 *   extractLastYamlFence(text)  last ```yaml fence, or the truncated tail
 *   (extractYaml stays in the controller: it writes scope.)
 *   isTruncated(stopReason)     did the model stop on a length limit
 *   stepIdOf / yamlVal          step-id and scalar reads for the YAML pane
 *   occurrences / toPatch       value-level diagnose-and-fix patch builder
 */
(function () {
    angular
        .module('cybersponse')
        .factory('fsrPbYamlService', fsrPbYamlService);

    function fsrPbYamlService() {
        // step_test synthesizes a step's id from its `id:` (else `name:`),
        // lowercased with whitespace collapsed to underscores -- mirror that so
        // the id we pass matches the step the connector resolves.
        function _stepIdOf(raw) {
            return String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
        }

        function _yamlVal(s) {
            return String(s || '').trim().replace(/^["']|["']$/g, '').trim();
        }

        function _occurrences(hay, needle) {
            if (!needle) return 0;
            var n = 0, i = 0;
            while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
            return n;
        }

        function _toPatch(fix, yaml) {
            var before = (fix.before === undefined || fix.before === null) ? '' : String(fix.before);
            var after = (fix.after === undefined || fix.after === null) ? '' : String(fix.after);
            return {
                stepId: fix.step_id || '',
                location: fix.location || '',
                before: before,
                after: after,
                confidence: fix.confidence || 'low',
                explanation: fix.explanation || '',
                kind: fix.kind || '',
                // Only a unique, non-empty literal is a safe one-click swap.
                applicable: before !== '' && before !== after && _occurrences(yaml, before) === 1,
                applied: false
            };
        }

        // Extract the LAST ```yaml … ``` block from `combined`. The closing
        // fence MUST be line-anchored (its own line, optional surrounding
        // spaces) -- a ``` that appears INSIDE the YAML (mid-line in a quoted
        // string, a description field, an embedded example) can no longer clip
        // the block. The old extractor used a non-greedy `([\s\S]*?)```` that
        // stopped at the FIRST ``` anywhere, silently truncating the playbook;
        // Save then compiled the clipped copy OVER the real record and the
        // steps past the clip were DELETED (HIGH -- silent data corruption).
        // Returns {yaml, truncated}: `truncated` is true when a ```yaml opener
        // has NO line-anchored close (an unterminated fence, e.g. the model
        // emitted an unclosed block) -- a WRITE must refuse rather than persist
        // a partial playbook. This helper is shared by the live turn and the
        // rehydrate scan so the two can't drift.
        function _extractLastYamlFence(combined) {
            var open = /```ya?ml[ \t]*\r?\n/ig;
            var body = null, truncated = false, om;
            while ((om = open.exec(combined)) !== null) {
                var rest = combined.slice(open.lastIndex);
                var close = /\r?\n[ \t]*```[ \t]*(?:\r?\n|$)/.exec(rest);
                if (close) {
                    body = rest.slice(0, close.index);
                    // Resume scanning AFTER this block so a later fence wins.
                    open.lastIndex += close.index + close[0].length;
                    truncated = false;
                } else {
                    // Opener with no line-anchored close → truncated capture.
                    body = rest;
                    truncated = true;
                    break;
                }
            }
            return { yaml: body != null ? body.replace(/^\s*\n/, '').replace(/\s+$/, '') : null,
                     truncated: truncated };
        }

        // Stop reasons that mean "cut off", not "finished". The connector's
        // OpenAI provider maps the wire `finish_reason: "length"` onto
        // **`max_tokens`**; it previously mapped onto `max_turns`, which read
        // as the tool-loop budget and so disguised a truncated build as a
        // benign stop. Both are listed -- the widget ships to boxes running
        // older framework builds that still emit the old token.
        var _TRUNCATED_STOPS = ['max_turns', 'max_tokens', 'length', 'max_tool_turns'];

        function _isTruncated(stopReason) {
            return _TRUNCATED_STOPS.indexOf(String(stopReason || '')) !== -1;
        }

        return {
            extractLastYamlFence: _extractLastYamlFence,
            isTruncated: _isTruncated,
            stepIdOf: _stepIdOf,
            yamlVal: _yamlVal,
            occurrences: _occurrences,
            toPatch: _toPatch
        };
    }
})();
