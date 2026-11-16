'use strict';
/**
 * fsrPbExportService -- builds the two chat-export documents.
 *
 * Moved out of view.controller.js with no behaviour change:
 *   buildMarkdown(snap)   the human-facing transcript export (.md)
 *   buildEventsJson(snap) the machine-readable sidecar (.events.json)
 * Both read a snapshot of the controller's state (see the controller's
 * _exportSnapshot) rather than scope, so they are testable without a
 * controller. The secret scrub is the controller's, passed in as snap.scrub.
 */
(function () {
    angular
        .module('cybersponse')
        .factory('fsrPbExportService', fsrPbExportService);

    function fsrPbExportService() {
        // Full, unambiguous timestamp for EXPORTS. The on-screen badge
        // (`formatTs`) is deliberately time-only -- a chat bubble sits next to
        // its neighbours, so the date is implied. An export is read weeks later
        // detached from that context, where "13:30:44" answers nothing: the
        // reader cannot tell which day, let alone which year, the session ran.
        // Exports therefore always carry the calendar date AND the year, plus
        // the UTC offset so a transcript shared across timezones still pins to
        // a real instant.
        function _exportTs(ts) {
            if (!ts) return '';
            try {
                var d = new Date(ts);
                if (isNaN(d.getTime())) return '';
                var p = function (n) { return (n < 10 ? '0' : '') + n; };
                var off = -d.getTimezoneOffset();
                var sign = off < 0 ? '-' : '+';
                off = Math.abs(off);
                return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
                    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
                    + ' UTC' + sign + p(Math.floor(off / 60)) + ':' + p(off % 60);
            } catch (e) { return ''; }
        }

        // First/last message timestamps -- the session's actual span, which is
        // what "when was this session?" is really asking. Distinct from the
        // export time, which only says when someone hit the button.
        function _sessionSpan(messages) {
            var ms = (messages || []).filter(function (m) { return m && m.ts; });
            if (!ms.length) return null;
            var times = ms.map(function (m) { return new Date(m.ts).getTime(); })
                .filter(function (t) { return !isNaN(t); });
            if (!times.length) return null;
            return { first: Math.min.apply(null, times), last: Math.max.apply(null, times) };
        }

        // Cap a large blob for the export. A single `get_record(full=true)`
        // result can be ~1000 lines of raw record JSON, which buries the
        // signal (the tool flow, the failure) in noise and makes the export
        // expensive to read back. Keep the head + tail so the shape is still
        // legible; mark how much was dropped. Tunable; generous enough that
        // normal tool results pass through untouched.
        var EXPORT_BLOB_CAP = 4000;
        function _capForExport(s) {
            s = String(s == null ? '' : s);
            if (s.length <= EXPORT_BLOB_CAP) return s;
            var head = s.slice(0, EXPORT_BLOB_CAP - 600);
            var tail = s.slice(-400);
            return head + '\n\n… [' + (s.length - head.length - tail.length)
                + ' chars truncated for export] …\n\n' + tail;
        }

        // Render one assistant event into Markdown lines.
        function _exportEvent(ev, push) {
            if (ev.type === 'tool_call') {
                push('- **tool** `' + (ev.name || '?') + '`'
                    + (ev.resultStatus ? ' _(' + ev.resultStatus + ')_' : ''));
                if (ev.inputDisplay) {
                    push('  - input:');
                    push('    ```json\n' + _indent(_capForExport(ev.inputDisplay), 4) + '\n    ```');
                }
                if (ev.resultDisplay != null) {
                    push('  - result:');
                    push('    ```\n' + _indent(_capForExport(ev.resultDisplay), 4) + '\n    ```');
                }
            } else if (ev.type === 'approval_request') {
                push('- **approval requested** `' + (ev.name || '') + '`');
                if (ev.display) push('    ```json\n' + _indent(ev.display, 4) + '\n    ```');
            } else if (ev.type === 'choice_card') {
                push('- **choice** -- ' + (ev.prompt || ''));
                (ev.options || []).forEach(function (o) {
                    push('    - ' + (o.label || o.value));
                });
                if (ev._resolved) push('  - _picked: ' + (ev._resolutionText || JSON.stringify(ev._picked))
                    + (ev._resolvedBy ? ' (by ' + ev._resolvedBy + ')' : '') + '_');
            } else if (ev.type === 'capability_gap') {
                push('- **capability gap** -- ' + (ev.missing || ''));
                if (ev.why) push('  - why: ' + ev.why);
                (ev.fixSteps || []).forEach(function (s, i) { push('  ' + (i + 1) + '. ' + s); });
                if (ev._resolved) push('  - _resumed: ' + (ev._resolutionText || ev._picked || '') + '_');
            } else if (ev.type === 'action_card') {
                push('- **action card** -- ' + (ev.summary || (ev.connector + '.' + ev.operation)));
                if (ev.args && Object.keys(ev.args).length) {
                    push('    ```json\n' + _indent(JSON.stringify(ev.args, null, 2), 4) + '\n    ```');
                }
                if (ev._resolved) push('  - _outcome: ' + (ev._outcome || '') + ' -- ' + (ev._resolutionText || '')
                    + (ev._resolvedBy ? ' (by ' + ev._resolvedBy + ')' : '') + '_');
            } else if (ev.type === 'manual_input') {
                push('- **manual input** -- ' + (ev.question || ''));
                if (ev._resolved) push('  - _outcome: ' + (ev._outcome || '') + ' -- ' + (ev._resolutionText || '') + '_');
            } else if (ev.type === 'playbook_offer') {
                push('- **playbook offer** -- ' + (ev.summary || ''));
                (ev.opsSummary || []).forEach(function (o) { push('    - ' + (o.label || (o.connector + '.' + o.operation))); });
                if (ev._resolved) push('  - _outcome: ' + (ev._outcome || '') + ' -- ' + (ev._resolutionText || '')
                    + (ev._resolvedBy ? ' (by ' + ev._resolvedBy + ')' : '') + '_');
            } else if (ev.type === 'info_card') {
                push('- **card** [' + (ev.severity || 'info') + '] ' + (ev.title || ev.variant || ''));
                (ev.blocks || []).forEach(function (b) {
                    if (b.kind === 'text' && b.text) push('    - ' + b.text.replace(/\n/g, ' '));
                    else if (b.kind === 'rows') (b.rows || []).forEach(function (r) {
                        push('    - ' + (r.label || '') + ': ' + (r.value != null ? r.value : ''));
                    });
                    else if (b.kind === 'tags') push('    - tags: ' + (b.tags || []).map(function (t) { return t.label; }).join(', '));
                    else if (b.kind === 'score') push('    - ' + (b.label || '') + ': ' + b.value + (b.max ? '/' + b.max : ''));
                });
            } else if (ev.type === 'error') {
                push('- **error**');
                if (ev.display) push('    ```\n' + _indent(ev.display, 4) + '\n    ```');
            }
        }

        function _indent(s, n) {
            var pad = new Array(n + 1).join(' ');
            return String(s).split('\n').map(function (line) { return pad + line; }).join('\n');
        }

        function buildMarkdown(snap) {
            var mi = snap.modeInfo;
            var L = [];
            var push = function (s) { L.push(s); };
            push('# Agentic Assistant -- chat activity export');
            push('');
            push('- Exported: ' + _exportTs(Date.now()) + '  (' + new Date().toISOString() + ')');
            var span = _sessionSpan(snap.messages);
            if (span) {
                push('- Session started: ' + _exportTs(span.first));
                push('- Last activity: ' + _exportTs(span.last));
            }
            push('- Session: `' + snap.sessionId + '`');
            push('- Mode: ' + (mi.mode || 'unknown') + (mi.mock_scenario ? ' (scenario: ' + mi.mock_scenario + ')' : ''));
            push('- Intent: ' + snap.uiIntent);
            push('- Widget: v' + (snap.widgetVersion || '?') + ' · contract v' + snap.contractVersion);
            if (snap.connectorInfo) {
                push('- Connector: ' + snap.connectorInfo.name + ' v' + snap.connectorInfo.version
                    + ' (config: ' + snap.connectorInfo.configName + ')');
            }
            var e = snap.entityContext;
            if (e && e.iri) {
                push('- Entity: ' + (e.displayName || e.iri) + ' [' + (e.module || '') + ']');
            }
            if (snap.usage && snap.usage.tokens) {
                push('- Usage: ' + snap.usage.tokensDisplay + ' tokens ('
                    + snap.usage.inputDisplay + ' in / ' + snap.usage.outputDisplay + ' out) · $' + snap.usage.cost);
            }
            if (snap.contractBanner) push('- Warning, version mismatch: ' + snap.contractBanner);
            if (snap.errorMessage) push('- Last error: ' + snap.errorMessage);
            push('');
            push('## Transcript');
            push('');
            if (!snap.messages.length) push('_(no messages yet)_');
            snap.messages.forEach(function (m, i) {
                var who = m.role === 'user' ? (m.author || 'Analyst')
                    : m.role === 'assistant' ? 'Assistant'
                    : 'System';
                push('### ' + (i + 1) + '. ' + who + (_exportTs(m.ts) ? ' · ' + _exportTs(m.ts) : ''));
                if (m.text && m.text.trim()) { push(''); push(m.text.trim()); }
                if (m.events && m.events.length) {
                    push('');
                    m.events.forEach(function (ev) { _exportEvent(ev, push); });
                }
                push('');
            });
            if (snap.currentYaml) {
                push('## Current playbook YAML');
                push('');
                push('```yaml\n' + snap.currentYaml + '\n```');
                push('');
            }
            push('## Client event log');
            push('');
            push('```json\n' + JSON.stringify(snap.eventLog, null, 2) + '\n```');
            // Final secret scrub on the whole document -- any echoed Bearer JWT,
            // session id, or token in a tool_result/error blob is redacted before
            // the analyst can copy or download it.
            return snap.scrub(L.join('\n'));
        }

        // Machine-readable sidecar (plan F, option 1). The human-facing md is
        // expensive to grep -- a single get_record/get_op_schema result is ~1000
        // lines and the whole doc pages past any read cap. This emits the raw
        // event structure verbatim (zero info loss) so an analyst/agent can
        // slice it: a header manifest (intent, per-type tool-call counts, error
        // count, final-YAML present) makes the failure shape visible without
        // reading the body, and the per-turn event arrays carry the full detail.
        // Same secret scrub as the md before it can be copied/downloaded.
        function buildEventsJson(snap) {
            var mi = snap.modeInfo;
            var toolCalls = 0, errors = 0;
            var byTool = {};
            snap.messages.forEach(function (m) {
                (m.events || []).forEach(function (ev) {
                    if (ev.type === 'tool_call') {
                        toolCalls++;
                        var k = ev.name || '?';
                        byTool[k] = (byTool[k] || 0) + 1;
                        if (ev.resultStatus === 'error') errors++;
                    } else if (ev.type === 'error') {
                        errors++;
                    }
                });
            });
            var e = snap.entityContext;
            var doc = {
                manifest: {
                    exported: new Date().toISOString(),
                    sessionStarted: _sessionSpan(snap.messages) ? new Date(_sessionSpan(snap.messages).first).toISOString() : null,
                    sessionLastActivity: _sessionSpan(snap.messages) ? new Date(_sessionSpan(snap.messages).last).toISOString() : null,
                    session: snap.sessionId,
                    mode: mi.mode || 'unknown',
                    mock_scenario: mi.mock_scenario || null,
                    intent: snap.uiIntent,
                    widgetVersion: snap.widgetVersion || null,
                    contractVersion: snap.contractVersion,
                    connector: snap.connectorInfo
                        ? { name: snap.connectorInfo.name, version: snap.connectorInfo.version, config: snap.connectorInfo.configName }
                        : null,
                    entity: (e && e.iri) ? { iri: e.iri, module: e.module || null, displayName: e.displayName || null } : null,
                    messageCount: snap.messages.length,
                    toolCallCount: toolCalls,
                    toolCallsByName: byTool,
                    errorCount: errors,
                    finalYaml: !!snap.currentYaml,
                    usage: (snap.usage && snap.usage.tokens)
                        ? { tokens: snap.usage.tokens, cost: snap.usage.cost } : null
                },
                messages: snap.messages.map(function (m) {
                    return { role: m.role, author: m.author || null, ts: m.ts || null, text: m.text || '', events: m.events || [] };
                }),
                currentYaml: snap.currentYaml || null,
                clientEventLog: snap.eventLog
            };
            return snap.scrub(JSON.stringify(doc, null, 2));
        }

        return {
            buildMarkdown: buildMarkdown,
            buildEventsJson: buildEventsJson
        };
    }
})();
