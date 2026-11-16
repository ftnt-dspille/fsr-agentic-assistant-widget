'use strict';
/// <reference path="./contract.d.ts" />
// The connector chat wire contract (envelope, poll frames, turn ack vs blocking
// transcript) is typed in contract.d.ts (FsrPbChat.*). The returns below are
// annotated with it so an editor surfaces the real shapes and a shape drift is
// visible at the seam. Runtime is plain ES5 -- the reference/JSDoc are erased.
(function () {
    angular
        .module('cybersponse')
        .factory('fsrPbAgentService', fsrPbAgentService);

    fsrPbAgentService.$inject = ['$q', '$http', '$window', '$injector', 'fsrPbMockConnectorService'];

    function fsrPbAgentService($q, $http, $window, $injector, fsrPbMockConnectorService) {

        // Fallback for a mock config with no scenario saved. Matches the default
        // both controllers write (view.controller.js / edit.controller.js), so a
        // bare config and a saved-default config resolve to the same demo.
        // tests/config.defaults.service.test.js keeps the three in agreement.
        var DEFAULT_MOCK_SCENARIO = 'playbook_soc_demo';

        // The connector identity is fixed for this widget -- it is not a user
        // setting. We resolve the installed VERSION and a config_id at runtime
        // (the connector is redeployed often, so a pinned version is brittle).
        //
        // Config selection: honor the connector's DEFAULT configuration (the
        // one starred in FortiSOAR → Connectors), else the first one. This
        // makes the choice VISIBLE and admin-controllable via the native
        // star-a-config gesture -- the widget deliberately does NOT hardcode a
        // preferred config name. (It used to pin `fsrpb-live`, which silently
        // overrode the starred default and left admins with no way to tell or
        // change which config ran. If the starred default is a broken egress,
        // fix the default in the UI -- don't reintroduce a hidden override.)
        //
        // NOTE: the connector was renamed `fsr-playbook-builder` →
        // `connector-fsr-agentic-assistant` (connector commit 6131c26; 0.3.127 was
        // the last build under the OLD name). The widget MUST track the new
        // name or it talks to the frozen pre-rename 0.3.127 connector and misses
        // every fix since (OpenAI provider, live-streaming, turn-counter, …).
        var CONNECTOR_NAME = 'connector-fsr-agentic-assistant';

        // Record pages where turning the session into a playbook is WANTED -- a
        // real SOC investigation of an alert / case / war room. `uiIntent`
        // defaults to 'triage' on every non-editor mount, so without this the
        // "Ready to automate this?" handoff appeared on ANY record (a ztpf
        // device, a template, a custom module) as soon as the agent ran one
        // tool. There the analyst asked to list steps, not to author automation.
        //
        // FortiSOAR 8.0 renames the `incidents` module's DISPLAY label to
        // "Cases" -- same module type (verified live: 8.0 Alerts/Cases, 7.x
        // Alerts/Incidents), so 'incidents' covers "case". There is no separate
        // 'cases' module to list.
        //
        // This MIRRORS the connector's canonical
        // `triage_sources.TRIAGE_RECORD_MODULES`, and a parity test in the
        // connector reads THIS array and fails on drift -- the same guard the
        // vendored verdict vocabulary uses. Two hand-maintained lists for one
        // concept is a known drift class; the test is what makes the copy safe.
        var TRIAGE_RECORD_MODULES = ['alerts', 'incidents', 'warrooms'];
        // Connector search tokenizes oddly: filter by an exact token in the name
        // (the full hyphenated name matches 0 rows), then match by exact name
        // client-side below. 'assistant' is unique to the Agentic Assistant connector.
        var CONNECTOR_SEARCH = 'assistant';
        var _resolved = null; // cached SUCCESSFUL resolution promise
        var _recordCache = null; // cached raw connector record fetch

        // A VISIBLE, session-only config override. Set by the user via the
        // needs_config help panel when the starred default config is broken and
        // a different config probes healthy. Deliberately NOT persisted (resets
        // on reload) and always surfaced in the UI banner -- this is the opposite
        // of the old hidden `PREFERRED_CONFIG` hardcode: nothing overrides the
        // connector default silently. The permanent fix is still to star a good
        // config in FortiSOAR → Connectors.
        var _configOverride = null; // { config_id, name } or null

        // Fetch the raw connector record (name, version, full config list) once.
        // Kept separate from _resolveConnector so the help panel can enumerate
        // and health-probe every config without committing to a selection.
        function _resolveRecord() {
            if (_recordCache) return _recordCache;
            _recordCache = $http.get('/api/integration/connectors/?search=' + CONNECTOR_SEARCH)
                .then(function (resp) {
                    var list = (resp.data && resp.data.data) || [];
                    var rec = list.filter(function (c) { return c.name === CONNECTOR_NAME; })[0];
                    if (!rec) {
                        return $q.reject({ code: 'connector_not_installed',
                            message: 'Connector "' + CONNECTOR_NAME + '" is not installed on this FortiSOAR instance.' });
                    }
                    return {
                        name: CONNECTOR_NAME,
                        version: rec.version,
                        configs: (rec.configuration || []).map(function (c) {
                            return { config_id: c.config_id, name: c.name, default: !!c.default };
                        })
                    };
                }, function (err) {
                    return $q.reject({ code: 'connector_lookup_failed',
                        message: 'Could not query connectors (HTTP ' + (err && err.status) + ').' });
                });
            _recordCache.catch(function () { _recordCache = null; });
            return _recordCache;
        }

        // Pick the config the widget will actually talk to: a live session
        // override if the user set one AND it still exists on the connector,
        // else the connector's starred DEFAULT, else the first config.
        function _chooseConfig(rec) {
            var cfgs = rec.configs || [];
            if (_configOverride) {
                var ov = cfgs.filter(function (c) { return c.config_id === _configOverride.config_id; })[0];
                if (ov) return ov;
                _configOverride = null; // stale override (config was removed) -- drop it
            }
            return cfgs.filter(function (c) { return c.default; })[0] || cfgs[0];
        }

        function _resolveConnector() {
            if (_resolved) return _resolved;
            _resolved = _resolveRecord().then(function (rec) {
                var chosen = _chooseConfig(rec);
                if (!chosen) {
                    return $q.reject({ code: 'connector_not_configured',
                        message: 'Connector "' + CONNECTOR_NAME + '" has no configuration. Add one in FortiSOAR → Connectors.' });
                }
                return {
                    name: rec.name, version: rec.version,
                    configId: chosen.config_id, configName: chosen.name,
                    isDefault: !!chosen.default, isOverride: !!_configOverride
                };
            });
            // Don't cache a failure -- a transient deploy window shouldn't poison
            // every later call.
            _resolved.catch(function () { _resolved = null; });
            return _resolved;
        }

        // Enumerate every configuration on the connector (id, name, default).
        // Real mode only; the mock connector has no config surface.
        function _listConfigs() {
            return _resolveRecord().then(function (rec) { return rec.configs.slice(); });
        }

        // Probe ONE config's real health via the connector's health_check op,
        // executed against that specific config_id (not the default). Returns
        // the health payload ({ok, llm_reachable, llm_error, llm_key_configured,
        // llm_provider, ...}). Never rejects for an *unhealthy* config -- an
        // ok:false payload is a valid answer; only transport failure rejects.
        function _healthCheckConfig(configId) {
            return _resolveRecord().then(function (rec) {
                var connectorService = $injector.get('connectorService');
                return connectorService
                    .executeConnectorAction(rec.name, rec.version, 'health_check', configId, {})
                    .then(_unwrapEnvelope);
            });
        }

        // Set / clear the visible session override. Clears the resolution cache
        // so the next dispatch re-selects. Returns nothing -- the controller owns
        // the banner state.
        function _setConfigOverride(cfg) {
            _configOverride = cfg && cfg.config_id
                ? { config_id: cfg.config_id, name: cfg.name } : null;
            _resolved = null;
        }
        function _clearConfigOverride() {
            _configOverride = null;
            _resolved = null;
        }

        // Force a fresh connector fetch (config list may have changed: a key was
        // fixed, a config added, the default re-starred). Health probes are
        // always live, but the record + resolution are cached -- bust both so a
        // "Re-check" reflects edits the admin just made in Connector settings.
        function _refresh() {
            _recordCache = null;
            _resolved = null;
        }

        // The active session override, if any (for the visible banner). Null
        // when the widget is using the connector default.
        function _activeOverride() {
            return _configOverride ? { config_id: _configOverride.config_id, name: _configOverride.name } : null;
        }

        function _queryParam(name) {
            var s = $window.location.search || '';
            var re = new RegExp('[?&]' + name + '=([^&]+)');
            var m = re.exec(s);
            return m ? decodeURIComponent(m[1]) : null;
        }

        function _isHarness() {
            var h = ($window.location && $window.location.hostname) || '';
            return h === 'localhost' || h === '127.0.0.1' || h === '::1';
        }

        // Mock vs real precedence (highest first):
        //   1. URL ?mock=<scenario>  → mock, that scenario
        //   2. URL ?mode=mock        → mock, config.mockScenario || default (demo-day insurance)
        //   2. URL ?mode=live|real   → real
        //   3. URL ?real=1           → real
        //   4. config.mockMode === 'mock' → mock, config.mockScenario || default
        //   5. config.mockMode === 'real' → real
        //   6. config.mockMode === 'auto' or unset → mock on localhost, real elsewhere
        function _activeScenario(cfg) {
            var urlMock = _queryParam('mock');
            if (urlMock) return urlMock;
            var urlMode = _queryParam('mode');
            if (urlMode === 'mock') return (cfg && cfg.mockScenario) || DEFAULT_MOCK_SCENARIO;
            if (urlMode === 'live' || urlMode === 'real') return null;
            if (_queryParam('real') === '1') return null;
            var mode = cfg && cfg.mockMode;
            if (mode === 'mock') return (cfg && cfg.mockScenario) || DEFAULT_MOCK_SCENARIO;
            if (mode === 'real') return null;
            // auto
            if (_isHarness()) return (cfg && cfg.mockScenario) || DEFAULT_MOCK_SCENARIO;
            return null;
        }

        // Public view of the resolved mode, for the controller to stamp into
        // chat_turn / chat_resume payloads (contract §0, §2). The connector
        // honors `mode`/`mock_scenario` server-side so a mock demo can run
        // end-to-end through the real connector with no LLM.
        function modeInfo(cfg) {
            var scenario = _activeScenario(cfg);
            return { mode: scenario ? 'mock' : 'live', mock_scenario: scenario || null };
        }

        // connectorService hands back the raw SOAR execute envelope
        // ({operation, status:"Success", message, data:{…connector payload…}}).
        // The mock connector returns the BARE payload. Unwrap .data here so live
        // and mock hand callers one consistent shape -- without this, live
        // chat_turn responses look empty because stop_reason/transcript live
        // under .data, not at the top level.
        function _unwrapEnvelope(resp) {
            if (resp && resp.data != null && typeof resp.status === 'string') return resp.data;
            return resp;
        }

        // A cached SUCCESSFUL resolution (version + config_id) can go STALE
        // mid-session: the connector gets uninstalled, renamed, or its config
        // changes, and every later executeConnectorAction then fails against the
        // frozen version/config with no recovery but a page reload. Detect that
        // class of failure so the dispatcher can drop the cache and re-resolve.
        function _isStaleResolutionError(err) {
            if (!err) return false;
            if (err.status === 404) return true;
            var msg = (err.data && (err.data.message
                        || (err.data.error && (err.data.error.message || err.data.error.code))))
                   || err.message || '';
            return /unknown connector|connector (?:was )?not (?:found|installed|configured)|no such connector|configuration.*not (?:found|exist)|invalid config/i
                .test(String(msg));
        }

        // Dispatch to the live connector through the cached resolution, with ONE
        // self-heal retry: if the call fails with a stale-resolution error, drop
        // `_resolved` and re-resolve once (the connector may have been
        // redeployed). A second failure surfaces to the caller unchanged.
        function _dispatchReal(action, payload, _retried) {
            var connectorService = $injector.get('connectorService');
            return _resolveConnector().then(function (res) {
                return connectorService.executeConnectorAction(res.name, res.version, action, res.configId, payload);
            }).then(_unwrapEnvelope, function (err) {
                if (!_retried && _isStaleResolutionError(err)) {
                    // Bust BOTH caches: a redeploy/rename/reconfigure changes the
                    // raw record (version, config list), not just the selection.
                    _resolved = null;
                    _recordCache = null;
                    return _dispatchReal(action, payload, true);
                }
                return $q.reject(err);
            });
        }

        // Always dispatch to the live connector, bypassing any mock scenario.
        // Used for real SOAR mutations (playbook creation) that must take effect
        // even when the chat track is mocked.
        function _executeReal(action, payload) {
            return _dispatchReal(action, payload);
        }

        // ─── Persona-aware UI framing (module-scoped assistant personas) ─────
        // A module may declare an assistant persona in the Key Store
        // (`fsr_assistant_profile:<module>`, per the module-scoped-personas
        // plan). Its `jSONValue.ui` block, when present, tells the widget how
        // to frame the opening state (greeting, composer placeholder,
        // quick-action deck, footer) so an authoring persona doesn't wear
        // SOC-triage clothing. Resolution order: a direct Key Store read first
        // (fast, the analyst's own creds); if that 403s in-browser (a known
        // /api/3 platform gotcha -- see the localStorage-schema-cache note) or
        // misses locally, fall back to the connector, which already resolves
        // the persona server-side (`load_profile`, incl. `bind_modules`) and
        // exposes it via the `resolve_persona` action. Any failure ⇒ null =
        // today's triage default, byte-unchanged.
        function _personaFromUi(ui, label) {
            ui = ui || {};
            return {
                found: true,
                label: label || ui.label || null,
                greeting: ui.greeting || null,
                subtitle: ui.subtitle || null,
                placeholder: ui.placeholder || null,
                pullLabel: ui.pullLabel || null,
                pullHint: ui.pullHint || null,
                buildHint: ui.buildHint || null,
                quickActions: (typeof ui.quickActions !== 'undefined' && ui.quickActions instanceof Array) ? ui.quickActions : null,
                // Module LIST page framing (no record open): its own deck and
                // nouns. Absent ⇒ the widget's neutral list deck.
                listQuickActions: (ui.listQuickActions instanceof Array) ? ui.listQuickActions : null,
                listLabel: ui.listLabel || null,
                listSubtitle: ui.listSubtitle || null,
                listNoun: ui.listNoun || null,
                recordNoun: ui.recordNoun || null,
                footer: ui.footer || null
            };
        }
        // A Key Store `keys` record → persona UI. The record EXISTING is itself
        // the signal to leave triage framing, even with no explicit `ui` block
        // (best-effort neutral author framing then kicks in client-side).
        function _personaFromKeysRecord(rec) {
            if (!rec) return null;
            var j = rec.jSONValue || rec.jsonValue || {};
            return _personaFromUi(j.ui, j.label || null);
        }
        // The connector's `resolve_persona` response. Accepts a nested `ui`
        // block or the flattened fields; `found:false` ⇒ no persona.
        function _personaFromConnector(r) {
            if (!r || r.found === false) return null;
            if (r.ui) return _personaFromUi(r.ui, r.label || null);
            if (r.label || r.greeting || r.subtitle || r.placeholder || r.pullLabel || r.pullHint || r.buildHint || r.quickActions || r.listQuickActions || r.footer) {
                return _personaFromUi(r, r.label || null);
            }
            return null;
        }
        function _personaViaConnector(module) {
            return _executeReal('resolve_persona', { module: module })
                .then(function (r) { return _personaFromConnector(r); },
                      function () { return null; });
        }
        function resolvePersona(config, module) {
            if (!module) return $q.when(null);
            var scenario = _activeScenario(config);
            if (scenario) {
                // Mock/harness: no Key Store or live connector -- serve the
                // persona from the mock connector so e2e can exercise each
                // framing deterministically.
                return fsrPbMockConnectorService.execute(scenario, 'resolve_persona', { module: module })
                    .then(function (r) { return _personaFromConnector(_unwrapEnvelope(r)); },
                          function () { return null; });
            }
            var key = 'fsr_assistant_profile:' + module;
            return $http.get('/api/3/keys?key=' + encodeURIComponent(key) + '&$limit=1')
                .then(function (resp) {
                    var d = (resp && resp.data) || {};
                    var rows = d['hydra:member'] || d.hydra_member || d.data || [];
                    if (rows.length) return _personaFromKeysRecord(rows[0]);
                    // No direct hit -- a `bind_modules` persona might still apply,
                    // which only the connector's loader resolves. Ask it.
                    return _personaViaConnector(module);
                }, function () {
                    // 403 (in-browser /api/3 gate) or transient error → connector.
                    return _personaViaConnector(module);
                });
        }

        function executeAction(config, action, payload) {
            var scenario = _activeScenario(config);
            if (scenario) {
                return fsrPbMockConnectorService.execute(scenario, action, payload);
            }
            // Real mode: resolve the connector (name fixed, version + config_id
            // looked up) then dispatch, with the self-heal retry on a stale
            // resolution. No connector fields come from settings.
            return _dispatchReal(action, payload);
        }

        /**
         * Is `module` a record page where the playbook-authoring handoff belongs?
         * @param {?string} module bare module name from the entity context
         * @returns {boolean}
         */
        function isTriageModule(module) {
            if (!module || typeof module !== 'string') return false;
            return TRIAGE_RECORD_MODULES.indexOf(module.trim()) !== -1;
        }

        return {
            modeInfo:    modeInfo,
            connectorName: CONNECTOR_NAME,
            /** Modules where the "Ready to automate this?" handoff is offered. */
            triageRecordModules: TRIAGE_RECORD_MODULES,
            isTriageModule: isTriageModule,
            resolveConnector: _resolveConnector,
            // Config-health surface for the needs_config help panel.
            /** @returns {PromiseLike<Array<{config_id:string,name:string,default:boolean}>>} */
            listConfigs: _listConfigs,
            /** @returns {PromiseLike<{ok:boolean,llm_reachable:boolean,llm_error:?string,llm_key_configured:boolean,llm_provider:string}>} */
            healthCheckConfig: _healthCheckConfig,
            /** Visible, session-only override of the connector default. */
            setConfigOverride: _setConfigOverride,
            clearConfigOverride: _clearConfigOverride,
            activeOverride: _activeOverride,
            refresh: _refresh,
            /** @returns {PromiseLike<?{found:boolean,label:?string,greeting:?string,subtitle:?string,placeholder:?string,pullLabel:?string,pullHint:?string,buildHint:?string,quickActions:?Array,listQuickActions:?Array,listLabel:?string,listSubtitle:?string,listNoun:?string,recordNoun:?string,footer:*}>} null ⇒ no persona (triage default) */
            resolvePersona: resolvePersona,
            /** @returns {PromiseLike<FsrPbChat.ChatTurnResponse>} detached ack ({accepted}) OR blocking transcript */
            chatTurn:    function (cfg, payload) { return executeAction(cfg, 'chat_turn', payload); },
            /** @returns {PromiseLike<FsrPbChat.ChatTurnResponse>} */
            chatResume:  function (cfg, payload) { return executeAction(cfg, 'chat_resume', payload); },
            /** @returns {PromiseLike<FsrPbChat.ChatHistoryResponse>} */
            chatHistory: function (cfg, sessionId) {
                return executeAction(cfg, 'chat_history', { session_id: sessionId, limit: 50 });
            },
            /** Who answered which card in the session, without the turns: what an
             *  open chat polls to retire a card answered somewhere else. */
            chatCardDecisions: function (cfg, sessionId) {
                return executeAction(cfg, 'chat_history',
                                     { session_id: sessionId, decisions_only: true });
            },
            // List prior conversations for the history browser. Mock/harness
            // sessions aren't persisted server-side, so short-circuit to an
            // empty list there instead of hitting the connector (which has no
            // list_sessions fixture and would error).
            // `query` (optional): search WITHIN sessions for a keyword (transcript
            // content), returning matching sessions each with a `snippet`. Empty
            // ⇒ the recent-sessions list.
            listSessions: function (cfg, query) {
                if (modeInfo(cfg).mode === 'mock') return $q.when({ sessions: [] });
                var payload = { limit: 50 };
                if (query) payload.query = query;
                return executeAction(cfg, 'list_sessions', payload);
            },
            // Flag a session 👍/👎 so the history browser can surface the ones
            // worth investigating. `rating` is 'up' | 'down' | '' (clear). Mock
            // sessions aren't persisted server-side, so short-circuit there.
            rateSession: function (cfg, sessionId, rating, note) {
                if (modeInfo(cfg).mode === 'mock') {
                    return $q.when({ ok: true, session_id: sessionId,
                                     rating: rating ? { rating: rating, note: note || null } : null });
                }
                return executeAction(cfg, 'rate_session', {
                    session_id: sessionId, rating: rating || '', note: note || ''
                });
            },
            // Read-only introspection of the agent's tool surface for a module.
            // Always triage intent (this UI never lists build-authoring tools);
            // the connector applies the module's Key Store persona slice when one
            // exists (⇒ persona_applied), else returns the triage slice. Returns
            // {ok, module, persona_applied, surfaces:[{intent, count, tools[]}]}.
            listAgentTools: function (cfg, payload) {
                return executeAction(cfg, 'list_agent_tools', payload || {});
            },
            // Action-based streaming (contract 2.5.0). A read-only poll of the
            // connector's per-event progress feed for an in-flight chat_turn.
            // Always hits the LIVE connector even when the chat track is mocked
            // would be meaningless (mock turns return instantly and write no
            // feed), so the controller only polls in live mode. Returns
            // {ok, session_id, contract_version, turn, cursor, frames, done,
            // stop_reason}; a connector older than 2.5.0 rejects the unknown op
            // and the controller degrades to the single blocking response.
            /** @returns {PromiseLike<FsrPbChat.ChatPollResponse>} frames + top-level `done` terminal */
            chatPoll: function (cfg, sessionId, cursor, sinceTurn, longPollMs) {
                return _executeReal('chat_poll', {
                    session_id: sessionId, cursor: cursor || 0,
                    // Turn fence: the highest turn already committed. The
                    // connector returns only a turn > this, so a poll that races
                    // chat_turn's prologue can't be served the prior, completed
                    // turn's terminal frame (stale-replay race).
                    since_turn: sinceTurn || 0,
                    // Long-poll window: the connector holds the poll until a
                    // frame lands or this many ms pass (0 = answer at once).
                    long_poll_ms: longPollMs || 0
                });
            },
            // Stop (C6): ends the server turn. The connector marks it cancelled;
            // the agent loop runs no further round and no tool once it sees the
            // mark, and the turn ends as stopped_by_analyst.
            chatCancel: function (cfg, sessionId) {
                return _executeReal('chat_cancel', { session_id: sessionId });
            },
            // Apply-patch (Track C3): validate_yaml against the LIVE connector so
            // the real compiler's `corrected_yaml`/`auto_fixes` come back -- the
            // mock track has no compiler and would render no fixes. Mirrors why
            // pushPlaybook's compile step is always live.
            validateYamlLive: function (cfg, yaml) { return _executeReal('validate_yaml', { yaml: yaml }); },
            // Creating the playbook is a REAL SOAR mutation -- even in mock mode.
            // The mock track scripts the (paid) chat, but the demo must end with a
            // genuine, clickable playbook in FortiSOAR, not a canned fixture. So we
            // always hit the live connector and run the real pipeline:
            // compile_yaml(yaml) → workflow_json → push_playbook({workflow_json}).
            // (The connector's push_playbook takes the COMPILED workflow_json, not
            // raw yaml; the old single-arg yaml call was a no-op against live.)
            pushPlaybook: function (cfg, yaml) {
                return _executeReal('compile_yaml', { yaml: yaml }).then(function (compiled) {
                    if (!compiled || compiled.ok === false || !compiled.workflow_json) {
                        return $q.reject({ message: 'Compile failed before create: ' +
                            JSON.stringify((compiled && (compiled.errors || compiled.error)) || compiled) });
                    }
                    return _executeReal('push_playbook', { workflow_json: compiled.workflow_json });
                }).then(function (r) {
                    r = r || {};
                    // Normalize the live envelope ({ok, collection_uuid, workflow_uuids,
                    // raw}) into the fields the controller renders, and derive IRIs.
                    var raw = r.raw || {};
                    if (!r.collection_iri && raw['@id']) r.collection_iri = raw['@id'];
                    if (!r.collection_uuid && r.collection_iri) {
                        r.collection_uuid = String(r.collection_iri).split('/').pop();
                    }
                    if (!r.workflow_iri) {
                        if (raw.workflows && raw.workflows[0] && raw.workflows[0]['@id']) {
                            r.workflow_iri = raw.workflows[0]['@id'];
                        } else if (r.workflow_uuids && r.workflow_uuids[0]) {
                            r.workflow_iri = '/api/3/workflows/' + r.workflow_uuids[0];
                        }
                    }
                    return r;
                });
            },
            // Read the open playbook back as authored YAML -- the READ counterpart
            // of compile_yaml, in the same dialect, so read → edit → compile →
            // update closes. Always the LIVE connector: it is a read of a real
            // record, and a mocked answer would ground the assistant in a
            // playbook that isn't the one on screen -- worse than no grounding.
            //
            // Why this exists: NOTHING in the agent's build tool slice can fetch
            // a live playbook (get_record/search_module_records are scoped out of
            // build, search_playbooks queries an offline corpus, analyze_playbook
            // takes yaml_text only). So the designer assistant was being asked to
            // edit a playbook it could not see, and every ungrounded turn
            // dead-ended asking the analyst to paste in what was already on their
            // screen (0/4 live runs). Handed the YAML it edits correctly first
            // try. The controller seeds this at designer mount.
            /** @returns {PromiseLike<{ok:boolean, yaml:string, workflow_uuid:string, name:string}>} */
            decompilePlaybook: function (cfg, workflowIri) {
                return _executeReal('decompile_playbook', { workflow_iri: workflowIri });
            },
            // Updating an EXISTING playbook is also a REAL SOAR mutation --
            // even in mock mode it routes through the live connector (Track C2).
            // compile_yaml(yaml) → workflow_json → update_playbook({workflow_json,
            // workflow_iri, session_id}). The connector PUTs to
            // /api/3/workflows/<uuid> -- the designer's own Save path, and the ONLY
            // path: an import_jobs merge_replace fallback used to sit behind it and
            // was removed (it returned ok while applying nothing, so a failed edit
            // reached the user as a success). A failure is now a real failure.
            // Before writing, the connector snapshots the playbook into its Versions
            // tab and FAILS CLOSED if it can't -- so res.version_uuid on success is
            // the user's rollback point. `workflow_iri` is the open playbook's IRI
            // (/api/3/workflows/<id>), seeded from main.playbookDetail by the
            // controller's _playbookEntityFromState onto entityContext.iri.
            // opts.stage: return the save body for the open designer to load as
            // unsaved changes instead of writing it (connector update_playbook
            // stage=true; the restore point and every guard still run).
            updatePlaybook: function (cfg, yaml, workflowIri, sessionId, opts) {
                return _executeReal('compile_yaml', { yaml: yaml }).then(function (compiled) {
                    if (!compiled || compiled.ok === false || !compiled.workflow_json) {
                        return $q.reject({ message: 'Compile failed before update: ' +
                            JSON.stringify((compiled && (compiled.errors || compiled.error)) || compiled) });
                    }
                    return _executeReal('update_playbook', {
                        workflow_json: compiled.workflow_json,
                        workflow_iri: workflowIri || null,
                        // Labels the restore point the connector snapshots into
                        // the Versions tab before it writes ("ai-pre-edit <id>"),
                        // so a rollback point is attributable to the chat that
                        // caused it. Optional: absent just yields "ai-pre-edit".
                        session_id: sessionId || null,
                        stage: !!(opts && opts.stage)
                    });
                }).then(function (r) {
                    r = r || {};
                    // Normalize: the connector echoes workflow_iri/workflow_uuid;
                    // fall back to the target we sent so the link renders even on
                    // an import_jobs fallback that returns a job record.
                    if (!r.workflow_iri) r.workflow_iri = workflowIri || null;
                    return r;
                });
            },
            respondManualInput: function (cfg, payload) {
                return executeAction(cfg, 'respond_manual_input', payload);
            },
            // Per-step Verify probe (Track C3 debug UI). Renders one step's args
            // and -- for safe ops -- executes it, returning the same per-step
            // record `step_test` emits: {ok, step_id, type, rendered_args,
            // output, output_top_keys, status, note} plus needs_confirm/risk for
            // a non-safe op the user hasn't acknowledged. Routed through the
            // connector's generic `call_mcp_tool` seam (tool="step_test"), and
            // always LIVE -- a probe against the mock track would render nothing
            // meaningful (no store, no run_op). Non-safe ops short-circuit with
            // status="needs_confirm" until the caller passes {confirm:true}.
            // `stepId` matches the step's `id:` or its `name:` (spaces collapse
            // to underscores), mirroring step_test's own id-synthesis.
            stepTest: function (cfg, yaml, stepId, opts) {
                opts = opts || {};
                var args = {
                    yaml_text: yaml,
                    step_id: stepId,
                    execute_safe_ops: opts.executeSafeOps !== false,
                    confirm: !!opts.confirm
                };
                if (opts.playbook) args.playbook = opts.playbook;
                if (opts.input) args.input = opts.input;
                return _executeReal('call_mcp_tool', { tool: 'step_test', args: args });
            },
            // ── Interactive debug session (Track C3 debug drawer) ────────────
            // A stateful walker on the connector: start returns a session_id,
            // then step/continue/stop drive it. Each returns {ok, status} where
            // status = {session_id, playbook, done, paused_at, steps_advanced,
            // trace_len, first_error, breakpoints[], last_step, trace[]}. All
            // LIVE -- the session lives in the connector's SessionStore; the mock
            // track has no walker. Routed through the same `call_mcp_tool` seam.
            startDebugSession: function (cfg, yaml, opts) {
                opts = opts || {};
                var args = {
                    yaml_text: yaml,
                    execute_safe_ops: opts.executeSafeOps !== false,
                    execute_unsafe_ops: !!opts.executeUnsafeOps,
                    max_steps: opts.maxSteps || 30
                };
                if (opts.playbook) args.playbook = opts.playbook;
                if (opts.input) args.input = opts.input;
                if (opts.breakpoints && opts.breakpoints.length) args.breakpoints = opts.breakpoints;
                return _executeReal('call_mcp_tool', { tool: 'start_debug_session', args: args });
            },
            stepDebugSession: function (cfg, sessionId, opts) {
                opts = opts || {};
                var args = { session_id: sessionId };
                if (opts.branchChoiceOverride) args.branch_choice_override = opts.branchChoiceOverride;
                return _executeReal('call_mcp_tool', { tool: 'step_debug_session', args: args });
            },
            continueDebugSession: function (cfg, sessionId, opts) {
                opts = opts || {};
                var args = { session_id: sessionId };
                if (opts.untilStepId) args.until_step_id = opts.untilStepId;
                if (opts.addBreakpoints && opts.addBreakpoints.length) args.add_breakpoints = opts.addBreakpoints;
                if (opts.maxAdvance) args.max_advance = opts.maxAdvance;
                return _executeReal('call_mcp_tool', { tool: 'continue_debug_session', args: args });
            },
            stopDebugSession: function (cfg, sessionId) {
                return _executeReal('call_mcp_tool', { tool: 'stop_debug_session', args: { session_id: sessionId } });
            },
            // ── Diagnose & fix (Track C3 value-level patches) ────────────────
            // `analyze_playbook` walks the compiled render-path and returns a
            // `diagnostics[]` list (unreachable var paths, missing keys, picklist
            // drift, empty required args, …). Each diagnostic feeds
            // `suggest_fix_for_diagnostic`, which returns a structured value-level
            // patch {ok, step_id, location, before, after, confidence, explanation,
            // kind} the widget renders as a before→after proposal. Both routed
            // through the same LIVE `call_mcp_tool` seam as step_test/debug -- the
            // mock track has no compiler/render-path to analyze.
            analyzePlaybook: function (cfg, yaml) {
                return _executeReal('call_mcp_tool', { tool: 'analyze_playbook', args: { yaml_text: yaml } });
            },
            suggestFix: function (cfg, diagnostic) {
                return _executeReal('call_mcp_tool', { tool: 'suggest_fix_for_diagnostic', args: { diagnostic: diagnostic } });
            },
            // ── Scheduled agent tasks (scheduled-agent-tasks plan) ──────────
            // Each task = one generated runner playbook + one FortiSOAR scheduler
            // row. The widget manages the prompt; the schedule is plumbing. The
            // mutating ops (create/update/delete/run-now) are ALWAYS LIVE -- they
            // are real SOAR mutations (push a playbook + write a schedule row) and
            // the mock track has no store for them. The two READ ops short-circuit
            // to empty in mock mode (no real schedule exists there), mirroring
            // listSessions -- so the panel + history drawer render a clean empty
            // state in a mock/harness e2e and the injection seams drive the rows.
            createScheduledTask: function (cfg, payload) {
                return _executeReal('create_scheduled_task', payload);
            },
            listScheduledTasks: function (cfg) {
                if (modeInfo(cfg).mode === 'mock') return $q.when({ tasks: [] });
                return _executeReal('list_scheduled_tasks', {});
            },
            updateScheduledTask: function (cfg, payload) {
                return _executeReal('update_scheduled_task', payload);
            },
            deleteScheduledTask: function (cfg, name) {
                return _executeReal('delete_scheduled_task', { name: name });
            },
            runScheduledTaskNow: function (cfg, name) {
                return _executeReal('run_scheduled_task_now', { name: name });
            },
            // Per-task run history (scheduled-agent-tasks plan §8.4): the runs
            // (one per cron fire) of one task, newest-first, each with its
            // verdict + stop_reason + a `parked` flag for HITL-gated runs the
            // analyst can resume in chat. Pure storage read -- no scheduler
            // transport -- so it resolves in dev/hermetic too.
            listScheduledTaskRuns: function (cfg, name) {
                if (modeInfo(cfg).mode === 'mock') return $q.when({ ok: true, runs: [] });
                return _executeReal('list_scheduled_task_runs', { name: name });
            }
        };
    }
})();
