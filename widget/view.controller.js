'use strict';
(function () {
    // Derive the widget version from the URL the controller script was served
    // from (e.g. ".../agenticAssistant-<version>/view.controller.js" → version).
    // Never hardcode the dotted version anywhere in this file -- the only source
    // of truth is info.json + the served path; a literal here drifts on bump and
    // the harness `stale-version-ref` lint then blocks bootstrap (see KB).
    // Works in the harness and in real SOAR -- both serve under a versioned
    // folder. Empty string when the match fails so the badge hides cleanly.
    var WIDGET_BASE = (function () {
        var scriptEl = document.currentScript || (function () {
            var scripts = document.getElementsByTagName('script');
            return scripts[scripts.length - 1];
        })();
        var src = (scriptEl && scriptEl.src) || '';
        // Strip the trailing "view.controller.js" so we're left with the
        // directory the widget is served from. Harness: "/<id>/". Real SOAR:
        // "widgets/installed/<id>/". Both work because both URLs serve the
        // widget's edit.html from the same folder.
        var withoutFile = src.replace(/view\.controller\.js(?:\?.*)?$/, '');
        // Drop the origin so ng-include uses a same-origin relative path.
        try { withoutFile = withoutFile.replace(/^https?:\/\/[^/]+/, ''); } catch (e) {}
        return withoutFile;
    })();
    var WIDGET_VERSION = (function () {
        var m = WIDGET_BASE.match(/-(\d+(?:\.\d+)+)\/?$/);
        return m ? m[1] : '';
    })();

    angular
        .module('cybersponse')
        .controller('agenticAssistant146DevCtrl', agenticAssistant146DevCtrl)
        // Grow the composer textarea to fit its content (up to the CSS
        // max-height, then scroll). Fires on the analyst typing AND on
        // programmatic fills like "Case context", which set ng-model directly
        // and would otherwise leave the field at its 1-line default height.
        .directive('fsrPbAutosize', function () {
            return {
                restrict: 'A',
                link: function (scope, element) {
                    var ta = element[0];
                    function fit() {
                        ta.style.height = 'auto';
                        // Cap matches .composer textarea max-height (160px);
                        // beyond that the textarea scrolls internally.
                        ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
                    }
                    element.on('input', fit);
                    // Catch programmatic ng-model changes (Case context fill,
                    // send-clear reset) that don't emit an 'input' event.
                    scope.$watch(function () { return ta.value; }, fit);
                    element.on('$destroy', function () { element.off('input', fit); });
                }
            };
        });

    // Contract version this widget implements (see
    // FSR_PLAYBOOK_BUILDER_CONNECTOR_CONTRACT.md §10). The connector echoes
    // its own `contract_version` in every envelope; we compare against this.
    var WIDGET_CONTRACT_VERSION = '2.8.0';

    agenticAssistant146DevCtrl.$inject = [
        '$scope', '$timeout', '$window', '$sce', '$injector', '$http', '$q', 'fsrPbAgentService',
        'fsrPbMarkdownService', 'fsrPbExportService',
        'fsrPbYamlService',
        'fsrPbHtmlService',
        'fsrPbEntityCardsService',
        'fsrPbTranscriptService',
        'fsrPbCardsService'
    ];

    function agenticAssistant146DevCtrl($scope, $timeout, $window, $sce, $injector, $http, $q, fsrPbAgentService, fsrPbMarkdownService, fsrPbExportService, fsrPbYamlService, fsrPbHtmlService, fsrPbEntityCardsService, fsrPbTranscriptService, fsrPbCardsService) {
        // Pure helpers live in the widgetAssets/js/*.service.js files; the names below are bound to them.
        var _PENDING_CARD_TYPES = fsrPbTranscriptService.PENDING_CARD_TYPES;
        function _isStaleReplay(transcript) {
            return fsrPbTranscriptService.isStaleReplay(transcript, $scope.messages);
        }
        var _findApprovalRequest = fsrPbCardsService.findApprovalRequest;
        var _collectOfferEdits = fsrPbCardsService.collectOfferEdits;
        var _collapseManualValues = fsrPbCardsService.collapseManualValues;

        var _cardHtml = fsrPbHtmlService.cardHtml;
        var _sanitizeHtml = fsrPbHtmlService.sanitizeHtml;
        function _entityHeadline(moduleLabel, name) {
            return fsrPbEntityCardsService.entityHeadline($scope.personaUi, moduleLabel, name, _overNonTriageRecord());
        }
        var _flattenEntityFields = fsrPbEntityCardsService.flattenEntityFields;
        var _recordHasFields = fsrPbEntityCardsService.recordHasFields;
        function _composeEntitySummary(e, rec) {
            return fsrPbEntityCardsService.composeEntitySummary(e, rec, $scope.personaUi, _overNonTriageRecord());
        }
        function _composeEntityCard(e, rec) {
            return fsrPbEntityCardsService.composeEntityCard(e, rec, $scope.personaUi, _overNonTriageRecord());
        }
        // A record page whose module is not a triage module (device, indicator,
        // custom module): framed as "working on", never "triaging", and given
        // the neutral record deck instead of the SOC investigation deck.
        function _overNonTriageRecord() {
            return !!($scope.entityContext && $scope.entityContext.iri) && !$scope.onTriageRecordPage();
        }
        var _buildEntityFields = fsrPbEntityCardsService.buildEntityFields;
        var _singularize = fsrPbEntityCardsService.singularize;

        // Playbook YAML helpers live in fsrPbYamlService (widgetAssets/js/fsrPbYaml.service.js).
        var _stepIdOf = fsrPbYamlService.stepIdOf;
        var _yamlVal = fsrPbYamlService.yamlVal;
        var _occurrences = fsrPbYamlService.occurrences;
        var _toPatch = fsrPbYamlService.toPatch;
        var _extractLastYamlFence = fsrPbYamlService.extractLastYamlFence;
        var _isTruncated = fsrPbYamlService.isTruncated;
        // $interval drives the live PENDING tool ticker. Resolved lazily through
        // the already-injected $injector rather than added to the controller
        // signature, so the DI arity the harness/bootstrap tests rely on is
        // unchanged.
        var $interval = $injector.get('$interval');
        // Teardown bookkeeping (see the consolidated $destroy handler): timers
        // scheduled before $destroy would otherwise fire against a torn-down
        // scope. Declared up top because the connector probe below is tracked.
        var _destroyed = false;               // controller torn down; post-$destroy callbacks must no-op
        var _pendingTimers = [];              // long-lived $timeouts to cancel on $destroy (init/retry/probe)
        function _trackTimer(promise) {       // register a timer for teardown; returns it for chaining
            _pendingTimers.push(promise);
            return promise;
        }

        // Pull the platform-injected config (FortiSOAR widget shell + harness
        // both provide this via the `config` factory). Merge it onto $scope
        // BEFORE the defaults block so saved values win over hardcoded ones.
        try {
            var _injectedConfig = $injector.get('config');
            if (_injectedConfig && typeof _injectedConfig === 'object') {
                // Injected config carries the user's saved values -- let it win
                // over whatever the parent scope may have pre-populated.
                $scope.config = angular.extend($scope.config || {}, _injectedConfig);
            }
        } catch (e) { /* config factory not available -- fall back to defaults */ }

        // ─── Theme handling ───────────────────────────────────────────────────
        // FortiSOAR exposes the active theme via $rootScope.theme (id: "light" |
        // "dark" | "steel"/"space") and the user-settings service. Both are
        // optional in the harness, so resolve them defensively via $injector and
        // mirror the value onto $scope.currentTheme; the template adds a
        // `theme-light` class on the root so the light overrides kick in. Only
        // "light" needs overrides -- "dark" and "space"/"steel" are both dark.
        $scope.currentTheme = 'dark';
        var _rootScope     = null;
        var _settingsSvc   = null;
        try { _rootScope   = $injector.get('$rootScope'); }     catch (e) { /* harness */ }
        try { _settingsSvc = $injector.get('settingsService'); } catch (e) { /* harness */ }

        function _resolveTheme() {
            if (_rootScope && _rootScope.theme && _rootScope.theme.id) return _rootScope.theme.id;
            if (_settingsSvc && typeof _settingsSvc.get === 'function') {
                try { return _settingsSvc.get('user/view/theme'); } catch (e) { /* noop */ }
            }
            return $scope.currentTheme;
        }
        $scope.currentTheme = _resolveTheme() || 'dark';
        // Themes whose --panel-default-bg is an opaque color the widget can
        // paint as its own surface. Deep Sea's is a translucent overlay.
        // "Space" is the label SOAR shows for the theme whose id is `steel`.
        var _PANEL_SURFACE_THEMES = ['steel', 'space', 'dark', 'light'];
        $scope.usesPanelSurface = function () {
            return _PANEL_SURFACE_THEMES.indexOf(String($scope.currentTheme || '').toLowerCase()) !== -1;
        };
        // React to runtime theme switches (FortiSOAR flips $rootScope.theme live).
        $scope.$watch(function () {
            return (_rootScope && _rootScope.theme && _rootScope.theme.id) || _resolveTheme();
        }, function (newVal) {
            if (newVal) $scope.currentTheme = newVal;
        });

        // ─── State ────────────────────────────────────────────────────────────
        // viewState: idle | sending | awaiting_approval | error
        $scope.viewState         = 'idle';
        $scope.messages          = [];
        $scope.currentYaml       = '';
        $scope.errorMessage      = '';
        // The in-flight decompile kicked off by the designer-mount seed, or null
        // once it has settled (success OR fail-closed). _runTurn waits on this so
        // the FIRST build turn cannot outrace the seed and ship blind -- the mount
        // race. See _seedPlaybookYaml.
        var _playbookSeedPromise = null;
        $scope.contractBanner    = '';   // persistent contract-drift warning (major mismatch)
        $scope.approvalRequest   = null;
        $scope.usage             = _emptyUsage();   // this turn's totals; see _absorbUsage

        // Template-mutated form fields must live on an object so child scopes
        // created by ng-include / ng-if write through to this reference.
        $scope.form = { inputText: '', approvalNote: '' };
        $scope.widgetVersion = WIDGET_VERSION;
        $scope.widgetEditUrl = WIDGET_BASE + 'edit.html';

        // Config defaults -- must exist before anything reads them. The widget
        // can boot with no config object at all (drawer + first ever render).
        if (!$scope.config) $scope.config = {};
        var _cfg = $scope.config;
        if (!_cfg.maxTurns)          _cfg.maxTurns          = 10;
        // Per-step Verify panel (step_test). Default OFF: an authoring aid that
        // is not on the compile/push path and that the build prompt never calls,
        // parked while the core build flow is validated. See view.html §yaml-verify.
        if (_cfg.enableStepVerify == null) _cfg.enableStepVerify = false;
        if (_cfg.showUsage == null)  _cfg.showUsage         = true;
        // mockMode 'auto' (the default) means: mock on localhost, real everywhere
        // else (fsrPbAgent _activeScenario).
        // Set 'mock' or 'real' in Settings to force one or the other.
        if (!_cfg.mockMode)          _cfg.mockMode          = 'auto';
        if (!_cfg.mockScenario)      _cfg.mockScenario      = 'playbook_soc_demo';
        if (!_cfg.mockSpeed)         _cfg.mockSpeed         = 'real';
        if (!_cfg.opener)            _cfg.opener            = 'auto';
        // Playbook build method (create strategy). 'auto' lets the connector
        // pick guided vs freeform by the model it runs; 'guided' always builds
        // from validated steps (compose); 'freeform' lets the model author the
        // playbook directly. Only acted on in Build.
        if (!_cfg.createStrategy)    _cfg.createStrategy    = 'auto';
        // When mounted in a drawer over a record, pre-render a summary as the
        // assistant's first message before any chat_turn (contract Phase B).
        if (_cfg.seedFromEntity == null) _cfg.seedFromEntity = true;
        // Strict contract checking: fail loudly on any contract drift instead
        // of soft-warning. Config-backed (durable in real SOAR); the harness
        // can also force it per-load with ?contract=strict.
        if (_cfg.contractStrict == null) _cfg.contractStrict = false;

        // Demo-mode globals are derived from edit-config values once at boot.
        // URL params still win per-load (?mock=, ?real=1, ?opener=1, ?fastmock=1).
        $window.__fsrPbSpeed  = _cfg.mockSpeed;
        $window.__fsrPbOpener = _cfg.opener;

        // ─── Entity context (drawer over an alert/incident) ──────────────────
        // SOAR passes the host record onto the widget scope when the widget is
        // mounted in a record drawer. We read it from the several keys SOAR has
        // used across versions, fall back to a harness/test override, and last
        // to a ?entity=<iri> URL param for manual testing. Null on a dashboard
        // mount -- that's the signal for `build` intent + no auto-seed.
        $scope.entityContext = _detectEntity();
        // Over a module LIST (no record open): the module we're working in.
        // Mutually exclusive with a record entityContext. See _listModuleFromState.
        $scope.listContext = null;

        // ─── Intent (drives system prompt + layout) ──────────────────────────
        // Default to TRIAGE (general Agentic assistant) on every mount -- over a
        // record OR on a dashboard. We do NOT presume the analyst wants to
        // *build a playbook*; that intent is entered only when they ask for it.
        // There is intentionally NO manual "switch to build" toggle over a
        // record: analysts must not be able to jump into playbook-authoring
        // from an alert/case investigation. The only way into build intent
        // there is the earned handoff (buildPlaybookFromTriage -- requires a
        // completed triage with real tool use).
        //
        // **The build MOUNT intent is the playbook designer, and only there**
        // (main.playbookDetail, KB §18.4). That is what lets the build persona
        // ASSUME its context -- an open playbook, a real step graph, a UUID -- so
        // its prompt can be specific instead of defensive. An analyst opening
        // the widget while looking at a playbook is authoring, not investigating.
        //
        // NOT the same as "build is unreachable elsewhere": the earned handoff
        // (openDraftInBuild / buildPlaybookFromTriage) still flips uiIntent to
        // 'build' at runtime after a real hunt. That IS the save-as-playbook
        // path -- triage converts an investigation into a playbook. What differs
        // is that the handoff arrives WITH a drafted playbook in hand, so build
        // still has something to work on.
        //
        // `config.defaultIntent='build'` was retired (see
        // docs/plans/build-persona-validation-plan.md): it was the one way to
        // reach build with NOTHING to build against -- every assumption above
        // false, and a second prompt variant to validate. A saved config still
        // carrying defaultIntent='build' now resolves to triage.
        $scope.inPlaybookEditor = _inPlaybookEditor();
        // In the designer, seed the open playbook as the entity so authoring
        // quick-actions have a playbook to read (unless a drawer entity already
        // won). See _seedPlaybookEntity.
        if ($scope.inPlaybookEditor) {
            _ensurePlaybookEntity();
        }
        // The intent a FRESH conversation starts in, from the mount alone:
        // the designer is authoring, everything else (record, persona mount,
        // dashboard) is triage. Runtime flips to `build` are always earned
        // (the triage→playbook handoff, or a rehydrated build session) and so
        // must never outlive the conversation that earned them -- every "start
        // a new/other conversation" path resets through here.
        function _defaultIntent() {
            return $scope.inPlaybookEditor ? 'build' : 'triage';
        }
        $scope.uiIntent = _defaultIntent();
        // Build-UI gate over a record. The build authoring surface (YAML pane,
        // Show YAML / Create Playbook, stray-draft handoff) is editor-only -- it
        // must NEVER passively appear on a module or record just because the
        // agent emitted YAML. The ONE exception is the deliberate triage→playbook
        // handoff ("Ready to automate this?"): the analyst explicitly asked to
        // turn the completed triage into a playbook, so build UI is unlocked for
        // that conversation. This flag latches that explicit intent; it's reset
        // on every context/session change so it can't leak to the next record.
        $scope._buildHandoffActive = false;
        // ─── Persona-aware framing ───────────────────────────────────────────
        // A module mounted over a record may declare an assistant persona in
        // the Key Store (`fsr_assistant_profile:<module>`). When one applies,
        // the SOC-triage opening (greeting, "Investigate this case" deck,
        // "Build playbook" footer, "Paste the FortiSOC summary" placeholder)
        // is the wrong voice -- e.g. a `ztpf_templates` authoring persona. We
        // resolve the persona's optional `ui` block and reframe the opener
        // from it; with a persona but no `ui`, a neutral best-effort framing
        // kicks in. Null (no persona) ⇒ everything below stays exactly as it
        // was. Kept SEPARATE from `uiIntent` on purpose: `uiIntent` flows into
        // the chat_turn `intent` field, which the connector resolves as only
        // triage|build -- a persona mount stays `triage`, and the connector
        // narrows tools by module server-side regardless.
        $scope.personaUi = null;
        var _personaModule = null;   // module personaUi was last resolved for
        // The module the drawer is working in: the open record's, else the
        // module whose LIST page we're on. Personas are module-scoped, so a
        // list page gets the same persona (and voice) as its records.
        function _contextModule() {
            var e = $scope.entityContext;
            if (e && e.module) return e.module;
            return ($scope.listContext && $scope.listContext.module) || null;
        }
        function _resolvePersonaUi() {
            if ($scope.inPlaybookEditor) { _personaModule = null; $scope.personaUi = null; return $q.when(null); } // designer owns build framing
            var module = _contextModule();
            if (!module) { _personaModule = null; $scope.personaUi = null; return $q.when(null); }
            // Defensive: an older/mocked agent service without the persona API
            // simply means "no persona" -- the widget stays in triage framing.
            if (typeof fsrPbAgentService.resolvePersona !== 'function') {
                _personaModule = module; $scope.personaUi = null; return $q.when(null);
            }
            _personaModule = module;
            return fsrPbAgentService.resolvePersona($scope.config, module).then(function (p) {
                // Only adopt if we're still on the module we asked about (a fast
                // record switch could land a stale response otherwise).
                if (_personaModule === module) $scope.personaUi = p || null;
                return p || null;
            }, function () { if (_personaModule === module) $scope.personaUi = null; return null; });
        }
        // Persona is module-scoped: when the mounted module changes (record
        // navigation), re-resolve BEFORE seeding so the new record's summary
        // card renders in the right voice; otherwise seed directly (cheap,
        // idempotent). Used by every reseed trigger outside the init chain.
        function _reseedForCurrentEntity() {
            var e = $scope.entityContext;
            var module = e && e.module;
            if (module && module !== _personaModule) {
                _resolvePersonaUi().finally(function () { _seedFromEntity(); });
            } else {
                _seedFromEntity();
            }
        }

        // Build-mode orientation hint: shown once the analyst is in build mode
        // with no YAML yet, so "I switched and don't know what to do" has an
        // answer. Suppressed as soon as a playbook exists or a turn is running.
        $scope.showBuildHint = function () {
            return $scope.uiIntent === 'build'
                && $scope.viewState === 'idle'
                && !$scope.currentYaml;
        };
        // Build-mode hint copy, persona-aware: persona override (ui.buildHint) →
        // neutral persona line → SOC "paste a FortiSOC summary" default. Keeps a
        // persona in build mode from advertising SOC-summary framing.
        $scope.buildHintSub = function () {
            var p = $scope.personaUi;
            if (p && p.buildHint) return p.buildHint;
            if (p) return "Describe what you want to build and I'll generate the YAML.";
            return "Describe the playbook you want, or paste a FortiSOC summary, and I'll generate the YAML.";
        };

        // ─── Quick-action context chips (FortiSOC-chat style) ────────────────
        // One-click investigation prompts, shown over a record in triage mode.
        // Each chip just supplies the user text; the connector already receives
        // the `entity` block on every chat_turn (contract §2) and does the
        // analysis -- a pure connector round-trip, no client-side composition.
        $scope.quickActions = [
            { key: 'timeline', label: 'Attack Timeline', sub: 'Order the key events and how the activity progressed',
              prompt: 'Build an attack timeline for this case -- order the key events and explain how the activity progressed.' },
            { key: 'blast', label: 'Blast Radius', sub: 'Assets and users at risk',
              prompt: 'Assess the blast radius for this case -- which assets, users, and systems are affected or at risk.' },
            { key: 'iocs', label: 'Threat Indicators', sub: 'IOCs to block now',
              prompt: 'Extract the threat indicators (IPs, domains, hashes, URLs) from this case that we should block now.' },
            { key: 'mitre', label: 'MITRE ATT&CK', sub: 'Tactics, techniques, and detection gaps',
              prompt: 'Map this case to MITRE ATT&CK -- the likely tactics, techniques, and any detection gaps.' },
            { key: 'similar', label: 'Similar Cases', sub: 'Is this part of a campaign?',
              prompt: 'Find similar or related cases and tell me whether this is part of a larger campaign.' },
            { key: 'next', label: 'Next Actions', sub: 'Prioritized response steps',
              prompt: 'Recommend prioritized next actions for this case based on its severity and current phase.' },
            // author_persona: teach the assistant a standing way to handle this
            // kind of record. A dedicated, deterministic turn (connector
            // short-circuit) drafts the persona and offers to remember it; the
            // prompt rides as the drafting goal.
            { key: 'author_persona', label: 'Teach How to Handle These', sub: 'Remember how to handle this kind of record',
              prompt: 'Build a standing assistant for this kind of record: how to investigate it well and what to check every time.' }
        ];

        // Show the chips only over a record, in triage mode, while idle, and
        // before the first user turn -- they collapse once the conversation
        // starts (mirrors FortiSOC chat's opening card grid).
        $scope.showQuickActions = function () {
            // The SOC investigation deck belongs ONLY over a triage record
            // (alert/incident). Route through the single surface predicate the
            // "Ready to automate" handoff already uses, so this deck can't leak
            // onto the wrong surfaces: onTriageRecordPage() excludes the playbook
            // editor (where the designer deck owns the UI -- the double-stack
            // bug) AND non-triage records (devices, templates, custom modules,
            // where "Build an attack timeline" is nonsense). Before this, the
            // deck only checked entity.iri + uiIntent==='triage', so it rendered
            // in the editor and over any record with an IRI.
            if (!$scope.onTriageRecordPage()) return false;
            var e = $scope.entityContext;
            if (!e || !e.iri) return false;
            if ($scope.uiIntent !== 'triage') return false;
            // A persona mount owns its own deck (personaQuickActions) -- never
            // show the SOC investigation deck over an authoring persona.
            if ($scope.personaUi) return false;
            if ($scope.viewState !== 'idle' || $scope.connectorReady === false) return false;
            for (var i = 0; i < $scope.messages.length; i++) {
                if ($scope.messages[i].role === 'user') return false;
            }
            return true;
        };

        // Persona-declared quick actions (persona.ui.quickActions), rendered in
        // place of the SOC deck when a persona with its own actions is active.
        // Same {key,label,sub,prompt} shape → reuses runQuickAction unchanged.
        $scope.personaQuickActions = function () {
            return ($scope.personaUi && $scope.personaUi.quickActions) || [];
        };
        $scope.showPersonaQuickActions = function () {
            // The designer deck owns the editor; a persona deck never shows there.
            // personaUi is already nulled on an editor mount, but guard explicitly
            // so this doesn't depend on that happening first (defense in depth,
            // and the same surface rule every other deck now follows).
            if ($scope.inPlaybookEditor) return false;
            var e = $scope.entityContext;
            if (!e || !e.iri) return false;
            if (!$scope.personaUi) return false;
            var acts = $scope.personaUi.quickActions;
            if (!(acts && acts.length)) return false;
            if ($scope.viewState !== 'idle' || $scope.connectorReady === false) return false;
            for (var i = 0; i < $scope.messages.length; i++) {
                if ($scope.messages[i].role === 'user') return false;
            }
            return true;
        };
        // ─── Record deck (non-triage records) ─────────────────────────────
        // A device, indicator or custom-module record with no persona deck used
        // to open with nothing to click: the SOC deck is triage-only. This is
        // the neutral starting set, named for the record's own module. Cached
        // per noun: ng-repeat over a fresh array each digest never settles.
        var _recordDeckCache = { key: null, deck: null };
        function _recordNoun() {
            var p = $scope.personaUi;
            if (p && p.recordNoun) return String(p.recordNoun);
            var e = $scope.entityContext;
            return (e && _moduleDisplayName(e.module, false)) || 'record';
        }
        $scope.recordQuickActions = function () {
            var noun = _recordNoun();
            if (_recordDeckCache.key === noun) return _recordDeckCache.deck;
            var lower = noun.toLowerCase();
            _recordDeckCache = { key: noun, deck: [
                { key: 'record_summary', label: 'Summarize this ' + lower, sub: 'What it is and what stands out',
                  prompt: 'Summarize this ' + lower + ': what it is, its current state, and anything that stands out.' },
                { key: 'record_related', label: 'What is related', sub: 'Linked records and recent activity',
                  prompt: 'Find the records linked to this ' + lower + ' and tell me what changed recently.' },
                { key: 'record_next', label: 'What to do next', sub: 'The most useful next step, and why',
                  prompt: 'Based on this ' + lower + ', what should I do next, and why?' }
            ] };
            return _recordDeckCache.deck;
        };
        $scope.showRecordQuickActions = function () {
            if ($scope.inPlaybookEditor) return false;
            var e = $scope.entityContext;
            if (!e || !e.iri) return false;
            if ($scope.onTriageRecordPage()) return false;
            if ($scope.showPersonaQuickActions()) return false;
            if ($scope.viewState !== 'idle' || $scope.connectorReady === false) return false;
            for (var i = 0; i < $scope.messages.length; i++) {
                if ($scope.messages[i].role === 'user') return false;
            }
            return true;
        };
        $scope.recordDeckLabel = function () {
            return 'Start with this ' + _recordNoun().toLowerCase();
        };
        // ─── List-page deck ───────────────────────────────────────────────
        // Over a module LIST the record decks don't apply ("Summarize this
        // profile" with no profile open). A persona can declare its own
        // `ui.listQuickActions` ({key,label,sub,prompt}); otherwise a neutral
        // module-level deck. Same runQuickAction plumbing.
        // Module display name from the platform's metadata cache
        // (modelMetadatasService.getModuleNameByType: synchronous, returns
        // [{name, type}]) -- "Automation Profiles", not "ztpf_automation_profiles".
        // Falls back to the type with spaces when the service is absent (harness).
        function _moduleDisplayName(module, plural) {
            if (!module) return '';
            try {
                var svc = $injector.get('modelMetadatasService');
                var hit = svc.getModuleNameByType([module], !!plural);
                if (hit && hit[0] && hit[0].name) return String(hit[0].name);
            } catch (e) { /* no metadata service: fall through */ }
            var raw = String(module).replace(/_/g, ' ');
            return plural ? raw : _singularize(raw);
        }
        function _listNoun() {
            var p = $scope.personaUi;
            if (p && p.listNoun) return String(p.listNoun);
            return _moduleDisplayName($scope.listContext && $scope.listContext.module, true);
        }
        function _listNounOne() {
            var p = $scope.personaUi;
            if (p && p.recordNoun) return String(p.recordNoun);
            return _moduleDisplayName($scope.listContext && $scope.listContext.module, false) || 'record';
        }
        // Cached per (module, persona): ng-repeat over a fresh array each digest
        // never settles ($digest infdig), so the default deck is built once.
        var _listDeckCache = { key: null, deck: null };
        $scope.listQuickActions = function () {
            var p = $scope.personaUi;
            if (p && p.listQuickActions && p.listQuickActions.length) return p.listQuickActions;
            var many = _listNoun() || 'records', one = _listNounOne();
            var key = many + '|' + one;
            if (_listDeckCache.key === key) return _listDeckCache.deck;
            _listDeckCache = { key: key, deck: [
                { key: 'list_attention', label: 'What needs attention', sub: 'The ' + many + ' to look at first, and why',
                  prompt: 'Look through the ' + many + ' here and tell me which need attention first, and why.' },
                { key: 'list_summary', label: 'Summarize ' + many, sub: 'Counts, recent changes, and the newest',
                  prompt: 'Summarize the ' + many + ' in this module: how many there are, what changed recently, and the newest ones.' },
                { key: 'list_find', label: 'Find one', sub: 'Describe the ' + one + ' and I will search for it',
                  prompt: 'Help me find a specific ' + one + '. Ask me what I am looking for, then search for it.' },
                { key: 'list_create', label: 'Create new ' + one, sub: 'Tell me what it should contain',
                  prompt: 'I want to create a new ' + one + '. Ask me what it should contain, then create it.' }
            ] };
            return _listDeckCache.deck;
        };
        $scope.showListQuickActions = function () {
            if ($scope.inPlaybookEditor) return false;
            if ($scope.entityContext && $scope.entityContext.iri) return false;
            if (!($scope.listContext && $scope.listContext.module)) return false;
            if ($scope.viewState !== 'idle' || $scope.connectorReady === false) return false;
            for (var i = 0; i < $scope.messages.length; i++) {
                if ($scope.messages[i].role === 'user') return false;
            }
            return true;
        };
        $scope.listDeckLabel = function () {
            var p = $scope.personaUi;
            return (p && p.listLabel) || ('Work in ' + (_listNoun() || 'this module'));
        };

        // Deck heading for the persona actions (persona.ui.label), with a
        // neutral default so a label-less persona still reads sensibly.
        $scope.personaDeckLabel = function () {
            return ($scope.personaUi && $scope.personaUi.label) || 'Quick actions';
        };
        // Composer placeholder: persona override → its text; persona without an
        // override → a neutral prompt; no persona → the original SOC line.
        $scope.composerPlaceholder = function () {
            if ($scope.connectorReady === false) return 'Configure a connector to start chatting…';
            var p = $scope.personaUi;
            if (p && p.placeholder) return p.placeholder;
            if (p) return 'Describe what you want to do…';
            // In the designer the analyst is editing a playbook, not pasting
            // a triage summary.
            if ($scope.inPlaybookEditor) {
                return $scope.hasOpenPlaybook()
                    ? 'Describe a change to this playbook…'
                    : 'Describe the playbook you want…';
            }
            return 'Paste the FortiSOC AI summary here, or describe what you want to do…';
        };

        // The "pull page details" composer button. In triage it pulls the case
        // on screen; under a persona it pulls whatever record we're mounted on,
        // so the hard-coded "Case context" wording is wrong there. Let a persona
        // ui block override the label/hint; otherwise fall back to neutral
        // "Record context" (persona) or "Case context" (triage).
        $scope.pageDetailsLabel = function () {
            if ($scope.inPlaybookEditor) return '⊕ Playbook context';
            var p = $scope.personaUi;
            if (p) return '⊕ ' + (p.pullLabel || 'Record context');
            return '⊕ Case context';
        };
        $scope.pageDetailsTitle = function () {
            if ($scope.inPlaybookEditor) return "Pull in this playbook's steps";
            var p = $scope.personaUi;
            if (p) return p.pullHint || 'Pull in details from this record';
            return "Pull in details from the case I'm looking at";
        };

        // One-click authoring prompts, shown only when mounted inside the
        // playbook designer (inPlaybookEditor) -- the build-mode counterpart
        // of quickActions above. Same runQuickAction plumbing.
        //
        // `create` comes first: it builds the steps INTO the open playbook
        // (usually the empty one just made) -- Apply writes them in place, no
        // separate playbook to go and open. The agent asks what it should do
        // before building anything.
        $scope.playbookQuickActions = [
            { key: 'create', label: 'Create a playbook', sub: 'Tell me what it should do; I’ll build the steps here',
              prompt: 'I want to create a new playbook.' },
            { key: 'explain', label: 'Explain this playbook', sub: 'Walk through what it does, step by step',
              prompt: 'Explain what this playbook does, step by step, in plain language.' },
            { key: 'add_step', label: 'Add a step', sub: 'Describe the step and I’ll author it',
              prompt: 'I want to add a step to this playbook. Ask me what it should do, then author it.' },
            { key: 'find_issues', label: 'Find issues', sub: 'Broken references, missing error handling, dead ends',
              prompt: 'Review this playbook for issues -- broken step references, missing error handling, and dead-end branches.' },
            { key: 'add_error_handling', label: 'Add error handling', sub: 'Wrap risky steps with on-failure branches',
              prompt: 'Identify steps in this playbook that could fail and propose error-handling branches for them.' },
            { key: 'optimize', label: 'Optimize', sub: 'Simplify, parallelize, or remove redundant steps',
              prompt: 'Look for ways to simplify this playbook -- redundant steps, opportunities to parallelize, unnecessary complexity.' }
        ];

        // Mirrors showQuickActions but for the playbook-editor mount: only
        // while idle, before the first user turn, and only inside the real
        // designer (inPlaybookEditor) -- never over an alert/case record.
        $scope.showPlaybookQuickActions = function () {
            if (!$scope.inPlaybookEditor) return false;
            if ($scope.viewState !== 'idle' || $scope.connectorReady === false) return false;
            for (var i = 0; i < $scope.messages.length; i++) {
                if ($scope.messages[i].role === 'user') return false;
            }
            return true;
        };

        $scope.runQuickAction = function (action) {
            if (!action || $scope.viewState !== 'idle' || $scope.connectorReady === false) return;
            _appendUserMessage(action.prompt);
            _logEvent('quick_action', { key: action.key });
            // Track C1: tag the chip's key onto the turn so the build prompt
            // can branch on it (Explain / Add a step / Find issues / Add error
            // handling / Optimize each route to a distinct toolset). Triage
            // chips carry their key too -- the connector ignores it for triage
            // but the turn tags record which chip fired (observability).
            _runTurn({ user: action.prompt, quickAction: action.key });
        };

        // ─── Save summary to comments ────────────────────────────────────────
        // Over a record whose module takes comments, the analyst can file the
        // conversation's outcome as a comment on that record. The text is built
        // from the cards already on screen (fsrPbCardsService.buildCommentSummary:
        // no model call), shown for editing, and only then POSTed to
        // /api/3/comments linked to the record.
        //
        // "Module takes comments" is read off the record when it already carries
        // its comments relationship, else (live only) from the module's metadata,
        // once per module. Fails closed: unknown means no button.
        var _commentsCap = {};   // module -> true | false | 'pending'
        function _hasOwn(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
        function _probeCommentsCapability(module) {
            _commentsCap[module] = 'pending';
            $http.get('/api/3/model_metadatas', { params: { type: module, '$relationships': true } }).then(function (resp) {
                _commentsCap[module] = fsrPbCardsService.moduleSupportsComments(resp && resp.data, module);
            }, function () { _commentsCap[module] = false; });
        }
        $scope.commentsSupported = function () {
            var e = $scope.entityContext;
            if (!e || !e.iri || !e.module || $scope.inPlaybookEditor) return false;
            if (_hasOwn(e.record, 'comments')) return true;
            var c = _commentsCap[e.module];
            if (c === true) return true;
            if (c === undefined && fsrPbAgentService.modeInfo($scope.config).mode === 'live') {
                _probeCommentsCapability(e.module);
            }
            return false;
        };

        $scope.commentSummary = { open: false, text: '', saving: false, saved: false, error: '' };

        function _hasUserTurn() {
            for (var i = 0; i < $scope.messages.length; i++) {
                if ($scope.messages[i].role === 'user') return true;
            }
            return false;
        }
        $scope.showCommentSummary = function () {
            if (!_hasUserTurn() || $scope.connectorReady === false) return false;
            return $scope.commentsSupported();
        };
        // False (button disabled) while there is no verdict, action or playbook
        // to report on.
        $scope.canSaveCommentSummary = function () {
            if ($scope.viewState === 'sending') return false;
            return !fsrPbCardsService.buildCommentSummary($scope.messages).empty;
        };
        $scope.openCommentSummary = function () {
            var s = fsrPbCardsService.buildCommentSummary($scope.messages, { now: Date.now() });
            if (s.empty) return;
            $scope.commentSummary = { open: true, text: s.text, saving: false, saved: false, error: '' };
        };
        $scope.closeCommentSummary = function () {
            $scope.commentSummary = { open: false, text: '', saving: false, saved: false, error: '' };
        };
        $scope.saveCommentSummary = function () {
            var cs = $scope.commentSummary, e = $scope.entityContext;
            if (!cs.open || cs.saving || !e || !e.iri || !e.module) return;
            if (!String(cs.text || '').trim()) { cs.error = 'Write something to save.'; return; }
            cs.saving = true; cs.error = '';
            _logEvent('comment_summary_save', { module: e.module });
            $http.post('/api/3/comments', fsrPbCardsService.commentPayload(cs.text, e.iri, e.module)).then(function () {
                $scope.commentSummary = { open: false, text: '', saving: false, saved: true, error: '' };
            }, function (err) {
                cs.saving = false;
                cs.error = 'Could not save the comment. ' + _sanitizeError(err);
            });
        };
        // The record page does not repaint its comments by itself.
        $scope.refreshRecordPage = function () {
            try { $injector.get('$state').reload(); } catch (err) { $window.location.reload(); }
        };

        // ─── "Pull in page details" (explicit context fill) ──────────────────
        // Grabs the current record's fields on demand and drops a rendered
        // summary into the composer, so the analyst can add a question before
        // sending. Available whenever the widget is mounted over a record --
        // useful in build mode, when auto-seed is off, or to re-pull context.
        // Visibility only depends on being over a record; the button stays
        // rendered while a turn is in flight (the template disables it via
        // ng-disabled) so it doesn't flicker in and out.
        $scope.canPullPageDetails = function () {
            var e = $scope.entityContext;
            return !!(e && e.iri);
        };

        // ─── Triage → playbook handoff ───────────────────────────────────────
        // Turn the triage conversation -- the agent's analysis AND the tools it
        // actually called -- into the design brief for a re-runnable playbook.
        // The full transcript already rides every chat_turn (messages[]); we
        // flip intent to `build` and add an explicit directive naming the
        // operations used so the connector designs the playbook around them.
        // Still a pure connector round-trip -- no client-side YAML synthesis.
        $scope.toolsUsedInTriage = function () {
            var seen = {}, out = [];
            $scope.messages.forEach(function (m) {
                (m.events || []).forEach(function (ev) {
                    if (ev.type === 'tool_call' && ev.name && !seen[ev.name]) {
                        seen[ev.name] = true; out.push(ev.name);
                    }
                });
            });
            return out;
        };

        // Total number of tool calls the agent has made this conversation --
        // every committed message plus the in-flight streaming preview. Shown
        // in the topbar usage meter so the analyst can see how much work the
        // agent did, not just the token/cost totals.
        $scope.toolsUsedCount = function () {
            var n = 0;
            var tally = function (m) {
                (m && m.events || []).forEach(function (ev) {
                    if (ev.type === 'tool_call') n++;
                });
            };
            $scope.messages.forEach(tally);
            tally($scope.streamingMessage);
            return n;
        };

        $scope.hasPendingInteractiveCard = function () {
            for (var i = 0; i < $scope.messages.length; i++) {
                var evs = $scope.messages[i].events || [];
                for (var j = 0; j < evs.length; j++) {
                    var ev = evs[j];
                    if (ev && _PENDING_CARD_TYPES[ev.type] && !ev._resolved) return true;
                }
            }
            return false;
        };

        // True when the mounted page is a SOC record the handoff belongs on.
        // `uiIntent` defaults to 'triage' on EVERY non-editor mount, so intent
        // alone never distinguished "triaging an alert" from "looking at a device
        // record" -- the CTA appeared on any module as soon as the agent ran one
        // tool. In the playbook editor there is no mounted record and the
        // designer owns build framing, so the handoff is moot there.
        $scope.onTriageRecordPage = function () {
            if ($scope.inPlaybookEditor) return false;
            var e = $scope.entityContext;
            // Defensive, mirroring _resolvePersonaUi: a mocked/older agent
            // service without the predicate keeps the previous behavior rather
            // than silently hiding the handoff everywhere. The real service
            // always ships in the same package as this controller (asserted by
            // a unit test), so this branch is test-stub territory only.
            if (typeof fsrPbAgentService.isTriageModule !== 'function') return true;
            return fsrPbAgentService.isTriageModule(e && e.module);
        };

        $scope.canBuildFromTriage = function () {
            // An authoring/custom persona isn't building a SOC playbook -- the
            // "Ready to automate this?" handoff is triage-only framing.
            if ($scope.personaUi) return false;
            // …and neither is a device / template / custom-module record, even
            // with no persona defined for it.
            if (!$scope.onTriageRecordPage()) return false;
            if ($scope.uiIntent !== 'triage' || $scope.viewState !== 'idle') return false;
            if ($scope.connectorReady === false) return false;
            // Don't surface the "Ready to automate" handoff while the chat is
            // still waiting on the analyst to act on a card -- only once the
            // conversation has truly come to rest.
            if ($scope.hasPendingInteractiveCard()) return false;
            // Only offer the playbook handoff once a real triage has actually
            // been performed AND come to rest. The agent must have run at least
            // one investigation operation -- that's the signal an investigation
            // worth automating took place. A bare user message with no
            // investigation (e.g. a blind/empty turn, or a question the agent
            // declined) is NOT a completed triage and must not surface the
            // "Ready to automate" CTA (regression: export sess-yq8nhcix showed
            // the CTA after a single message that never reached the agent's
            // tools). `viewState === 'idle'` + no pending card already guarantee
            // the conversation has come cleanly to rest (errors set 'error',
            // approvals set 'awaiting_approval').
            return $scope.toolsUsedInTriage().length > 0;
        };

        $scope.buildPlaybookFromTriage = function () {
            if (!$scope.canBuildFromTriage()) return;
            var tools = $scope.toolsUsedInTriage();
            var lines = ['Design a re-runnable FortiSOAR playbook that automates the investigation and response we just worked through above.'];
            if (tools.length) {
                lines.push('');
                lines.push('Operations used during triage (build the playbook around these): ' + tools.join(', ') + '.');
            }
            lines.push('');
            lines.push('Produce the playbook YAML and parameterize it so it can re-run on similar cases.');
            var directive = lines.join('\n');
            $scope.uiIntent = 'build';   // _runTurn reads uiIntent for the `intent` field
            $scope._buildHandoffActive = true;   // explicit handoff → unlock the build pane over this record
            _appendUserMessage(directive);
            _logEvent('build_from_triage', { tools: tools });
            _runTurn({ user: directive });
        };

        // ─── Triage draft handoff (A3) ───────────────────────────────────────
        // The agent can author a ```yaml fence even in a triage session (e.g.
        // a "build an attack timeline" ask the model interpreted as authoring).
        // The YAML pane is build-only (view.html gates it on uiIntent !==
        // 'triage'), so that draft would otherwise render nowhere and be
        // silently lost. Rather than expose Create directly in triage, surface
        // a CTA: the draft exists, switch to Build mode to review and create it.
        // Distinct from canBuildFromTriage (which starts a *new* build turn) --
        // this just reveals YAML that already exists.
        // A triage session that has authored YAML and come to rest -- the raw
        // condition, independent of where the widget is mounted.
        function _triageDraftReady() {
            return $scope.uiIntent === 'triage'
                && $scope.viewState === 'idle'
                && !!$scope.currentYaml;
        }

        // Editor-only CTA. Over a module/record we no longer PASSIVELY surface a
        // "switch to Build to see the draft" prompt for an incidental ```yaml the
        // agent emitted during triage -- build UI must not appear on a record on
        // its own. On a record, the only way into build is the explicit
        // triage→playbook handoff (the "Ready to automate this?" CTA). This CTA
        // remains for the designer, where triage framing can still occur.
        $scope.hasTriageDraft = function () {
            return $scope.inPlaybookEditor && _triageDraftReady();
        };

        // Explicit analyst action: reveal the existing draft in build. Unlike the
        // CTA above it isn't editor-gated -- invoking it IS the deliberate handoff
        // (from the designer CTA, or the triage→playbook save flow), so it latches
        // _buildHandoffActive to unlock the build pane over a record.
        $scope.openDraftInBuild = function () {
            if (!_triageDraftReady()) return;
            _logEvent('triage_draft_to_build', { yamlLength: $scope.currentYaml.length });
            $scope.uiIntent = 'build';           // reveals the yaml-pane (gated on !== 'triage')
            $scope._buildHandoffActive = true;   // explicit handoff → unlock build UI over this record
        };

        $scope.pullInPageDetails = function () {
            if (!$scope.canPullPageDetails() || $scope.viewState === 'sending') return;
            _resolveEntityRecord().then(function (rec) {
                if (!rec) return;
                var e = $scope.entityContext;
                e.record = rec;
                var summary = _composeEntitySummary(e, rec);
                // Preserve whatever the analyst already typed verbatim; just
                // separate it from the pulled summary with a blank line.
                var existing = $scope.form.inputText || '';
                var sep = !existing.trim() ? '' : (/\n\s*$/.test(existing) ? '' : '\n\n');
                $scope.form.inputText = existing + sep + summary;
                _logEvent('pull_in_page_details', { iri: e.iri });
                $timeout(function () {
                    var ta = document.querySelector('.fsr-pb-widget .composer textarea');
                    if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
                }, 0);
            });
        };

        // ─── Initiator (current SOAR user) ───────────────────────────────────
        // usersService exists in real SOAR; in the harness it usually doesn't.
        // Fall back to a "Harness" placeholder so the badge still renders.
        $scope.initiator = { name: '', iri: '', avatar: '' };
        try {
            var _usersService = $injector.get('usersService');
            var _cu = _usersService && _usersService.getCurrentUser && _usersService.getCurrentUser();
            if (_cu && (_cu.firstname || _cu.lastname || _cu.userid || _cu.email)) {
                $scope.initiator.name = (
                    ((_cu.firstname || '') + ' ' + (_cu.lastname || '')).trim()
                    || _cu.userid || _cu.email || 'Unknown user'
                );
                $scope.initiator.iri = _cu['@id'] || _cu.iri || '';
                try {
                    $scope.initiator.avatar = (_usersService.getCurrentAvatar && _usersService.getCurrentAvatar()) || '';
                } catch (e) { /* avatar optional */ }
            } else if (_usersService && _usersService.loadCurrentUser) {
                _usersService.loadCurrentUser().then(function (u) {
                    if (!u) return;
                    $scope.initiator.name = (
                        ((u.firstname || '') + ' ' + (u.lastname || '')).trim()
                        || u.userid || u.email || 'Unknown user'
                    );
                    $scope.initiator.iri = u['@id'] || u.iri || '';
                });
            }
        } catch (e) { /* harness: no usersService */ }
        if (!$scope.initiator.name) $scope.initiator.name = 'Harness user';

        // The REAL owner of the currently-open session (from chat_history.initiator).
        // Null for a fresh conversation you started; set when reopening a stored
        // session so the UI can show who started it (not the current viewer).
        $scope.sessionInitiator = null;
        // Owner label to show ONLY when the open session was started by someone
        // other than the current viewer (else it's just "you" -- no need to badge).
        $scope.chatOwnerLabel = function () {
            var si = $scope.sessionInitiator;
            if (!si || !si.name) return '';
            if (si.name === $scope.initiator.name) return '';
            return si.name;
        };

        // Short, locale-aware time for the chat message badge.
        $scope.formatTs = function (ts) {
            if (!ts) return '';
            try {
                var d = new Date(ts);
                return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            } catch (e) { return ''; }
        };

        // Human-friendly date for a history row. `ts` is epoch SECONDS
        // (sqlite time.time()); show the calendar date, plus a relative hint
        // ("Today"/"Yesterday") for recent conversations so the analyst can
        // scan the list without parsing dates.
        $scope.formatSessionDate = function (ts) {
            if (!ts) return '';
            try {
                var d = new Date(ts * 1000);
                if (isNaN(d.getTime())) return '';
                var now = new Date();
                var startOfDay = function (x) {
                    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
                };
                var dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
                var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                if (dayDiff === 0) return 'Today ' + time;
                if (dayDiff === 1) return 'Yesterday ' + time;
                var opts = { month: 'short', day: 'numeric' };
                if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
                return d.toLocaleDateString([], opts) + ' ' + time;
            } catch (e) { return ''; }
        };



        // ─── Settings (in-widget gear → inline modal) ────────────────────────
        // Drawer contexts (alert/incident side panels) and the harness both
        // hide the dashboard's edit chrome, and the harness's $uibModal is a
        // no-op stub. So we render the edit form in a self-contained overlay
        // that works in any context.
        $scope.settingsOpen = false;
        $scope.openSettings = function () {
            // The connector identity is fixed and resolved via resolveConnector
            // (it is not a user-picked setting), so there is no connector list
            // to load here -- opening the overlay is all this needs to do.
            $scope.settingsOpen = true;
        };
        $scope.closeSettings = function () {
            $scope.settingsOpen = false;
            $window.__fsrPbSpeed  = $scope.config.mockSpeed || 'real';
            $window.__fsrPbOpener = $scope.config.opener    || 'auto';
        };

        // ── Overflow menu ────────────────────────────────────────────────
        // The low-frequency top-bar actions (History, Export, Tools, Settings)
        // live behind a single overflow button to keep the header uncluttered.
        // Each item just closes the menu then opens its existing overlay.
        $scope.menuOpen = false;
        $scope.toggleMenu = function () { $scope.menuOpen = !$scope.menuOpen; };
        $scope.closeMenu  = function () { $scope.menuOpen = false; };

        // The menu's panels share one tab strip, so moving between them is one
        // click instead of close -> menu -> pick. Each panel keeps its own
        // open/close pair (and its own load on open); a tab closes whichever is
        // showing and opens the next.
        $scope.panelTabs = [
            { key: 'history',   label: 'History',   icon: 'ic-history' },
            { key: 'scheduled', label: 'Scheduled', icon: 'ic-calendar' },
            { key: 'tools',     label: 'Tools',     icon: 'ic-tools' },
            { key: 'export',    label: 'Export',    icon: 'ic-download' },
            { key: 'settings',  label: 'Settings',  icon: 'ic-settings' }
        ];
        $scope.activePanel = function () {
            if ($scope.historyOpen)   return 'history';
            if ($scope.scheduledOpen) return 'scheduled';
            if ($scope.toolsOpen)     return 'tools';
            if ($scope.exportOpen)    return 'export';
            if ($scope.settingsOpen)  return 'settings';
            return null;
        };
        $scope.switchPanel = function (key) {
            if (key === $scope.activePanel()) return;
            $scope.historyOpen = false;
            $scope.scheduledOpen = false;
            $scope.toolsOpen = false;
            $scope.exportOpen = false;
            if ($scope.settingsOpen) $scope.closeSettings();
            ({
                history: $scope.openHistory,
                scheduled: $scope.openScheduledTasks,
                tools: $scope.openTools,
                export: $scope.openExport,
                settings: $scope.openSettings
            }[key] || angular.noop)();
        };

        // Status pill wording. viewState stays the machine value (tests and the
        // a11y announcer read it); this is only what the analyst sees.
        var _STATE_LABELS = {
            idle: 'Ready', sending: 'Working', awaiting_approval: 'Needs approval', error: 'Error'
        };
        $scope.stateLabel = function () {
            var s = String($scope.viewState || '');
            return _STATE_LABELS[s] || (s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' '));
        };

        // ── Tools panel ──────────────────────────────────────────────────
        // Read-only "what can the agent do on this module?" list. Always triage
        // intent; the connector applies the module's persona slice when one
        // exists. Mirrors the openHistory() async convention.
        $scope.toolsOpen = false;
        $scope.toolsLoading = false;
        $scope.toolsError = '';
        $scope.tools = [];
        $scope.toolsModule = '';
        $scope.toolsPersonaApplied = false;
        $scope.toolIsWrite = function (t) { return !!t && t.tier >= 3; };
        // Approval-tier vocabulary, mirrored from the connector's
        // `_tier_for_run_op` / `list_agent_tools` docstring (tiers 0-4, or -1
        // "dynamic"). `run_op` is the canonical dynamic tool: its effective tier
        // is resolved per (connector, op) at call time, so the registry tags it
        // -1. Keep these labels in sync with that server-side ladder.
        $scope.TIER_META = {
            '-1': { label: 'dyn', name: 'Dynamic',
                    desc: 'Tier resolved at call time from the actual (connector, op) -- e.g. run_op. A read bounces auto; a mutation/containment op prompts.' },
            '0': { label: 't0', name: 'Local',
                   desc: 'Pure local shaping (authoring / card emit). No box side effect. Auto-runs.' },
            '1': { label: 't1', name: 'FSR read',
                   desc: 'Read-only FortiSOAR / safely-classified op. Auto-runs.' },
            '2': { label: 't2', name: 'External read',
                   desc: 'Read-only third-party query (enrichment / hunt). Auto-runs + logged.' },
            '3': { label: 't3', name: 'FSR write',
                   desc: 'Mutates FortiSOAR data (create/update record, playbook write). Approval-gated.' },
            '4': { label: 't4', name: 'Remediation',
                   desc: 'Third-party side effect (containment / remediation). Approval-gated.' }
        };
        $scope.tierMeta = function (t) {
            var k = (t && t.tier != null) ? String(t.tier) : '';
            return $scope.TIER_META[k] || { label: 't?', name: 'Unclassified',
                desc: 'No tier reported; unknown ops escalate to approval by default.' };
        };
        $scope.tierLabel = function (t) { return $scope.tierMeta(t).label; };
        $scope.tierTitle = function (t) {
            var m = $scope.tierMeta(t);
            return m.name + ' -- ' + m.desc;
        };
        // Ordered legend rows for the panel key (dynamic first, then 0→4).
        // Precomputed ONCE (stable object identities) -- an ng-repeat over a
        // function that rebuilt this every digest would trip $rootScope:infdig.
        $scope.tierLegendRows = ['-1', '0', '1', '2', '3', '4'].map(function (k) {
            var m = $scope.TIER_META[k];
            return { key: k, label: m.label, name: m.name, desc: m.desc };
        });
        $scope.toolsLegendOpen = false;
        $scope.toggleToolsLegend = function () {
            $scope.toolsLegendOpen = !$scope.toolsLegendOpen;
        };
        // Free-text filter over the loaded tool surface (name + description),
        // so a long persona/module slice stays scannable. Case-insensitive,
        // whitespace-tolerant; empty filter returns the full list. Held on an
        // OBJECT (not a primitive) because the search input lives inside an
        // ng-if in the template -- a bare $scope.toolsFilter would be shadowed on
        // the ng-if child scope and never reach filteredTools() (AngularJS dot
        // rule).
        $scope.toolsSearch = { q: '' };
        $scope.filteredTools = function () {
            var q = ($scope.toolsSearch.q || '').trim().toLowerCase();
            if (!q) return $scope.tools;
            return ($scope.tools || []).filter(function (t) {
                return ((t.name || '') + ' ' + (t.description || ''))
                    .toLowerCase().indexOf(q) !== -1;
            });
        };
        $scope.clearToolsFilter = function () { $scope.toolsSearch.q = ''; };
        $scope.openTools = function () {
            $scope.closeMenu();
            var module = ($scope.entityContext && $scope.entityContext.module) || '';
            $scope.toolsOpen = true;
            $scope.toolsSearch.q = '';
            $scope.toolsError = '';
            $scope.toolsLoading = true;
            $scope.tools = [];
            $scope.toolsModule = module;
            $scope.toolsPersonaApplied = false;
            fsrPbAgentService.listAgentTools($scope.config, {
                intent: 'triage', module: module, include_mcp: true
            }).then(function (res) {
                var surfaces = (res && res.surfaces) || [];
                var triage = surfaces.filter(function (s) { return s.intent === 'triage'; })[0]
                          || surfaces[0] || { tools: [] };
                $scope.tools = triage.tools || [];
                $scope.toolsPersonaApplied = !!(res && res.persona_applied);
                if (res && res.module) $scope.toolsModule = res.module;
                $scope.toolsLoading = false;
            }).catch(function (err) {
                $scope.toolsError = (err && err.message) || 'Could not load tools.';
                $scope.toolsLoading = false;
            });
        };
        $scope.closeTools = function () { $scope.toolsOpen = false; };
        // Edit-form save/cancel live on the same scope as the form (no separate
        // controller -- avoids ctrlreg in the harness).
        $scope.save = function () {
            // Harness persists widget config under this key; real SOAR persists
            // via the host shell's modal save. Writing to localStorage is a no-op
            // in real SOAR (host re-reads from API on next mount), safe to do
            // unconditionally.
            try {
                // Derive the harness localStorage key from the runtime-detected
                // version (WIDGET_VERSION, parsed from the script URL) so it never
                // needs a per-release bump; fall back to the bare name if the URL
                // match failed (real SOAR sets __fsrWidgetId__ anyway).
                var widgetId = ($window.__fsrWidgetId__
                    || ('agenticAssistant' + (WIDGET_VERSION ? '-' + WIDGET_VERSION : '')));
                $window.localStorage.setItem('harness:config:' + widgetId, JSON.stringify($scope.config));
                $scope.saveFeedback = 'Saved.';
                $timeout(function () { $scope.saveFeedback = ''; }, 1500);
            } catch (e) {}
            $scope.closeSettings();
            _probeConnector();
        };
        $scope.cancel = function () { $scope.settingsOpen = false; };
        $scope.saveFeedback = '';

        $scope.mockScenarios = [
            { value: 'playbook_soc_demo',    label: 'SOC demo (branching)' },
            { value: 'immediate_block_ip',   label: 'Immediate · block IP' },
            { value: 'conditional_block_ip', label: 'Immediate · block IP (conditional params)' },
            { value: 'immediate_quarantine', label: 'Immediate · quarantine host' },
            { value: 'immediate_rejected',   label: 'Immediate · cancel path' },
            { value: 'playbook_ioc_sweep',   label: 'Playbook · IOC sweep' },
            { value: 'incident_smtp_intrusion', label: 'Incident · SMTP intrusion (triage)' },
            { value: 'c2_hunt',              label: 'C2 hunt · multi-pivot enrichment (triage)' }
        ];

        // ─── Connector availability gate ─────────────────────────────────────
        // chat is disabled until we confirm the configured connector exists.
        // null = unknown (probing), true = ok, false = missing/misconfigured.
        $scope.connectorReady = null;
        $scope.connectorGateMessage = '';

        // Mirrors fsrPbAgentService._activeScenario precedence: URL ?mock=
        // wins, then ?real=1, then config.mockMode (mock/real/auto), with
        // 'auto' meaning mock on localhost. When mock is active we don't
        // need a real connector -- the mock service serves fixtures.
        function _isMockActive() {
            if (_queryParam('mock')) return true;
            var urlMode = _queryParam('mode');
            if (urlMode === 'mock') return true;
            if (urlMode === 'live' || urlMode === 'real') return false;
            if (_queryParam('real') === '1') return false;
            var mode = $scope.config && $scope.config.mockMode;
            if (mode === 'mock') return true;
            if (mode === 'real') return false;
            var h = ($window.location && $window.location.hostname) || '';
            return h === 'localhost' || h === '127.0.0.1' || h === '::1';
        }

        // The needs_config help state. null ⇒ connector healthy (or mock).
        // When set, the template renders the config-help panel instead of the
        // composer. Shape: {fault, message, detail, activeConfig, grades[],
        // healthyConfigs[], settingsUrl, override, gradesLoading}.
        $scope.connectorHelp = null;
        $scope.connectorChecking = false;

        // Best-effort deep link to this appliance's Connector settings. The exact
        // in-app route isn't exposed to widgets, so we point at the connectors
        // settings page and always show the connector + config NAMES as text so
        // manual navigation works even if the route drifts across versions.
        function _connectorSettingsUrl() {
            var origin = ($window.location && $window.location.origin) || '';
            return origin + '/#/settings/connectors';
        }

        // Turn a health_check payload into a specific, human fault.
        // health_check `fault` codes for a connector installed without its
        // library: an install problem for an admin, never a config fault or a
        // blip worth retrying. Fallback text for a connector that sends none.
        var FRAMEWORK_FAULTS = {
            framework_missing: 'The Agentic Assistant connector is installed without its fsr-playbooks library. Allow the appliance to reach PyPI, then reinstall the connector.',
            framework_mismatch: 'The Agentic Assistant connector loaded the wrong version of its fsr-playbooks library. Reinstall the connector.'
        };

        function _classifyHealth(h) {
            h = h || {};
            if (!h.llm_key_configured) {
                return { fault: 'no_key',
                    message: 'The active configuration has no LLM API key set.' };
            }
            if (!h.llm_reachable) {
                var err = h.llm_error || '';
                var rejected = /401|403|invalid|unauthor|api.?key|permission|forbidden/i.test(err);
                if (rejected) {
                    return { fault: 'key_rejected',
                        message: 'The LLM endpoint rejected the configured API key.', detail: err };
                }
                // A TIMEOUT is not the same claim as "unreachable", and saying
                // the strong one is how a healthy config ended up behind a
                // config-fault panel. Measured live: the endpoint answers in
                // ~700ms and a few percent of probes hang the full ceiling, on
                // warm workers, clearing on the next attempt. The connector now
                // retries once; if BOTH attempts time out the honest sentence is
                // "slow / not answering", not "your config is wrong".
                if (/timed out|timeout/i.test(err)) {
                    return { fault: 'timeout',
                        message: 'The LLM endpoint did not answer in time. It may be slow or briefly unavailable.',
                        detail: err };
                }
                return { fault: 'unreachable',
                    message: 'The configured LLM endpoint is unreachable from the connector.', detail: err };
            }
            return { fault: 'not_ready',
                message: 'The connector reports it is not ready to run a turn.',
                detail: h.llm_error || '' };
        }

        function _enterNeedsConfig(res, cls) {
            $scope.connectorReady = false;
            $scope.connectorGateMessage = cls.message;
            $scope.connectorHelp = {
                fault: cls.fault,
                message: cls.message,
                detail: cls.detail || '',
                activeConfig: res
                    ? { name: res.configName, config_id: res.configId, isDefault: res.isDefault, isOverride: res.isOverride }
                    : null,
                grades: [],
                healthyConfigs: [],
                settingsUrl: _connectorSettingsUrl(),
                override: fsrPbAgentService.activeOverride(),
                gradesLoading: true
            };
            _gradeAllConfigs();
        }

        function _recomputeHealthy() {
            var help = $scope.connectorHelp;
            if (!help) return;
            var active = help.activeConfig && help.activeConfig.config_id;
            // The grade pass re-probes the ACTIVE config too. When that comes
            // back healthy the panel is holding evidence against its own
            // banner, and it used to keep showing the alarm anyway: the active
            // config rendered green with no "Use this session" button (it is
            // filtered out of healthyConfigs below), and Re-check was the only
            // way out. That is the visible half of an intermittent probe
            // timeout -- so let the panel dismiss itself instead.
            var activeGrade = (help.grades || []).filter(function (g) {
                return g.config_id === active;
            })[0];
            if (active && activeGrade && activeGrade.ok === true) {
                $scope.connectorReady = true;
                $scope.connectorGateMessage = '';
                $scope.connectorHelp = null;
                $scope.connectorOverride = fsrPbAgentService.activeOverride();
                _logEvent('connector_gate_self_cleared', { config: activeGrade.name });
                return;
            }
            help.healthyConfigs = (help.grades || []).filter(function (g) {
                return g.ok === true && g.config_id !== active;
            });
        }

        // Probe every configuration on the connector so the panel can show which
        // one to star. Each probe is live + free (health_check does a models.list,
        // no generation). Failures grade as unhealthy rather than throwing.
        function _gradeAllConfigs() {
            fsrPbAgentService.listConfigs().then(function (cfgs) {
                if (!$scope.connectorHelp) return;
                $scope.connectorHelp.grades = cfgs.map(function (c) {
                    return { name: c.name, config_id: c.config_id, isDefault: c.default,
                             ok: null, detail: null, error: null, probing: true };
                });
                $scope.connectorHelp.gradesLoading = false;
                cfgs.forEach(function (c, i) {
                    fsrPbAgentService.healthCheckConfig(c.config_id).then(
                        function (h) {
                            var g = $scope.connectorHelp && $scope.connectorHelp.grades[i];
                            if (!g) return;
                            g.probing = false; g.ok = !!(h && h.ok);
                            g.detail = h && h.llm_probe; g.error = h && h.llm_error;
                            _recomputeHealthy();
                        },
                        function () {
                            var g = $scope.connectorHelp && $scope.connectorHelp.grades[i];
                            if (!g) return;
                            g.probing = false; g.ok = false; g.error = 'probe failed';
                            _recomputeHealthy();
                        }
                    );
                });
            }, function () {
                if ($scope.connectorHelp) $scope.connectorHelp.gradesLoading = false;
            });
        }

        function _probeConnector() {
            if (_isMockActive()) {
                $scope.connectorReady = true;
                $scope.connectorGateMessage = '';
                $scope.connectorHelp = null;
                return;
            }
            // Real mode: resolve the connector (installed version + selected
            // config_id), THEN health-gate that config so a resolvable-but-broken
            // config (bad key / unreachable egress) surfaces the help panel up
            // front instead of only failing at the first chat turn.
            $scope.connectorReady = null;
            $scope.connectorGateMessage = '';
            $scope.connectorChecking = true;
            fsrPbAgentService.resolveConnector().then(
                function (res) {
                    $scope.connectorInfo = res; // {name, version, configId, configName, isDefault, isOverride}
                    return fsrPbAgentService.healthCheckConfig(res.configId).then(
                        function (h) {
                            if (h && h.ok) {
                                $scope.connectorReady = true;
                                $scope.connectorGateMessage = '';
                                $scope.connectorHelp = null;
                                // Keep a soft banner when a temp override is live.
                                $scope.connectorOverride = fsrPbAgentService.activeOverride();
                            } else if (h && FRAMEWORK_FAULTS[h.fault]) {
                                // The connector installed without its library
                                // (the appliance could not reach PyPI, or a
                                // wrong build loaded). No config change fixes
                                // that, so no config help panel and no retry
                                // hint: show the connector's own instruction.
                                $scope.connectorReady = false;
                                $scope.connectorHelp = null;
                                $scope.connectorGateMessage = h.message || FRAMEWORK_FAULTS[h.fault];
                            } else {
                                _enterNeedsConfig(res, _classifyHealth(h));
                            }
                        },
                        function (hErr) {
                            // health_check transport failed (connector redeploying
                            // / gateway blip) -- a transient gate, not a config
                            // fault. Show the retry hint, no help panel.
                            $scope.connectorReady = false;
                            $scope.connectorHelp = null;
                            $scope.connectorGateMessage = _sanitizeError(hErr);
                        }
                    );
                },
                function (err) {
                    // Resolve failed: not installed / no config / lookup error.
                    if (err && err.code === 'connector_not_installed') {
                        $scope.connectorReady = false;
                        $scope.connectorHelp = null;
                        $scope.connectorGateMessage = err.message;
                    } else if (err && err.code === 'connector_not_configured') {
                        _enterNeedsConfig(null, { fault: 'no_config', message: err.message });
                    } else {
                        $scope.connectorReady = false;
                        $scope.connectorHelp = null;
                        $scope.connectorGateMessage = (err && err.message) ||
                            'Connector "' + fsrPbAgentService.connectorName + '" is unavailable.';
                    }
                }
            ).finally(function () { $scope.connectorChecking = false; });
        }

        // ── needs_config help panel actions (bound in view.html) ──────────────
        // Re-check after the admin fixes the config in Connector settings.
        $scope.recheckConnector = function () {
            fsrPbAgentService.refresh();
            _probeConnector();
        };
        // Adopt a healthy config for THIS session only (visible banner; not
        // persisted). The permanent fix is still to star it in Connector settings.
        $scope.useConfigTemporarily = function (grade) {
            if (!grade || !grade.config_id) return;
            fsrPbAgentService.setConfigOverride({ config_id: grade.config_id, name: grade.name });
            _logEvent('config_override_set', { config: grade.name });
            _probeConnector();
        };
        $scope.clearConfigOverride = function () {
            fsrPbAgentService.clearConfigOverride();
            $scope.connectorOverride = null;
            _logEvent('config_override_cleared', {});
            _probeConnector();
        };
        // Re-probe only when mockMode flips (mock mode skips the gate entirely).
        // The connector itself is fixed, so there's nothing else to react to.
        $scope.$watch('config.mockMode', function (val, old) {
            if (val !== old) _probeConnector();
        });
        _trackTimer($timeout(_probeConnector, 0));

        var _sessionId = _ensureSessionId();
        // The host-record IRI that _sessionId is currently scoped to. Seeded from
        // the construction-time entity so the first entityContext.iri $watch pass
        // (which fires with the initial value) does NOT trigger a redundant switch.
        // A later change to a DIFFERENT record re-points the session (see the watch).
        var _sessionEntityIri = ($scope.entityContext && $scope.entityContext.iri) || null;
        var _turnCounter = 0;
        var _eventLog = [];
        var _turnAborted = false;
        var _lastSentPayload = null;   // test probe: last payload handed to the agent service

        var COLLAPSE_THRESHOLD = 400; // chars; tool results larger than this start collapsed

        // ─── Action-based streaming (contract 2.5.0) ─────────────────────────
        // While a blocking chat_turn is in flight, poll chat_poll in parallel
        // and render the connector's per-event progress feed as a transient
        // preview message so the analyst sees incremental updates instead of
        // ~10-30 s of dead air. On `done`/`stream_end` we discard the preview
        // and the authoritative transcript (from chat_turn's own return) takes
        // its place. Purely additive: against a <2.5.0 connector (or in mock
        // mode) the poll is skipped/disabled and the single response still works.
        var STREAM_MIN_CONTRACT = '2.5.0';   // connector must be >= this to stream
        var STREAM_POLL_MS      = 700;        // interval between polls (only when the connector answers at once)
        var LONG_POLL_MS        = 8000;       // window the connector holds one poll open for a new frame
        var LONG_POLL_FLOOR_MS  = 1000;       // an answer faster than this with nothing new is not a held poll
        var REPOLL_MS           = 50;         // gap before the next held poll (never 0: no hot loop)
        // Max consecutive transient (5xx/gateway/network) poll failures before
        // surfacing the error instead of silently retrying. A single blip is
        // expected (the connector's own poll loop has the same shape); a
        // SUSTAINED burst means the gateway is down, and retrying every 700ms
        // for 6 minutes leaves the analyst staring at a typing indicator
        // (tracker #106). 10 = ~7s of sustained failure before we surface.
        var STREAM_MAX_TRANSIENT_ERRORS = 10;
        // Defense-in-depth wall-clock cap on a DETACHED turn (contract §11). The
        // connector's own lost-producer guard normally writes a terminal after
        // STREAM_TIMEOUT_SECS=300, but if chat_poll itself is unreachable the
        // widget would otherwise poll forever with the composer stuck on the
        // typing indicator. After this long with no authoritative commit we
        // settle the turn ourselves so 'sending' always ends. Admin-tunable.
        var DETACHED_WATCHDOG_MS = (function () {
            var v = parseInt($scope.config && $scope.config.detachedTimeoutMs, 10);
            return (v && v > 0) ? v : 360000;   // 6 min, above the connector's 300 s
        })();
        $scope.streamingMessage = null;       // transient assistant preview (not in messages[])
        $scope.streamStatus = '';             // live status line text under the typing dots
        // B1/B2 -- transcript pin-to-bottom + composer focus restore.
        var _pinnedToBottom = true;           // false once the analyst scrolls up to read history
        var _scrollBound = false;             // one-time scroll listener guard
        var _wantComposerFocus = false;       // set on user send; consumed when the turn returns to idle
        var _stream = null;                   // active stream session bookkeeping
        var _tickTimer = null;                // $interval bumping PENDING tool elapsed timers
        var _lastTurn = 0;                    // highest committed turn # (gates out stale poll frames)
        var _committedTurns = {};             // turn# -> true; commit each turn at most once (ack/terminal/POST race)
        var _committedToolUseIds = {};        // tool_use id -> true; dedup re-committed transcripts (audit integrity, incl. null-turn)
        var _committedToolResultIds = {};     // tool_use id -> true once its RESULT is rendered; lets a cumulative resume complete a still-pending chip without re-rendering a finished one (#91)
        var _msgKeySeq = 0;                   // monotonic id source for message._key (stable ng-repeat track-by; no $index bleed)
        var _detachedActive = false;          // a detached turn is in flight; its transcript may ONLY commit via chat_poll

        // ─── Test probe ───────────────────────────────────────────────────────
        // Exposed whenever the widget runs in the harness (localhost) -- in mock
        // mode AND in forced live mode (?mode=live). The live detached/poll path
        // is where the real "stuck on the typing bubbles" hang lives, so it must
        // be introspectable from e2e too; the probe is a read-only window handle
        // and never reaches a deployed (non-localhost) install.
        var _host = ($window.location && $window.location.hostname) || '';
        var _isHarness = (_host === 'localhost' || _host === '127.0.0.1' || _host === '::1');
        var _mockActive = !!_queryParam('mock') || _queryParam('mode') === 'mock'
            || (_isHarness && !_queryParam('real') && _queryParam('mode') !== 'live' && _queryParam('mode') !== 'real');
        if (_mockActive || _isHarness) {
            $window.__agenticAssistant__ = {
                get state()        { return $scope.viewState; },
                // Is the widget serving its OWN canned fixtures rather than
                // talking to a connector? The probe attaches on any localhost
                // mount, so its presence alone says nothing about which track is
                // live. lib/localUiDriver.ts asserts this is false after boot:
                // a local matrix row that graded mock frames would pass
                // vacuously, which is the worst thing that gate could do.
                get mockActive()   { return !!_mockActive; },
                get messageCount() { return $scope.messages.length; },
                get lastTurn()     { return $scope.messages[$scope.messages.length - 1]; },
                // The TRANSCRIPT and its card frames. `events` below is the
                // UI-action log (_eventLog) -- a different thing entirely, and
                // conflating the two made the live sweep's playbook-build row
                // structurally unpassable: it scanned `p.messages[].events`
                // for the playbook_offer, `p.messages` was undefined, so the
                // offer was never seen and the accept branch was dead code
                // that no failure could point at (cards #101/#84).
                get messages()     {
                    return ($scope.messages || []).map(function (m) {
                        return { role: m.role, author: m.author || null, ts: m.ts || null,
                                 text: m.text || '', events: (m.events || []).slice() };
                    });
                },
                get currentYaml()  { return $scope.currentYaml; },
                get pushResult()   { return $scope._lastPushResult || null; },
                get events()       { return _eventLog.slice(); },
                get config()       { return $scope.config; },
                get connectorListLoading() { return !!$scope.connectorListLoading; },
                get intent()       { return $scope.uiIntent; },
                get entity()       { return $scope.entityContext ? angular.copy($scope.entityContext) : null; },
                get contractBanner() { return $scope.contractBanner; },
                get lastPayload()  { return _lastSentPayload; },
                get quickActions() { return $scope.quickActions; },
                get showQuickActions() { return $scope.showQuickActions(); },
                get inPlaybookEditor() { return $scope.inPlaybookEditor; },
                get playbookQuickActions() { return $scope.playbookQuickActions; },
                get showPlaybookQuickActions() { return $scope.showPlaybookQuickActions(); },
                get composerText() { return $scope.form.inputText; },
                openExport:        function () { $scope.openExport(); $scope.$applyAsync(); },
                get exportText()   { return $scope.form.exportText; },
                get exportOpen()   { return $scope.exportOpen; },
                runQuickAction:   function (key) {
                    var a = ($scope.quickActions || []).filter(function (x) { return x.key === key; })[0];
                    if (a) { $scope.runQuickAction(a); $scope.$applyAsync(); }
                },
                pullInPageDetails: function () { $scope.pullInPageDetails(); $scope.$applyAsync(); },
                get canBuildFromTriage() { return $scope.canBuildFromTriage(); },
                get toolsUsedInTriage() { return $scope.toolsUsedInTriage(); },
                // A3: simulate the agent having authored YAML during triage so
                // the draft-handoff CTA can be exercised in a browser.
                get hasTriageDraft() { return $scope.hasTriageDraft(); },
                seedTriageDraft: function (yaml) {
                    // The stray-draft CTA is editor-only now (build UI never
                    // appears over a record), so simulate the designer context.
                    $scope.inPlaybookEditor = true;
                    $scope.uiIntent = 'triage';
                    $scope.viewState = 'idle';
                    $scope.currentYaml = yaml || 'playbooks:\n  - name: Drafted in triage';
                    $scope.$applyAsync();
                },
                openDraftInBuild: function () { $scope.openDraftInBuild(); $scope.$applyAsync(); },
                buildFromTriage: function () { $scope.buildPlaybookFromTriage(); $scope.$applyAsync(); },
                get sessionId()    { return _sessionId; },
                // History browser probes.
                openHistory:       function () { $scope.openHistory(); $scope.$applyAsync(); },
                closeHistory:      function () { $scope.closeHistory(); $scope.$applyAsync(); },
                get historyOpen()  { return $scope.historyOpen; },
                get sessions()     { return ($scope.sessions || []).slice(); },
                loadSession:       function (id) { $scope.loadSession(id); $scope.$applyAsync(); },
                // Test-only: drive the refresh-rehydrate path with a canned
                // transcript so the post-reload build-state reconstruction
                // (YAML restore + build-mode flip) can be asserted in a browser.
                replayTurns:       function (turns, decisions) {
                    $scope.messages = [];
                    _replayTurns(turns || [], decisions);
                    $scope.$applyAsync();
                },
                // Test-only: deliver a decisions poll result.
                applyCardDecisions: function (decisions) {
                    _applyCardDecisions(decisions);
                    $scope.$applyAsync();
                },
                // Test-only: inject a fake session list (mock mode never hits
                // the connector, so listSessions returns empty) so the history
                // panel can be exercised in a browser.
                injectSessions: function (list) {
                    $scope.sessions = list || [];
                    $scope.historyLoading = false;
                    $scope.historyError = '';
                    $scope.$applyAsync();
                },
                // Test-only: inject content-search results (mock never persists
                // sessions server-side, so the real query→connector path returns
                // empty) so the history search UI can be exercised in a browser.
                injectSearchResults: function (list) {
                    $scope.searchResults = list || [];
                    $scope.searching = false;
                    $scope.$applyAsync();
                },
                // Test-only: inject a fake connector list into the form so
                // the combobox search can be exercised without a live backend.
                injectConnectors: function (list) {
                    $scope.connectors = list || [];
                    $scope.connectorListLoading = false;
                    $scope.$applyAsync();
                },
                // ── Scheduled tasks (recurring agent runs) ───────────────────
                // Mock mode never hits the connector, and the scheduled ops
                // route through _executeReal (always-live), so the panel + the
                // per-task history drawer need explicit injection seams to be
                // exercised in a browser/hermetic e2e -- the same reason
                // injectSessions exists for the history browser.
                openScheduledTasks: function () { $scope.openScheduledTasks(); $scope.$applyAsync(); },
                closeScheduledTasks: function () { $scope.closeScheduledTasks(); $scope.$applyAsync(); },
                get scheduledOpen() { return $scope.scheduledOpen; },
                get scheduledTasks() { return ($scope.scheduledTasks || []).slice(); },
                injectScheduledTasks: function (list) {
                    $scope.scheduledTasks = list || [];
                    $scope.scheduledLoading = false;
                    $scope.scheduledError = '';
                    $scope.$applyAsync();
                },
                openScheduledHistory: function (t) { $scope.openScheduledHistory(t); $scope.$applyAsync(); },
                closeScheduledHistory: function () { $scope.closeScheduledHistory(); $scope.$applyAsync(); },
                get scheduledHistoryOpen() { return $scope.scheduledHistoryOpen; },
                get scheduledRuns() { return ($scope.scheduledRuns || []).slice(); },
                injectScheduledTaskRuns: function (runs) {
                    $scope.scheduledRuns = runs || [];
                    $scope.scheduledRunsLoading = false;
                    $scope.scheduledRunsError = '';
                    $scope.$applyAsync();
                },
                openScheduledRun: function (run) { $scope.openScheduledRun(run); $scope.$applyAsync(); }
            };
        }

        // ─── Actions ──────────────────────────────────────────────────────────

        $scope.sendMessage = function () {
            var text = ($scope.form.inputText || '').trim();
            if (!text || $scope.viewState !== 'idle') return;
            if ($scope.connectorReady === false) return;
            $scope.form.inputText = '';
            _wantComposerFocus = true;   // B2: refocus the composer once the turn settles
            _appendUserMessage(text);
            _scrollToBottom(true);       // B1: the analyst's own send always re-pins to bottom
            _runTurn({ user: text });
        };

        $scope.onInputKey = function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                $scope.sendMessage();
            }
        };

        $scope.newConversation = function () {
            $scope.messages = [];
            _resetUsage();
            $scope.currentYaml = '';
            $scope._buildHandoffActive = false;   // fresh chat → relock build UI over a record
            // ...and drop the intent back to the mount default. Clearing only
            // the handoff flag left `uiIntent === 'build'` latched from the
            // previous conversation's triage→playbook handoff, which is not
            // cosmetic: the connector's build slice drops the whole triage
            // toolset (get_record / update_record / run_op / siem_* / faz_*),
            // so "+ New" over an alert produced an agent that could no longer
            // read or edit the record in front of it and answered record
            // questions as playbook authoring. There is no manual toggle back,
            // so this was an inescapable dead end short of navigating away.
            // Reset the UI intent for the fresh conversation. The session key is
            // record/page-scoped now (not intent-scoped), so this drives the UI
            // affordances and the soft `intent` prior, not which thread bucket
            // the session files under.
            $scope.uiIntent = _defaultIntent();
            $scope.errorMessage = '';
            $scope.approvalRequest = null;
            $scope.viewState = 'idle';
            $scope.sessionInitiator = null;   // a fresh chat is owned by the viewer
            _sessionId = _mintSession();
            // A fresh session restarts the connector's turn numbering at 1, so the
            // stream fence MUST reset too. Without this, a prior/rehydrated session
            // that advanced _lastTurn (e.g. history-open sets it to the replayed
            // turn count) leaves minTurn = _lastTurn + 1 > 1, so the new session's
            // first turn_start (turn:1) is dropped as stale, sawStart never latches,
            // the `done` terminal is ignored, and the detached turn polls until the
            // 6-min watchdog fails it with "taking too long / lost contact." Also
            // tear down any in-flight stream in case "+ New" is hit mid-turn.
            _stopStreaming();
            _lastTurn = 0;
            _committedTurns = {};
            _committedToolUseIds = {};
            _committedToolResultIds = {};
            _resetLiveRating();
            _logEvent('new_conversation', { sessionId: _sessionId });
            // Re-seed the record summary card over the now-empty timeline. The
            // entity watcher can't do it here: the IRI didn't change, so it
            // never fires, and "+ New" on the same record page left a bare hero
            // with no summary card until a full page reload.
            _reseedForCurrentEntity();
        };

        // Approvals render as an inline transcript card (one consistent
        // in-chat surface for user input -- no blocking modal). A card's
        // Approve/Reject is live only while it is THE pending approval; once
        // acted on we stamp the event so it shows a resolved footer instead.
        // Whether an event's step row draws a frame (see FsrPbRender.stepFrame).
        $scope.stepFrame = function (ev) {
            return $window.FsrPbRender.stepFrame(ev && ev.type);
        };

        $scope.isPendingApproval = function (ev) {
            if (!$scope.approvalRequest || !ev || ev._resolved) return false;
            // Match on approval_id, but tolerate a connector that didn't send
            // one (the old modal gated on bare approvalRequest truthiness) --
            // normalize null/undefined/'' so an id-less request still resolves.
            var a = ev.approvalId || '';
            var b = $scope.approvalRequest.approvalId || '';
            return a === b;
        };
        // A1/A2 for the approval card. Unlike the other cards this one gates its
        // visibility on the `$scope.approvalRequest` singleton, so we keep that
        // request live during the in-flight window (don't null it, or the card's
        // buttons/note would vanish mid-submit) and only clear it on success. On
        // failure the request stays pending → the card is retryable in place.
        // `remember` is "Approve & always allow": only offered when the card
        // carries `alwaysAllow` (a run_playbook its persona would have asked
        // about), and only ever with an approve.
        $scope.respondApprovalInline = function (ev, decision, remember) {
            if (!$scope.isPendingApproval(ev) || $scope.cardBusy(ev)) return;
            var req = $scope.approvalRequest;
            var note = $scope.form.approvalNote;
            var _toolName = req.tool || ev.name || 'the action';
            var _remember = !!(remember && decision === 'approve' && ev.alwaysAllow);
            _appendUserMessage(_approvalUserText(_toolName, decision, note)
                + (_remember ? ' Always allow "' + ev.alwaysAllow.playbook + '" from now on.' : ''));
            _scrollToBottom(true);
            ev._submitting = true;
            ev._error = null;
            ev._decision = decision;
            ev._remember = _remember;
            var p = _runResume(req.approvalId, req.turnId, decision, note, _remember);
            if (!p || typeof p.then !== 'function') { ev._submitting = false; return; }
            p.then(function (res) {
                ev._submitting = false;
                ev._resolved = true;
                // A 200 from chat_resume means the RESUME was accepted -- NOT
                // that the approved tool ran. When the connector could not
                // execute it (e.g. the tool was absent from the worker's
                // registry, so dispatch returned "unknown tool"), the card still
                // painted a green "Approved" while the tool chip sat forever on
                // "awaiting result". That reads as success to an analyst who
                // just authorised a containment action -- the worst possible
                // direction to be wrong in. Grade the actual outcome.
                var outcome = _approvalOutcome(res, req.tool || ev.name);
                ev._outcome = outcome.status;
                if (outcome.status === 'failed' || outcome.status === 'expired') ev._error = outcome.detail;
                $scope.form.approvalNote = '';
                if ($scope.approvalRequest === req) $scope.approvalRequest = null;
            }, function (err) {
                ev._submitting = false;
                ev._error = _sanitizeError(err);
            });
        };

        // Grade what actually happened to an approved action, from the resume
        // response. Returns {status: 'executed'|'failed'|'denied'|'unknown',
        // detail}. `unknown` is deliberately NOT treated as failure -- some
        // providers stream the tool result on a later poll -- but it also does
        // not claim success: the footer stays neutral until evidence arrives.
        function _approvalOutcome(res, toolName) {
            if (!res || typeof res !== 'object') return { status: 'unknown', detail: '' };
            if (res.stop_reason === 'approval_unverified') {
                return { status: 'failed',
                         detail: 'The action could not be verified and was NOT executed.' };
            }
            // The approval is gone: its 10-minute window lapsed, or another
            // tab/turn already answered it. Nothing ran, and the connector's
            // own text ("no suspended session for approval_id ...") is
            // plumbing -- say what happened and what to do.
            // Another reviewer (the Monitor queue, a second tab) answered this
            // card first. The connector refused to run it twice and says who
            // decided it; that sentence is the whole story.
            if (res.error && res.error.code === 'already_decided') {
                return { status: 'expired', detail: res.error.message || 'Someone else already answered this approval.' };
            }
            if (res.code === 'approval_not_found') {
                return { status: 'expired',
                         detail: 'This approval is no longer waiting: approvals last 10 minutes, '
                             + 'or it was already answered. Nothing ran. Ask again and it will be staged fresh.' };
            }
            if (res.ok === false || res.error) {
                return { status: 'failed', detail: _sanitizeError(res.error || res) };
            }
            var tx = res.transcript || [];
            for (var i = tx.length - 1; i >= 0; i--) {
                var e = tx[i];
                if (!e || e.type !== 'tool_result') continue;
                if (toolName && e.name && e.name !== toolName) continue;
                // The connector emits the payload as `content` (see the
                // ToolResultFrame the resume path appends); `result` is only a
                // legacy shape. Reading `result` alone meant the payload was
                // ALWAYS undefined on a real frame, so every approved action
                // fell through to 'executed' -- including a refusal. Live on
                // 8.0 an approved run_playbook came back
                // {ok:false, code:"run_not_permitted"} and the card still
                // painted a green "Approved" with no error anywhere on screen.
                var r = e.content !== undefined ? e.content : e.result;
                if (typeof r === 'string') {
                    try { r = JSON.parse(r); } catch (_) { /* leave as text */ }
                }
                if (r && typeof r === 'object') {
                    if (r.code === 'user_denied') return { status: 'denied', detail: '' };
                    // A PARKED run is not a failure. An approved run_playbook
                    // whose playbook contains a manual_input step returns
                    // {ok:false, code:"awaiting_input"} ALONGSIDE triggered:true
                    // and a run_pk -- it RAN and is waiting on a human at the
                    // playbook's own gate. It must be checked before the
                    // ok:false line below, which used to render "Approved --
                    // but the action did not run" for a live run sitting on the
                    // box waiting for this analyst's input. They then re-approve
                    // or abandon a run that is fine (tracker #90). Same
                    // `ok:false` double duty the connector wire and the matrix
                    // grader already distinguish (verdict-vocabulary.json
                    // notAnError.codes) -- this was the last consumer that did
                    // not.
                    // The code list is generated from the shared verdict
                    // vocabulary (widgetAssets/js/fsrPbVerdictVocab.js).
                    if ($window.FsrPbVerdictVocab.parkedCodes.indexOf(r.code) !== -1) {
                        return { status: 'parked',
                                 detail: r.message || '' };
                    }
                    // dispatch()'s unknown-tool envelope and the generic
                    // {ok:false} failure envelope both mean "did not run".
                    if (r.ok === false || r.error) {
                        return { status: 'failed',
                                 detail: _sanitizeError(r.error || r.message
                                                        || r.reason || r) };
                    }
                    return { status: 'executed', detail: '' };
                }
                // A frame with no readable payload proves nothing. Stay neutral
                // rather than claim success -- `unknown` is the documented
                // "no evidence yet" state, and silently upgrading it to
                // 'executed' is how this bug read as a green approval.
                return { status: 'unknown', detail: '' };
            }
            return { status: 'unknown', detail: '' };
        }

        // The header button stages into the open designer, or creates a new
        // playbook anywhere else -- label it for what it will do.
        $scope.hasOpenPlaybook = function () { return !!_openPlaybookIri(); };
        // Is there anything to put into the designer? In the designer the YAML
        // pane is seeded with the open playbook itself (playbookYaml), so
        // "Apply to designer" showed before a single edit existed. Outside the
        // designer any YAML is a new playbook, so it always counts.
        $scope.yamlHasChanges = function () {
            if (!$scope.currentYaml) return false;
            if (!$scope.hasOpenPlaybook() || !$scope.playbookYaml) return true;
            return String($scope.currentYaml).trim() !== String($scope.playbookYaml).trim();
        };

        $scope.pushPlaybook = function () {
            if (!$scope.currentYaml) return;
            // Truncation guard (fail-closed, stateless). A well-formed playbook
            // YAML never contains a standalone ``` fence line; if one survives in
            // the buffer it means a fence boundary was swallowed into the body
            // (a clip artifact from an older session, a bad paste, or a manual
            // edit). Compiling+writing that would overwrite the real record with
            // a partial playbook, silently deleting steps -- so REFUSE and surface
            // it rather than persist. Computed from the content itself so it can
            // never go stale against the ~15 sites that set currentYaml.
            if (/^[ \t]*```/m.test($scope.currentYaml)) {
                _appendSystemMessage('Save blocked: the playbook YAML still ' +
                    'contains a ``` code-fence marker, which means it may be ' +
                    'truncated. Review and fix the YAML pane before saving so ' +
                    'the full playbook is written.');
                _logEvent('save_blocked_truncated_yaml', {});
                return;
            }
            // Modify-in-place vs create (Track C2). When mounted in the playbook
            // designer over an open playbook (entityContext.iri is a workflows
            // IRI), UPDATE the existing record in place; otherwise CREATE a new
            // collection. One button, picked by whether an open-playbook IRI is
            // present. The update path preserves the workflow uuid (non-
            // destructive); create uses the deterministic-uuid conflict handling.
            var _openIri = _openPlaybookIri();
            var _isUpdate = !!_openIri;
            _setState('sending');
            _logEvent('action_call', { action: _isUpdate ? 'update_playbook' : 'push_playbook' });
            // The session id labels the pre-edit restore point the connector
            // writes to the playbook's Versions tab, so a snapshot is traceable
            // to the chat that caused it. Only an update has something to
            // restore; a create does not.
            // With the designer open, stage instead of writing: a PUT behind the
            // canvas is invisible until a page reload, and the analyst's next
            // Save would overwrite it with the stale canvas. Staged, the change
            // shows at once as unsaved edits and their Save is the write.
            var _stage = _isUpdate && !!_designerDetailScope();
            var _promise = _isUpdate
                ? fsrPbAgentService.updatePlaybook($scope.config, $scope.currentYaml,
                                                   _openIri, _sessionId, { stage: _stage })
                : fsrPbAgentService.pushPlaybook($scope.config, $scope.currentYaml);
            _promise.then(function (res) {
                    _logEvent('action_result', {
                        action: _isUpdate ? 'update_playbook' : 'push_playbook', ok: res.ok });
                    $scope._lastPushResult = res;
                    if (res.ok !== false && res.staged && res.workflow) {
                        if (_stageIntoDesigner(res.workflow)) {
                            _closeStepPalette();
                            _appendSystemMessage('The change is in the designer -- it is not saved '
                                + 'yet. Review it and click Save in the designer to keep it. The '
                                + 'playbook as it was is saved in the Versions tab.');
                        }
                    } else if (res.ok !== false) {
                        // The playbook is now a real record in FortiSOAR ��� link to
                        // it. A workflow uuid opens that playbook directly
                        // (/playbooks/<wf_uuid>); fall back to the collection view
                        // (/playbooks/collections/<coll_uuid>). Root-relative
                        // resolves both inside SOAR (same-origin) and through the
                        // harness proxy.
                        var _wfUuids = res.workflow_uuids
                            || (res.workflows || []).map(function (w) { return w.uuid; });
                        if (!_wfUuids || !_wfUuids.length) {
                            // Update (PUT) returns a single workflow_uuid, not the
                            // collection's workflow_uuids[] list -- fold it in so the
                            // deep-link renders. (An empty [] is truthy in JS, so the
                            // `||` chain above can't reach this on its own.)
                            if (res.workflow_uuid) _wfUuids = [res.workflow_uuid];
                        }
                        $scope.playbookLink = (_wfUuids && _wfUuids[0])
                            ? '/playbooks/' + _wfUuids[0]
                            : (res.collection_uuid
                                ? '/playbooks/collections/' + res.collection_uuid
                                : (res.workflow_iri || null));
                        $scope.playbookName = (res.raw && res.raw.name)
                            || ($scope.entityContext && $scope.entityContext.displayName)
                            || 'playbook';
                        var _verb = _isUpdate ? 'Updated playbook in FortiSOAR' : 'Created playbook in FortiSOAR';
                        _appendSystemMessage(_verb +
                            ($scope.playbookLink
                                ? ': [' + $scope.playbookName + '](' + $scope.playbookLink + ')'
                                : (res.workflow_iri ? ': ' + res.workflow_iri : '.')));
                    } else {
                        $scope.playbookLink = null;
                        if (res.error && res.error.code === 'would_drop_fields') {
                            // The save guard refused a deletion nobody asked
                            // for. Its message is for the agent; say it plainly.
                            _appendSystemMessage($window.FsrPbRender.dropRefusalText(res.error.dropped));
                            _setState('idle');
                            return;
                        }
                        var _errMsg = res.error && (res.error.message || res.error.code)
                            ? (res.error.message || res.error.code)
                            : (typeof res.error === 'string' ? res.error : JSON.stringify(res));
                        _appendSystemMessage((_isUpdate ? 'Update' : 'Create') + ' failed: ' + _errMsg);
                    }
                    _setState('idle');
                })
                .catch(_handleError);
        };

        $scope.stopTurn = function () {
            if ($scope.viewState !== 'sending') return;
            _turnAborted = true;
            _stopStreaming();
            _logEvent('stop_requested', {});
            // C6: stop the server turn too, not only our wait on it. The
            // connector marks the turn cancelled, so no tool runs after Stop.
            var sid = _sessionId;
            var stopping = fsrPbAgentService.modeInfo($scope.config).mode === 'live'
                ? fsrPbAgentService.chatCancel($scope.config, sid) : null;
            if (stopping) {
                stopping.then(function (res) {
                    _logEvent('stop_sent', { turn: res && res.turn, cancelled: !!(res && res.cancelled) });
                }).catch(function () {
                    _appendSystemMessage('Could not reach the server to stop this turn. It may still finish.');
                });
            }
            _appendSystemMessage('Stop requested. The server stops this turn before its next step.');
            _setState('idle');
        };

        // C6: after a reload the connector may still be running this session's
        // turn. Ask chat_poll for the running turn (fenced past the last
        // committed turn) and resume the live view on it, instead of showing
        // nothing until the turn ends. A finished or absent turn leaves the
        // transcript as it is.
        function _reattachRunningTurn() {
            if (fsrPbAgentService.modeInfo($scope.config).mode !== 'live') return;
            if (typeof fsrPbAgentService.chatPoll !== 'function') return;
            if (_stream || $scope.viewState === 'sending') return;
            var sid = _sessionId;
            if (_inFlightSession() !== sid) return;   // no turn was running at last unload
            var probe;
            try { probe = fsrPbAgentService.chatPoll($scope.config, sid, 0, _lastTurn, 0); }
            catch (e) { return; }   // a connector/stub without the op: nothing to resume
            if (!probe || typeof probe.then !== 'function') return;
            probe
                .then(function (resp) {
                    if (sid !== _sessionId || _stream || $scope.viewState === 'sending') return;
                    if (!resp || typeof resp.turn !== 'number' || resp.done) { _markInFlight(null); return; }
                    if (resp.turn <= _lastTurn) { _markInFlight(null); return; }
                    _turnAborted = false;
                    _detachedActive = true;   // the poll terminal is the only commit
                    _setState('sending');
                    _logEvent('reattach', { turn: resp.turn });
                    _startStreaming();
                })
                .catch(function () { /* nothing running to resume */ });
        }

        // ─── Interactive card handlers ────────────────────────────────────────

        $scope.pickChoice = function (event, option) {
            if (!event || event._resolved || $scope.viewState !== 'idle') return;
            if (event.multi) {
                var idx = event._picked.indexOf(option.value);
                if (idx >= 0) {
                    event._picked.splice(idx, 1);
                } else {
                    if (event.maxSelect && event._picked.length >= event.maxSelect) return;
                    event._picked.push(option.value);
                }
                return; // wait for explicit Continue
            }
            event._resolved = true;
            event._picked = option.value;
            event._open = false;
            event._resolutionText = option.label || option.value;
            event._resolvedBy = $scope.initiator.name;
            event._resolvedAt = Date.now();
            _runResumeChoice(event.choiceId, option.value);
        };

        // Free-text answer (cards emitted with allow_text). Same resume path as
        // a chip: the typed text IS the value the model receives.
        $scope.canSubmitChoiceText = function (event) {
            return !!(event && event.allowText && !event._resolved
                && $scope.viewState === 'idle'
                && String(event._typed || '').trim());
        };

        $scope.submitChoiceText = function (event) {
            if (!$scope.canSubmitChoiceText(event)) return;
            var text = String(event._typed).trim();
            event._resolved = true;
            event._picked = text;
            event._open = false;
            event._resolutionText = text;
            event._resolvedBy = $scope.initiator.name;
            event._resolvedAt = Date.now();
            _runResumeChoice(event.choiceId, text);
        };

        // Enter sends, Shift+Enter is a newline -- same as the chat composer.
        $scope.choiceTextKeydown = function ($event, event) {
            if ($event && $event.key === 'Enter' && !$event.shiftKey) {
                $event.preventDefault();
                $scope.submitChoiceText(event);
            }
        };

        $scope.isChipPicked = function (event, option) {
            if (!event) return false;
            return event.multi
                ? event._picked.indexOf(option.value) >= 0
                : event._picked === option.value;
        };

        $scope.canSubmitMulti = function (event) {
            if (!event || !event.multi || event._resolved) return false;
            return event._picked.length >= (event.minSelect || 1);
        };

        $scope.submitMultiChoice = function (event) {
            if (!$scope.canSubmitMulti(event)) return;
            event._resolved = true;
            event._open = false;
            var labels = event.options
                .filter(function (o) { return event._picked.indexOf(o.value) >= 0; })
                .map(function (o) { return o.label || o.value; });
            event._resolutionText = labels.join(' · ');
            event._resolvedBy = $scope.initiator.name;
            event._resolvedAt = Date.now();
            _runResumeChoice(event.choiceId, event._picked.slice());
        };

        // Confirm is gated on required fields being non-empty. If the card
        // declares `required_fields` we honor exactly that set; otherwise every
        // editable field is treated as required (a sane default -- the connector
        // wouldn't surface an arg it didn't want filled). Contract §E.
        $scope.resumeCapabilityGap = function (event, value, label) {
            if (!event || event._resolved || $scope.viewState !== 'idle') return;
            event._resolved = true;
            event._picked = value;
            event._open = false;
            event._resolutionText = label || value;
            event._resolvedBy = $scope.initiator.name;
            event._resolvedAt = Date.now();
            _runResumeChoice(event.choiceId, value);
        };

        // Currently-visible fields for an action_card, applying the 2.4.0
        // conditional-parameter `visibility` recursion. Delegates to the pure
        // render module so the branch logic is unit-tested in node.
        $scope.actionCardFields = function (event) {
            if (!event) return [];
            return $window.FsrPbRender.resolveActionFields(event, event.args);
        };

        $scope.actionCardValid = function (event) {
            if (!event) return false;
            return $window.FsrPbRender.actionCardComplete(event, event.args);
        };

        $scope.actionCardBranchLabel = function (event) {
            if (!event) return '';
            return $window.FsrPbRender.actionCardBranchLabel(event, event.args);
        };

        // #129 -- a resolved card collapses its arg FORM to a read-only receipt
        // of the values that actually ran. The form is still one click away
        // (`_argsExpanded`) because "what exactly did I send" is a real
        // question after the fact; it is just no longer the default rendering.
        // Memoized on the args signature, and that is load-bearing, not an
        // optimization: the summary builds FRESH row objects, and ngRepeat's
        // collection watcher compares items by identity -- returning a new array
        // every digest is an infinite-digest loop ($rootScope:infdig). Caching
        // by signature hands back a stable reference until the args change.
        $scope.actionCardArgSummary = function (event) {
            if (!event) return [];
            var sig;
            // A cyclic/unserializable args bag caches under one sentinel rather
            // than recomputing forever -- an infdig is worse than a stale row.
            try { sig = JSON.stringify(event.args || {}); } catch (e) { sig = ' nosig'; }
            if (event._argSummarySig !== sig || !event._argSummary) {
                event._argSummarySig = sig;
                event._argSummary = $window.FsrPbRender.actionCardArgSummary(event, event.args);
            }
            return event._argSummary;
        };

        $scope.toggleActionArgs = function (event) {
            if (!event) return;
            event._argsExpanded = !event._argsExpanded;
        };

        // dynamic_list dependent second-select: the items for the picked group.
        // Delegates to the pure render module so the lookup is unit-tested.
        $scope.dynamicListItems = function (field, group) {
            return $window.FsrPbRender.dynamicListItems(field, group);
        };

        // A1/A4 -- an interactive card is "busy" (its buttons disabled) while its
        // own resume is in flight (`_submitting`) OR while ANY turn is streaming
        // (viewState 'sending'). Deliberately NOT busy on viewState 'error', so a
        // failed card stays actionable for retry (A2). Template gates every
        // interactive card's buttons on this.
        $scope.cardBusy = function (event) {
            return !!(event && event._submitting) || $scope.viewState === 'sending';
        };

        // A1/A2 -- shared in-flight/success/error orchestration for an interactive
        // card. Instead of stamping `_resolved` before the network call (buttons
        // vanish instantly, no recovery), we: flag `_submitting` (→ disabled +
        // spinner, buttons stay put), fire `runFn` (returns the resume promise),
        // and only flip `_resolved`+outcome on SUCCESS. On failure we clear
        // `_submitting` and stamp `_error` on the card so an inline error + the
        // still-live buttons give an in-place retry (the global banner still
        // shows too, via _handleError). `runFn` must return the resume promise.
        function _resolveCardVia(event, outcome, resolutionText, runFn) {
            if (!event || event._resolved || $scope.cardBusy(event)) return;
            event._submitting = true;
            event._error = null;
            var p = runFn();
            if (!p || typeof p.then !== 'function') {   // defensive (e.g. guard bailed)
                event._submitting = false;
                return;
            }
            p.then(function (res) {
                event._submitting = false;
                // The same resume promise also feeds _handleTurnResult, which may
                // have already re-flagged THIS card with a terminal outcome while
                // the promise settled (e.g. approval_unverified →
                // _flagPendingCardsUnverified). Don't clobber that terminal state
                // with the optimistic 'approve' stamp.
                if (event._outcome === 'unverified') return;
                // Someone answered this card first (the Monitor queue, another
                // tab). Nothing ran on this click: show THEIR decision, never a
                // "Confirmed by <me>" for an action this analyst did not take.
                var taken = res && res.error && res.error.code === 'already_decided';
                if (taken) {
                    var d = res.error.decided || {};
                    event._resolved = true;
                    event._outcome = d.decision === 'approve' ? 'approve' : 'reject';
                    event._open = false;
                    // The footer appends "· <who>", so the text names only the decision.
                    event._resolutionText = d.decision === 'approve' ? 'Already approved'
                        : d.decision === 'reject' ? 'Already rejected' : (res.error.message || 'Already answered');
                    event._resolvedBy = d.actor || '';
                    event._resolvedAt = d.decided_at ? d.decided_at * 1000 : Date.now();
                    event._decidedElsewhere = true;
                    return;
                }
                event._resolved = true;
                event._outcome = outcome;
                event._open = false;
                event._resolutionText = resolutionText;
                event._resolvedBy = $scope.initiator.name;
                event._resolvedAt = Date.now();
            }, function (err) {
                // Keep the card actionable; _handleError already ran the global
                // banner + scrub. Surface a bounded inline copy for in-card retry.
                event._submitting = false;
                event._error = _sanitizeError(err);
            });
        }

        $scope.confirmActionCard = function (event) {
            if (!event || event._resolved || $scope.cardBusy(event) || !$scope.actionCardValid(event)) return;
            var grant = event._grantAlways ? 'always' : undefined;
            _resolveCardVia(event, 'approve', 'Confirmed ' + event.summary, function () {
                return _runResumeAction(event.cardId, 'approve', event.args, grant, event.configId);
            });
        };

        // The configuration the card will run on right now: the analyst's pick
        // from the card's options, else the card's own. Null when the connector
        // sent none (the action runs on the default, and the card says nothing).
        $scope.actionCardRunsOn = function (event) {
            if (!event) return null;
            var opts = event.configOptions || [];
            for (var i = 0; i < opts.length; i++) {
                if (opts[i].id === event.configId) return opts[i];
            }
            return event.runsOn || null;
        };

        $scope.cancelActionCard = function (event) {
            _resolveCardVia(event, 'reject', 'Cancelled ' + event.summary, function () {
                return _runResumeAction(event.cardId, 'reject', null);
            });
        };

        // The open playbook's workflow IRI when the widget is mounted over the
        // designer -- the update-in-place target for Save and for applying an
        // accepted enhancement_offer. Guarded: only a `workflows` record is a valid
        // target; an alert/case IRI over the designer would be a mis-seed.
        function _openPlaybookIri() {
            var iri = ($scope.inPlaybookEditor && $scope.entityContext
                && $scope.entityContext.iri) ? $scope.entityContext.iri : null;
            if (iri && $scope.entityContext.module !== 'workflows') iri = null;
            return iri;
        }

        // playbook_offer (contract 2.5.0): the end-of-triage "Save as Playbook"
        // CTA. Accept compiles the session transcript into a FSRPB playbook and
        // pushes it; decline closes the session. Both resume via chat_resume with
        // the offer_id, mirroring the choice/action handlers above.
        $scope.acceptPlaybookOffer = function (event) {
            if (!event || event._resolved || $scope.viewState !== 'idle') return;
            var title = (event.title != null ? String(event.title).trim() : '')
                || event.titleSuggestion || '';
            event._resolved = true;
            event._outcome = 'accept';
            event._open = false;
            event._resolutionText = title ? ('Saving as “' + title + '”') : 'Saving as playbook';
            event._resolvedBy = $scope.initiator.name;
            event._resolvedAt = Date.now();
            _runResumeOffer(event.offerId, 'accept', title, _collectOfferEdits(event));
        };


        $scope.declinePlaybookOffer = function (event) {
            if (!event || event._resolved || $scope.viewState !== 'idle') return;
            event._resolved = true;
            event._outcome = 'decline';
            event._open = false;
            event._resolutionText = 'Not saved';
            event._resolvedBy = $scope.initiator.name;
            event._resolvedAt = Date.now();
            _runResumeOffer(event.offerId, 'decline', null);
        };

        // persona_offer: the assistant drafted the standing way to handle this
        // kind of record (its memory for the module). Save teaches it -- accept
        // writes the Key Store persona (connector _resume_persona_offer_accept,
        // which updates in place when one already exists). No title or edits:
        // the drafted persona is what the analyst reviewed on the card.
        $scope.acceptPersonaOffer = function (event) {
            if (!event || event._resolved || $scope.viewState !== 'idle') return;
            event._resolved = true;
            event._outcome = 'accept';
            event._open = false;
            event._resolutionText = 'Remembered';
            event._resolvedBy = $scope.initiator.name;
            event._resolvedAt = Date.now();
            _runResumeOffer(event.offerId, 'accept', null);
        };


        $scope.declinePersonaOffer = function (event) {
            if (!event || event._resolved || $scope.viewState !== 'idle') return;
            event._resolved = true;
            event._outcome = 'decline';
            event._open = false;
            event._resolutionText = 'Not saved';
            event._resolvedBy = $scope.initiator.name;
            event._resolvedAt = Date.now();
            _runResumeOffer(event.offerId, 'decline', null);
        };

        // enhancement_offer: apply a VERIFIED edit to the playbook the analyst
        // has open. playbook_offer's Save creates a new playbook; this Apply
        // updates the open one in place (connector-side update_playbook, which
        // snapshots into the Versions tab first).
        //
        // This passes the open playbook's
        // workflow_iri explicitly -- chat_resume carries no entity block
        // (contract §4), so the connector has no other way to know which
        // playbook to write, and it refuses rather than guessing.
        //
        // From the open designer, Apply works the way the analyst would: the
        // connector takes a restore point (Versions tab) and hands back the
        // edited playbook, which lands in the canvas as UNSAVED changes -- the
        // analyst reviews it and clicks the designer's Save. Canvas edits the
        // analyst has not saved would be replaced, so Apply waits for them.
        $scope.acceptEnhancementOffer = function (event) {
            if (!event || event._resolved || $scope.viewState !== 'idle') return;
            var _iri = _openPlaybookIri();
            var ds = _iri ? _designerScope() : null;
            if (ds && _designerHasUnsavedEdits(ds) && !_onlyOurStagedDraft(ds)) {
                event._blockedText = 'Save or discard your changes in the designer first -- '
                    + 'applying would replace them.';
                return;
            }
            event._blockedText = null;
            event._resolved = true;
            event._outcome = 'accept';
            event._open = false;
            event._resolutionText = ds ? 'Adding to the designer' : 'Applying to the open playbook';
            event._resolvedBy = $scope.initiator.name;
            event._resolvedAt = Date.now();
            _runResumeOffer(event.offerId, 'accept', null, null, _iri, ds ? 'canvas' : null);
        };

        $scope.declineEnhancementOffer = function (event) {
            if (!event || event._resolved || $scope.viewState !== 'idle') return;
            event._resolved = true;
            event._outcome = 'decline';
            event._open = false;
            event._resolutionText = 'Not applied';
            event._resolvedBy = $scope.initiator.name;
            event._resolvedAt = Date.now();
            _runResumeOffer(event.offerId, 'decline', null);
        };


        // Gate for the manual_input submit button -- all required fields filled
        // (parity with actionCardValid). Delegates to the pure render module.
        $scope.manualInputValid = function (event) {
            if (!event) return false;
            return $window.FsrPbRender.manualInputComplete(event);
        };

        // ── manual_input expiry ─────────────────────────────────────────────
        // A manual_input step can carry its own timeout. When it lapses the run
        // continues down its timeout branch and a later submit can NEVER land --
        // it retrieves as `{}` and nothing tells the analyst, so an abandoned
        // gate reads as an accepted one. The connector has always sent the
        // deadline (`expires_at` / `expires_in_seconds`); the widget read
        // neither, leaving it as a sentence baked into the question text that
        // went stale the moment it rendered. Now it is a live countdown, and the
        // submit is structurally refused past zero rather than merely discouraged.
        //
        // `ev._expiry` is recomputed by a 1s ticker rather than by a binding, so
        // the template stays a plain read and the digest cost is one pass over
        // the open cards -- and only while a deadline is actually running.
        var _expiryTimer = null;

        function _eachOpenManualInput(fn) {
            var msgs = ($scope.messages || []).slice();
            if ($scope.streamingMessage) msgs.push($scope.streamingMessage);
            for (var i = 0; i < msgs.length; i++) {
                var evs = (msgs[i] && msgs[i].events) || [];
                for (var j = 0; j < evs.length; j++) {
                    var ev = evs[j];
                    if (ev && ev.type === 'manual_input' && !ev._resolved) fn(ev);
                }
            }
        }

        function _tickExpiry() {
            var now = Date.now();
            var live = 0;
            var expiryOf = $window.FsrPbRender && $window.FsrPbRender.manualInputExpiry;
            if (!expiryOf) { _stopExpiryTicker(); return; }
            _eachOpenManualInput(function (ev) {
                var e = expiryOf(ev, now);
                ev._expiry = e;
                // Keep ticking only while something is still counting DOWN. An
                // already-lapsed card needs no further updates -- its state is
                // terminal -- so a chat full of expired gates costs nothing.
                if (e && !e.expired) live++;
            });
            if (!live) _stopExpiryTicker();
        }

        // Idempotent: safe to call after anything that may have added a card.
        // Ticks once immediately so a card is never rendered with a blank
        // countdown for up to a second before the first interval fires.
        function _syncExpiryTicker() {
            _tickExpiry();
            if (_expiryTimer || _destroyed) return;
            var running = false;
            _eachOpenManualInput(function (ev) {
                if (ev._expiry && !ev._expiry.expired) running = true;
            });
            if (running) _expiryTimer = $interval(_tickExpiry, 1000);
        }

        function _stopExpiryTicker() {
            if (_expiryTimer) { $interval.cancel(_expiryTimer); _expiryTimer = null; }
        }

        // Cards answered somewhere else. Another analyst, another tab, the
        // Monitor queue or an always-allow grant can answer a card this chat
        // still shows open; live, a second analyst saw Confirm & Execute on an
        // update that had already run. History carries the decisions, and
        // while a card is open the chat asks for them every
        // DECISION_POLL_MS (only when the page is visible and no turn runs).
        var DECISION_POLL_MS = 20000;
        var _decisionTimer = null;

        function _applyCardDecisions(decisions) {
            var changed = $window.FsrPbRender.applyCardDecisions($scope.messages, decisions);
            changed.forEach(function (ev) {
                if (ev.type === 'approval_request' && $scope.approvalRequest
                        && ($scope.approvalRequest.approvalId || '') === (ev.approvalId || '')) {
                    $scope.approvalRequest = null;
                    if ($scope.state === 'awaiting_approval') _setState('idle');
                }
            });
            if (changed.length) _logEvent('card_decided_elsewhere', { count: changed.length });
            return changed;
        }

        function _hasOpenCard() {
            return ($scope.messages || []).some(function (m) {
                return ((m && m.events) || []).some(function (ev) {
                    return ev && !ev._resolved
                        && (ev.type === 'action_card' || ev.type === 'approval_request');
                });
            });
        }

        function _pollDecisions() {
            if (_destroyed || !_hasOpenCard()) { _stopDecisionPoll(); return; }
            if ($window.document && $window.document.hidden) return;
            if ($scope.state === 'sending' || $scope.streamingMessage) return;
            var sid = _sessionId;
            fsrPbAgentService.chatCardDecisions($scope.config, sid).then(function (res) {
                if (_destroyed || sid !== _sessionId) return;
                _applyCardDecisions(res && res.card_decisions);
                if (!_hasOpenCard()) _stopDecisionPoll();
            }, function () { /* the next tick retries */ });
        }

        function _syncDecisionPoll() {
            if (_decisionTimer || _destroyed || !_hasOpenCard()) return;
            _decisionTimer = $interval(_pollDecisions, DECISION_POLL_MS);
        }

        function _stopDecisionPoll() {
            if (_decisionTimer) { $interval.cancel(_decisionTimer); _decisionTimer = null; }
        }

        // True once a gate's deadline has passed -- the submit/reject buttons are
        // disabled from here, because the run has already taken its timeout
        // branch and neither answer can reach it.
        $scope.manualInputExpired = function (event) {
            return !!(event && event._expiry && event._expiry.expired);
        };

        // `button` is one of the pause's own buttons ({label, primary}) when the
        // card shows them; absent for the generic Approve & Continue. The
        // primary button submits the form, so it needs the required fields; any
        // other ("Cancel", "Save Example") is a choice the run branches on and
        // goes through as chosen.
        $scope.submitManualInput = function (event, button) {
            if (!event || event._resolved || $scope.cardBusy(event)) return;
            var _option = (button && button.label) || null;
            if ((!button || button.primary) && !$scope.manualInputValid(event)) return;
            // The deadline is enforced here and not only on the disabled button:
            // the gate can lapse between the click and this handler, and an
            // answer sent past zero is silently discarded by the run.
            if ($scope.manualInputExpired(event)) return;
            var _inputId = event.inputId;
            var _values = _collapseManualValues(event);
            event._chosen = _option;
            _appendUserMessage(_manualInputUserText(_inputId, 'approve', _values, _option));
            _scrollToBottom(true);
            _resolveCardVia(event, 'approve', _option ? _option : 'Manual input submitted', function () {
                return _runResumeManualInput(event.inputId, event.workflowRunIri, 'approve',
                    _collapseManualValues(event), _option);
            });
        };

        // The pause shows its own buttons when it offers a real choice (two or
        // more); otherwise the generic Approve & Continue / Reject pair.
        $scope.manualInputHasChoice = function (event) {
            return !!(event && event.buttons && event.buttons.length >= 2);
        };

        // A button is disabled while the card is busy or lapsed; the primary
        // one also waits for the required fields.
        $scope.manualInputButtonDisabled = function (event, button) {
            if ($scope.cardBusy(event) || $scope.manualInputExpired(event)) return true;
            return !!(button && button.primary) && !$scope.manualInputValid(event);
        };

        // A pause's prompt is the playbook author's description: markdown on
        // current playbooks, rich-text HTML on older ones. YAML fences stay
        // visible here -- the chat renderer drops them because chat YAML has its
        // own panel, but a pause showing "Save as YAML" output has no other home.
        var _PROMPT_HTML = /<(p|br|div|ul|ol|li|table|tr|td|b|strong|em|i|span|h[1-6])\b[^>]*>/i;
        $scope.renderPromptText = function (text) {
            if (!text) return $sce.trustAsHtml('');
            if (_PROMPT_HTML.test(text)) return $sce.trustAsHtml(_sanitizeHtml(_cardHtml(String(text))));
            // Markdown descriptions still use the odd bare `<hr>` / `<br>` (the ZTPF
            // "Data Collected" pause does): make them markdown before escaping.
            return $scope.renderMarkdown(String(text)
                .replace(/^[ \t]*<hr\s*\/?>[ \t]*$/gim, '---')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/```ya?ml\b/gi, '```text'));
        };

        $scope.rejectManualInput = function (event) {
            // Reject rides the same `respond_manual_input` call as submit, so a
            // lapsed gate can no more be rejected than answered.
            if (!event || $scope.manualInputExpired(event)) return;
            _appendUserMessage(_manualInputUserText(event.inputId, 'reject', null));
            _scrollToBottom(true);
            _resolveCardVia(event, 'reject', 'Manual input rejected', function () {
                return _runResumeManualInput(event.inputId, event.workflowRunIri, 'reject', null);
            });
        };

        // Block-aware markdown -> safe HTML lives in fsrPbMarkdownService
        // (widgetAssets/js/fsrPbMarkdown.service.js). Same output, same $sce wrapper.
        $scope.renderMarkdown = function (text) { return fsrPbMarkdownService.render(text); };

        // Copy the playbook YAML with explicit "✓ Copied" feedback (mirrors the
        // export modal's copy affordance) -- previously there was no signal the
        // copy landed, and the muted-grey link read as disabled.
        $scope.yamlCopied = false;
        $scope.copyYaml = function () {
            if (!$scope.currentYaml) return;
            var done = function () {
                $scope.yamlCopied = true;
                $timeout(function () { $scope.yamlCopied = false; }, 1800);
                // The native clipboard promise resolves outside Angular's digest;
                // schedule one so the "✓ Copied" binding actually re-renders.
                $scope.$applyAsync();
            };
            // Clipboard API unavailable/blocked (insecure context, no permission,
            // unfocused doc) -- select the YAML body so the user can ⌘C manually.
            var selectFallback = function () {
                var el = document.querySelector('.fsr-pb-widget .yaml-pane .yaml-body');
                if (el && document.createRange && $window.getSelection) {
                    var r = document.createRange(); r.selectNodeContents(el);
                    var sel = $window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
                }
            };
            try {
                var p = $window.navigator.clipboard.writeText($scope.currentYaml);
                if (p && p.then) { p.then(done, selectFallback); } else { done(); }
            } catch (e) { selectFallback(); }
        };

        // Let the YAML pane "swap" to a wider split, borrowing width from the
        // chat side, so long step bodies aren't squeezed into 40%. Pure CSS
        // class toggle (see .yaml-wide in view.html); no layout reflow cost.
        $scope.yamlWide = false;
        $scope.toggleYamlWidth = function () { $scope.yamlWide = !$scope.yamlWide; };

        // Let the analyst hide the YAML pane entirely (some people just want the
        // chat and don't care to watch the YAML build up). When hidden the chat
        // takes the full width and a compact "Create Playbook" affordance moves to
        // the topbar so the build is still completable without revealing the pane.
        // The preference persists across reloads (view pref, not a config field).
        $scope.yamlHidden = (function () {
            try { return $window.localStorage.getItem('fsrPbYamlHidden') === '1'; }
            catch (e) { return false; }
        })();
        $scope.toggleYamlHidden = function () {
            $scope.yamlHidden = !$scope.yamlHidden;
            try { $window.localStorage.setItem('fsrPbYamlHidden', $scope.yamlHidden ? '1' : '0'); }
            catch (e) {}
        };
        // True when there's an authored playbook to show (build mode + YAML) --
        // gates both the toggle and the topbar Create shortcut.
        // The build authoring pane (and its Show YAML / Create Playbook header
        // controls) is editor-only over a record: it surfaces ONLY inside the
        // playbook designer, or once the analyst has explicitly invoked the
        // triage→playbook handoff (_buildHandoffActive). A stray ```yaml the
        // agent emitted mid-triage no longer flips a module/record into build.
        $scope.hasYamlPane = function () {
            if (!$scope.currentYaml || $scope.uiIntent === 'triage') return false;
            return $scope.inPlaybookEditor || $scope._buildHandoffActive;
        };

        // ─── Per-step Verify (Track C3 -- interactive debug UI) ───────────────
        // The YAML pane surfaces a "Verify" control per parsed step. It drives
        // fsrPbAgentService.stepTest → the connector's `step_test` tool, which
        // renders that one step's args and (for safe ops) executes it, returning
        // {status, rendered_args, output_top_keys, note, needs_confirm, risk}.
        // A non-safe op short-circuits to needs_confirm; we surface a confirm
        // dialog and re-probe with {confirm:true} only on the user's OK.
        $scope.verifyResults = {};   // stepId → rendered result record
        $scope.verifyBusy    = {};   // stepId → in-flight flag
        $scope.verifyConfirm = null; // pending needs_confirm: {stepId, note, risk}


        // Parse the current YAML into a flat [{id, name, type}] step list for the
        // Verify affordance. Hand-rolled (no YAML lib on the platform): scan for
        // `steps:` blocks, treat each `- ` item inside as a step, and capture its
        // name/id/type keys. Memoized on the YAML text so ng-repeat doesn't
        // reparse every digest.
        $scope.yamlSteps = function () {
            var yaml = $scope.currentYaml || '';
            if ($scope._ysKey === yaml) return $scope._ysCache;
            var out = [], lines = yaml.split('\n');
            var inSteps = false, stepsIndent = -1, cur = null;
            var indentOf = function (l) { return l.length - l.replace(/^\s+/, '').length; };
            var flush = function () {
                if (cur && (cur.name || cur.rawId)) {
                    var id = _stepIdOf(cur.rawId || cur.name);
                    if (id) out.push({ id: id, name: cur.name || id, type: cur.type || '' });
                }
                cur = null;
            };
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (!line.trim()) continue;
                var ind = indentOf(line), m;
                if (!inSteps) {
                    if (/^\s*steps\s*:\s*$/.test(line)) { inSteps = true; stepsIndent = ind; }
                    continue;
                }
                if (ind <= stepsIndent) {
                    flush(); inSteps = false;
                    if (/^\s*steps\s*:\s*$/.test(line)) { inSteps = true; stepsIndent = ind; }
                    continue;
                }
                if ((m = line.match(/^(\s*)-\s*(.*)$/))) {
                    flush(); cur = {};
                    // A step's direct keys sit one indent level in from the `-`
                    // marker; nested keys (arguments.resource.name, …) are deeper
                    // and must NOT clobber the step's own name/id/type.
                    cur.keyIndent = m[1].length + 2;
                    var im, rest = m[2];
                    if ((im = rest.match(/^name\s*:\s*(.+)$/))) cur.name = _yamlVal(im[1]);
                    else if ((im = rest.match(/^id\s*:\s*(.+)$/))) cur.rawId = _yamlVal(im[1]);
                    else if ((im = rest.match(/^type\s*:\s*(.+)$/))) cur.type = _yamlVal(im[1]);
                    continue;
                }
                if (!cur || ind !== cur.keyIndent) continue; // only direct step keys
                if ((m = line.match(/^\s*name\s*:\s*(.+)$/))) cur.name = _yamlVal(m[1]);
                else if ((m = line.match(/^\s*id\s*:\s*(.+)$/))) cur.rawId = _yamlVal(m[1]);
                else if ((m = line.match(/^\s*type\s*:\s*(.+)$/))) cur.type = _yamlVal(m[1]);
            }
            flush();
            $scope._ysKey = yaml; $scope._ysCache = out;
            return out;
        };

        $scope.verifyStep = function (stepId, confirm) {
            if (!$scope.currentYaml || !stepId || $scope.verifyBusy[stepId]) return;
            $scope.verifyBusy[stepId] = true;
            _logEvent('action_call', { action: 'step_test', step_id: stepId, confirm: !!confirm });
            fsrPbAgentService.stepTest($scope.config, $scope.currentYaml, stepId, { confirm: !!confirm })
                .then(function (res) {
                    $scope.verifyBusy[stepId] = false;
                    res = res || {};
                    _logEvent('action_result', { action: 'step_test', step_id: stepId, status: res.status, ok: res.ok });
                    // Non-safe op the user hasn't acknowledged -- gate on confirm
                    // rather than rendering a half-run result.
                    if (res.needs_confirm || res.status === 'needs_confirm') {
                        $scope.verifyConfirm = {
                            stepId: stepId,
                            note: res.note || '',
                            risk: res.risk || res.tier || ''
                        };
                        return;
                    }
                    $scope.verifyConfirm = null;
                    res.renderedArgsDisplay = res.rendered_args
                        ? JSON.stringify(res.rendered_args, null, 2) : '';
                    res.output_top_keys = res.output_top_keys || [];
                    $scope.verifyResults[stepId] = res;
                })
                .catch(function (err) {
                    $scope.verifyBusy[stepId] = false;
                    $scope.verifyResults[stepId] = {
                        status: 'error',
                        note: (err && err.message) || 'Verify failed',
                        output_top_keys: []
                    };
                });
        };

        $scope.confirmVerifyStep = function () {
            if (!$scope.verifyConfirm) return;
            var id = $scope.verifyConfirm.stepId;
            $scope.verifyConfirm = null;
            $scope.verifyStep(id, true);
        };
        $scope.cancelVerifyStep = function () { $scope.verifyConfirm = null; };

        // ─── Apply-patch (Track C3) -- one-click compiler auto-fixes ──────────
        // validate_yaml/compile_yaml return `corrected_yaml` + `auto_fixes[]`
        // when the compiler can mechanically repair known foot-guns (namespace
        // refs, `vars.input.<p>` missing `.params.`, `stop`→`end`, …). Surface
        // that as a reviewable before→after patch the analyst applies with one
        // click, rather than re-authoring each warning by hand.
        $scope.patchProposal = null;    // { autoFixes:[{code,line,message}], correctedYaml, note }
        $scope.patchClean = false;      // transient "no fixes needed" acknowledgement

        $scope.checkAndFix = function () {
            if (!$scope.currentYaml || $scope.viewState !== 'idle') return;
            $scope.patchClean = false;
            _setState('sending');
            _logEvent('action_call', { action: 'validate_yaml', purpose: 'check_and_fix' });
            fsrPbAgentService.validateYamlLive($scope.config, $scope.currentYaml)
                .then(function (res) {
                    res = res || {};
                    var corrected = res.corrected_yaml;
                    var fixes = res.auto_fixes || [];
                    _logEvent('action_result', {
                        action: 'validate_yaml', ok: res.ok, autoFixes: fixes.length });
                    if (corrected && corrected !== $scope.currentYaml) {
                        $scope.patchProposal = {
                            autoFixes: fixes,
                            correctedYaml: corrected,
                            note: res.auto_fix_note || ''
                        };
                    } else {
                        // Nothing to mechanically fix. If validation surfaced
                        // hard errors, hand them to the chat; otherwise flash a
                        // "clean" acknowledgement.
                        if (res.ok === false) {
                            _appendSystemMessage('Validation errors:\n'
                                + JSON.stringify(res.errors || res, null, 2));
                        } else {
                            $scope.patchClean = true;
                            $timeout(function () { $scope.patchClean = false; }, 2400);
                        }
                    }
                    _setState('idle');
                })
                .catch(_handleError);
        };

        $scope.applyPatch = function () {
            if (!$scope.patchProposal) return;
            var n = ($scope.patchProposal.autoFixes || []).length;
            $scope.currentYaml = $scope.patchProposal.correctedYaml; // $watch clears stale verify/patch state
            _logEvent('patch_applied', { autoFixes: n });
            _appendSystemMessage('Applied ' + n + ' auto-fix' + (n === 1 ? '' : 'es')
                + ' to the playbook YAML.');
        };
        $scope.dismissPatch = function () { $scope.patchProposal = null; };

        // ─── Diagnose & fix (Track C3) -- value-level render-path patches ──────
        // `Check & fix` above handles the compiler's mechanical, whole-YAML
        // auto-fixes. This is its render-path sibling: analyze_playbook surfaces
        // semantic diagnostics (unreachable var paths, missing/close-match keys,
        // picklist drift, empty required args) and suggest_fix_for_diagnostic
        // turns each into a structured value-level patch
        // {step_id, location, before, after, confidence, explanation, kind}.
        // We render them as reviewable before→after proposals. A patch is
        // one-click "applicable" only when its `before` value appears EXACTLY
        // once in the YAML -- an unambiguous, safe textual swap. Ambiguous or
        // non-literal fixes are shown read-only with a "Send to chat" escape
        // hatch so the agent applies them with full structural context.
        $scope.valuePatches = null;   // [{stepId, location, before, after, confidence, explanation, kind, applicable, applied}]
        $scope.valuePatchClean = false;
        var _valuePatchApply = false; // suppresses the currentYaml $watch teardown of the batch during a self-apply



        $scope.diagnoseAndFix = function () {
            if (!$scope.currentYaml || $scope.viewState !== 'idle') return;
            $scope.valuePatchClean = false;
            $scope.valuePatches = null;
            _setState('sending');
            _logEvent('action_call', { action: 'analyze_playbook', purpose: 'diagnose_and_fix' });
            fsrPbAgentService.analyzePlaybook($scope.config, $scope.currentYaml)
                .then(function (res) {
                    res = res || {};
                    var diags = res.diagnostics || [];
                    _logEvent('action_result', {
                        action: 'analyze_playbook', ok: res.ok, diagnostics: diags.length });
                    if (!diags.length) {
                        // A genuine analysis FAILURE (could not analyze: bad
                        // YAML, backend error) reports ok:false with an error
                        // and no diagnostics. Do not flash "No issues found" --
                        // nothing was checked. (ok:false WITH diagnostics is a
                        // successful analysis that found issues, handled below.)
                        if (res.ok === false && res.error) {
                            _handleError(res.error);
                            return null;
                        }
                        $scope.valuePatchClean = true;
                        $timeout(function () { $scope.valuePatchClean = false; }, 2400);
                        _setState('idle');
                        return null;
                    }
                    // Resolve each diagnostic to a structured fix in parallel; a
                    // diagnostic with no auto-fix recipe (ok:false) is dropped.
                    return $q.all(diags.map(function (d) {
                        return fsrPbAgentService.suggestFix($scope.config, d)
                            .then(function (fix) { return fix; }, function () { return null; });
                    })).then(function (fixes) {
                        var patches = [];
                        (fixes || []).forEach(function (fix) {
                            if (fix && fix.ok === true) patches.push(_toPatch(fix, $scope.currentYaml));
                        });
                        _logEvent('action_result', {
                            action: 'suggest_fix_for_diagnostic', proposals: patches.length });
                        if (patches.length) {
                            $scope.valuePatches = patches;
                        } else {
                            $scope.valuePatchClean = true;
                            $timeout(function () { $scope.valuePatchClean = false; }, 2400);
                        }
                        _setState('idle');
                    });
                })
                .catch(_handleError);
        };

        $scope.applyValuePatch = function (idx) {
            var p = $scope.valuePatches && $scope.valuePatches[idx];
            if (!p || !p.applicable || p.applied) return;
            // Re-check uniqueness against the CURRENT yaml -- an earlier apply in
            // this same batch may have shifted occurrence counts.
            if (_occurrences($scope.currentYaml, p.before) !== 1) { p.applicable = false; return; }
            _valuePatchApply = true; // keep the panel through the self-induced $watch
            $scope.currentYaml = $scope.currentYaml.replace(p.before, p.after);
            p.applied = true;
            _logEvent('patch_applied', { kind: p.kind, location: p.location, valueLevel: true });
            _appendSystemMessage('Applied fix at ' + (p.location || p.stepId || 'step')
                + ': `' + p.before + '` → `' + p.after + '`.');
        };

        // Non-applicable (ambiguous/structural) proposal → hand it to the agent
        // with full context by seeding the composer, so the analyst can send it.
        $scope.sendPatchToChat = function (idx) {
            var p = $scope.valuePatches && $scope.valuePatches[idx];
            if (!p) return;
            var ask = 'Fix the ' + (p.kind || 'issue')
                + (p.stepId ? ' in step "' + p.stepId + '"' : '')
                + (p.location ? ' at ' + p.location : '')
                + ': change `' + p.before + '` to `' + p.after + '`.';
            var existing = ($scope.form.inputText || '').trim();
            $scope.form.inputText = existing ? (existing + '\n' + ask) : ask;
        };

        $scope.dismissValuePatches = function () { $scope.valuePatches = null; };

        // U7: the troubleshoot card's one primary action. It hands the fix to the
        // assistant by seeding the composer; the analyst sends it (nothing runs here).
        $scope.troubleshootPrimary = function (ev) {
            if (!ev || !ev.primary || !ev.primary.ask) return;
            var existing = ($scope.form.inputText || '').trim();
            $scope.form.inputText = existing ? (existing + '\n' + ev.primary.ask) : ev.primary.ask;
        };

        // ─── Interactive debug session (Track C3 debug drawer) ───────────────
        // A stateful walker on the connector: startDebugSession returns a
        // session_id + status; step/continue advance it; stop drops it. The
        // status snapshot (paused_at, steps_advanced, trace[], last_step,
        // first_error, breakpoints) drives the panel. Breakpoints are toggled on
        // the parsed step list and applied on start + on continue.
        $scope.debug = {
            active: false,   // panel open
            sessionId: null, // live session id
            status: null,    // latest status snapshot
            busy: false,     // an op is in flight
            error: '',       // last op error
            breakpoints: {}  // stepId → true
        };

        function _debugFail(err) {
            $scope.debug.busy = false;
            $scope.debug.error = (err && err.message) || 'Debug session error';
            _logEvent('error', { scope: 'debug', message: $scope.debug.error });
        }
        function _debugApply(res) {
            $scope.debug.busy = false;
            res = res || {};
            if (res.ok === false) { $scope.debug.error = res.error || 'Debug op failed'; return null; }
            $scope.debug.error = '';
            if (res.status) $scope.debug.status = res.status;
            return res;
        }

        $scope.openDebug = function () {
            if (!$scope.currentYaml) return;
            $scope.debug.active = true;
            $scope.debug.error = '';
        };
        // Close the panel; drop any live session on the connector so it doesn't
        // linger in the SessionStore until its TTL.
        $scope.closeDebug = function () {
            if ($scope.debug.sessionId) $scope.stopDebug();
            $scope.debug.active = false;
        };

        $scope.toggleBreakpoint = function (stepId) {
            if (!stepId) return;
            if ($scope.debug.breakpoints[stepId]) delete $scope.debug.breakpoints[stepId];
            else $scope.debug.breakpoints[stepId] = true;
            // Live session already running -- new breakpoints take effect on the
            // next continue (add_breakpoints); removing one can't be un-set on
            // the connector mid-session, but the local map still reflects intent.
        };
        function _breakpointList() { return Object.keys($scope.debug.breakpoints); }

        $scope.startDebug = function () {
            if (!$scope.currentYaml || $scope.debug.busy) return;
            $scope.debug.busy = true;
            $scope.debug.error = '';
            _logEvent('action_call', { action: 'start_debug_session' });
            fsrPbAgentService.startDebugSession($scope.config, $scope.currentYaml, {
                breakpoints: _breakpointList()
            })
                .then(function (res) {
                    res = _debugApply(res);
                    if (res && res.status) {
                        $scope.debug.sessionId = res.status.session_id;
                        _logEvent('action_result', { action: 'start_debug_session',
                            session_id: res.status.session_id, paused_at: res.status.paused_at });
                    }
                })
                .catch(_debugFail);
        };

        $scope.debugStep = function () {
            if (!$scope.debug.sessionId || $scope.debug.busy) return;
            $scope.debug.busy = true;
            _logEvent('action_call', { action: 'step_debug_session' });
            fsrPbAgentService.stepDebugSession($scope.config, $scope.debug.sessionId)
                .then(_debugApply).catch(_debugFail);
        };

        $scope.debugContinue = function () {
            if (!$scope.debug.sessionId || $scope.debug.busy) return;
            $scope.debug.busy = true;
            _logEvent('action_call', { action: 'continue_debug_session' });
            fsrPbAgentService.continueDebugSession($scope.config, $scope.debug.sessionId, {
                addBreakpoints: _breakpointList()
            })
                .then(_debugApply).catch(_debugFail);
        };

        $scope.stopDebug = function () {
            var sid = $scope.debug.sessionId;
            if (!sid) return;
            $scope.debug.sessionId = null;
            _logEvent('action_call', { action: 'stop_debug_session' });
            fsrPbAgentService.stopDebugSession($scope.config, sid)
                .then(function (res) { _debugApply(res); })
                .catch(function () { /* session already gone -- ignore */ });
        };

        // Convenience view helpers for the debug panel.
        $scope.debugDone = function () {
            return !!($scope.debug.status && $scope.debug.status.done);
        };
        $scope.debugTrace = function () {
            return ($scope.debug.status && $scope.debug.status.trace) || [];
        };

        // Stale results/gate when the YAML changes underneath the pane (a new
        // draft, a rehydrated session, a reset) -- the old per-step verdicts no
        // longer describe the current steps.
        $scope.$watch('currentYaml', function (nv, ov) {
            if (nv === ov) return;
            $scope.verifyResults = {};
            $scope.verifyBusy = {};
            $scope.verifyConfirm = null;
            $scope.patchProposal = null;
            // Value-level patches reference literal `before` strings that a YAML
            // edit can invalidate, so drop the batch on an external edit -- but
            // NOT when the edit was our own one-click apply (we keep the panel so
            // the analyst can apply the remaining proposals).
            if (_valuePatchApply) { _valuePatchApply = false; }
            else { $scope.valuePatches = null; $scope.valuePatchClean = false; }
            // A live debug session walks the YAML it started with; once the YAML
            // changes the session is stale. Drop it on the connector
            // (fire-and-forget -- don't reapply its final snapshot, we're
            // resetting) and clear the panel state.
            if ($scope.debug) {
                var _sid = $scope.debug.sessionId;
                $scope.debug.sessionId = null;
                $scope.debug.status = null;
                $scope.debug.error = '';
                if (_sid) {
                    fsrPbAgentService.stopDebugSession($scope.config, _sid)
                        .catch(function () { /* session already gone -- ignore */ });
                }
            }
        });

        // ─── Export chat activity (for review) ───────────────────────────────
        // Serialize the whole session -- messages, every tool call + result,
        // interactive cards and how they were resolved, the current YAML, token
        // usage, and the raw client event log -- into one Markdown document the
        // analyst can copy or download and hand to a reviewer. Pure read of
        // scope state; no connector call.
        $scope.exportOpen = false;
        $scope.form.exportText = '';
        $scope.exportCopied = false;

        function _exportModeInfo() {
            try { return fsrPbAgentService.modeInfo($scope.config) || {}; } catch (e) { return {}; }
        }




        // Chat export documents are built by fsrPbExportService
        // (widgetAssets/js/fsrPbExport.service.js) from a snapshot of this scope.
        function _exportSnapshot() {
            return {
                modeInfo: _exportModeInfo(),
                messages: $scope.messages,
                currentYaml: $scope.currentYaml,
                uiIntent: $scope.uiIntent,
                widgetVersion: $scope.widgetVersion,
                contractVersion: WIDGET_CONTRACT_VERSION,
                connectorInfo: $scope.connectorInfo,
                entityContext: $scope.entityContext,
                usage: $scope.usage,
                contractBanner: $scope.contractBanner,
                errorMessage: $scope.errorMessage,
                sessionId: _sessionId,
                eventLog: _eventLog,
                scrub: _scrubSecrets
            };
        }
        function _buildExportMarkdown() { return fsrPbExportService.buildMarkdown(_exportSnapshot()); }
        function _buildExportEventsJson() { return fsrPbExportService.buildEventsJson(_exportSnapshot()); }


        $scope.downloadExportJson = function () {
            try {
                var blob = new $window.Blob([_buildExportEventsJson()], { type: 'application/json' });
                var url = $window.URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'fsrpb-chat-' + _sessionId + '.events.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                $timeout(function () { $window.URL.revokeObjectURL(url); }, 0);
                _logEvent('export_downloaded_json', {});
            } catch (e) { /* download not available -- md/copy is the fallback */ }
        };

        $scope.openExport = function () {
            $scope.form.exportText = _buildExportMarkdown();
            $scope.exportCopied = false;
            $scope.exportOpen = true;
            _logEvent('export_opened', { messages: $scope.messages.length });
        };
        $scope.closeExport = function () { $scope.exportOpen = false; };

        // ─── History browser (prior conversations) ───────────────────────────
        // Lists every stored conversation (server-side, keyed by session_id)
        // newest-first so the analyst can reopen a past chat. The current
        // session only lives in localStorage, so without this a "New
        // conversation" orphaned the prior chat -- the transcript survived in the
        // connector store but its id was lost from the UI.
        $scope.historyOpen = false;
        $scope.historyLoading = false;
        $scope.historyError = '';
        $scope.sessions = [];
        // The search text + rating filter live on an OBJECT (not bare $scope
        // primitives): the history panel renders under `ng-if`, which spawns a
        // child scope, and a bare `ng-model="historyQuery"` there would shadow a
        // NEW primitive on the child while filteredSessions() reads the parent's
        // untouched copy (the classic AngularJS dot-rule trap). Binding through
        // `historyUi.*` writes back to this one object every scope shares.
        $scope.historyUi = { query: '', filter: 'all' };  // filter: all|up|down|flagged

        // Search WITHIN sessions (content search). When the search box carries a
        // keyword, ask the connector to grep transcript CONTENT across ALL stored
        // sessions -- not just the 50 recent, and not just titles -- so "FIXME"
        // finds any conversation that MENTIONS it, each row carrying a match
        // `snippet`. Empty query falls back to the recent list. A monotonic token
        // drops a stale response so fast typing never renders an earlier query.
        $scope.searchResults = null;   // null ⇒ no active content search
        $scope.searching = false;
        var _searchSeq = 0;
        $scope.$watch('historyUi.query', function (q) {
            q = (q || '').trim();
            if (!q) { $scope.searchResults = null; $scope.searching = false; return; }
            var seq = ++_searchSeq;
            $scope.searching = true;
            fsrPbAgentService.listSessions($scope.config, q)
                .then(function (res) {
                    if (seq !== _searchSeq) return;   // superseded by a newer query
                    $scope.searchResults = (res && res.sessions) || [];
                    $scope.searching = false;
                })
                .catch(function () {
                    if (seq !== _searchSeq) return;
                    $scope.searchResults = [];
                    $scope.searching = false;
                });
        });

        // The visible history rows: the recent list (or the content-search
        // results when a keyword is active), then the rating chip. A getter, so
        // it re-derives as the query / results / ratings change.
        $scope.filteredSessions = function () {
            var q = ($scope.historyUi.query || '').trim();
            var list = q ? ($scope.searchResults || []) : ($scope.sessions || []);
            var f = $scope.historyUi.filter;
            if (f && f !== 'all') {
                list = list.filter(function (s) {
                    var r = s.rating && s.rating.rating;
                    return f === 'flagged' ? !!r : r === f;
                });
            }
            return list;
        };

        // True while a content search is in flight (query typed, results pending).
        $scope.historySearching = function () {
            return $scope.searching &&
                ($scope.historyUi.query || '').trim() !== '';
        };
        $scope.sessionRating = function (s) { return (s && s.rating && s.rating.rating) || ''; };

        // Toggle a 👍/👎 on a session. Clicking the active rating clears it.
        // Optimistic: update the row immediately, revert on error. Stops the
        // click from also opening the session (the row is clickable).
        $scope.rateSession = function (s, rating, $event) {
            if ($event) { $event.stopPropagation(); $event.preventDefault(); }
            if (!s || !s.session_id) return;
            var prev = s.rating || null;
            var next = ($scope.sessionRating(s) === rating) ? '' : rating;
            s.rating = next ? { rating: next, note: (prev && prev.note) || null } : null;
            _logEvent('session_rated', { session: s.session_id, rating: next || 'cleared' });
            fsrPbAgentService.rateSession($scope.config, s.session_id, next, (prev && prev.note) || '')
                .then(function (res) { s.rating = (res && res.rating) || (next ? s.rating : null); })
                .catch(function () { s.rating = prev; });   // revert on failure
        };

        // ── Live-session rating ──────────────────────────────────────────────
        // The same 👍/👎 the History panel shows per row, but for the session
        // the analyst is currently in -- so they can rate a conversation without
        // reopening it from history. Reuses the rate_session sink (and its
        // optimistic-update-with-revert) via $scope.rateSession, keyed to a
        // stable object whose session_id is re-synced to _sessionId at click
        // time (it changes on "+ New" / session switch). The rating is NOT
        // re-seeded on reload -- chat_history doesn't echo it (contract
        // follow-up), so the control reflects what you set this session; the
        // write persists regardless.
        var _liveSession = { session_id: _sessionId, rating: null };

        // True once the active session has produced at least one assistant turn.
        // Nothing to rate on an empty / greeting-only conversation, so the
        // control stays hidden until there's real output to judge.
        $scope.canRateLiveSession = function () {
            if (!_sessionId) return false;
            for (var i = 0; i < $scope.messages.length; i++) {
                if ($scope.messages[i].role === 'assistant') return true;
            }
            return false;
        };

        $scope.liveSessionRating = function () {
            return (_liveSession.rating && _liveSession.rating.rating) || '';
        };

        $scope.rateThisSession = function (rating, $event) {
            _liveSession.session_id = _sessionId;   // re-sync (new / switched session)
            $scope.rateSession(_liveSession, rating, $event);
        };

        // A rating belongs to one session; drop it whenever the active session
        // changes so the control doesn't show a stale verdict on a new thread.
        function _resetLiveRating() { _liveSession.rating = null; }

        // When switching to a stored session we can't read its rating from
        // chat_history (the contract doesn't echo it), but the History list --
        // if it's been opened this session -- already carries each row's rating.
        // Seed from there when available so the live control reflects a prior
        // verdict; otherwise start blank.
        function _seedLiveRatingFromHistory(sessionId) {
            var match = ($scope.sessions || []).filter(function (s) {
                return s && s.session_id === sessionId;
            })[0];
            _liveSession.rating = (match && match.rating) || null;
        }

        $scope.openHistory = function () {
            $scope.historyOpen = true;
            $scope.historyError = '';
            $scope.historyLoading = true;
            $scope.sessions = [];
            $scope.searchResults = null;
            $scope.searching = false;
            $scope.historyUi = { query: '', filter: 'all' };
            _logEvent('history_opened', {});
            fsrPbAgentService.listSessions($scope.config)
                .then(function (res) {
                    $scope.sessions = (res && res.sessions) || [];
                    $scope.historyLoading = false;
                })
                .catch(function (err) {
                    $scope.historyError = (err && err.message) || 'Could not load conversation history.';
                    $scope.historyLoading = false;
                });
        };

        $scope.closeHistory = function () { $scope.historyOpen = false; };

        // ─── Scheduled tasks (recurring agent runs) ─────────────────────────
        // scheduled-agent-tasks plan: each task = one generated runner playbook
        // + one FortiSOAR scheduler row. The widget manages the prompt; the
        // schedule is plumbing. Mirrors the history-panel async convention.
        $scope.scheduledOpen = false;
        $scope.scheduledLoading = false;
        $scope.scheduledError = '';
        $scope.scheduledTasks = [];
        $scope.scheduledEditing = false;
        $scope.scheduledEditingExisting = false;
        $scope.scheduledSaving = false;
        $scope.scheduledFormError = '';
        $scope.scheduledDraft = {};

        $scope.openScheduledTasks = function () {
            $scope.scheduledOpen = true;
            $scope.scheduledError = '';
            $scope.scheduledLoading = true;
            $scope.scheduledTasks = [];
            $scope.scheduledEditing = false;
            $scope.scheduledFormError = '';
            _logEvent('scheduled_opened', {});
            fsrPbAgentService.listScheduledTasks($scope.config)
                .then(function (res) {
                    $scope.scheduledTasks = (res && res.tasks) || [];
                    $scope.scheduledLoading = false;
                })
                .catch(function (err) {
                    $scope.scheduledError = (err && err.message) || 'Could not load scheduled tasks.';
                    $scope.scheduledLoading = false;
                });
        };
        $scope.closeScheduledTasks = function () { $scope.scheduledOpen = false; };

        function _blankScheduledDraft() {
            return { name: '', cron: '0 9 * * 1', prompt: '', intent: 'triage',
                     agent_config: 'fsrpb-anthropic', allow_mutating: false,
                     enabled: true, notify_target: '' };
        }

        $scope.newScheduledTask = function () {
            $scope.scheduledEditing = true;
            $scope.scheduledEditingExisting = false;
            $scope.scheduledFormError = '';
            $scope.scheduledDraft = _blankScheduledDraft();
        };

        $scope.editScheduledTask = function (t) {
            $scope.scheduledEditing = true;
            $scope.scheduledEditingExisting = true;
            $scope.scheduledFormError = '';
            $scope.scheduledDraft = {
                name: t.name, cron: t.cron, prompt: t.prompt,
                intent: t.intent || 'triage',
                agent_config: t.agent_config || 'fsrpb-anthropic',
                allow_mutating: !!t.allow_mutating,
                enabled: t.enabled !== false,
                notify_target: t.notify_target || '',
            };
        };

        $scope.cancelScheduledEdit = function () {
            $scope.scheduledEditing = false;
            $scope.scheduledFormError = '';
        };

        // Human-readable cron preview ("Every Monday 09:00"). A small helper
        // for the common 5-field forms; advanced expressions fall through to
        // the raw string (the analyst still sees what they typed).
        $scope.scheduledCronPreview = function () {
            var c = ($scope.scheduledDraft && $scope.scheduledDraft.cron) || '';
            var p = String(c).trim().split(/\s+/);
            if (p.length !== 5) return '';
            var minute = p[0], hour = p[1], dom = p[2], mon = p[3], dow = p[4];
            var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            var at = (hour === '*' ? 'every hour' : (hour.length <= 2 ? hour.padStart(2,'0') + ':' + (minute === '*' ? '00' : minute.padStart(2,'0')) : hour + ':' + minute));
            var dayPart = (dow === '*' ? 'every day' : (days[+dow] || ('day ' + dow)));
            var datePart = (dom === '*' && mon === '*' ? '' : (' on day ' + dom + (mon !== '*' ? '/' + mon : '')));
            if (dow !== '*' && dom === '*') return dayPart === 'every day' ? 'Daily at ' + at : 'Every ' + dayPart + ' at ' + at;
            if (dow === '*' && dom === '*' && mon === '*') return 'Daily at ' + at;
            return dayPart + datePart + ' at ' + at;
        };

        $scope.saveScheduledTask = function () {
            var d = $scope.scheduledDraft;
            if (!d.name || !d.cron || !d.prompt) {
                $scope.scheduledFormError = 'Name, schedule, and prompt are required.';
                return;
            }
            $scope.scheduledSaving = true;
            $scope.scheduledFormError = '';
            var payload = {
                name: d.name, cron: d.cron, intent: d.intent || 'triage',
                prompt: d.prompt, agent_config: d.agent_config || 'fsrpb-anthropic',
                allow_mutating: !!d.allow_mutating, enabled: d.enabled !== false,
                notify_target: d.notify_target || '',
            };
            var op = $scope.scheduledEditingExisting
                ? fsrPbAgentService.updateScheduledTask($scope.config, payload)
                : fsrPbAgentService.createScheduledTask($scope.config, payload);
            op.then(function (res) {
                if (res && res.ok === false) {
                    $scope.scheduledFormError = (res.error && res.error.message) || 'Save failed.';
                    $scope.scheduledSaving = false;
                    return;
                }
                $scope.scheduledSaving = false;
                $scope.scheduledEditing = false;
                // Refresh the list.
                fsrPbAgentService.listScheduledTasks($scope.config).then(function (r) {
                    $scope.scheduledTasks = (r && r.tasks) || [];
                });
            }).catch(function (err) {
                $scope.scheduledFormError = (err && err.message) || 'Save failed.';
                $scope.scheduledSaving = false;
            });
        };

        $scope.runScheduledTaskNow = function (name) {
            fsrPbAgentService.runScheduledTaskNow($scope.config, name)
                .then(function (res) {
                    if (res && res.ok === false) {
                        $scope.scheduledError = (res.error && res.error.message) || 'Trigger failed.';
                    } else {
                        $scope.scheduledError = '';
                    }
                })
                .catch(function (err) {
                    $scope.scheduledError = (err && err.message) || 'Trigger failed.';
                });
        };

        $scope.removeScheduledTask = function (name) {
            if (!confirm('Delete scheduled task "' + name + '"? This removes the schedule and the generated runner playbook.')) return;
            fsrPbAgentService.deleteScheduledTask($scope.config, name)
                .then(function () {
                    $scope.scheduledTasks = ($scope.scheduledTasks || []).filter(function (t) { return t.name !== name; });
                })
                .catch(function (err) {
                    $scope.scheduledError = (err && err.message) || 'Delete failed.';
                });
        };

        // ─── Scheduled tasks: per-task run history drawer (plan §8.4) ──────────
        // Each cron fire is a stored chat session (id ``sched:<name>:<uuid>``).
        // This drawer lists those runs newest-first with their outcome, and a
        // "Resume" handoff for parked (HITL-gated) runs: it closes the drawer and
        // hands the session to the existing chat history path (loadSession),
        // which rehydrates the transcript AND re-surfaces any pending approval
        // card -- so an analyst approves the gated action inline, exactly as
        // the plan's "resume from the chat History panel" describes. No new
        // transcript rendering: the chat already owns that.
        $scope.scheduledHistoryOpen = false;
        $scope.scheduledHistoryTask = null;
        $scope.scheduledRuns = [];
        $scope.scheduledRunsLoading = false;
        $scope.scheduledRunsError = '';

        $scope.openScheduledHistory = function (t) {
            $scope.scheduledHistoryOpen = true;
            $scope.scheduledHistoryTask = t && t.name ? t : { name: t };
            $scope.scheduledRunsError = '';
            $scope.scheduledRunsLoading = true;
            $scope.scheduledRuns = [];
            _logEvent('scheduled_history_opened', { name: $scope.scheduledHistoryTask.name });
            fsrPbAgentService.listScheduledTaskRuns($scope.config, $scope.scheduledHistoryTask.name)
                .then(function (res) {
                    if (res && res.ok === false) {
                        $scope.scheduledRunsError = (res.error && res.error.message)
                            || 'Could not load run history.';
                    } else {
                        $scope.scheduledRuns = (res && res.runs) || [];
                    }
                    $scope.scheduledRunsLoading = false;
                })
                .catch(function (err) {
                    $scope.scheduledRunsError = (err && err.message)
                        || 'Could not load run history.';
                    $scope.scheduledRunsLoading = false;
                });
        };

        $scope.closeScheduledHistory = function () {
            $scope.scheduledHistoryOpen = false;
            $scope.scheduledHistoryTask = null;
            $scope.scheduledRuns = [];
            $scope.scheduledRunsError = '';
        };

        // A run's outcome badge: parked (HITL-gated, resumable) > failed >
        // completed. `parked` is the connector's authoritative resumable flag
        // (session is in suspended_sessions); stop_reason disambiguates the rest.
        $scope.scheduledRunBadge = function (run) {
            if (!run) return { label: '--', cls: 'scheduled-badge-off' };
            if (run.parked) return { label: 'parked · resume', cls: 'scheduled-badge-mutating' };
            var sr = run.stop_reason || '';
            if (/^awaiting_/.test(sr)) return { label: sr.replace('awaiting_', 'waiting: '), cls: 'scheduled-badge-mutating' };
            if (sr === 'error' || /fail/i.test(sr)) return { label: 'failed', cls: 'scheduled-badge-off' };
            if (sr === 'end_turn' || sr === 'stop' || sr === 'max_turns' || sr === 'completed')
                return { label: 'completed', cls: 'scheduled-badge-on' };
            return { label: sr || 'run', cls: 'scheduled-badge' };
        };

        // Hand a run's session to the chat: close this drawer and switch the
        // active conversation. loadSession rehydrates the full transcript; for a
        // parked run it also re-surfaces the approval card the gate parked on,
        // so "Resume" is the same path as "View" -- the chat owns both.
        $scope.openScheduledRun = function (run) {
            if (!run || !run.session_id) return;
            $scope.closeScheduledHistory();
            $scope.closeScheduledTasks();
            $scope.loadSession(run.session_id);
        };

        $scope.isCurrentSession = function (sessionId) { return sessionId === _sessionId; };

        $scope.loadSession = function (sessionId) {
            $scope.historyOpen = false;
            if (!sessionId || sessionId === _sessionId) return;
            _switchToSession(sessionId);
        };

        // Swap the active conversation to a stored session: persist the id,
        // clear the current timeline, and rehydrate from the connector. Mirrors
        // newConversation's reset but keyed to an existing session.
        function _switchToSession(sessionId) {
            _turnAborted = true;                 // stop waiting on any in-flight turn
            _stopStreaming();
            _sessionId = sessionId;
            _seedLiveRatingFromHistory(sessionId);
            $scope._buildHandoffActive = false;   // switching sessions relocks build UI over a record
            // Same reset as newConversation: the intent belongs to the
            // conversation, not the widget. If the session we're loading IS a
            // build session, the rehydrate below re-latches build+handoff once
            // it sees the restored YAML -- so defaulting here can only fix a
            // stale latch, never lose a real one. The session key below is
            // record/page-scoped (not intent), so uiIntent no longer affects
            // which bucket this thread files under.
            $scope.uiIntent = _defaultIntent();
            try { $window.localStorage.setItem(_sessionKey(), sessionId); } catch (e) {}
            $scope.messages = [];
            _resetUsage();
            $scope.currentYaml = '';
            $scope.errorMessage = '';
            $scope.approvalRequest = null;
            $scope.streamingMessage = null;
            _setState('idle');
            _logEvent('load_session', { sessionId: sessionId });
            fsrPbAgentService.chatHistory($scope.config, _sessionId)
                .then(function (res) {
                    $scope.sessionInitiator = (res && res.initiator) || null;
                    if (res && res.turns && res.turns.length) _replayTurns(res.turns, res.card_decisions);
                })
                .catch(function () { /* empty/unreachable -- leave a clean slate */ });
        }

        $scope.copyExport = function () {
            try {
                $window.navigator.clipboard.writeText($scope.form.exportText);
                $scope.exportCopied = true;
                $timeout(function () { $scope.exportCopied = false; }, 1800);
            } catch (e) {
                // Clipboard API unavailable (insecure context / harness) -- fall
                // back to selecting the textarea so the user can ⌘C manually.
                var ta = document.querySelector('.fsr-pb-widget .export-textarea');
                if (ta) { ta.focus(); ta.select(); }
            }
        };

        $scope.downloadExport = function () {
            try {
                var blob = new $window.Blob([$scope.form.exportText], { type: 'text/markdown' });
                var url = $window.URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'fsrpb-chat-' + _sessionId + '.md';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                $timeout(function () { $window.URL.revokeObjectURL(url); }, 0);
                _logEvent('export_downloaded', {});
            } catch (e) { /* download not available -- copy is the fallback */ }
        };

        // ─── Turn orchestration ───────────────────────────────────────────────

        // Stamp the resolved mode (live|mock) + mock_scenario into every
        // outgoing payload so the connector can honor mock-mode server-side
        // (contract §0). `extra` is merged last so call-site fields win.
        function _withMode(base, extra) {
            var mi = {};
            try { mi = fsrPbAgentService.modeInfo($scope.config) || {}; } catch (e) {}
            var out = angular.extend({}, base, { mode: mi.mode, mock_scenario: mi.mock_scenario });
            // Stamp the acting SOAR user on every user-originated call so the
            // connector can persist the real chat author/initiator (it runs
            // under the service account and can't derive who is chatting). The
            // connector reads it on chat_turn; other ops ignore it.
            var actor = _actorPayload();
            if (actor) out.actor = actor;
            if (extra) angular.extend(out, extra);
            _lastSentPayload = out;
            return out;
        }

        // The current SOAR user as a compact author dict for the wire. Null in
        // the harness placeholder case so we never persist a fake initiator.
        function _actorPayload() {
            var i = $scope.initiator || {};
            if (!i.name || i.name === 'Harness user') return null;
            var a = { name: i.name };
            if (i.iri) a.iri = i.iri;
            return a;
        }

        // Entity block for chat_turn (contract §2). Carries the summary_seed
        // once the widget has pre-rendered it (Phase B) so the connector can
        // use it verbatim as the assistant's first turn.
        function _entityPayload() {
            var e = $scope.entityContext;
            if (!e || !e.iri) {
                // Over a module LIST: the module alone, so the connector resolves
                // the module's persona and frames the turn as a list page (it
                // reads "module, nothing naming a record" as exactly that).
                var lc = $scope.listContext;
                return (lc && lc.module) ? { module: lc.module, view: 'list' } : undefined;
            }
            var out = { iri: e.iri, module: e.module };
            // Stable identifiers so the connector/agent can fetch more from
            // FortiSOAR directly (related records, correlated events, raw logs)
            // via its SOAR tools. iri is the canonical GET key; uuid/id are the
            // bare identifiers for tools that take them separately. These live
            // at the entity top level, NOT in `fields` (where they're noise).
            if (e.record && typeof e.record === 'object') {
                if (e.record.uuid) out.uuid = e.record.uuid;
                if (e.record.id != null) out.id = e.record.id;
            }
            if (e.summary_seed) out.summary_seed = e.summary_seed;
            // The open playbook's YAML, in the designer only. This is the one
            // piece of context the assistant cannot obtain for itself -- its build
            // tool slice has no live-playbook read -- so without it every
            // authoring turn is blind. Sent whole and never truncated: the
            // assistant edits this text and the push button compiles the result
            // back over the real record, so a clipped copy would silently drop
            // the analyst's steps.
            if ($scope.inPlaybookEditor && $scope.playbookYaml) {
                out.playbook_yaml = $scope.playbookYaml;
            }
            // Ship the cleaned substantive fields so quick-actions have real
            // data to reason over (contract §2 entity.fields). Only when the
            // record is actually populated on the scope.
            if (e.record && typeof e.record === 'object') {
                var fields = _buildEntityFields(e.record);
                if (Object.keys(fields).length) out.fields = fields;
                var tags = e.record.recordTags;
                if (angular.isArray(tags) && tags.length) {
                    out.tags = tags.filter(function (t) { return typeof t === 'string'; });
                }
            }
            return out;
        }

        // ─── Streaming preview lifecycle ─────────────────────────────────────
        // Called when a turn is dispatched. Starts a parallel poll loop that
        // renders the connector's progress feed into $scope.streamingMessage.
        // No-op in mock mode (no live feed) -- the single blocking response is
        // already fast there. Safe to call alongside any chat_turn/chat_resume.
        function _startStreaming() {
            _stopStreaming();
            // Only the live connector writes a progress feed.
            var _mode = fsrPbAgentService.modeInfo($scope.config).mode;
            if (_mode !== 'live') {
                _streamTrace('start:skipped-not-live', { mode: _mode });
                return;
            }
            _streamTrace('start', { lastTurn: _lastTurn, minTurn: _lastTurn + 1,
                turnAborted: _turnAborted });
            // Status from send: the dots never sit bare while the connector
            // prepares the turn. The first activity frame replaces it.
            $scope.streamStatus = 'Thinking';
            _stream = {
                cursor: 0,
                frames: [],        // raw per-event wire frames (no envelopes)
                sawStart: false,   // have we observed a turn_start for THIS turn?
                turn: null,        // the turn number this stream is bound to
                minTurn: _lastTurn + 1, // the new turn we're streaming; older turns are stale
                supported: true,   // flips false on a <2.5.0 / unknown-op reply
                startedAt: Date.now(), // wall-clock anchor for the detached watchdog
                timer: null,
                stopped: false,
                kept: 0,           // debug: frames rendered into the preview
                dropped: 0,         // debug: frames gated out (stale turn / pre-start)
                transientErrors: 0  // consecutive transient (5xx/network) poll failures
            };
            _markInFlight(_sessionId);
            _schedulePoll(0);
            _startTicker();
        }

        // Live "elapsed" counter for tools still PENDING. The server only sends
        // a tool's duration_ms when it COMPLETES, so until then we count up from
        // the client-side _startedAt the renderer stamped. A 1s $interval (only
        // while a stream is active) refreshes each pending chip's _elapsedLabel;
        // _mergeUiState carries _startedAt across the 700ms preview rebuilds so
        // the count is continuous. Frozen the moment the tool_result lands
        // (durationLabel takes over). Cheap -- at most a handful of pending tools.
        function _startTicker() {
            if (_tickTimer) return;
            _tickTimer = $interval(_tickElapsed, 1000);
        }

        function _tickElapsed() {
            var msg = $scope.streamingMessage;
            if (!msg || !msg.events) return;
            var now = Date.now();
            var fmt = $window.FsrPbRender && $window.FsrPbRender.formatDuration;
            for (var i = 0; i < msg.events.length; i++) {
                var e = msg.events[i];
                if (e && e.type === 'tool_call' && e.resultStatus === 'pending'
                    && e.durationMs == null && e._startedAt) {
                    e._elapsedLabel = fmt ? fmt(now - e._startedAt) : null;
                }
            }
        }

        function _stopTicker() {
            if (_tickTimer) { $interval.cancel(_tickTimer); _tickTimer = null; }
        }

        function _schedulePoll(delay) {
            if (!_stream || _stream.stopped) {
                _streamTrace('schedule:declined',
                    { hasStream: !!_stream, stopped: !!(_stream && _stream.stopped) });
                return;
            }
            _stream.timer = $timeout(_pollOnce, delay);
        }

        // A DETACHED turn commits ONLY via the chat_poll terminal -- the
        // chat_turn ack carried no transcript. So every way the poll loop can
        // tear down WITHOUT an authoritative commit (signal-only terminal, a
        // chat_poll that goes unsupported mid-detached-turn, the wall-clock
        // watchdog, a render throw) would otherwise strand the composer in
        // 'sending' forever -- the "stuck on the typing bubbles" hang the analyst
        // sees. This is the single chokepoint that guarantees a detached turn
        // always leaves 'sending': commit whatever we streamed (degrade) or, when
        // asked, surface an error. No-op once the turn is already committed, and
        // in NON-detached mode (where the blocking chat_turn return is still
        // authoritative and will commit on its own). Wrapped so a throw inside the
        // commit can't itself re-strand the state.
        function _settleDetachedIfStranded(s, opts) {
            opts = opts || {};
            if (!_detachedActive) return;                       // blocking return will commit
            var turn = s && s.turn;
            if (turn != null && _committedTurns[turn]) return;  // authoritative transcript already rendered
            try {
                if (opts.error || turn == null) {
                    // No anchored turn (turn_start never seen) or an explicit
                    // failure -- surface a soft error, don't fabricate a turn.
                    if (turn != null) _committedTurns[turn] = true;
                    $scope.errorMessage = opts.error
                        || 'The build ended without a result. Please retry.';
                    _detachedActive = false;
                    _setState('error');
                    _logEvent('detached_settled', { turn: turn, mode: 'error' });
                    return;
                }
                // Degrade: commit the frames we streamed as the turn's transcript
                // so the conversation isn't lost and the composer is freed.
                _logEvent('detached_settled', { turn: turn, mode: 'degrade',
                    frames: (s.frames || []).length });
                _handleTurnResult({
                    ok: true, turn: turn, stop_reason: 'end_turn',
                    contract_version: opts.contractVersion || STREAM_MIN_CONTRACT,
                    transcript: (s.frames || []).slice(), _fromPoll: true
                }, true);
            } catch (e) {
                // Last-resort guarantee: never leave the composer hung.
                if (turn != null) _committedTurns[turn] = true;
                _detachedActive = false;
                $scope.errorMessage = 'The build result could not be rendered. Please retry.';
                _setState('error');
                _logEvent('detached_settle_failed', { turn: turn, error: String(e && e.message || e) });
            }
        }

        // The poll is a long-poll: the connector holds it until a frame lands,
        // so the next one goes out at once. An answer that came straight back
        // with nothing new means a connector that does not hold the request, so
        // keep the old cadence for it rather than spin.
        // Frames only count when the cursor moved: a connector that re-sends
        // the same frames must not drive a tight loop.
        function _nextPollDelay(resp, startedAt, cursorBefore, cursorAfter) {
            // Only a connector that says it held the poll gets the fast re-poll;
            // anything else (older connector, mock) keeps the fixed cadence.
            if (!(resp && resp.long_poll)) return STREAM_POLL_MS;
            var gotFrames = !!(resp.frames && resp.frames.length);
            var advanced = cursorAfter > cursorBefore;
            if ((gotFrames && advanced) || (Date.now() - startedAt) >= LONG_POLL_FLOOR_MS) return REPOLL_MS;
            return STREAM_POLL_MS;
        }

        function _pollOnce() {
            var s = _stream;
            if (!s || s.stopped || _turnAborted) {
                _streamTrace('poll:declined', { hasStream: !!s,
                    stopped: !!(s && s.stopped), turnAborted: _turnAborted });
                return;
            }
            // Defense-in-depth wall-clock cap (contract §11): if a detached turn
            // has streamed past the watchdog without an authoritative commit,
            // settle it ourselves rather than poll forever.
            if (_detachedActive && s.startedAt
                && (Date.now() - s.startedAt) > DETACHED_WATCHDOG_MS
                && (s.turn == null || !_committedTurns[s.turn])) {
                _settleDetachedIfStranded(s, {
                    error: 'The build is taking too long and lost contact with the connector. Please retry.'
                });
                _stopStreaming();
                return;
            }
            var pollStartedAt = Date.now();
            var cursorBefore = s.cursor;
            fsrPbAgentService.chatPoll($scope.config, _sessionId, s.cursor, s.minTurn - 1, LONG_POLL_MS)
                .then(function (resp) {
                    if (s !== _stream || s.stopped) return;   // superseded/stopped
                    s.transientErrors = 0;   // reset on any successful response
                    // A throw inside absorb/render (e.g. FsrPbRender chokes on a
                    // malformed frame) must NOT fall through to .catch -- that
                    // handler classifies a status-0 throw as "transient" and
                    // re-polls the same broken frame every interval, re-throwing
                    // forever until the 6-min watchdog while the composer sits in
                    // 'sending'. Catch it here and settle the detached turn (or,
                    // in blocking mode, just tear down the poll and let the
                    // chat_turn return commit).
                    try {
                        // Capability gate: an older connector that somehow answers
                        // without the streaming contract -- stand down quietly.
                        var got = _parseVer(resp && resp.contract_version);
                        var want = _parseVer(STREAM_MIN_CONTRACT);
                        if (!got || got.major < want.major
                            || (got.major === want.major && got.minor < want.minor)) {
                            s.supported = false;
                            // In detached mode there is no blocking transcript to
                            // fall back to -- settle so the composer isn't stranded.
                            _settleDetachedIfStranded(s, {
                                error: 'The connector is too old to stream this build (needs '
                                    + STREAM_MIN_CONTRACT + '+). Please retry.'
                            });
                            _stopStreaming();
                            return;
                        }
                        _absorbPoll(resp, s);
                        if (s.stopped) return;
                        if (resp && resp.done && s.sawStart) {
                            // Terminal reached. _absorbPoll commits when the
                            // terminal carries a transcript; if it was signal-only,
                            // settle so the detached turn still leaves 'sending'.
                            _settleDetachedIfStranded(s, { contractVersion: resp && resp.contract_version });
                            _stopStreaming();
                            return;
                        }
                        _schedulePoll(_nextPollDelay(resp, pollStartedAt, cursorBefore, s.cursor));
                    } catch (e) {
                        _logEvent('poll_absorb_failed', {
                            turn: s.turn, error: String(e && e.message || e) });
                        _settleDetachedIfStranded(s, {
                            error: 'The build result could not be rendered. Please retry.'
                        });
                        _stopStreaming();
                    }
                })
                .catch(function (err) {
                    if (s !== _stream || s.stopped) return;
                    // A connector without chat_poll rejects the op -- degrade to
                    // the single blocking response. Distinguish that from a
                    // transient network blip (retry same cursor).
                    //
                    // CAREFUL: the rejected request descriptor itself echoes
                    // operation:'chat_poll', so matching the bare token used to
                    // misclassify a transient 502 / ERR_EMPTY_RESPONSE as
                    // "connector can't stream" and strand the turn with a dead
                    // banner -- the source of the intermittent "Streaming this
                    // build is unavailable" failures on a flaky upstream. Only a
                    // structured "operation unknown/unsupported" rejection (and
                    // never a 5xx/transport error) counts as unsupported.
                    var status = (err && (err.status != null ? err.status
                        : (err.data && err.data.status))) || 0;
                    var blob = JSON.stringify(err || '');
                    var transient = status <= 0 || status >= 500
                        || /ERR_EMPTY_RESPONSE|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|Bad Gateway|Gateway Time|temporarily unavailable|network error|timeout/i.test(blob);
                    var unsupported = !transient
                        && /unknown operation|no such operation|invalid operation|unsupported operation|operation[^"]*not found/i.test(blob);
                    if (unsupported) {
                        s.supported = false;
                        // Detached turns have no blocking fallback -- settle.
                        _settleDetachedIfStranded(s, {
                            error: 'Streaming this build is unavailable (chat_poll). Please retry.'
                        });
                        _stopStreaming();
                        return;
                    }
                    // Transient (502/gateway/network): retry, but cap consecutive
                    // failures so a SUSTAINED burst doesn't leave the composer
                    // stuck in 'sending' for the full 6-min watchdog. After
                    // STREAM_MAX_TRANSIENT_ERRORS consecutive transient failures,
                    // surface the gateway problem to the analyst instead of
                    // silently retrying (tracker #106: a hunt that dies on a
                    // transient blip reads as 'the agent did nothing').
                    s.transientErrors++;
                    if (s.transientErrors >= STREAM_MAX_TRANSIENT_ERRORS) {
                        _streamTrace('transient_budget_exhausted', {
                            count: s.transientErrors, status: status });
                        _settleDetachedIfStranded(s, {
                            error: 'The connector is temporarily unreachable'
                                + ' (repeated gateway errors). Please retry.'
                        });
                        _stopStreaming();
                        return;
                    }
                    _schedulePoll(STREAM_POLL_MS);   // transient -- retry, same cursor
                });
        }

        // Fold a poll response into the live preview. Frames are RAW per-event
        // wire shapes (text / tool_use / tool_result / usage / error) bracketed
        // by turn_start / stream_end envelopes. We ignore a stale prior turn's
        // tail (first poll can briefly see the previous completed turn before
        // chat_turn writes turn_start) by gating on having seen turn_start.
        function _absorbPoll(resp, stream) {
            // Use the stream reference captured by the poll that fired this
            // absorb, NOT the global `_stream`: if `_startStreaming` replaced
            // `_stream` between the poll dispatch and this callback, folding the
            // old turn's frames into the new stream would commit stale frames
            // into a fresh turn. Fall back to the global for legacy callers.
            var s = stream || _stream;
            if (!s || s.stopped || s !== _stream) return;
            // Advance _lastTurn from the poll response's top-level `turn` field.
            // _lastTurn is the stream fence's source of truth: _startStreaming sets
            // minTurn = _lastTurn + 1, and the stale-turn gate drops frames with
            // f.turn < minTurn. But _lastTurn was only updated inside
            // _handleTurnResult (from result.turn, which comes from s.turn -- often
            // null when turn_start frames lack a `turn` field). So through the
            // approval → manual_input arc, _lastTurn never advanced past 1, and
            // the NEXT chat_turn's stream had minTurn=2, causing the first poll to
            // serve the previous turn's stale `done:true` terminal -- which the
            // `resp.done && s.sawStart` check treated as the current turn ending,
            // killing the stream before turn 3 ever streamed. The poll response's
            // top-level `turn` is authoritative (the connector echoes it on every
            // poll), so advance _lastTurn here to keep the fence current.
            if (resp && typeof resp.turn === 'number' && resp.turn > _lastTurn) {
                _lastTurn = resp.turn;
            }
            var frames = (resp && resp.frames) || [];
            for (var i = 0; i < frames.length; i++) {
                var f = frames[i];
                if (!f || !f.type) continue;
                if (f.type === 'turn_start') {
                    // Ignore a stale prior turn's frames: the first poll (fired
                    // at delay 0) can land before chat_turn has written THIS
                    // turn's turn_start, surfacing the previous (already-done)
                    // turn. Latching it would set sawStart and let a stale
                    // resp.done tear the stream down before the new turn streams.
                    if (f.turn != null && f.turn < s.minTurn) { s.dropped++; continue; }
                    // A fresh turn for this stream. If we'd already latched a
                    // prior turn, reset the accumulator to its frames.
                    if (s.turn != null && f.turn != null && f.turn !== s.turn) s.frames = [];
                    s.sawStart = true;
                    s.turn = (f.turn != null) ? f.turn : s.turn;
                    continue;
                }
                if (f.type === 'stream_end') {
                    // Terminal frame. Stale prior-turn terminals (seen before
                    // this turn's turn_start) are ignored.
                    if (!s.sawStart) { s.dropped++; continue; }
                    // Poll-to-completion: when the terminal carries the
                    // authoritative transcript, commit it through the SAME path
                    // as chat_turn's own return. This is what lets a long
                    // (>5-min) agentic build land via the feed even when the
                    // blocking POST is just a fast {accepted} ack (or 300s-dies).
                    // _handleTurnResult is idempotent per turn, so if chat_turn
                    // ALSO returns the transcript only one commit wins.
                    if (f.transcript && f.transcript.length) {
                        if (typeof resp.cursor === 'number') s.cursor = resp.cursor;
                        _handleTurnResult({
                            ok: f.ok !== false,
                            turn: s.turn,
                            turn_id: f.turn_id || (resp && resp.turn_id),
                            stop_reason: f.stop_reason,
                            contract_version: f.contract_version || (resp && resp.contract_version),
                            transcript: f.transcript,
                            // Authoritative transcript from the poll terminal -- the
                            // only source allowed to commit during a detached turn.
                            _fromPoll: true,
                            // 2.7.0: terminal frame carries the full envelope so it
                            // can stand in for the blocking return in detached mode.
                            last_assistant_yaml: f.last_assistant_yaml,
                            tags: f.tags
                        });
                        return;   // _handleTurnResult tore down the stream.
                    }
                    // Signal-only terminal (no transcript): defer to chat_turn's
                    // blocking return to commit. Nothing to render here.
                    continue;
                }
                // Don't render anything until we've anchored the new turn -- a
                // first poll may surface the previous turn's trailing frames.
                if (!s.sawStart) { s.dropped++; continue; }
                // A status frame (thinking, reading the record, a round) is a
                // label for the live line, not a row: it never enters the
                // preview. It stands until the next real frame supersedes it.
                if (f.type === 'activity') {
                    s.status = $window.FsrPbRender.narrationText(f.message, 'Working on it') || null;
                    continue;
                }
                s.status = null;
                $window.FsrPbRender.appendStreamFrame(s.frames, f);
                s.kept++;
            }
            if (resp && typeof resp.cursor === 'number') s.cursor = resp.cursor;
            // Rebuild the preview through the SAME render path as a committed
            // message (interleaveText timeline): text lines and the tools they
            // trigger, interleaved in stream order, tools showing input/output.
            // Because the committed message renders identically, the turn ending
            // is a seamless swap -- the timeline does not get lost. Usage is
            // absorbed into the topbar meter separately.
            if (s.frames.length) {
                var preview = $window.FsrPbRender.buildAssistantMessage(s.frames, {
                    now: Date.now, collapseThreshold: COLLAPSE_THRESHOLD, interleaveText: true
                });
                // The renderer reseeds every tool_call's expand state to collapsed
                // on each rebuild. Carry the analyst's open/collapse choices from
                // the previous preview onto the matching new events so a tool the
                // analyst expanded doesn't snap shut on the next 700ms poll.
                _mergeUiState($scope.streamingMessage, preview);
                preview._streaming = true;
                $scope.streamingMessage = preview;
                // A status frame newer than the last real frame wins; otherwise
                // the line follows the preview (never a stale label).
                $scope.streamStatus = s.status || _deriveStreamStatus(preview);
                _absorbUsage(s.frames);   // live token/cost meter
            } else if (s.status) {
                $scope.streamStatus = s.status;
            }
        }

        // The live status line under the typing dots: what the agent is doing
        // right now, read straight from the latest preview. Uses the connector's
        // own analyst labels (one source of truth, no widget-side phrase list),
        // and switches to the answer phase once prose starts streaming. Empty
        // before the first frame, when the dots alone carry "working".
        function _deriveStreamStatus(preview) {
            var evs = (preview && preview.events) || [];
            if (!evs.length) return '';
            var last = evs[evs.length - 1];
            if (last && last.type === 'text' && (last.text || '').trim()) {
                return 'Writing the answer';
            }
            for (var i = evs.length - 1; i >= 0; i--) {
                var e = evs[i];
                if (e.type === 'tool_call') {
                    // A finished call is not the current work: the model is
                    // reading its result and deciding the next step.
                    var done = e.durationMs != null
                        || (!!e.resultStatus && e.resultStatus !== 'pending');
                    if (done) return 'Thinking';
                    return $window.FsrPbRender.narrationText(
                        e.label || e.partialLabel || $window.FsrPbRender.toolCallLabel(e.name),
                        'Working on it') || 'Working on it';
                }
            }
            return 'Looking into it';
        }

        // Re-apply per-tool UI expand state ({_open,_inputOpen,_resultOpen}) from
        // a prior streaming preview onto a freshly rebuilt one. Keyed by
        // _toolUseId; positional fallback for events that never got an id.
        function _mergeUiState(prev, next) {
            if (!prev || !next) return;
            // Carry the analyst's open/closed choice for the reasoning panel so
            // it does not snap shut on the next 700ms rebuild.
            if (prev._reasoningOpen != null) next._reasoningOpen = prev._reasoningOpen;
            if (!prev.events || !next.events) return;
            var byId = {};
            var byPos = [];
            prev.events.forEach(function (e) {
                if (e.type !== 'tool_call') return;
                // Carry _startedAt + _elapsedLabel too: the renderer re-stamps
                // _startedAt to "now" on every rebuild, which would reset the
                // PENDING ticker each 700ms poll. Preserving the original start
                // keeps the count-up continuous.
                var ui = { _open: e._open, _inputOpen: e._inputOpen, _resultOpen: e._resultOpen,
                           _startedAt: e._startedAt, _elapsedLabel: e._elapsedLabel };
                if (e._toolUseId) byId[e._toolUseId] = ui;
                byPos.push(ui);
            });
            var pos = 0;
            next.events.forEach(function (e) {
                if (e.type !== 'tool_call') return;
                var ui = (e._toolUseId && byId[e._toolUseId]) || byPos[pos];
                pos++;
                if (!ui) return;
                if (ui._open != null) e._open = ui._open;
                if (ui._inputOpen != null) e._inputOpen = ui._inputOpen;
                if (ui._resultOpen != null) e._resultOpen = ui._resultOpen;
                // Only carry the start time onto a still-pending tool -- once the
                // result lands the renderer sets durationMs and the ticker stops.
                if (e.durationMs == null && ui._startedAt) {
                    e._startedAt = ui._startedAt;
                    if (ui._elapsedLabel != null) e._elapsedLabel = ui._elapsedLabel;
                }
            });
        }

        // C6: the session whose turn is in flight, kept in sessionStorage so a
        // reload knows to ask the connector for a running turn. Set while a
        // stream runs, cleared when it tears down (commit, stop, abort).
        var IN_FLIGHT_KEY = 'fsrPbInFlightSession';
        function _markInFlight(sid) {
            try {
                if (sid) $window.sessionStorage.setItem(IN_FLIGHT_KEY, sid);
                else $window.sessionStorage.removeItem(IN_FLIGHT_KEY);
            } catch (e) { /* storage blocked: no reattach, nothing else changes */ }
        }
        function _inFlightSession() {
            try { return $window.sessionStorage.getItem(IN_FLIGHT_KEY); } catch (e) { return null; }
        }

        function _stopStreaming() {
            // Streaming only ever tears down on commit, abort, or $destroy -- all
            // points where the detached turn is finished. Clear the gate so a
            // later resume turn's synchronous return isn't mistaken for an ack.
            // Traced: a teardown that happens AFTER the next turn started
            // streaming is the shape of #98, and it is otherwise silent.
            if (_stream) {
                _streamTrace('stop', { turn: _stream.turn, kept: _stream.kept,
                    dropped: _stream.dropped, turnAborted: _turnAborted });
            }
            _detachedActive = false;
            _markInFlight(null);
            _stopTicker();
            if (_stream && _stream.timer) $timeout.cancel(_stream.timer);
            if (_stream) {
                _stream.stopped = true;
                _logEvent('stream_stats', { kept: _stream.kept, dropped: _stream.dropped, turn: _stream.turn });
            }
            _stream = null;
            $scope.streamingMessage = null;
            $scope.streamStatus = '';
        }

        // Render list = committed messages + the transient streaming preview
        // (when active). Both use the identical timeline renderer, so the live
        // preview and the final committed message look the same -- the turn
        // ending just drops the _streaming flag. $watchCollection compares
        // item-by-item, so a fresh concat with stable contents won't churn.
        // Stamp a stable, monotonic `_key` on every message the timeline renders.
        // The messages ng-repeat used to `track by $index`, so a full array
        // rebuild (history reload / rehydrate) re-bound each row's DOM+scope BY
        // POSITION -- bleeding one message's per-event card state (`_open`,
        // `_picked`, `_resolved`) onto whatever message now sits at that index
        // (HIGH -- state bleed on reload). Assigning the key lazily HERE covers
        // every creation path (append, rehydrate, seed) with no per-site edits,
        // and it persists on the object so the key is stable across digests.
        function _keyMessages(list) {
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i]._key == null) list[i]._key = 'm' + (_msgKeySeq++);
            }
            return list;
        }
        $scope.chatMessages = function () {
            _keyMessages($scope.messages);
            if ($scope.streamingMessage) {
                // The live preview is one object rebuilt each poll; give it a
                // FIXED key so it doesn't churn a new row every ~700ms.
                if ($scope.streamingMessage._key == null) $scope.streamingMessage._key = 'm-streaming';
                return $scope.messages.concat([$scope.streamingMessage]);
            }
            return $scope.messages;
        };

        // ─── B1 -- auto-scroll (pin-to-bottom) ────────────────────────────────
        // Keep the transcript pinned to the latest content as messages append and
        // the live preview streams in -- UNLESS the analyst has scrolled up to read
        // earlier history, in which case we leave their position alone (so a long
        // streaming turn doesn't yank them back down mid-read). A scroll listener
        // re-arms the pin whenever they return to (near) the bottom.
        var _SCROLL_PIN_SLOP = 48;            // px from bottom still counts as "pinned"
        function _messagesEl() { return document.querySelector('.fsr-pb-widget .messages'); }
        function _bindScrollWatch(el) {
            if (_scrollBound || !el) return;
            _scrollBound = true;
            el.addEventListener('scroll', function () {
                var gap = el.scrollHeight - el.scrollTop - el.clientHeight;
                _pinnedToBottom = gap <= _SCROLL_PIN_SLOP;
            }, { passive: true });
        }
        function _scrollToBottom(force) {
            // Defer a tick so the just-appended / just-streamed DOM has laid out
            // and scrollHeight reflects it before we pin.
            $timeout(function () {
                var el = _messagesEl();
                if (!el) return;
                _bindScrollWatch(el);
                if (force) _pinnedToBottom = true;
                if (_pinnedToBottom) el.scrollTop = el.scrollHeight;
            }, 0);
        }
        // A cheap per-digest content signal: message count + the live preview's
        // growth (event count + text length). Any increase → new content to pin to.
        $scope.$watch(function () {
            var s = $scope.streamingMessage;
            return $scope.messages.length + '|' +
                (s ? ((s.events ? s.events.length : 0) + '.' + (s.text ? s.text.length : 0)) : 'x');
        }, function (nv, ov) {
            if (nv === ov) return;   // no content change (initial call or unrelated digest)
            _scrollToBottom(false);
        });

        // ─── B2 -- restore composer focus after a user send ───────────────────
        // The composer disables while a turn is in flight, so focus can't be
        // restored at send time; instead we re-focus when the turn settles back to
        // idle. Gated on _wantComposerFocus (set only on a USER send) so a card
        // resume, history load, or entity seed never steals focus into the composer.
        function _focusComposer() {
            $timeout(function () {
                var ta = document.querySelector('.fsr-pb-widget .composer textarea');
                if (ta && !ta.disabled) ta.focus();
            }, 0);
        }
        $scope.$watch('viewState', function (nv, ov) {
            if (nv === 'idle' && ov && ov !== 'idle' && _wantComposerFocus) {
                _wantComposerFocus = false;
                _focusComposer();
            }
        });

        // Single teardown chokepoint (drawer closed, route change). AngularJS
        // auto-deregisters $watch/$on bound to this scope, but $timeout/$interval
        // promises survive $destroy and their callbacks would keep mutating a
        // detached $scope (entity resolution retries, the init seed, the pending
        // ticker). Stop the stream (timer + ticker), cancel every tracked
        // long-lived timer, and set `_destroyed` so any callback already past
        // cancellation no-ops instead of touching a torn-down instance.
        $scope.$on('$destroy', function () {
            _destroyed = true;
            _stopStreaming();
            _stopExpiryTicker();
            _stopDecisionPoll();
            _pendingTimers.forEach(function (t) {
                try { $timeout.cancel(t); } catch (e) { /* not a $timeout promise */ }
            });
            _pendingTimers = [];
        });

        function _runTurn(opts) {
            // Close the mount race: in the designer, the open playbook's YAML is
            // decompiled asynchronously at mount (_seedPlaybookYaml). A turn fired
            // before that lands would ship without entity.playbook_yaml and the
            // assistant would be blind to the very playbook it is being asked to
            // change. If a seed is still in flight, show the sending state and
            // defer the actual turn until it settles (grounded, or fail-closed and
            // proceeding blind rather than hanging). Every later turn -- promise
            // already cleared -- runs synchronously.
            if ($scope.inPlaybookEditor && _playbookSeedPromise) {
                _setState('sending');
                $q.when(_playbookSeedPromise).finally(function () {
                    _runTurnNow(opts);
                });
                return;
            }
            _runTurnNow(opts);
        }

        function _runTurnNow(opts) {
            _turnAborted = false;
            // Latch NOW: by the time the fence arrives the composer is cleared.
            // A quick-action chip is an explicit intent the analyst clicked, so
            // it always wins over whatever phrasing rode along with it.
            _readOnlyTurn = _isReadOnlyChip(opts && opts.quickAction);
            _setState('sending');
            var payload = _withMode({
                session_id: _sessionId,
                messages: _serializeMessagesForServer(),
                intent: $scope.uiIntent,
                // Phase 1 page facts: the connector derives the frontier prior
                // from these when `intent` is absent; `intent` (above) still wins
                // when present (soft override). Harmless on older connectors
                // (extra fields are ignored).
                page: _currentStateName(),
                in_playbook_editor: !!$scope.inPlaybookEditor,
                max_turns: $scope.config.maxTurns,
                // Create-method toggle (Settings): the connector only acts on it
                // for the build intent. Harmless on older connectors.
                create_strategy: $scope.config.createStrategy
            });
            // Track C1: a quick-action chip's key (e.g. "explain", "add_step")
            // rides the payload so the connector's build prompt routes it to
            // the matching toolset. Absent on free-typed turns + handoffs.
            if (opts && opts.quickAction) payload.quick_action = opts.quickAction;
            var entity = _entityPayload();
            if (entity) payload.entity = entity;
            // Detached turn (contract 2.7.0): decouple the agent run from the HTTP
            // request so a long build doesn't die against uwsgi's ~5-min harakiri
            // ceiling. The connector returns a fast {accepted} ack (no transcript)
            // and we drive the whole turn off chat_poll, committing the terminal
            // stream_end frame's authoritative transcript (poll-to-completion).
            // Only meaningful in live mode -- mock turns return instantly.
            if (payload.mode === 'live') payload.detached = true;
            _resetUsage();   // a new turn starts its own totals
            _logEvent('action_call', { action: 'chat_turn', payload_summary: { msgs: payload.messages.length, intent: payload.intent, mode: payload.mode, detached: !!payload.detached, quick_action: payload.quick_action || null } });
            _startStreaming();
            // Latch detached state AFTER _startStreaming (which calls
            // _stopStreaming → clears the flag). _handleTurnResult uses it to
            // refuse committing any transcript that rides the synchronous
            // chat_turn return -- the authoritative transcript must arrive via
            // chat_poll. A buggy connector echoing the prior turn's transcript
            // inline is what produced the duplicate-enrichment / no-playbook
            // export sess-ei6esw96. Sync (mock) turns leave this false.
            _detachedActive = !!payload.detached;
            fsrPbAgentService.chatTurn($scope.config, payload)
                .then(_handleTurnResult)
                .catch(_handleError);
        }

        function _runResume(approvalId, turnId, decision, note, remember) {
            _turnAborted = false;
            _setState('sending');
            _logEvent('action_call', { action: 'chat_resume', approval_id: approvalId, turn_id: turnId, decision: decision });
            _startStreaming();
            // `approval_id` is the key the connector pops the SuspendedSession
            // by -- without it a tier-3 op (push_playbook) is never executed and
            // the turn dead-ends. turn_id is kept for logging/compat.
            var payload = { session_id: _sessionId, turn_id: turnId, decision: decision, note: note };
            if (approvalId) payload.approval_id = approvalId;
            if (remember) payload.remember = true;
            var p = fsrPbAgentService.chatResume($scope.config, _withMode(payload));
            p.then(_handleTurnResult).catch(_handleError);
            return p;
        }

        function _runResumeChoice(choiceId, value) {
            _turnAborted = false;
            _setState('sending');
            _logEvent('action_call', { action: 'chat_resume', choice_id: choiceId, value: value });
            _startStreaming();
            fsrPbAgentService.chatResume($scope.config, _withMode({
                session_id: _sessionId, decision: 'choice', choice_id: choiceId, value: value
            })).then(_handleTurnResult).catch(_handleError);
        }

        function _runResumeAction(cardId, decision, args, grant, configId) {
            _turnAborted = false;
            _setState('sending');
            var logged = { action: 'chat_resume', card_id: cardId, decision: decision };
            if (configId) logged.config = configId;
            _logEvent('action_call', logged);
            _startStreaming();
            var payload = { session_id: _sessionId, decision: decision, card_id: cardId, args: args };
            if (grant) payload.grant = grant;
            // Where the approved action runs. The connector accepts only a
            // configuration the card itself offered; an older connector ignores
            // the field and runs on the default, as before.
            if (configId) payload.config = configId;
            var p = fsrPbAgentService.chatResume($scope.config, _withMode(payload));
            p.then(_handleTurnResult).catch(_handleError);
            return p;
        }

        // chat_resume for a playbook_offer (decision accept|decline). On accept
        // the connector compiles + pushes the session as a playbook and returns a
        // fresh turn; the response is routed through _handleTurnResult like any
        // other turn (its stop_reason is honored, contract §3).
        function _runResumeOffer(offerId, decision, title, edits, workflowIri, applyTo) {
            _turnAborted = false;
            _setState('sending');
            _logEvent('action_call', { action: 'chat_resume', offer_id: offerId, decision: decision });
            _startStreaming();
            var payload = { session_id: _sessionId, decision: decision, offer_id: offerId };
            if (decision === 'accept' && title) payload.title = title;
            if (decision === 'accept' && edits) payload.edits = edits;
            // enhancement_offer accept only: names the playbook to update in
            // place. chat_resume carries no entity block, so without this the
            // connector has no target and (correctly) refuses to write.
            if (decision === 'accept' && workflowIri) payload.workflow_iri = workflowIri;
            if (decision === 'accept' && applyTo) payload.apply_to = applyTo;
            fsrPbAgentService.chatResume($scope.config, _withMode(payload))
                .then(_handleTurnResult).catch(_handleError);
        }

        function _runResumeManualInput(inputId, workflowRunIri, decision, values, option) {
            _turnAborted = false;
            _setState('sending');
            _logEvent('action_call', { action: 'respond_manual_input', input_id: inputId, decision: decision });
            _startStreaming();
            var payload = {
                session_id: _sessionId, input_id: inputId,
                workflow_run_iri: workflowRunIri, decision: decision, values: values
            };
            if (option) payload.option = option;
            var p = fsrPbAgentService.respondManualInput($scope.config, _withMode(payload));
            p.then(_handleTurnResult).catch(_handleError);
            return p;
        }

        // The render pipeline (seedFieldValues / normalizeSeverity /
        // normalizeBlocks / normalizeInfoCard / inferToolStatus / build the
        // assistant message) lives in the pure, framework-free render module
        // widgetAssets/js/fsrPbRender.js so it can be unit-tested in node
        // without booting Angular/DOM (SOAR_TEST_KIT_DESIGN.md, Layer 1). The
        // thin wrapper below binds the widget's clock; behavior is identical.
        // _normalizeInfoCard is kept as a wrapper because the entity-seed path
        // (_renderSeed) also composes an info card directly.
        function _normalizeInfoCard(ev) {
            return $window.FsrPbRender.normalizeInfoCard(ev, { now: Date.now });
        }

        // Contract 2.2.0 -- on `approval_unverified` the action card the analyst
        // just approved was rejected by the connector's binding check and never
        // ran. Re-flag the most recent approved action_card so its outcome no
        // longer reads as a successful "Confirmed", making it clear the analyst
        // must re-issue. Best-effort: walk newest message → oldest event.
        function _flagPendingCardsUnverified() {
            for (var i = $scope.messages.length - 1; i >= 0; i--) {
                var events = $scope.messages[i].events || [];
                for (var j = events.length - 1; j >= 0; j--) {
                    var ev = events[j];
                    if (ev.type === 'action_card' && ev._outcome !== 'reject') {
                        ev._resolved = true;
                        ev._outcome = 'unverified';
                        ev._resolutionText = 'NOT executed -- failed verification, re-issue required';
                        ev._open = false;
                        return;
                    }
                }
            }
        }



        // ─── Show an applied edit in the designer the analyst has open ──────
        // Apply writes the playbook server-side (connector update_playbook), but
        // the designer loaded its copy once, in its state resolve, and never
        // re-reads it: the canvas kept the old steps until a page reload, so an
        // in-place edit looked like it had done nothing. PlaybookDesignerCtrl
        // swaps a playbook into the canvas with `refresh(pb)` -- the same path
        // its Versions restore takes (KB drawer-widgets: designer refresh).
        //
        // Guards, both from that controller's behaviour:
        //   * `originalPlaybook` must become the saved copy first, or refresh()
        //     strips the new steps' @ids and Revert returns to the old version;
        //   * refresh() replaces unsaved canvas edits with no prompt, and a later
        //     designer Save would PUT those stale edits over this write -- so an
        //     edited canvas is left alone and the analyst is told to reload.
        function _designerScope() {
            var el = $window.document && $window.document.getElementById('designer-container');
            var sc = el && $window.angular.element(el).scope();
            for (var i = 0; sc && i < 12; i++, sc = sc.$parent) {
                if (typeof sc.refresh === 'function' && sc.originalPlaybook) return sc;
            }
            return null;
        }

        // The canvas's unsaved state is the assistant's own staged draft and
        // nothing more: no step open, and the designer's change list is where
        // the stage left it. A follow-up offer is built on that draft, so its
        // Apply replaces only what the assistant put there. Live: Apply #2 was
        // refused with "Save or discard" over Apply #1's draft.
        var _stagedMark = null;
        function _changeCount() {
            var dsc = _designerDetailScope();
            return dsc && dsc.previousChanges ? dsc.previousChanges.length : 0;
        }
        function _onlyOurStagedDraft(ds) {
            if (!_stagedMark || ds.stepSelected || (ds.stepForm && ds.stepForm.$dirty)) return false;
            return _changeCount() === _stagedMark.changes;
        }

        // "Unsaved" means what the designer's own Save button means:
        // details.$dirty || parentForm.$dirty. Never previousChanges.length --
        // that is the undo history, and the designer's Save only marks the
        // form pristine and records the saved index; it does NOT clear the
        // list. Live: after a Save, Apply stayed blocked with "Save or
        // discard" on a clean canvas until the page was reloaded.
        function _designerHasUnsavedEdits(ds) {
            if (ds.stepSelected || (ds.stepForm && ds.stepForm.$dirty)) return true;
            var detail = $window.document.querySelector('[data-cs-designer-detail]');
            var dsc = detail && $window.angular.element(detail).isolateScope();
            return !!(dsc && ((dsc.details && dsc.details.$dirty)
                || (dsc.parentForm && dsc.parentForm.$dirty)));
        }

        // The csDesignerDetail directive (isolated scope) owns the designer's
        // `details` form; emitting from it reaches PlaybookDesignerCtrl's
        // `designerDetail:entityUpdated` listener -- the undo/redo path. Two
        // args, never "snapshot": that mode adds a "replace with the loaded
        // version?" confirm to Save that would read as nonsense here.
        function _designerDetailScope() {
            var el = $window.document.querySelector('[data-cs-designer-detail]');
            var d = el && $window.angular.element(el).isolateScope();
            return d && typeof d.$emit === 'function' ? d : null;
        }

        // Load a staged workflow (connector update_playbook stage=true) into the
        // open designer as unsaved changes: the analyst sees it at once, undo
        // works, and their Save is the write. Returns false when no designer.
        function _stageIntoDesigner(workflow) {
            var d = _designerDetailScope();
            if (!d) {
                _logEvent('designer_stage_failed', { reason: 'no_designer' });
                $scope.messages.push({ role: 'system', ts: Date.now(), events: [],
                    text: 'I could not reach the designer to add the change. Nothing was saved; '
                        + 'reload the page and apply it again.' });
                return false;
            }
            // Never let a top-level null/undefined overwrite a designer key: the
            // designer's init reads e.g. playbookOrigin['@id'] on its first line,
            // and a null there blanked the canvas (KB §18.9). The connector strips
            // them too; this keeps the invariant if any producer regresses.
            var body = {};
            Object.keys(workflow).forEach(function (k) {
                if (workflow[k] !== null && workflow[k] !== undefined) body[k] = workflow[k];
            });
            // Only ever into the playbook the change was built for. The designer
            // entity is the canvas; a workflow for another playbook merged over
            // it renames the canvas and replaces its steps, and the analyst's
            // Save would then write that over the wrong record.
            var openUuid = d.entity && d.entity.uuid;
            if (workflow.uuid && openUuid && String(workflow.uuid) !== String(openUuid)) {
                _logEvent('designer_stage_refused', { reason: 'other_playbook',
                    staged: workflow.uuid, open: openUuid });
                $scope.messages.push({ role: 'system', ts: Date.now(), events: [],
                    text: 'This change was made for ' + (workflow.name ? '\u201c' + workflow.name
                        + '\u201d' : 'another playbook') + ', not the playbook open in the '
                        + 'designer, so nothing was changed. Open that playbook to apply it, '
                        + 'or start a new chat here to build for this one.' });
                return false;
            }
            var merged = $window.angular.extend({}, d.entity, body);
            d.$emit('designerDetail:entityUpdated', merged, true);
            if (d.details) d.details.$dirty = true;
            _logEvent('designer_staged', { steps: (workflow.steps || []).length });
            return true;
        }

        // Close the designer's left "Steps" palette after we stage a build.
        // On a NEW playbook the designer seeds a `placeholderStep` and auto-
        // opens that palette so the analyst picks a start step; our Apply
        // supplies its own Start/trigger step, so the placeholder is now dead
        // weight and its panel just covers the canvas. Clearing the placeholder
        // is exactly what the palette's own Cancel button does
        // (clearPlaceholderStep, id="close-selected-pb-step-btn" in
        // app/playbooks/designer/designer.html), and dropping placeholderStep
        // removes the `open` class on #step-collections -- the panel closes.
        // Fail-soft and narrow: only when a placeholder is actually open and no
        // step form is being edited, so a palette the analyst opened on purpose
        // is left alone. Never let this throw into the Apply path.
        function _closeStepPalette() {
            try {
                var ds = _designerScope();
                if (!ds || !ds.playbook || !ds.playbook.placeholderStep) return;
                if (ds.stepSelected) return;   // analyst is mid-edit in a step form
                if (typeof ds.clearPlaceholderStep === 'function') {
                    ds.clearPlaceholderStep();
                    if (!ds.$$phase && !(ds.$root && ds.$root.$$phase)) ds.$applyAsync();
                    _logEvent('designer_palette_closed', {});
                    return;
                }
                // Fallback: do exactly what the user's Cancel click does.
                var btn = $window.document.getElementById('close-selected-pb-step-btn');
                if (btn) { btn.click(); _logEvent('designer_palette_closed', { via: 'click' }); }
            } catch (e) {
                _logEvent('designer_palette_close_failed', {});
            }
        }

        function _loadStagedIntoDesigner(transcript) {
            if (!_openPlaybookIri()) return;
            var card = (transcript || []).find(function (e) {
                return e && e.type === 'info_card' && e.variant === 'playbook_staged';
            });
            if (!card || !card.workflow) return;
            if (!_stageIntoDesigner(card.workflow)) return;
            _closeStepPalette();
            _stagedMark = { changes: _changeCount() };
            // The canvas now holds the draft, so the next turn edits IT: the
            // open playbook the connector grounds on is entity.playbook_yaml,
            // seeded once from the saved copy. Live: turn 2 edited the saved
            // (empty) playbook and every edit failed "no steps yet".
            if (typeof card.yaml === 'string' && card.yaml.trim()) {
                $scope.playbookYaml = card.yaml;
                $scope.currentYaml = card.yaml;
            }
        }

        function _refreshDesignerAfterApply(transcript) {
            var openIri = _openPlaybookIri();
            if (!openIri) return;
            var card = (transcript || []).find(function (e) {
                return e && e.type === 'info_card' && e.variant === 'playbook_updated';
            });
            if (!card) return;
            var uuid = String(card.workflow_iri || openIri).split('/').pop();
            if (uuid !== String(openIri).split('/').pop()) return;   // wrote a different playbook
            var ds = _designerScope();
            if (!ds) return;
            if (_designerHasUnsavedEdits(ds)) {
                _logEvent('designer_refresh_skipped', { reason: 'unsaved_edits' });
                $scope.messages.push({ role: 'system', ts: Date.now(), events: [],
                    text: 'Saved. The designer has unsaved changes, so it still shows the old '
                        + 'steps -- reload the page to see the update (saving the designer now '
                        + 'would overwrite it).' });
                return;
            }
            $http.get('/api/3/workflows/' + uuid + '?$relationships=true&$versions=true')
                .then(function (resp) {
                    var pb = resp && resp.data;
                    if (!pb || !Array.isArray(pb.steps)) return;
                    ds.originalPlaybook = $window.angular.copy(pb);
                    ds.refresh(pb);
                    _logEvent('designer_refreshed', { steps: pb.steps.length });
                })
                .catch(function (err) {
                    _logEvent('designer_refresh_failed', { status: err && err.status });
                });
        }

        function _handleTurnResult(result, fromPoll) {
            fromPoll = fromPoll || (result && result._fromPoll);
            // A nullish resolution (empty 200 body, an unwrapped envelope with
            // no .data, a mock action with no fixture) must not throw -- the
            // downstream `result.transcript` deref would, and two call sites
            // (.then(_handleTurnResult) without a .catch) would then leave the
            // turn stuck in 'sending'. Coerce to an empty result so the turn
            // settles cleanly to idle, and surface the anomaly in the log.
            if (!result || typeof result !== 'object') {
                _logEvent('turn_result_empty', { received: result === undefined ? 'undefined' : String(result) });
                result = {};
            }
            // Detached-mode commit gate. A detached turn's authoritative
            // transcript arrives ONLY via the chat_poll terminal (fromPoll). The
            // synchronous chat_turn return must be a pure {accepted} ack; if a
            // connector echoes a transcript inline anyway, ignore it -- never
            // commit it -- and wait for the poll terminal. Without this, a stale
            // inline transcript bypassed the ack short-circuit below (which only
            // fires on an EMPTY transcript) and got committed (sess-ei6esw96).
            if (_detachedActive && !fromPoll) {
                if (result && typeof result.turn === 'number' && result.turn > _lastTurn) _lastTurn = result.turn;
                _logEvent('turn_ack', {
                    turn: result && result.turn,
                    turn_id: result && result.turn_id,
                    detached_sync_transcript_ignored: !!(result && result.transcript && result.transcript.length)
                });
                return;
            }
            // Async ack: in poll-to-completion mode the connector accepts the
            // turn and returns immediately ({accepted:true} with no transcript);
            // the authoritative transcript then arrives via the chat_poll
            // terminal (stream_end), NOT here. Latch the turn number so stale-
            // frame gating still works, but don't tear down the live preview or
            // commit anything -- let the stream keep running.
            if (result && (result.accepted || result.stop_reason === 'accepted')
                       && !(result.transcript && result.transcript.length)) {
                if (typeof result.turn === 'number' && result.turn > _lastTurn) _lastTurn = result.turn;
                _logEvent('turn_ack', { turn: result.turn, turn_id: result.turn_id });
                return;
            }
            // Idempotency: the poll terminal, a late chat_turn return, and (in
            // sync mode) both at once can all land here for the same turn.
            // Commit each turn exactly once -- first writer wins.
            var _turnNo = (result && typeof result.turn === 'number') ? result.turn : null;
            if (_turnNo != null && _committedTurns[_turnNo]) {
                _logEvent('turn_result_duplicate', { turn: _turnNo, stop_reason: result && result.stop_reason });
                return;
            }
            // The authoritative response is in -- tear down the live preview so
            // the rendered transcript (cards, coalesced text) takes its place.
            _stopStreaming();
            if (_turnAborted) {
                _logEvent('turn_result_discarded', { stop_reason: result && result.stop_reason });
                return;
            }
            // Contract drift gate (§10). May flip us into 'error' under strict.
            if (_checkContractVersion(result && result.contract_version)) return;
            // Remember the committed turn so the next stream ignores its
            // (now stale) frames if the first poll outraces chat_turn.
            if (result && typeof result.turn === 'number' && result.turn > _lastTurn) {
                _lastTurn = result.turn;
            }
            // Stale-replay guard (defense-in-depth, covers sync mode too): a
            // transcript whose tool calls are ALL already on screen is an echo
            // of an earlier turn -- committing it would duplicate the timeline
            // and overwrite no YAML. Treat the turn as committed (so the real
            // poll terminal, if any, still wins via idempotency) but render
            // nothing.
            if (result.transcript && result.transcript.length && _isStaleReplay(result.transcript)) {
                if (_turnNo != null) _committedTurns[_turnNo] = true;
                _logEvent('stale_transcript_skipped', { turn: _turnNo, stop_reason: result.stop_reason });
                _detachedActive = false;
                _setState('idle');
                return;
            }
            _detachedActive = false;
            if (_turnNo != null) _committedTurns[_turnNo] = true;
            _logEvent('action_result', { action: 'chat_turn', stop_reason: result.stop_reason });
            _appendAssistantMessage(result.transcript || []);
            // A TRUNCATED turn's fence is a fragment, and Save compiles the
            // fence back OVER the open record -- so adopting it would delete
            // every step the model never got to write. Same destructive class
            // as a fragment fence, arriving through the token cap instead.
            // Keep the previous `currentYaml` rather than a half-playbook.
            if (_isTruncated(result.stop_reason)) {
                // NOT an error state. Every token here means the reply is
                // INCOMPLETE, but incomplete is not failed: `max_tool_turns` is
                // the benign "tool-loop budget spent, send another message"
                // stop, and the analyst resumes by typing. So the one safe
                // common behaviour is: keep the previous draft, say why, and
                // let them carry on.
                // (`max_turns` is the framework's PRE-FIX label for the
                // output-token cap -- the cap now reports `max_tokens`. Kept in
                // the list so a box on an older framework still guards.)
                _logEvent('truncated_yaml_discarded', { stop_reason: result.stop_reason });
                // Append a visible system notice to the transcript so the analyst
                // sees why the reply stopped early and can resume by typing.
                // Every truncated stop gets a line: `max_turns` / `length` are
                // the output-token cap under older labels (see above), and a cap
                // with no explanation is exactly the silent stop this exists for.
                var msg = { type: 'activity', lines: [] };
                if (result.stop_reason === 'max_tool_turns') {
                    msg.lines.push({ message: 'Stopped early: tool budget reached. Send another message to continue.' });
                } else {
                    msg.lines.push({ message: 'Reply was cut off at the output limit. Ask me to continue.' });
                }
                if ($scope.messages && $scope.messages.length) {
                    var lastMsg = $scope.messages[$scope.messages.length - 1];
                    if (lastMsg && lastMsg.events) {
                        lastMsg.events.push(msg);
                    }
                }
                _setState('idle');
                return;
            }
            // Only a verified offer card loads a playbook into `currentYaml`,
            // the thing Save compiles over the open record. A playbook the
            // model typed into its reply is held in `withheldYaml` (offered
            // back behind one click) and the pane stays as the analyst left
            // it. Live: "what's the impact of removing this step?" was
            // answered with a whole playbook, and the fence scrape made that
            // answer the open playbook. A read-only chip withholds even a
            // verified offer: the analyst scoped the turn to change nothing.
            // Falls through rather than returning early: the turn can still
            // carry an `approval_required` / `error` stop_reason, and those
            // handlers live below.
            _loadTurnYaml(result.transcript || [], result.last_assistant_yaml);
            _refreshDesignerAfterApply(result.transcript || []);
            _loadStagedIntoDesigner(result.transcript || []);
            _absorbUsage(result.transcript || []);

            if (result.stop_reason === 'approval_required') {
                var ar = _findApprovalRequest(result.transcript || []);
                $scope.approvalRequest = ar
                    ? { tool: ar.tool, approvalId: ar.approval_id, turnId: result.turn_id }
                    : null;
                _setState('awaiting_approval');
                return;
            }
            if (result.stop_reason === 'error') {
                var errEv = (result.transcript || []).find(function (e) { return e.type === 'error'; });
                $scope.errorMessage = errEv ? _sanitizeError(errEv) : 'Unknown error';
                _setState('error');
                return;
            }
            // Contract 2.2.0: the resume failed the connector's HMAC binding
            // check -- the suspended action was NOT executed (fail-closed).
            // Clear the pending approval/action card, surface the message, and
            // prompt the analyst to re-issue the request. (A pre-2.2.0 widget
            // falls through to the generic `error` handling above.)
            if (result.stop_reason === 'approval_unverified') {
                var unverEv = (result.transcript || []).find(function (e) { return e.type === 'error'; });
                $scope.errorMessage = (unverEv && unverEv.message)
                    || 'The approved action could not be cryptographically verified and was NOT executed. Please re-issue the request.';
                $scope.approvalRequest = null;
                _flagPendingCardsUnverified();
                _setState('error');
                _logEvent('approval_unverified', { message: $scope.errorMessage });
                return;
            }
            _setState('idle');
        }

        // ─── Helpers ──────────────────────────────────────────────────────────

        // `opts.author` (string name) and `opts.ts` (epoch MS) come from
        // rehydration so a reopened chat shows the REAL sender + original time.
        // Live sends pass neither → default to the current user + now.
        function _appendUserMessage(text, opts) {
            opts = opts || {};
            $scope.messages.push({
                role: 'user', text: text, events: [],
                ts: opts.ts || Date.now(),
                author: opts.author || $scope.initiator.name
            });
        }

        // The analyst's manual-input submission as a user message, so the
        // next chat_turn's serialized history includes the facts the connector
        // also persists to its canonical conversation. Without this, the
        // follow-up turn sees only the assistant's narration (which may omit
        // the run_pk or the fact that input was submitted), and the model
        // asks the analyst to confirm something the session already holds --
        // the `agent_asks_for_data_it_holds` strand (tracker #114).
        function _manualInputUserText(inputId, decision, values, option) {
            var gate = 'manual_input_id=' + inputId;
            if (decision === 'reject') {
                return 'I declined the manual-input gate (' + gate + ').';
            }
            var vals = Object.keys(values || {}).map(function (k) {
                return k + ': ' + values[k];
            }).join(', ');
            var lead = option
                ? 'I chose "' + option + '" on the manual-input gate (' + gate + ')'
                : 'I approved the manual-input gate (' + gate + ')';
            return lead + (vals ? ' with values: ' + vals : '') + '.';
        }

        function _approvalUserText(toolName, decision, note) {
            var label = decision === 'approve' ? 'approved' : 'rejected';
            var msg = 'I ' + label + ' the ' + toolName + ' action';
            if (note) msg += ' (note: ' + note + ')';
            return msg + '.';
        }

        function _appendSystemMessage(text) {
            $scope.messages.push({ role: 'system', text: text, events: [], ts: Date.now() });
        }

        // Delegates to the pure render module (fsrPbRender.js). The clock +
        // collapse threshold are bound here so the extracted code stays
        // framework-free and node-testable; the controller just pushes the
        // resulting render model onto $scope.messages.
        // Dedup keyed on tool_use id (globally unique). The turn-numbered
        // idempotency at _handleTurnResult only fires when result.turn != null;
        // a null-turn transcript (or any second commit path -- a poll terminal
        // racing a late chat_turn return) slips past it and re-renders the whole
        // turn, DOUBLE-COUNTING every tool call in export & audit (HIGH -- audit
        // integrity). A tool_use id can be committed exactly once, so if this
        // transcript carries an id already on the timeline it's a re-commit --
        // drop it. Text-only turns (no ids) can't be safely deduped this way and
        // fall through to the turn-level guard, which is where they belong.
        function _assistantToolUseIds(events) {
            var ids = [];
            (events || []).forEach(function (e) {
                var id = e && (e.id || e._toolUseId || e.tool_use_id);
                if (id && (e.type === 'tool_use' || e.type === 'tool_call' ||
                           e.type === 'tool_result')) ids.push(id);
            });
            return ids;
        }
        function _appendAssistantMessage(events) {
            // A RESUME transcript is cumulative: the connector replays every
            // pre-approval frame and appends the new ones. Dropping the whole
            // message on the first already-committed id therefore threw away the
            // new content too -- the manual_input CARD the analyst has to fill in,
            // and the tool_result that completes the run_playbook chip (which is
            // why that chip sat on PENDING forever). The approved playbook then
            // stayed parked on the box with no way to answer it. #91.
            //
            // Drop the REPLAYED frames, keep the new ones: audit integrity is
            // about not counting a tool call twice, which per-frame filtering
            // preserves exactly, while an all-or-nothing skip also silently
            // discarded content nobody had seen.
            // Dropping a replayed tool_use also drops its NAME, and the fresh
            // tool_result it pairs with then renders through the renderer's
            // unpaired fallback as "Used tool tool". Carry the name across:
            // the result frame keeps `tool` even when its tool_use is trimmed.
            var namesById = {};
            (events || []).forEach(function (e) {
                var nid = e && (e.id || e._toolUseId || e.tool_use_id);
                if (nid && e.name &&
                    (e.type === 'tool_use' || e.type === 'tool_call')) {
                    namesById[nid] = e.name;
                }
            });
            var seen = [];
            var fresh = (events || []).filter(function (e) {
                var id = e && (e.id || e._toolUseId || e.tool_use_id);
                if (!id) return true;                       // text/cards ride along
                if (e.type === 'tool_use' || e.type === 'tool_call') {
                    if (_committedToolUseIds[id]) { seen.push(id); return false; }
                    return true;
                }
                // A tool_result for a call whose RESULT is already rendered is a
                // replay; one for a still-pending call is the completion we need.
                if (e.type === 'tool_result') {
                    if (_committedToolResultIds[id]) { seen.push(id); return false; }
                    if (!e.tool && namesById[id]) e.tool = namesById[id];
                    return true;
                }
                return true;
            });
            if (!fresh.length) {
                _logEvent('assistant_message_duplicate_skipped',
                          { tool_use_id: seen[0], replayed: seen.length });
                return;
            }
            if (seen.length) {
                _logEvent('assistant_message_replay_trimmed',
                          { replayed: seen.length, kept: fresh.length });
            }
            events = fresh;
            var ids = _assistantToolUseIds(events);
            (events || []).forEach(function (e) {
                var id = e && (e.id || e._toolUseId || e.tool_use_id);
                if (id && e.type === 'tool_result') _committedToolResultIds[id] = true;
            });
            ids.forEach(function (id) { _committedToolUseIds[id] = true; });
            $scope.messages.push($window.FsrPbRender.buildAssistantMessage(events, {
                now: Date.now,
                collapseThreshold: COLLAPSE_THRESHOLD,
                // Timeline mode: text renders as ordered events interleaved with
                // the tools/cards it triggered, so the committed message reads as
                // the SAME chronological timeline as the live streaming preview
                // (no jarring re-layout when the turn ends).
                interleaveText: true
            }));
            // A committed turn is where a manual_input gate normally arrives.
            _syncExpiryTicker();
            _syncDecisionPoll();
        }

        // Cap a prior-turn tool_result before it is re-sent to the connector.
        // Every prior tool_result rides verbatim in the next turn's `messages`
        // (full incident + alert records + 60-row searches ≈ 30 KB), bloating the
        // request body and the model's context -- a contributor to the 300 s build
        // timeout. The full record already lives server-side; the transcript only
        // needs enough to read the flow. Keep head+tail so the shape stays legible.
        var PRIOR_RESULT_CAP = 2048;
        function _capPriorResult(s) {
            s = String(s == null ? '' : s);
            if (s.length <= PRIOR_RESULT_CAP) return s;
            var head = s.slice(0, PRIOR_RESULT_CAP - 200);
            var tail = s.slice(-120);
            return head + '\n… (' + (s.length - head.length - tail.length)
                + ' chars truncated) …\n' + tail;
        }

        function _serializeMessagesForServer() {
            return $scope.messages
                // Seeded entity summary is display-only (a structured card with
                // empty text); the connector receives it via entity.summary_seed
                // (contract §2), so don't also send an empty assistant message.
                .filter(function (m) { return (m.role === 'user' || m.role === 'assistant') && !m._seeded; })
                .map(function (m) {
                    if (m.role === 'user') return { role: 'user', content: m.text };
                    var content = [];
                    // Legacy coalesced shape (interleaveText off). With timeline
                    // mode on, text rides as ordered 'text' events below instead.
                    if (m.text) content.push({ type: 'text', text: m.text });
                    (m.events || []).forEach(function (e) {
                        if (e.type === 'text') { if (e.text) content.push({ type: 'text', text: e.text }); }
                        else if (e.type === 'tool_use') content.push({ type: 'tool_use', name: e.name, input: _safeParse(e.display) });
                        else if (e.type === 'tool_result') content.push({ type: 'tool_result', tool: e.name, content: _capPriorResult(e.display) });
                        else if (e.type === 'tool_call') {
                            // Flatten the paired UI event back to the wire shape
                            // the server expects (tool_use followed by tool_result).
                            if (e.inputDisplay !== null) {
                                content.push({ type: 'tool_use', id: e._toolUseId || undefined, name: e.name, input: _safeParse(e.inputDisplay) });
                            }
                            if (e.resultDisplay !== null) {
                                content.push({ type: 'tool_result', tool_use_id: e._toolUseId || undefined, tool: e.name, content: _capPriorResult(e.resultDisplay) });
                            }
                        }
                    });
                    return { role: 'assistant', content: content };
                });
        }



        // ── Read-only asks never adopt a fence (T1 §6g.2 F2) ────────────────
        //
        // A ```yaml fence is a WRITE: Save compiles the LAST fence back over
        // the open record. So a fence returned on a turn the analyst
        // explicitly scoped read-only ("just explain it, change nothing") is
        // an unrequested write on a question -- the same destructive class as
        // the truncated fence above, arriving through model disposition
        // instead of the token cap.
        //
        // The connector's build prompt already carries the rule ("a fence is a
        // WRITE, never emit one on a question"), and it moved both offending
        // scenarios a long way -- but `explain_loop_semantics` still authors a
        // playbook about half the time on BOTH models tested. A prompt is a
        // disposition lever, and disposition is exactly what a prompt cannot
        // guarantee; the write itself has to be refused where it lands.
        //
        // Keyed on the CHIP the analyst pressed, never on their words. This
        // used to be eight regexes over the user's text, and it failed twice
        // over:
        //
        //   1. It matched none of the prompts that actually matter. The Explain
        //      chip sends "Explain what this playbook does, step by step, in
        //      plain language" -- no "don't change", no "just explain", no
        //      "change nothing", so not one pattern fired.
        //   2. The caller then wrote `!(opts && opts.quickAction) && ...`, so a
        //      chip firing forced the flag FALSE -- excluding the single most
        //      reliable read-only signal in the product from the read-only path.
        //
        // Matching intent against phrasing is guesswork either way: the analyst
        // can always say it a way the list has never seen. A chip is a fact.
        // This mirrors the connector's `_READ_ONLY_QUICK_ACTIONS`, and the two
        // sets must stay in step -- if they drift, the widget withholds a fence
        // on a turn the server armed to write one, or the reverse.
        //
        // This is a nicety, NOT the gate. It is client-side, so it protects
        // only turns that come through this widget; the load-bearing refusal
        // is in the tool (`emit_playbook_offer` refuses to drop steps the open
        // playbook has), which no caller can route around.
        var _READ_ONLY_CHIPS = { explain: true, find_issues: true,
            // list-page questions: a drafted playbook is not what was asked for
            list_attention: true, list_summary: true, list_find: true };

        // Latched per turn at send time: the fence lands in a later callback,
        // by which point the composer has been cleared.
        var _readOnlyTurn = false;

        function _isReadOnlyChip(key) {
            return !!(key && _READ_ONLY_CHIPS[String(key).trim().toLowerCase()]);
        }

        // The withheld playbook is NOT discarded. The analyst gets an explicit
        // one-click way to take the draft anyway: a chip scopes the TURN, but
        // they may still decide they want the draft it produced. Refusing
        // silently would lose real work; refusing loudly costs one click.
        $scope.withheldYaml = null;
        $scope.withheldReason = null;

        $scope.applyWithheldYaml = function () {
            if (!$scope.withheldYaml) return;
            _logEvent('withheld_yaml_applied', { yamlLength: $scope.withheldYaml.length });
            $scope.currentYaml = $scope.withheldYaml;
            $scope.withheldYaml = null;
        };

        $scope.dismissWithheldYaml = function () {
            if (!$scope.withheldYaml) return;
            _logEvent('withheld_yaml_dismissed', { yamlLength: $scope.withheldYaml.length });
            $scope.withheldYaml = null;
        };

        // The verified bytes a turn's offer card carries, or null. The card
        // holds exactly what verify passed; a fence is whatever the model
        // happened to type, and live the two diverged (it verified one
        // document, then printed three different ones). A trace-built offer
        // carries no final_yaml: its accept compiles the recorded trace, so
        // there is nothing for the pane to load.
        function _offerYaml(events) {
            for (var k = 0; k < events.length; k++) {
                var ev = events[k];
                if (ev && (ev.type === 'enhancement_offer' || ev.type === 'playbook_offer')) {
                    var y = ev.final_yaml || ev.finalYaml;
                    if (y) return String(y);
                }
            }
            return null;
        }

        // The last ```yaml fence in the turn's text, or null. Text arrives as
        // streamed deltas, so a fence can span several events: concatenate
        // first, then match the LAST line-anchored fence.
        function _replyYaml(events) {
            var combined = '';
            for (var i = 0; i < events.length; i++) {
                if (events[i] && events[i].type === 'text') combined += (events[i].text || '');
            }
            return _extractLastYamlFence(combined).yaml;
        }

        function _loadTurnYaml(events, lastAssistantYaml) {
            var prior = String($scope.currentYaml || '').trim();
            var verified = _offerYaml(events);
            if (verified != null && !_readOnlyTurn) {
                $scope.currentYaml = verified.trim();
                $scope.withheldYaml = null;
                return;
            }
            // 2.7.0 detached terminal frames carry last_assistant_yaml too.
            var typed = verified != null ? verified : _replyYaml(events);
            if (typed == null && lastAssistantYaml) typed = String(lastAssistantYaml);
            typed = typed == null ? '' : typed.trim();
            if (!typed || typed === prior) return;
            $scope.withheldYaml = typed;
            $scope.withheldReason = _readOnlyTurn ? 'readonly' : 'unverified';
            _logEvent(_readOnlyTurn ? 'readonly_yaml_withheld' : 'unverified_yaml_withheld',
                      { yamlLength: typed.length });
        }

        // ── Turn usage meter ────────────────────────────────────────────────
        // The header shows the CURRENT turn's totals. _absorbUsage recomputes
        // them from the frames it is handed and REPLACES the meter, it never
        // accumulates. The live poll re-absorbs the whole turn each tick and
        // the committed transcript carries the same rounds again, so a replace
        // counts every round exactly once. A new turn starts from zero.
        function _emptyUsage() {
            return { tokens: 0, tokensDisplay: '0', inputDisplay: '0', outputDisplay: '0',
                     cost: '0.0000', tooltip: '' };
        }

        function _resetUsage() {
            $scope.usage = _emptyUsage();
        }

        // Anthropic's input_tokens EXCLUDES the cache counters; OpenAI's already
        // contains its cached part. Only used for frames from a connector that
        // predates the normalized total_input/total_tokens fields.
        function _isAnthropicModel(model) {
            var m = String(model || '').toLowerCase();
            return m.indexOf('claude') !== -1 || m.indexOf('anthropic') === 0;
        }

        function _roundUsage(e) {
            var input = Number(e.input_tokens) || 0;
            var output = Number(e.output_tokens) || 0;
            var cacheRead = Number(e.cache_read) || 0;
            var cacheWrite = Number(e.cache_write) || 0;
            var totalInput = (typeof e.total_input === 'number') ? e.total_input
                : (_isAnthropicModel(e.model) ? input + cacheRead + cacheWrite : input);
            var total = (typeof e.total_tokens === 'number') ? e.total_tokens
                : totalInput + output;
            return { input: totalInput, output: output, cached: cacheRead,
                     total: total, cost: Number(e.cost_usd) || 0 };
        }

        // ── Model badge ─────────────────────────────────────────────────────
        // Where the conversation is going: the model named by the newest usage
        // frame (live poll, committed transcript, or a replayed turn). Before
        // any turn has answered, the badge falls back to the connector
        // configuration in use; with neither it stays hidden.
        $scope.lastModel = '';
        function _noteModel(events) {
            var m = fsrPbCardsService.latestModel(events);
            if (m) $scope.lastModel = m;
        }
        // Memoized on its label: a template binding that gets a fresh object
        // every digest never settles ($rootScope:infdig).
        var _badgeMemo = { label: null, badge: null };
        $scope.modelBadge = function () {
            var d = fsrPbCardsService.describeModel($scope.lastModel);
            var ci = $scope.connectorInfo;
            var label = d ? d.label : (ci && ci.configName ? 'Configuration: ' + ci.configName : '');
            if (!label) return null;
            if (_badgeMemo.label !== label) {
                _badgeMemo = { label: label, badge: {
                    label: label,
                    title: d ? 'Your messages are sent to this model.'
                        : 'Your messages go to the model set in this connector configuration. The model name shows after the first reply.'
                } };
            }
            return _badgeMemo.badge;
        };

        function _absorbUsage(events) {
            _noteModel(events);
            var acc = { input: 0, output: 0, cached: 0, total: 0, cost: 0 };
            (events || []).forEach(function (e) {
                if (!e || e.type !== 'usage') return;
                var r = _roundUsage(e);
                acc.input += r.input;
                acc.output += r.output;
                acc.cached += r.cached;
                acc.total += r.total;
                acc.cost += r.cost;
            });
            var cost = acc.cost.toFixed(4);
            var tooltip = _formatThousands(acc.input) + ' in'
                + (acc.cached ? ' (' + _formatThousands(acc.cached) + ' cached)' : '')
                + ' \u00b7 ' + _formatThousands(acc.output) + ' out \u00b7 $' + cost;
            $scope.usage = {
                tokens: acc.total,
                tokensDisplay: _formatThousands(acc.total),
                inputDisplay: _formatThousands(acc.input),
                outputDisplay: _formatThousands(acc.output),
                cost: cost,
                tooltip: tooltip
            };
        }

        function _formatThousands(n) {
            return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        }



        function _setState(s) {
            $scope.viewState = s;
            if (s !== 'error') $scope.errorMessage = '';
            _logEvent('state', { state: s });
        }

        // B3 (a11y) -- a screen-reader announcement for the turn lifecycle.
        //
        // Deliberately NOT aria-live on the transcript itself: the streaming
        // preview rebuilds its event list every poll (~700ms), so a live region
        // over it would re-announce the whole partial answer several times per
        // turn. Announcing the STATE instead is the standard chat pattern --
        // one short, low-churn message per transition -- and it is what a
        // non-sighted analyst actually needs ("is it working / did it finish").
        // Returns '' when idle with nothing to say, so the region stays quiet.
        $scope.a11yStatus = function () {
            switch ($scope.viewState) {
                case 'sending': return 'Assistant is working…';
                case 'awaiting_approval': return 'Waiting for your approval.';
                case 'error': return 'The turn failed. ' + ($scope.errorMessage || '');
                default: return $scope.messages && $scope.messages.length
                    ? 'Response complete.' : '';
            }
        };

        // Redact secrets from any string before it is shown, stored, or
        // exported. A 404/timeout from the gateway echoes the request -- which
        // includes the live `Authorization: Bearer …` JWT and the
        // Websocket-SessionID -- straight back in the error body. Never let those
        // reach the banner or a downloaded .md. Pure string→string; safe on any
        // text (transcripts, export markdown, error blobs).
        var ERR_BANNER_CAP = 600;
        function _scrubSecrets(s) {
            if (s == null) return '';
            return String(s)
                // Authorization header / bearer tokens (with or without the header
                // name). Charset covers base64url (-_) AND standard base64 (+/=) so a
                // token containing +, / or = padding is redacted in full, not truncated
                // at the first such char (S6).
                .replace(/(Authorization"?\s*[:=]\s*"?\s*)Bearer\s+[A-Za-z0-9._\-+/=]+/gi, '$1Bearer [REDACTED]')
                .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{12,}/gi, 'Bearer [REDACTED]')
                // Bare JWTs (header.payload.signature) that aren't preceded by "Bearer".
                .replace(/\beyJ[A-Za-z0-9._\-+/=]{20,}/g, '[REDACTED-JWT]')
                // Session / token fields in JSON or header form.
                .replace(/(Websocket-SessionID"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[REDACTED]')
                .replace(/("?(?:token|api[_-]?key|secret|password)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[REDACTED]');
        }

        // Turn a raw error into a bounded, secret-free, analyst-friendly banner
        // string. Detects gateway HTML (nginx 404 / 5xx) and maps it to plain
        // guidance instead of dumping the echoed request body.
        function _sanitizeError(err) {
            var raw = (err && err.message) ? err.message
                : (typeof err === 'string' ? err : '');
            var status = (err && (err.status || err.statusCode)) || 0;
            // Pull an HTTP status out of the body if it isn't on the object.
            if (!status) {
                var sm = /\b(404|500|502|503|504)\b/.exec(raw);
                if (sm && /<html|not found|nginx|bad gateway|gateway time-?out|service unavailable/i.test(raw)) {
                    status = parseInt(sm[1], 10);
                }
            }
            var isHtml = /<html|<!doctype|404 not found|nginx/i.test(raw);
            if (isHtml || status === 404 || status === 502 || status === 503 || status === 504) {
                if (status === 502 || status === 504) {
                    return 'The connector timed out (HTTP ' + status + '). The build may be taking longer than the gateway allows. Try again in a moment.';
                }
                if (status === 503) {
                    return 'The connector is temporarily unavailable (HTTP 503). It may be redeploying. Try again in a moment.';
                }
                return 'The connector did not respond (HTTP ' + (status || 404) + '). It may be redeploying, or the request timed out. Try again in a moment.';
            }
            var msg = _scrubSecrets(raw) || ('Error: ' + _scrubSecrets(JSON.stringify(err || '')));
            if (msg.length > ERR_BANNER_CAP) {
                msg = msg.slice(0, ERR_BANNER_CAP) + '… (truncated)';
            }
            return msg;
        }

        function _handleError(err) {
            _stopStreaming();
            _detachedActive = false;
            if (_turnAborted) {
                _logEvent('turn_error_discarded', { message: err && err.message });
                return;
            }
            $scope.errorMessage = _sanitizeError(err);
            // If the backend says the connector is missing, flip the gate so
            // the composer disables and the user gets a clear hint to install/configure.
            var blob = JSON.stringify(err || '');
            if (/does not exist|connector .* not (?:found|installed)/i.test(blob)) {
                $scope.connectorReady = false;
                $scope.connectorGateMessage = 'Connector "' + fsrPbAgentService.connectorName + '" is not installed on this FortiSOAR instance.';
            } else if (!_isMockActive() &&
                /\b401\b|\b403\b|unauthor|forbidden|invalid.*api.?key|api.?key.*(?:invalid|missing|not configured)|openai_api_key|anthropic_api_key|llm.*(?:unreachable|not configured)|provider.*not configured/i.test(blob)) {
                // A turn failed on what looks like an LLM auth/config fault. The
                // config may have been broken all along (or just changed) -- run
                // the health gate so the needs_config help panel takes over
                // instead of leaving a dead error toast.
                _probeConnector();
            }
            _setState('error');
            _logEvent('error', { message: $scope.errorMessage });
        }

        function _safeParse(s) { try { return JSON.parse(s); } catch (e) { return s; } }

        function _logEvent(type, payload) {
            _eventLog.push({ type: type, payload: payload, t: Date.now() });
        }

        // Stream-lifecycle trace, on the CONSOLE rather than `_eventLog`.
        // `_eventLog` is only reachable through the debug object, which is gated
        // to localhost by design -- so on a real appliance, the one class of bug
        // that needs it most (#98: the poll loop does not restart after a
        // resume) is invisible. Every guard that can silently decline to poll
        // now says so by name. Silence here means the guard was never reached,
        // which is itself the answer.
        function _streamTrace(what, detail) {
            // Opt-in only. This poll-loop tracer (#98) is a diagnostic, not a
            // default: left on it emitted two blocks per turn, swamping the test
            // tiers (~1.9k of a ship-verify run's 2.7k lines were this). Enable by
            // setting window.__FSRPB_STREAM_DEBUG = true (console or harness) to
            // debug a stuck/declined poll; silent otherwise.
            try {
                if (!$window.__FSRPB_STREAM_DEBUG) return;
                if ($window.console && $window.console.log) {
                    $window.console.log('[fsr-pb-stream] ' + what + ' '
                        + JSON.stringify(detail || {}));
                }
            } catch (e) { /* never let tracing break a turn */ }
        }

        // Persist the active session under a RECORD/PAGE-scoped key -- ONE thread
        // per mounted record/page, NOT per intent (Phase 1, state-derived-intent
        // plan). A triage ask and an authoring ask on the same record share one
        // continuous conversation, so "triage this alert, then build a playbook
        // for it" carries its context across the handoff with no page flip. The
        // per-turn connector frontier (Phase 2) now gates tools per turn, so the
        // bleed the old per-intent split guarded against is prevented by the
        // frontier, not by separate threads.
        //   - on a record (entity.iri): `fsrPbSession:<iri>` -- all intents share it;
        //   - the playbook designer with no saved record: a dedicated editor bucket;
        //   - off-record (dashboard / module list): the bare `fsrPbSession:triage`
        //     bucket (kept for legacy-session adoption below).
        function _sessionKey() {
            var e = $scope.entityContext;
            var iri = e && e.iri;
            if (iri) return 'fsrPbSession:' + iri;
            if ($scope.inPlaybookEditor) return 'fsrPbSession:playbookEditor';
            return 'fsrPbSession:triage';
        }

        function _ensureSessionId() {
            // One-shot stash from the Agentic Assistant Monitor's "Open in chat":
            // the monitor writes fsrPbOpenSession before navigating so the
            // drawer opens the specific session, not a new one.
            var ls = $window.localStorage;
            var oneShot = ls && ls.getItem('fsrPbOpenSession');
            if (oneShot) { ls.removeItem('fsrPbOpenSession'); return oneShot; }
            var fromQuery = _queryParam('session');
            if (fromQuery) return fromQuery;
            var key = _sessionKey();
            var fromStorage = ls && ls.getItem(key);
            // Legacy migration: the pre-scoping key was un-namespaced and
            // triage-defaulted. Adopt it ONLY for the un-scoped triage bucket
            // (an off-record mount) -- adopting a global session onto a specific
            // record would re-introduce the cross-record bleed that record-
            // scoping fixes. It re-persists under the scoped key on the next write.
            if (!fromStorage && ls && key === 'fsrPbSession:triage') {
                fromStorage = ls.getItem('fsrPbSession');
            }
            if (fromStorage) return fromStorage;
            return _mintSession();
        }

        function _mintSession() {
            var s = _queryParam('mock')
                ? 'mock-' + (_queryParam('mock') || 'default') + '-' + (++_turnCounter)
                : 'sess-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
            try { $window.localStorage.setItem(_sessionKey(), s); } catch (e) {}
            return s;
        }

        function _queryParam(name) {
            var s = $window.location.search || '';
            var re = new RegExp('[?&]' + name + '=([^&]+)');
            var m = re.exec(s);
            return m ? decodeURIComponent(m[1]) : null;
        }

        // ─── Entity context detection ─────────────────────────────────────────
        // Real SOAR injects the host record onto the widget scope when mounted
        // in a record drawer. URL params are NOT a reliable channel in real
        // SOAR (the widget lives inside the SPA route), so ?entity= is only a
        // harness/test aid; the scope + window override are the durable paths.
        function _detectEntity() {
            var rec = $scope.record || $scope.recordData || $scope.entity || $scope.entityData
                || ($scope.$parent && ($scope.$parent.record || $scope.$parent.entity)) || null;
            if (!rec && $window.__fsrPbEntity__) rec = $window.__fsrPbEntity__;   // harness/test override
            if (!rec) {
                var iriParam = _queryParam('entity');                            // harness manual test
                if (iriParam) rec = { '@id': iriParam };
            }
            // Durable real-SOAR channel: the host record is NOT reliably exposed
            // on the widget scope when mounted in a record drawer, but the
            // UI-Router state carries the module + id of the page we're over
            // (e.g. an alert detail). Build the IRI from $state.params; the
            // record itself is then fetched authoritatively in _seedFromEntity.
            // This mirrors how the fortisocchatagent widget derives context.
            if (!rec || (typeof rec === 'object' && !(rec['@id'] || rec.iri || rec.id))) {
                var fromState = _entityFromState();
                if (fromState) rec = fromState;
            }
            if (!rec || typeof rec !== 'object') return null;
            var iri = rec['@id'] || rec.iri || rec.id || '';
            if (!iri) return null;
            var module = _moduleFromIri(iri) || rec.module || rec['@type'] || '';
            return { iri: iri, module: module, record: rec, summary_seed: '' };
        }

        // Read the current UI-Router state for a module-detail page and return a
        // minimal record stub ({ '@id', module }) the seed flow can resolve.
        // Returns null on a dashboard/list mount or when $state is unavailable
        // (e.g. some harness contexts). Safe: never throws.
        function _entityFromState() {
            var $state;
            try { $state = $injector.get('$state'); } catch (e) { return null; }
            var params = ($state && $state.params) || {};
            var stateName = ($state && $state.current && $state.current.name) || '';
            // Only seed over a record-detail page, not a list or dashboard.
            if (stateName && stateName.indexOf('Detail') < 0 && stateName.indexOf('detail') < 0) return null;
            var module = params.module || '';
            var id = params.id || '';
            if (!module || !id) return null;
            // params.id may already be a full IRI or just the bare uuid/id.
            var iri = /^\/api\//.test(String(id)) ? id : '/api/3/' + module + '/' + id;
            return { '@id': iri, module: module };
        }

        // Module LIST mount (main.modules.list, /main/modules/<type>): no record
        // is open, but the page still names a module. Returns that module, or
        // null over a record, a dashboard, the designer, or without ui-router.
        // `?listModule=<module>` stands in for the router in the harness.
        function _listModuleFromState() {
            var qp = _queryParam('listModule');
            if (qp) return qp;
            var $state;
            try { $state = $injector.get('$state'); } catch (e) { return null; }
            var stateName = ($state && $state.current && $state.current.name) || '';
            if (stateName.indexOf('main.modules.list') !== 0) return null;
            var params = ($state && $state.params) || {};
            if (params.id) return null;
            return params.module || null;
        }

        function _moduleFromIri(iri) {
            var m = /\/api\/\d+\/([^\/?]+)\//.exec(String(iri || ''));
            return m ? m[1] : '';
        }

        // ─── Playbook-editor mount detection ──────────────────────────────────
        // Drawer widgets stay mounted across UI-Router state changes (KB §18.4);
        // `enableFor` includes `main.playbookDetail` (the playbook designer,
        // `/playbooks/:id`) so this widget can float there. That state carries
        // NO `module` param (it's not a generic record-detail route), so
        // _entityFromState() correctly returns null for it -- this is a
        // dedicated check. Safe: never throws, returns false if $state is
        // unavailable (harness contexts without ui-router).
        function _inPlaybookEditor() {
            var $state;
            try { $state = $injector.get('$state'); } catch (e) { return false; }
            return !!($state && $state.current && $state.current.name === 'main.playbookDetail');
        }

        // The FortiSOAR router state name for the mounted page (Phase 1 page
        // fact). The widget reports raw page facts; the connector classifies them
        // into an affordance prior (one taxonomy). Null in harness contexts with
        // no ui-router -- the connector then falls back to the module/triage
        // default. `intent` still rides the payload as the soft override.
        function _currentStateName() {
            var $state;
            try { $state = $injector.get('$state'); } catch (e) { return null; }
            return ($state && $state.current && $state.current.name) || null;
        }

        // Is the current entity the OPEN PLAYBOOK? In the designer that's the
        // only sensible entity. "A workflows record" is not enough: moving from
        // one playbook to another in the designer kept the FIRST one as the
        // entity, so every turn sent its YAML and Apply staged its steps onto
        // the second playbook's canvas. It must be the playbook the designer
        // has open now ($state.params.id), when ui-router can say which.
        function _entityIsOpenPlaybook() {
            var e = $scope.entityContext;
            if (!(e && e.iri && e.module === 'workflows')) return false;
            // Without ui-router (some harness mounts) there is nothing to
            // compare against; a designer state with no id is a playbook that
            // is not this one.
            if (!_currentStateName()) return true;
            var open = _playbookEntityFromState();
            return !!open && open.iri === e.iri;
        }

        // In the designer the entity MUST be the open playbook. The widget is a
        // persistent drawer, so a stale entity captured on a prior page (e.g. a
        // Key Store `keys` record) would otherwise survive into the editor --
        // leaking "Triaging key" framing and a `module: keys` into the authored
        // playbook's Start step (the reported bug). Replace it with the playbook,
        // but never yank an in-progress conversation (only when nothing but a
        // stale seed card is on screen).
        function _ensurePlaybookEntity() {
            if (_entityIsOpenPlaybook()) return;
            // Adopt the open playbook even over an ACTIVE chat. The old
            // "leave it, context just goes stale" guard predates record-scoped
            // sessions: same-tab alert -> designer navigation kept the ALERT's
            // whole conversation -- its cards, its approval state -- on screen
            // over the playbook. Nothing is lost by adopting: the record's
            // thread is durable in its own session bucket and rehydrates when
            // the analyst navigates back. The entity watch sees the new iri
            // and re-points the visible session to the playbook's own thread.
            $scope.messages = [];
            $scope.entityContext = null;
            $scope.personaUi = null; _personaModule = null;
            // The previous playbook's YAML and staged draft belong to it. Left
            // in place they ride the next turn as "the open playbook" (and a
            // seed that fails for this one would never replace them).
            $scope.playbookYaml = '';
            $scope.currentYaml = '';
            _stagedMark = null;
            _seedPlaybookEntity();
        }

        // Build the entity stub for the playbook currently open in the designer.
        // main.playbookDetail (/playbooks/:id) carries the playbook's own UUID in
        // $state.params.id; a FortiSOAR playbook is a `workflows` record, so its
        // canonical IRI is /api/3/workflows/<id>. Returns null when $state is
        // unavailable (harness without ui-router) or the id is missing. Safe.
        function _playbookEntityFromState() {
            var $state;
            try { $state = $injector.get('$state'); } catch (e) { return null; }
            var params = ($state && $state.params) || {};
            var id = params.id || '';
            if (!id) return null;
            var iri = /^\/api\//.test(String(id)) ? String(id) : '/api/3/workflows/' + id;
            return { iri: iri, module: 'workflows' };
        }

        // Seed the open playbook as the entityContext so its identity (and, once
        // resolved, its fields) ride every chat_turn -- otherwise the authoring
        // quick-actions ("Explain this playbook", "Find issues") fire a build turn
        // with no playbook to read. Best-effort populates e.record via
        // FormEntityService → HTTP.
        //
        // It also pulls the playbook back as YAML (_seedPlaybookYaml). That is
        // NOT redundant with the record: the agent's build tool slice has no way
        // to fetch a live playbook (get_record/search_module_records are scoped
        // out of build, search_playbooks hits an offline corpus, analyze_playbook
        // takes yaml_text only), so without the YAML the assistant is being asked
        // to edit something it cannot see and dead-ends asking the analyst to
        // paste in what is already on their screen. This comment used to claim
        // "the connector can also fetch by iri with its own SOAR tools" -- it
        // cannot, and that wrong assumption is exactly what the eval caught.
        //
        // Deliberately does NOT render an auto-seed summary card: that alert/case
        // format misfits a playbook and would hide the authoring quick-actions
        // (which require an empty timeline).
        function _seedPlaybookEntity() {
            var pbe = _playbookEntityFromState();
            if (!pbe) return;
            $scope.entityContext = pbe;
            try { _resolveEntityRecord().then(null, function () {}); } catch (e) {}
            _seedPlaybookYaml(pbe.iri);
        }

        // Pull the open playbook back as authored YAML and hold it as the
        // editing base. Two jobs:
        //   1. it rides every build turn (see _entityPayload) so the assistant
        //      can see what it is being asked to change;
        //   2. it seeds currentYaml, so the push button has a base even when the
        //      assistant answers with only a partial edit.
        // Best-effort and silent: a designer that cannot read its playbook is
        // degraded, not broken -- the analyst can still paste YAML by hand -- and a
        // red banner on mount for something they did not ask for is worse than
        // the assistant asking them for the YAML.
        function _seedPlaybookYaml(iri) {
            if (!iri) return;
            // Publish the promise so _runTurn can wait on it, and clear it the
            // moment it settles either way -- a later turn (seed already done)
            // must run synchronously, and a fail-closed seed must not leave a
            // pending promise that would hang the next send.
            function _settled() { _playbookSeedPromise = null; }
            try {
                _playbookSeedPromise = fsrPbAgentService.decompilePlaybook($scope.config, iri)
                    .then(function (res) {
                        // A slow decompile of the playbook the analyst has
                        // since navigated away from must not land as the
                        // grounding copy of the one open now.
                        if (_openPlaybookIri() !== iri) { _settled(); return; }
                        if (res && res.ok !== false && res.yaml) {
                            $scope.playbookYaml = String(res.yaml);
                            // Never clobber work in progress: if the analyst (or a
                            // prior turn) already has YAML in hand, the seed is only
                            // the grounding copy.
                            if (!$scope.currentYaml) $scope.currentYaml = $scope.playbookYaml;
                            _logEvent('playbook_yaml_seeded', {
                                iri: iri, chars: $scope.playbookYaml.length });
                        }
                        _settled();
                    }, function () { _settled(); /* degraded, not broken */ });
            } catch (e) { _playbookSeedPromise = null; /* degraded, not broken */ }
        }

        // ─── Auto-seed from entity (Phase B) ──────────────────────────────────
        // Pre-render a summary of the host record as the assistant's first
        // message before any chat_turn. Resolves to true if a seed was added.
        var _seedInFlight = false;
        function _seedFromEntity() {
            var e = $scope.entityContext;
            // Never render the alert/case summary card over a playbook -- it
            // misfits and would hide the authoring quick-actions.
            if ($scope.inPlaybookEditor) return $q.when(false);
            if (!e || !e.iri || !$scope.config.seedFromEntity) return $q.when(false);
            if ($scope.messages.length > 0) return $q.when(false);
            // Guard against concurrent triggers (init + state-event + watcher all
            // racing while record resolution is in flight) pushing duplicate
            // cards -- only one resolve runs against an empty timeline.
            if (_seedInFlight) return $q.when(false);
            // Drawer already handed us a populated record -- seed directly.
            if (_recordHasFields(e.record)) { _renderSeed(e, e.record); return $q.when(true); }
            // Otherwise resolve authoritatively (FormEntityService → HTTP fetch).
            // Whatever comes back (full record, bare {@id} stub, or nothing), we
            // ALWAYS render a seed card as long as we have an IRI -- the composer
            // falls back to the IRI for the name. An entity with no card is the
            // failure the analyst sees as a missing summary over a real record.
            _seedInFlight = true;
            return _resolveEntityRecord().then(function (rec) {
                rec = (_recordHasFields(rec) || (rec && (rec['@id'] || rec.iri))) ? rec : (e.record || {});
                if (!(rec['@id'] || rec.iri)) rec['@id'] = e.iri;
                e.record = rec;
                if ($scope.messages.length === 0) { _renderSeed(e, rec); return true; }
                return false;
            }, function () {
                var rec = _recordHasFields(e.record) ? e.record : { '@id': e.iri };
                if ($scope.messages.length === 0) { _renderSeed(e, rec); return true; }
                return false;
            }).finally(function () { _seedInFlight = false; });
        }

        // Resolve the host record's full fields -- from the drawer-supplied
        // object if it's already populated, then from the platform
        // FormEntityService (authoritative, in-memory, same source the native
        // record drawer reads), and last from an HTTP fetch by IRI.
        // Shared by the auto-seed and the on-demand "pull in page details".
        function _resolveEntityRecord() {
            var e = $scope.entityContext;
            if (!e || !e.iri) return $q.when(null);
            if (_recordHasFields(e.record)) return $q.when(e.record);
            return _formEntityRecord(e).then(function (rec) {
                if (_recordHasFields(rec)) { e.record = rec; return rec; }
                // Fall back to an authoritative HTTP fetch (relative URL →
                // harness proxy / SOAR API).
                return $http.get(e.iri + '?$relationships=true').then(function (resp) {
                    var r = (resp && resp.data) || null;
                    // Only adopt the response if it actually looks like the record
                    // (has fields, or at least an IRI). A proxy error page / 200
                    // with a non-record body would otherwise clobber the {@id}
                    // stub and defeat the seed card (and every later reseed).
                    if (r && typeof r === 'object' && (_recordHasFields(r) || r['@id'] || r.iri)) {
                        e.record = r;
                        return r;
                    }
                    return e.record || null;
                }, function () { return e.record || null; });
            });
        }

        // Load the current detail-page record via the platform FormEntityService
        // (the same source the native record drawer uses) and flatten its
        // field-wrapped shape into the plain record the seed/card composers
        // expect. Returns null (→ caller falls back to HTTP) when the service
        // is unavailable (harness), errors, or holds a *different* record than
        // the one we're contextualised over (a list→detail navigation can
        // briefly leave a stale entity in the service).
        function _formEntityRecord(e) {
            var svc;
            try { svc = $injector.get('FormEntityService'); } catch (err) { return $q.when(null); }
            if (!svc || !svc.get) return $q.when(null);
            var entity;
            try { entity = svc.get(); } catch (err) { return $q.when(null); }
            if (!entity || !entity.loadFields) return $q.when(null);
            return $q.when(entity.loadFields()).then(function () {
                var rec = _flattenEntityFields(entity);
                var iri = (rec && (rec['@id'] || rec.iri)) || '';
                if (iri && e && e.iri && String(iri) !== String(e.iri)) return null;
                return rec;
            }, function () { return null; });
        }






        // Render an info-card text block: sanitized HTML, trusted for ng-bind-html.
        // Handles both entity-summary blocks (record HTML) and connector-emitted
        // text cards (plain text → passes through escaped, unchanged).
        $scope.renderCardText = function (t) {
            return $sce.trustAsHtml(_sanitizeHtml(t));
        };




        function _renderSeed(e, rec) {
            // Connector still receives the plain-text summary verbatim via the
            // entity block (contract §2 summary_seed). The on-screen render uses
            // the structured card -- see _composeEntityCard.
            e.summary_seed = _composeEntitySummary(e, rec);
            var card = _normalizeInfoCard(_composeEntityCard(e, rec));
            $scope.messages.push({ role: 'assistant', text: '', events: [card], ts: Date.now(), _seeded: true });
        }









        // Empty-hero copy is entity-aware AND persona-aware: a persona mount
        // announces the record in its own voice (via _entityHeadline: greeting →
        // neutral "Working on …" → SOC "Triaging …"), never SOC-triage clothing.
        $scope.heroHeading = function () {
            // In the playbook designer we're authoring, not triaging a record --
            // announce the open playbook (or a neutral build prompt), never
            // "Triaging <module>".
            if ($scope.inPlaybookEditor) {
                var pb = $scope.entityContext;
                var pbn = (pb && (pb.displayName || (pb.record && (pb.record.name || pb.record.title)))) || '';
                return pbn ? 'Editing playbook: ' + pbn : 'Build a playbook';
            }
            var e = $scope.entityContext;
            if (e && e.iri) {
                var nm = e.displayName || (e.record && (e.record.name || e.record.title || e.record.subject)) || '';
                return _entityHeadline(_singularize(e.module) || 'record', nm);
            }
            if ($scope.listContext && $scope.listContext.module) {
                return 'Working in ' + _listNoun();
            }
            return 'Paste the FortiSOC summary to begin';
        };
        // Hero subtitle: persona override (ui.subtitle) → neutral persona line →
        // SOC triage default. Mirrors composerPlaceholder's three-tier pattern so
        // an authoring/orchestration persona doesn't advertise "containment
        // actions -- block, isolate, disable" over a non-SOC record.
        $scope.heroSub = function () {
            if ($scope.inPlaybookEditor) {
                return "Ask me to explain, add, reorder, or fix a step, or describe a new playbook and I'll generate the YAML.";
            }
            var e = $scope.entityContext;
            var p = $scope.personaUi;
            if (e && e.iri) {
                if (p && p.subtitle) return p.subtitle;
                if (p) return "Ask me to explain, edit, or work on this record.";
                if (_overNonTriageRecord()) return 'Ask me what this ' + _recordNoun().toLowerCase() + ' is, what is related to it, or what to do next.';
                return "I'll suggest containment actions (block, isolate, disable), or build a re-runnable hunt and respond playbook for this case.";
            }
            if ($scope.listContext && $scope.listContext.module) {
                if (p && p.listSubtitle) return p.listSubtitle;
                return 'Ask about the ' + _listNoun() + ' here, find one, or create a new ' + _listNounOne() + '.';
            }
            return "I'll suggest whether to take immediate action (block, isolate, disable), or build a re-runnable hunt and respond playbook.";
        };

        // ─── Contract-version drift (§10) ─────────────────────────────────────
        // Returns true if the turn should be abandoned (strict failure).
        var _contractNewerWarned = false;
        function _isStrictContract() {
            return _queryParam('contract') === 'strict' || !!($scope.config && $scope.config.contractStrict);
        }
        function _parseVer(v) {
            var m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || ''));
            return m ? { major: +m[1], minor: +m[2], patch: +(m[3] || 0) } : null;
        }
        function _checkContractVersion(v) {
            // Mock fixtures and pre-2.0 connectors may omit it -- soft-ignore
            // unless strict mode demands a version on every envelope.
            var strict = _isStrictContract();
            if (!v) {
                if (strict) return _contractFail('connector did not report a contract_version');
                return false;
            }
            var got = _parseVer(v);
            var want = _parseVer(WIDGET_CONTRACT_VERSION);
            if (!got) {
                if (strict) return _contractFail('unparseable contract_version "' + v + '"');
                return false;
            }
            if (got.major !== want.major) {
                var emsg = 'Connector contract v' + v + ' is a MAJOR mismatch with this widget (expects v'
                    + WIDGET_CONTRACT_VERSION + '). Update the connector or widget before relying on this.';
                $scope.contractBanner = emsg;
                if ($window.console && console.error) console.error('[agenticAssistant] ' + emsg);
                if (strict) return _contractFail(emsg);
                return false;
            }
            // Same major from here -- clear any stale banner.
            $scope.contractBanner = '';
            if (got.minor < want.minor) {
                var wmsg = 'Connector contract v' + v + ' is older than the widget minimum v'
                    + WIDGET_CONTRACT_VERSION + '. Some features may be unavailable.';
                if ($window.console && console.warn) console.warn('[agenticAssistant] ' + wmsg);
                if (strict) return _contractFail(wmsg);
            } else if (got.minor > want.minor && !_contractNewerWarned) {
                _contractNewerWarned = true;
                if ($window.console && console.warn) {
                    console.warn('[agenticAssistant] Connector contract v' + v + ' is newer than the widget (v'
                        + WIDGET_CONTRACT_VERSION + '). Unknown event types are ignored.');
                }
            }
            return false;
        }
        function _contractFail(msg) {
            $scope.errorMessage = 'Contract check failed (strict): ' + msg;
            _setState('error');
            _logEvent('contract_strict_fail', { message: msg });
            return true;
        }

        // Bounded poll for the entity when UI-Router is slow to settle onto the
        // record-detail state. _detectEntity() reads $state.params, which is empty
        // mid-transition; retry up to ENTITY_RESOLVE_TRIES × ENTITY_RESOLVE_DELAY_MS
        // (~2s) so the seed/opener wait for the record instead of firing blind.
        // Resolves with the entity, or null once tries are exhausted (a genuine
        // dashboard/list mount, where proceeding entity-less is correct).
        var ENTITY_RESOLVE_TRIES = 10;
        var ENTITY_RESOLVE_DELAY_MS = 200;
        function _resolveEntityContextWithRetry(triesLeft) {
            if ($scope.entityContext && $scope.entityContext.iri) return $q.when($scope.entityContext);
            var d = _detectEntity();
            if (d && d.iri) {
                $scope.entityContext = d;
                $scope.listContext = null;
                if ($scope.uiIntent !== 'build') $scope.uiIntent = 'triage';
                return $q.when(d);
            }
            // Work in the listed module meanwhile -- but keep retrying: the
            // router can sit on the list state mid-transition to a record
            // (opener.entity.race), so a list state is not yet an answer.
            var listModule = _listModuleFromState();
            $scope.listContext = listModule ? { module: listModule } : null;
            // Frame the list in its module's persona now, not after ~2s of retry.
            if (listModule && listModule !== _personaModule) _resolvePersonaUi();
            if (triesLeft <= 0) return $q.when(null);
            return _trackTimer($timeout(angular.noop, ENTITY_RESOLVE_DELAY_MS)).then(function () {
                if (_destroyed) return $q.when(null);   // drawer closed mid-retry
                return _resolveEntityContextWithRetry(triesLeft - 1);
            });
        }

        // ─── Init: rehydrate history if session present ──────────────────────
        _trackTimer($timeout(function () {
            if (_destroyed) return;   // torn down before init settled
            // A lone auto-seed summary card (added by the entityContext $watch
            // below when the record is immediately available -- e.g. a drawer mount
            // or an injected entity) must NOT suppress init: otherwise the opener
            // turn never fires and the triage chat dead-ends with only the summary
            // card. Bail only when a REAL (non-seed) message is already present --
            // i.e. a rehydrated session -- which is the case this guard was for.
            if ($scope.messages.some(function (m) { return !m._seeded; })) return;
            // Resolve the entity (with a bounded retry) BEFORE seeding / running
            // the opener. The old code fired _seedFromEntity()+_runOpener()
            // immediately and relied on a disconnected 300ms re-detect to fix a
            // null entity -- but by the time that fired the blind opener had
            // already pushed a message, so _seedFromEntity's `messages.length>0`
            // guard bailed (summary card never rendered) and the opener turn had
            // gone out with no entity. Symptom: "the triage summary card is
            // missing and in exactly those cases the chat doesn't work."
            // _resolveEntityContextWithRetry waits for $state to settle onto the
            // record-detail page, then proceeds (or proceeds entity-less after
            // exhausting tries -- a genuine dashboard/list mount).
            // Kick off entity resolution NOW, independent of chatHistory -- so the
            // context (and uiIntent) settle on first paint even if the history
            // call is slow, and seeding waits on it rather than racing it.
            var _entityReady = _resolveEntityContextWithRetry(ENTITY_RESOLVE_TRIES);
            // Resolve the persona once the entity module has settled, BEFORE the
            // seed composes the greeting card -- so it renders in the persona's
            // voice on first paint rather than flashing SOC framing then
            // re-labelling. personaUi stays null (unchanged behavior) if none.
            var _personaReady = _entityReady.then(_resolvePersonaUi).catch(function () { return null; });
            var _seedAndOpen = function () {
                return _personaReady.then(function () {
                    return _seedFromEntity();
                }).then(function () {
                    // The entity wait above can take ~2s. If the analyst sent a
                    // message meanwhile, the greeting would land after their
                    // question as a second, unrelated assistant turn.
                    if (_destroyed || $scope.viewState !== 'idle') return;
                    if ($scope.messages.some(function (m) { return !m._seeded; })) return;
                    if (_shouldRunOpener()) _runOpener();
                });
            };
            // If the connector resolved as unavailable, skip chatHistory (it
            // would just error) and seed from the entity instead -- local, needs
            // no connector. When resolution is still pending or succeeded we let
            // chatHistory run; resolveConnector gates the actual call and its
            // .catch below seeds from the entity if the connector is missing.
            if ($scope.connectorReady === false) {
                _personaReady.then(_seedFromEntity);
                return;
            }
            // If the host record is already known at construction, _sessionId is
            // record-scoped and this loads THIS record's thread. If the record
            // resolves later (drawer opens / navigation), the entityContext.iri
            // $watch re-points the session via _switchSessionForEntity -- so a
            // record mount never keeps the last record's thread on screen.
            // Guard: if a record switch supersedes this session before the load
            // returns, drop the result rather than replay a stale thread over the
            // record now on screen.
            var _initSession = _sessionId;
            fsrPbAgentService.chatHistory($scope.config, _initSession)
                .then(function (res) {
                    if (_sessionId !== _initSession) return;
                    $scope.sessionInitiator = (res && res.initiator) || null;
                    if (res && res.turns && res.turns.length) {
                        _replayTurns(res.turns, res.card_decisions);
                    } else {
                        _seedAndOpen();
                    }
                    _reattachRunningTurn();
                })
                .catch(_seedAndOpen);
        }, 0));

        // Replay a chat_history `turns` payload into the message timeline:
        // each entry is {user:str} and/or {transcript:[wire events]} in
        // chronological order (connector contract). Shared by the init
        // rehydrate and the history browser's session switch.
        function _replayTurns(turns, decisions) {
            var assistantTurns = 0;
            (turns || []).forEach(function (t) {
                // Connector stores original time as epoch SECONDS; messages use MS.
                var tsMs = (typeof t.ts === 'number') ? Math.round(t.ts * 1000) : null;
                if (t.resume) {
                    _replayChoiceAnswer(t.resume, t.author, tsMs);
                    return;
                }
                if (t.user) {
                    _appendUserMessage(t.user, {
                        author: (t.author && t.author.name) || null,
                        ts: tsMs
                    });
                }
                if (typeof t.model === 'string' && t.model) $scope.lastModel = t.model;
                if (t.transcript) {
                    _noteModel(t.transcript);
                    _appendAssistantMessage(t.transcript);
                    // Stamp the assistant message's original time (buildAssistantMessage
                    // defaults to now; on replay we know when it really happened).
                    if (tsMs && $scope.messages.length) {
                        var _replayed = $scope.messages[$scope.messages.length - 1];
                        _replayed.ts = tsMs;
                        // Same correction for a manual_input gate's deadline
                        // anchor. `expires_in_seconds` is relative to when the
                        // connector BUILT the frame; the renderer anchors it to
                        // "now" because that is normally the same moment. On
                        // replay it is not -- an hour-old gate would otherwise
                        // restart its countdown and invite an answer the run
                        // stopped waiting for long ago. A card carrying the
                        // absolute `expiresAt` ignores the anchor entirely.
                        (_replayed.events || []).forEach(function (ev) {
                            if (ev && ev.type === 'manual_input') ev._seenAtMs = tsMs;
                        });
                    }
                    assistantTurns++;
                }
            });
            // Advance the turn fence to the rehydrated turn count. Without this,
            // _lastTurn stayed 0 after a history-open, so the NEXT turn's stream
            // fence (minTurn = _lastTurn + 1 = 1) failed to exclude the prior,
            // already-terminal turn -- chat_poll then re-served that completed
            // turn's transcript and the widget committed it as the new turn
            // (export sess-ei6esw96: a "build" replayed the prior enrichment).
            // One assistant transcript == one connector turn; counting them
            // matches the connector's turn_idx (max prior turn + 1). Under-count
            // is safe (the detached/stale-replay guards still catch it); we never
            // over-count, which would hang the next poll.
            if (assistantTurns > _lastTurn) _lastTurn = assistantTurns;
            _rehydrateBuildState();
            // Before the approval re-arms: a card answered elsewhere must come
            // back answered, not with live buttons.
            _applyCardDecisions(decisions);
            _rehydrateApprovalState();
            _syncDecisionPoll();
            // Replayed gates carry corrected anchors above; start (or decline to
            // start) the countdown against them.
            _syncExpiryTicker();
        }

        // A stored choice answer (chat_history `resume` row): mark the most
        // recent matching card answered. The pick used to live only on the card
        // object in this browser, so a reload showed the card open again as if
        // nothing had been chosen.
        function _replayChoiceAnswer(resume, author, tsMs) {
            var id = resume && resume.choice_id;
            if (!id) return;
            for (var i = $scope.messages.length - 1; i >= 0; i--) {
                var evs = $scope.messages[i].events || [];
                for (var j = evs.length - 1; j >= 0; j--) {
                    var ev = evs[j];
                    if (!ev || ev.choiceId !== id
                        || (ev.type !== 'choice_card' && ev.type !== 'capability_gap')) continue;
                    var value = resume.value;
                    ev._resolved = true;
                    ev._open = false;
                    ev._picked = ev.multi ? [].concat(value || []) : value;
                    ev._resolutionText = resume.label
                        || (Array.isArray(value) ? value.join(' · ') : String(value == null ? '' : value));
                    ev._resolvedBy = (author && author.name) || null;
                    ev._resolvedAt = tsMs;
                    return;
                }
            }
        }

        // A parked tier-3 approval survives a refresh on the CONNECTOR (the
        // SuspendedSession lives in storage, TTL 10m) but did not survive in the
        // UI: `isPendingApproval` gates on the `$scope.approvalRequest`
        // singleton, which is only ever set from a live turn result. After a
        // reload the card replayed from history with no Approve/Reject buttons
        // at all -- the analyst could see the action was waiting on them and had
        // no way to act on it, and the session dead-ended until the gate expired.
        // Reconstruct the singleton from the replayed transcript.
        function _rehydrateApprovalState() {
            if ($scope.approvalRequest) return;   // a live turn already set it
            var msgs = $scope.messages || [];
            for (var m = msgs.length - 1; m >= 0; m--) {
                var evs = (msgs[m] && msgs[m].events) || [];
                for (var i = evs.length - 1; i >= 0; i--) {
                    var ev = evs[i];
                    if (!ev || ev.type !== 'approval_request') continue;
                    if (ev._resolved) return;   // newest approval already acted on
                    // Tool activity AFTER the request means the turn moved on --
                    // the gate was resolved in a prior session, so don't re-arm.
                    // Note the renderer MERGES a wire `tool_result` into the
                    // `tool_call` chip, so matching only 'tool_result' here
                    // would never fire on a replayed transcript.
                    for (var j = i + 1; j < evs.length; j++) {
                        var nxt = evs[j] && evs[j].type;
                        if (nxt === 'tool_call' || nxt === 'tool_result') return;
                    }
                    if (!ev.approvalId) return;   // nothing to resume by
                    $scope.approvalRequest = {
                        tool: ev.name,
                        approvalId: ev.approvalId,
                        // No turn_id on the replay path: chat_resume pops by
                        // approval_id and keeps turn_id for logging only.
                        turnId: null
                    };
                    _setState('awaiting_approval');
                    _logEvent('approval_rehydrated', { approval_id: ev.approvalId });
                    return;
                }
            }
        }

        // On refresh the timeline is rebuilt from the connector transcript, but
        // the build-vs-triage UI state the analyst was in when they left is NOT
        // carried on the wire. Reconstruct it from the replayed content so a
        // session that already authored a playbook returns in build mode -- YAML
        // pane + toggle visible -- instead of dropping to a bare triage view that
        // re-offers "Build playbook" for work that's already done (export
        // sess-rur4yvdd: post-refresh YAML toggle gone, create-link gone, and a
        // confusing "Ready to automate this?" CTA over an already-built playbook).
        function _rehydrateBuildState() {
            var restored = null;
            var pushed = null;
            $scope.messages.forEach(function (m) {
                if (m.role !== 'assistant') return;
                (m.events || []).forEach(function (ev) {
                    if (ev.type === 'info_card' && ev.variant === 'playbook_pushed') pushed = ev;
                });
                // Same rule as the live _loadTurnYaml: only a verified offer
                // restores the draft. A playbook typed into a reply was never
                // loaded live, so a refresh must not load it either. Replayed
                // events are display cards (camelCase finalYaml); _offerYaml
                // accepts both spellings.
                var turnYaml = _offerYaml(m.events || []);
                // Latest turn that produced YAML wins -- a later push/confirm turn
                // carries none, so an earlier draft must still be restored.
                if (turnYaml != null) restored = turnYaml;
            });
            if (restored != null) $scope.currentYaml = restored.trim();

            // Restore the "created playbook" deep link from the persisted
            // playbook_pushed card (offer-accept path) so it survives a refresh
            // even though it first appeared as a live system message.
            if (pushed) {
                var link = (pushed.blocks || []).reduce(function (acc, b) {
                    return acc || (b.kind === 'link' ? b.url : null);
                }, null);
                if (link) $scope.playbookLink = link;
                if (pushed.title) $scope.playbookName = pushed.title;
            }

            // A restored playbook (authored YAML or a confirmed push) means the
            // analyst was building -- come back in build mode (over a record the
            // default is triage). hasYamlPane()/the YAML toggle and the redundant
            // build-from-triage CTA are all gated on uiIntent, so a triage-default
            // rehydrate would hide the playbook and re-offer work already done.
            // The restored session IS a build context, so also latch the handoff
            // flag -- otherwise hasYamlPane() (editor/handoff-gated over a record)
            // would suppress the very YAML we just reconstructed.
            if ($scope.currentYaml || pushed) {
                $scope.uiIntent = 'build';
                $scope._buildHandoffActive = true;
            }
        }

        // ─── Live drawer / navigation context refresh ────────────────────────
        // This widget mounts as a drawer/standalone popup (info.json display
        // "drawer", enableFor "viewPanel.modulesDetail"). The host record is
        // NOT on $scope at controller-construction time, and the analyst can
        // open the widget on a list page and THEN navigate to a record detail
        // (or move between records) while the widget stays mounted. A one-shot
        // boot detection therefore misses the record. Mirror fortisocchatagent:
        // (re)detect on popupOpened + $stateChangeSuccess so every chat_turn
        // carries the current entity. Without this the connector receives no
        // `entity` block and triage runs blind.
        // Track the LIST page's module across navigation (list -> other list,
        // record -> list). The persona is module-scoped, so a module change
        // re-resolves it; the deck and hero read listContext directly.
        function _refreshListContext() {
            var m = _listModuleFromState();
            var prev = $scope.listContext && $scope.listContext.module;
            $scope.listContext = m ? { module: m } : null;
            if (m && m !== prev && !($scope.entityContext && $scope.entityContext.iri)) {
                _resolvePersonaUi();
            }
        }

        function _refreshEntityContext() {
            // In the playbook designer the entity is the open playbook, not a
            // record-detail; keep it seeded and skip the record logic (which would
            // otherwise clear it, since _detectEntity() returns null there).
            $scope.inPlaybookEditor = _inPlaybookEditor();
            if ($scope.inPlaybookEditor) {
                _ensurePlaybookEntity();
                return;
            }
            var prevIri = $scope.entityContext && $scope.entityContext.iri;
            var next = _detectEntity();
            var nextIri = next && next.iri;
            if (!nextIri) {
                // Left the record (navigated to a list/dashboard). If nothing but
                // the auto-seed summary is on screen -- no real conversation has
                // started -- drop it so the stale "Triaging <record>" card doesn't
                // linger over an unrelated list. An in-progress chat is left
                // intact (yanking it mid-investigation would orphan the work);
                // its context just stops updating until we're over a record again.
                if (prevIri && _isOnlySeeded()) {
                    $scope.messages = [];
                    $scope.entityContext = null;
                    $scope.personaUi = null;   // left the record → drop its framing
                    _personaModule = null;
                }
                // After the record framing is dropped, so a list persona
                // resolved here isn't cleared behind it.
                _refreshListContext();
                return;
            }
            $scope.listContext = null;
            if (nextIri === prevIri) return;
            $scope.entityContext = next;
            // A new record = a fresh triage. Relock the build pane: a handoff the
            // analyst invoked on the *previous* record must not carry its build UI
            // onto this one.
            $scope._buildHandoffActive = false;
            // Landing on a new record always starts in triage. Build over a record
            // is only ever reached through the explicit handoff (which re-sets
            // intent+flag together), so a stale 'build' from the prior record must
            // not survive -- it would otherwise strand a build hint on this record.
            // (_defaultIntent, not a literal 'triage': a drawer over a record
            // opened from inside the designer keeps the designer's build mount.)
            $scope.uiIntent = _defaultIntent();
            // The entityContext.iri $watch (below) sees this change and switches
            // the visible conversation to THIS record's own scoped session via
            // _switchSessionForEntity -- so we never keep the previous record's
            // chat on screen. Seed only if the switch leaves the thread empty; the
            // watch handles that too, so nothing more is needed here.
        }

        // Re-point the widget to the host record's own scoped session and show
        // only that thread. Driven by the entityContext.iri $watch whenever the
        // record changes under a mounted widget (list → detail, detail → another
        // detail, or a late record resolution after construction).
        function _switchSessionForEntity() {
            _sessionEntityIri = ($scope.entityContext && $scope.entityContext.iri) || null;
            _sessionId = _ensureSessionId();   // record-scoped now (entityContext set)
            // Reset the stream fence + per-turn bookkeeping for the thread we are
            // switching to (mirror newConversation): a rehydrate sets _lastTurn to
            // the replayed count, so a stale fence from the previous record would
            // drop the next turn's start frame. Also tear down any in-flight stream
            // from the record we're leaving.
            _stopStreaming();
            _lastTurn = 0;
            _committedTurns = {};
            _committedToolUseIds = {};
            _committedToolResultIds = {};
            $scope.approvalRequest = null;
            $scope.viewState = 'idle';
            $scope.sessionInitiator = null;
            // Guard against a rapid second switch (A→B→A) racing this load: only
            // apply the result if it is still the active session when it returns.
            var _switchSession = _sessionId;
            fsrPbAgentService.chatHistory($scope.config, _switchSession)
                .then(function (res) {
                    if (_sessionId !== _switchSession) return;
                    $scope.sessionInitiator = (res && res.initiator) || null;
                    $scope.messages = [];
                    if (res && res.turns && res.turns.length) {
                        _replayTurns(res.turns, res.card_decisions);
                    } else {
                        _reseedForCurrentEntity();
                    }
                })
                .catch(function () {
                    if (_sessionId !== _switchSession) return;
                    $scope.sessionInitiator = null;
                    $scope.messages = [];
                    _reseedForCurrentEntity();
                });
        }

        // True when the conversation holds nothing but auto-seed summary cards
        // (no analyst turn, no real agent turn, no system notice) -- i.e. the
        // widget has shown the record header but the investigation hasn't begun.
        function _isOnlySeeded() {
            for (var i = 0; i < $scope.messages.length; i++) {
                var m = $scope.messages[i];
                if (m.role === 'user') return false;
                if (m.role === 'system') return false;
                if (m.role === 'assistant' && !m._seeded) return false;
            }
            return true;
        }

        // Keyboard parity for a clickable non-button (role="button"): Enter or
        // Space toggles `obj[key]` the way a click does.
        $scope.toggleOnKey = function ($event, obj, key) {
            if (!$event || !obj || ($event.key !== 'Enter' && $event.key !== ' ')) return;
            $event.preventDefault();
            obj[key] = !obj[key];
        };

        // Tool-row status chip text. `success`/`ok` render as a tick: a word
        // on every finished call is noise, while failed/skipped/waiting are
        // the states an analyst should notice.
        $scope.toolStatusText = function (status) {
            switch (status) {
                case 'success': case 'ok': return '✓';
                case 'guard': return 'skipped';
                case 'awaiting': return 'waiting';
                case 'error': return 'failed';
                case 'pending': return 'running';
                default: return status || '';
            }
        };

        // A tool call parked on an action card: 'awaiting' until the analyst
        // decides, then the card's outcome ('approve' / 'reject'). The call
        // itself never gets a result (the approved write runs as its own call),
        // so without this its row read "Updated the record / running" forever.
        // '' for every other call, which renders as before.
        $scope.toolCardDecision = function (ev, msg) {
            if (!ev || !ev._awaitsCardId || ev.resultStatus !== 'pending') return '';
            var evs = (msg && msg.events) || [];
            for (var i = 0; i < evs.length; i++) {
                if (evs[i].type === 'action_card' && evs[i].cardId === ev._awaitsCardId) {
                    if (!evs[i]._resolved) return 'awaiting';
                    return evs[i]._outcome === 'approve' ? 'approve' : 'reject';
                }
            }
            return '';
        };

        var _DECISION_CHIP = { awaiting: 'needs approval', approve: 'approved', reject: 'cancelled' };
        $scope.toolDecisionChip = function (decision) { return _DECISION_CHIP[decision] || ''; };

        // ─── Verdict card helpers ─────────────────────────────────────────────
        // Format confidence as a percentage (0-1 → 0-100%)
        $scope.formatConfidence = function (val) {
            if (val == null || typeof val !== 'number') return '--';
            return Math.round(Math.max(0, Math.min(1, val)) * 100) + '%';
        };

        // ── verdict_card interactions ───────────────────────────────────────
        // Scroll to the tool_call block that produced the evidence and highlight
        // it briefly. Missing ids (evidence not in the transcript) get the chip's
        // .missing class in the template and never reach this function.
        // This is the only definition: a second $scope.<name> = function would
        // silently win (see tests/scopeFunctions.unique.test.js).
        $scope.scrollToToolCall = function (toolUseId) {
            var selector = '[data-tool-use-id="' + toolUseId + '"]';
            try {
                var el = document.querySelector(selector);
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.classList.add('evidence-highlight');
                    $timeout(function () { el.classList.remove('evidence-highlight'); }, 2000);
                }
            } catch (e) {
                console.log('Error scrolling to tool call:', e);
            }
        };

        // Pre-fill the composer with a recommended action label and focus the
        // composer (`.composer` is the template's wrapper; `.composer-input`
        // matches nothing in view.html).
        $scope.applyRecommendedAction = function (action) {
            if (action && action.label) {
                $scope.form.inputText = action.label;
                // Focus the composer input
                $timeout(function () {
                    var input = document.querySelector('.composer textarea');
                    if (input) input.focus();
                });
            }
        };

        $scope.$on('popupOpened', function () { _refreshEntityContext(); });
        $scope.$on('$stateChangeSuccess', function () { _refreshEntityContext(); });

        // Agentic Assistant Monitor "Open in chat" seam: the monitor widget
        // stashes the target session_id in localStorage (using our own
        // _sessionKey convention) before navigating to the record page, and
        // also broadcasts this event for the already-mounted case. When the
        // drawer is already open (same page), switch immediately. The
        // localStorage stash is consumed by _ensureSessionId at mount time.
        $scope.$on('fsrAgenticAssistant:openSession', function (_evt, data) {
            // A live chat handles the open here, so the one-shot stash the monitor
            // also wrote must not linger: _ensureSessionId would consume it on the
            // NEXT fresh mount and hijack an unrelated drawer open later.
            try {
                var ls = $window.localStorage;
                if (data && ls && ls.getItem('fsrPbOpenSession') === data.session_id) {
                    ls.removeItem('fsrPbOpenSession');
                }
            } catch (e) {}
            if (data && data.session_id && data.session_id !== _sessionId) {
                _switchToSession(data.session_id);
            }
        });

        // Backstop for the seed: the init retry caps entity resolution at ~2s and
        // the reseed otherwise only fires on popupOpened/$stateChangeSuccess. If
        // the host record settles onto $state AFTER init gave up and no further
        // state event fires, those paths miss it -- the analyst is left over a
        // real record with the entity-aware hero but NO summary card. Watch the
        // resolved IRI directly: whenever an entity is present and the timeline is
        // still empty, seed. _seedFromEntity is idempotent (messages-length guard
        // + _seedInFlight), so repeated digests never double-seed.
        $scope.$watch(function () {
            return $scope.entityContext && $scope.entityContext.iri;
        }, function (iri) {
            // A triage record different from the one the session is scoped to (a
            // late resolution after construction, or navigation between records) →
            // switch to THAT record's own thread so we never show another record's
            // chat. This is the single authority for record→session re-pointing;
            // _switchSessionForEntity updates _sessionEntityIri.
            // The playbook DESIGNER is exempt: its entity is the open playbook
            // (a `workflows` IRI), not a triage record -- its session is the single
            // build thread and must never be re-pointed by an entity change.
            var e = $scope.entityContext;
            var isDesigner = $scope.uiIntent === 'build' || $scope.inPlaybookEditor
                || (e && e.module === 'workflows');
            // ...but ARRIVING at the designer from a triage record is a context
            // change, not an in-designer entity wobble. Same-tab alert →
            // playbook navigation used to keep the alert's session on screen
            // (its cards, its approval state) over the open playbook, because
            // the exemption swallowed the switch. Only exempt when the session
            // was not scoped to a non-workflows record: a late entity
            // resolution on a designer mount (no prior scope) and
            // playbook→playbook both keep the single build thread.
            var leavingRecordScope = !!_sessionEntityIri
                && _sessionEntityIri.indexOf('/workflows/') === -1;
            // Playbook A -> playbook B in the designer is a context change too:
            // each playbook has its own thread, and keeping A's session on B
            // grounded B's turns on A's conversation.
            var leavingOtherPlaybook = !!iri && !!_sessionEntityIri
                && _sessionEntityIri.indexOf('/workflows/') !== -1
                && iri.indexOf('/workflows/') !== -1;
            if (iri && iri !== _sessionEntityIri
                    && (!isDesigner || leavingRecordScope || leavingOtherPlaybook)) {
                _switchSessionForEntity();
                return;
            }
            if (iri && $scope.messages.length === 0) _reseedForCurrentEntity();
        });

        function _shouldRunOpener() {
            // Never run the opener if the connector isn't installed/configured --
            // it would just produce an immediate error banner on first load.
            if ($scope.connectorReady === false) return false;
            // Order of precedence: drawer override > URL ?opener= > default off.
            var override = $window.__fsrPbOpener;
            if (override === 'on')  return true;
            if (override === 'off') return false;
            // 'auto' / undefined → URL fallback
            return _queryParam('opener') === '1';
        }

        function _runOpener() {
            // Fires one chat_turn with no user message (empty messages[] is the
            // opener signal) so the connector can present the opening
            // choice_card (Immediate action vs Build playbook). Carries the
            // resolved intent + entity so triage drawers open differently from
            // dashboard build mounts.
            _turnAborted = false;
            _setState('sending');
            _logEvent('action_call', { action: 'chat_turn', kind: 'opener', intent: $scope.uiIntent });
            var payload = _withMode({
                session_id: _sessionId, messages: [], intent: $scope.uiIntent,
                max_turns: $scope.config.maxTurns
            });
            var entity = _entityPayload();
            if (entity) payload.entity = entity;
            _startStreaming();
            fsrPbAgentService.chatTurn($scope.config, payload).then(_handleTurnResult).catch(_handleError);
        }

    }
})();
