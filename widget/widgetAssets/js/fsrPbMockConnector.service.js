'use strict';
/**
 * Deterministic mock connector. Selected by ?mock=<scenario> in the harness URL.
 *
 * Fixtures live in widgetAssets/fixtures/<scenario>.json. Format:
 *   {
 *     "scenario": "happy_path",
 *     "responses": [
 *       { "action": "chat_turn",     "match": { ... optional partial-match keys ... }, "response": {...} },
 *       { "action": "validate_yaml", "response": {...} },
 *       ...
 *     ]
 *   }
 *
 * Responses are matched and consumed in declaration order per action. If an
 * action is called more times than declared, the last entry repeats.
 */
(function () {
    angular
        .module('cybersponse')
        .factory('fsrPbMockConnectorService', fsrPbMockConnectorService);

    fsrPbMockConnectorService.$inject = ['$q', '$http', '$timeout'];

    function fsrPbMockConnectorService($q, $http, $timeout) {

        var _fixtureCache = {};   // scenario -> Promise<fixture>
        var _cursor       = {};   // scenario -> { action -> index }
        var _assetsBase   = _detectAssetsBase();

        // Find the URL prefix this widget was served from by inspecting our
        // own <script> tag. The harness mounts widgets at /<name>-<version>/...
        function _detectAssetsBase() {
            var marker = 'widgetAssets/js/fsrPbMockConnector.service.js';
            var scripts = document.getElementsByTagName('script');
            for (var i = 0; i < scripts.length; i++) {
                var src = scripts[i].src || '';
                var idx = src.indexOf(marker);
                if (idx >= 0) return src.substring(0, idx);
            }
            return '/agenticAssistant-1.0.0/';
        }

        function _loadFixture(scenario) {
            if (_fixtureCache[scenario]) return _fixtureCache[scenario];
            var url = _assetsBase + 'widgetAssets/fixtures/' + scenario + '.json';
            _fixtureCache[scenario] = $http.get(url, { cache: false })
                .then(function (resp) {
                    var data = resp && resp.data;
                    // The harness proxy falls through to SOAR for unknown URLs
                    // and may return the SPA HTML. Detect & reject explicitly
                    // so we don't silently swallow it as "no entries".
                    if (typeof data === 'string') {
                        try { data = JSON.parse(data); }
                        catch (e) {
                            return $q.reject({ message: 'Fixture ' + scenario + '.json not found (got non-JSON at ' + url + ')' });
                        }
                    }
                    if (!data || typeof data !== 'object' || !Array.isArray(data.responses)) {
                        return $q.reject({ message: 'Fixture ' + scenario + '.json is malformed (missing responses[])' });
                    }
                    return data;
                });
            return _fixtureCache[scenario];
        }

        function _matches(match, payload) {
            if (!match) return true;
            for (var k in match) {
                if (!match.hasOwnProperty(k)) continue;
                var want = match[k];
                var got  = payload ? payload[k] : undefined;
                if (Array.isArray(want)) {
                    if (!Array.isArray(got) || got.length !== want.length) return false;
                    for (var i = 0; i < want.length; i++) if (got[i] !== want[i]) return false;
                } else if (typeof want === 'object' && want !== null) {
                    if (!_matches(want, got)) return false;
                } else if (got !== want) {
                    return false;
                }
            }
            return true;
        }

        function _nextResponse(scenario, fixture, action, payload) {
            var actionEntries = (fixture.responses || []).filter(function (r) { return r.action === action; });
            if (!actionEntries.length) {
                return $q.reject({ message: 'No fixture for action ' + action + ' in scenario ' + scenario });
            }
            _cursor[scenario] = _cursor[scenario] || {};
            _cursor[scenario].consumed = _cursor[scenario].consumed || {};
            var consumed = _cursor[scenario].consumed;

            // Prefer the first unconsumed entry whose `match` matches the payload.
            var entry = null;
            for (var i = 0; i < actionEntries.length; i++) {
                var key = action + ':' + i;
                if (consumed[key]) continue;
                if (_matches(actionEntries[i].match, payload)) {
                    entry = actionEntries[i];
                    consumed[key] = true;
                    break;
                }
            }
            // Nothing matched — fall back to the last entry (repeats forever).
            if (!entry) entry = actionEntries[actionEntries.length - 1];

            if (entry.error) {
                return $q.reject(JSON.parse(JSON.stringify(entry.error)));
            }
            return $q.when(JSON.parse(JSON.stringify(entry.response || {})));
        }

        function _speed() {
            // Drawer-driven runtime override wins, then URL ?fastmock=1, else 'real'.
            if (typeof window !== 'undefined') {
                if (window.__fsrPbSpeed === 'instant' || window.__fsrPbSpeed === 'fast' || window.__fsrPbSpeed === 'real') {
                    return window.__fsrPbSpeed;
                }
                var s = (window.location && window.location.search) || '';
                if (/[?&]fastmock=1/.test(s)) return 'fast';
            }
            return 'real';
        }

        function execute(scenario, action, payload) {
            if (!scenario) return $q.reject({ message: 'Mock scenario not specified' });
            return _loadFixture(scenario)
                .then(function (fixture) {
                    var delay = (fixture.delays && fixture.delays[action]) != null ? fixture.delays[action] : 50;
                    var sp = _speed();
                    if (sp === 'fast') delay = Math.min(delay, 30);
                    else if (sp === 'instant') delay = 0;
                    return $timeout(function () {
                        return _nextResponse(scenario, fixture, action, payload);
                    }, delay);
                });
        }

        function reset() { _cursor = {}; _fixtureCache = {}; }

        return { execute: execute, reset: reset };
    }
})();
