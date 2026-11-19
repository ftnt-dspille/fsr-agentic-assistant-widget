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

        // ── Model badge ─────────────────────────────────────────────────────
        // The header names where the conversation is being sent. The model id
        // comes off the connector's own usage frames (`model`), e.g.
        // "anthropic/claude-haiku-5-5", "gpt-4.1-mini" or "fortiai-proxy".
        // Returns { model, provider, label } or null for nothing usable.
        // The provider comes from an explicit "<provider>/" prefix, else from
        // the family name; an id of unknown family is shown as it came.
        var _PROVIDER_NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google',
            gemini: 'Google', mistral: 'Mistral', meta: 'Meta', fortiai: 'FortiAI', azure: 'Azure OpenAI' };
        function _describeModel(raw) {
            var id = String(raw == null ? '' : raw).trim();
            if (!id) return null;
            var provider = '';
            var model = id;
            var slash = id.indexOf('/');
            if (slash > 0 && slash < id.length - 1) {
                var prefix = id.slice(0, slash).toLowerCase();
                provider = _PROVIDER_NAMES[prefix] || (prefix.charAt(0).toUpperCase() + prefix.slice(1));
                model = id.slice(slash + 1);
            } else {
                var low = id.toLowerCase();
                if (low.indexOf('claude') === 0) provider = 'Anthropic';
                else if (/^(gpt|o\d|chatgpt)/.test(low)) provider = 'OpenAI';
                else if (low.indexOf('gemini') === 0) provider = 'Google';
                else if (low.indexOf('fortiai') === 0) provider = 'FortiAI';
            }
            // "fortiai-proxy via FortiAI" says the same thing twice.
            var redundant = provider && model.toLowerCase().indexOf(provider.toLowerCase()) !== -1;
            var label = 'Model: ' + model + (provider && !redundant ? ' via ' + provider : '');
            return { model: model, provider: provider, label: label };
        }

        // The newest model named by a list of wire events (usage frames), or ''.
        function _latestModel(events) {
            var found = '';
            (events || []).forEach(function (e) {
                if (e && e.type === 'usage' && e.model) found = String(e.model);
            });
            return found;
        }

        // ── Comments-capable check ─────────────────────────────────────────
        // A module supports comments when its metadata carries a relationship
        // attribute to the comments module (`type: 'comments'`, formType
        // manyToMany). Accepts the model_metadatas record, or a list of them
        // (matched on `type` when a module is given). Fails closed: anything
        // unreadable is "no".
        function _moduleSupportsComments(meta, module) {
            var m = meta;
            if (m && m['hydra:member']) m = m['hydra:member'];
            if (Array.isArray(m)) {
                var want = String(module || '');
                m = m.filter(function (x) { return x && (!want || x.type === want); })[0];
            }
            if (!m || !Array.isArray(m.attributes)) return false;
            return m.attributes.some(function (a) {
                return !!a && (a.type === 'comments'
                    || (!!a.dataSource && a.dataSource.model === 'comments'));
            });
        }

        // ── Comment summary (deterministic, no model call) ──────────────────
        // Built only from what the conversation already holds: verdict cards,
        // action and approval cards with their outcomes, and playbook offers.
        // Times are UTC so the comment reads the same for everyone.
        function _pad2(n) { return n < 10 ? '0' + n : String(n); }
        function _fmtTime(ms) {
            if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
            var d = new Date(ms);
            return d.getUTCFullYear() + '-' + _pad2(d.getUTCMonth() + 1) + '-' + _pad2(d.getUTCDate())
                + ' ' + _pad2(d.getUTCHours()) + ':' + _pad2(d.getUTCMinutes()) + ' UTC';
        }
        function _oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
        function _at(ms) { var t = _fmtTime(ms); return t ? ' (' + t + ')' : ''; }

        function _actionLine(ev) {
            var what = _oneLine(ev.summary || ev.display || ev.title);
            if (!what) return '';
            if (ev._error) return 'Failed: ' + what + _at(ev._resolvedAt) + ' - ' + _oneLine(ev._error);
            if (!ev._resolved) return 'Proposed, not yet decided: ' + what;
            var o = ev._outcome;
            if (o === 'reject' || o === 'denied') return 'Declined: ' + what + _at(ev._resolvedAt);
            if (o === 'failed' || o === 'expired') return 'Did not run: ' + what + _at(ev._resolvedAt);
            if (o === 'unverified') return 'Approved, result not confirmed: ' + what + _at(ev._resolvedAt);
            return 'Approved: ' + what + _at(ev._resolvedAt);
        }

        function _buildCommentSummary(messages, opts) {
            opts = opts || {};
            var verdicts = [], actions = [], playbooks = [];
            (messages || []).forEach(function (m) {
                ((m && m.events) || []).forEach(function (ev) {
                    if (!ev) return;
                    if (ev.type === 'verdict_card') {
                        verdicts.push({ ev: ev, ts: m.ts });
                    } else if (ev.type === 'action_card' || ev.type === 'approval_request') {
                        var line = _actionLine(ev);
                        if (line) actions.push(line);
                    } else if (ev.type === 'playbook_offer' && ev._outcome === 'accept') {
                        var t = _oneLine(ev.title || ev.titleSuggestion);
                        playbooks.push('Saved as a playbook' + (t ? ': ' + t : '') + _at(ev._resolvedAt));
                    } else if (ev.type === 'enhancement_offer' && ev._outcome === 'accept') {
                        var s = _oneLine(ev.summary || ev.display);
                        playbooks.push('Playbook updated' + (s ? ': ' + s : '') + _at(ev._resolvedAt));
                    }
                });
            });
            var lines = [];
            if (verdicts.length) {
                var last = verdicts[verdicts.length - 1];
                var v = last.ev;
                var head = 'Verdict: ' + (v.dispositionLabel || v.disposition || 'Needs more information');
                var bits = [v.severityLabel, v.confidenceLabel].filter(Boolean);
                if (bits.length) head += ' (' + bits.join(', ') + ')';
                head += _at(last.ts);
                lines.push(head);
                if (v.summary) lines.push(_oneLine(v.summary));
                var findings = (v.findings || []).map(function (f) { return _oneLine(f && f.claim); })
                    .filter(Boolean);
                if (findings.length) {
                    lines.push('', 'Findings:');
                    findings.forEach(function (f) { lines.push('- ' + f); });
                }
                var unknowns = (v.unknowns || []).map(_oneLine).filter(Boolean);
                if (unknowns.length) {
                    lines.push('', 'Could not confirm:');
                    unknowns.forEach(function (u) { lines.push('- ' + u); });
                }
            }
            if (actions.length) {
                if (lines.length) lines.push('');
                lines.push('Actions:');
                actions.forEach(function (a) { lines.push('- ' + a); });
            }
            if (playbooks.length) {
                if (lines.length) lines.push('');
                lines.push('Playbooks:');
                playbooks.forEach(function (p) { lines.push('- ' + p); });
            }
            if (!lines.length) return { empty: true, text: '' };
            var title = 'Assistant summary' + (opts.now ? ' - ' + _fmtTime(opts.now) : '');
            return { empty: false, text: title + '\n\n' + lines.join('\n') };
        }

        function _escapeHtml(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        // The comment body FortiSOAR stores: the analyst's (possibly edited)
        // text as paragraphs, escaped, one line break per newline.
        function _commentHtml(text) {
            return String(text == null ? '' : text).split(/\n{2,}/).map(function (para) {
                return '<p>' + _escapeHtml(para.replace(/^\n+|\n+$/g, '')).replace(/\n/g, '<br>') + '</p>';
            }).join('');
        }

        // POST /api/3/comments body: the text plus the parent record linked
        // through its module's relationship field (`{ alerts: [iri] }`).
        function _commentPayload(text, iri, module) {
            var body = { content: _commentHtml(text) };
            body[module] = [iri];
            return body;
        }

        return {
            findApprovalRequest: _findApprovalRequest,
            collectOfferEdits: _collectOfferEdits,
            collapseManualValues: _collapseManualValues,
            describeModel: _describeModel,
            latestModel: _latestModel,
            moduleSupportsComments: _moduleSupportsComments,
            buildCommentSummary: _buildCommentSummary,
            commentPayload: _commentPayload
        };
    }
})();
