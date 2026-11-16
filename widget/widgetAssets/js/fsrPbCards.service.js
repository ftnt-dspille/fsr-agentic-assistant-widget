'use strict';
/**
 * fsrPbCardsService -- pure helpers for the card payloads the widget builds:
 * the approval display, the playbook-offer edits, and the manual-input values.
 *
 * Moved verbatim out of view.controller.js (no behaviour change). Each helper
 * reads only its argument.
 */
(function () {
    angular
        .module('cybersponse')
        .factory('fsrPbCardsService', fsrPbCardsService);

    fsrPbCardsService.$inject = [];

    function fsrPbCardsService() {
        function _findApprovalRequest(events) {
            for (var i = events.length - 1; i >= 0; i--) {
                if (events[i].type === 'approval_request') return events[i];
            }
            return null;
        }

        // Collect the safe inline edits (contract §5) from a reviewed draft:
        //   edits.manual_input_prompts[<op label>]  -- prompt/value the analyst
        //       supplied for a verified:false (or manual_input) gap.
        //   edits.branch_labels[<decision node>][<branch key>] -- renamed fork
        //       label. Title rides separately on the payload.
        // Wiring/DAG structure is never touched. Returns null when nothing
        // changed so the accept payload stays byte-identical to pre-2.6.0.
        function _collectOfferEdits(event) {
            var prompts = {}, labels = {};
            // gaps (shared op refs -- covers both the flat list and fork children)
            (event.opsSummary || []).forEach(function (o) {
                if (o.needsInput && o.promptDraft != null && String(o.promptDraft).trim() !== '') {
                    prompts[o.label] = o.promptDraft;
                }
            });
            // edited branch labels on decision/manual_input forks
            (event.draftSteps || []).forEach(function (st) {
                if (st.kind !== 'fork') return;
                (st.branches || []).forEach(function (b) {
                    if (b.keyDraft != null && b.keyDraft !== b.key) {
                        labels[st.node] = labels[st.node] || {};
                        labels[st.node][b.key] = b.keyDraft;
                    }
                });
            });
            var edits = {};
            if (Object.keys(prompts).length) edits.manual_input_prompts = prompts;
            if (Object.keys(labels).length) edits.branch_labels = labels;
            return Object.keys(edits).length ? edits : null;
        }

        // Collapse the card's UI-model values into the workflow's field values.
        // A dynamic_list field is edited via two helper keys (name__group /
        // name__item); the workflow expects a single [group, item] array under
        // `name`. Every other field passes through as-is. Returns a fresh dict
        // (never mutates the card model).
        function _collapseManualValues(event) {
            var vals = event.values || {};
            var out = {};
            var k;
            for (k in vals) {
                if (!vals.hasOwnProperty(k)) continue;
                if (/__group$|__item$/.test(k)) continue;  // helper keys, not fields
                out[k] = vals[k];
            }
            (event.fields || []).forEach(function (f) {
                if (!f || f.control !== 'dynamic_list' || f.name == null) return;
                var g = vals[f.name + '__group'];
                var it = vals[f.name + '__item'];
                // Only emit a selection when both levels are chosen; an empty
                // pick submits an empty array (field is optional in the schema).
                out[f.name] = (g && it) ? [g, it] : [];
            });
            return out;
        }

        return {
            findApprovalRequest: _findApprovalRequest,
            collectOfferEdits: _collectOfferEdits,
            collapseManualValues: _collapseManualValues
        };
    }
})();
