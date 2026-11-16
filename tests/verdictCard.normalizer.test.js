/**
 * verdictCard.normalizer.test.js -- jest tests for verdictCard normalization.
 * Tests confidence clamping, disposition/severity defaults, evidence array
 * handling, and field normalization.
 */

describe('normalizeVerdictCard', function () {
    var normalizer;

    beforeAll(function () {
        // Load fsrPbRender which exports normalizeVerdictCard
        var api = require('../widget/widgetAssets/js/fsrPbRender.js');
        normalizer = api.normalizeVerdictCard;
    });

    it('should normalize a complete verdict card', function () {
        var ev = {
            id: 'vc-001',
            disposition: 'true_positive',
            severity: 'high',
            confidence: 0.85,
            summary: 'This is a verdict',
            findings: [
                { claim: 'Finding 1', evidence: ['tool-1', 'tool-2'] },
                { claim: 'Finding 2', evidence: ['tool-3'] }
            ],
            unknowns: ['Unknown 1', 'Unknown 2'],
            recommended_actions: [
                { label: 'Action 1', tool: 'block', args: { ip: '1.2.3.4' } }
            ]
        };

        var result = normalizer(ev);

        expect(result.type).toBe('verdict_card');
        expect(result.cardId).toBe('vc-001');
        expect(result.disposition).toBe('true_positive');
        expect(result.severity).toBe('high');
        expect(result.confidence).toBe(0.85);
        expect(result.summary).toBe('This is a verdict');
        expect(result.findings.length).toBe(2);
        expect(result.findings[0].claim).toBe('Finding 1');
        expect(result.findings[0].evidence[0].id).toBe('tool-1');
        expect(result.findings[0].evidence[0].missing).toBe(false);
        expect(result.unknowns.length).toBe(2);
        expect(result.recommendedActions.length).toBe(1);
    });

    it('should default missing id to a generated cardId', function () {
        var ev = { disposition: 'benign' };
        var result = normalizer(ev);

        expect(result.cardId).toMatch(/^verdict-\d+$/);
    });

    it('should clamp confidence to [0, 1]', function () {
        expect(normalizer({ confidence: -0.5 }).confidence).toBe(0);
        expect(normalizer({ confidence: 1.5 }).confidence).toBe(1);
        expect(normalizer({ confidence: 0.5 }).confidence).toBe(0.5);
    });

    it('should default missing confidence to 0.5', function () {
        var result = normalizer({});
        expect(result.confidence).toBe(0.5);
    });

    it('should default invalid disposition to needs_more_info', function () {
        expect(normalizer({ disposition: 'invalid' }).disposition).toBe('needs_more_info');
        expect(normalizer({}).disposition).toBe('needs_more_info');
    });

    it('should accept all valid dispositions', function () {
        var dispositions = ['true_positive', 'false_positive', 'benign', 'suspicious', 'needs_more_info'];
        dispositions.forEach(function (d) {
            expect(normalizer({ disposition: d }).disposition).toBe(d);
        });
    });

    it('should default invalid severity to info', function () {
        expect(normalizer({ severity: 'invalid' }).severity).toBe('info');
        expect(normalizer({}).severity).toBe('info');
    });

    it('should accept all valid severities', function () {
        var severities = ['critical', 'high', 'medium', 'low', 'info'];
        severities.forEach(function (s) {
            expect(normalizer({ severity: s }).severity).toBe(s);
        });
    });

    it('should handle empty findings array', function () {
        var result = normalizer({ findings: [] });
        expect(result.findings).toEqual([]);
    });

    it('should handle null findings', function () {
        var result = normalizer({ findings: null });
        expect(result.findings).toEqual([]);
    });

    it('should convert evidence ids to objects with missing flag', function () {
        var ev = {
            findings: [
                { claim: 'Test', evidence: ['id-1', 'id-2'] }
            ]
        };
        var result = normalizer(ev);

        expect(result.findings[0].evidence.length).toBe(2);
        expect(result.findings[0].evidence[0]).toEqual({ id: 'id-1', missing: false });
        expect(result.findings[0].evidence[1]).toEqual({ id: 'id-2', missing: false });
    });

    it('should handle malformed finding objects', function () {
        var ev = {
            findings: [
                { claim: 'Valid' },
                { evidence: ['id-1'] },  // missing claim
                null,  // null finding
                'invalid'  // non-object
            ]
        };
        var result = normalizer(ev);

        expect(result.findings.length).toBe(4);
        expect(result.findings[0].claim).toBe('Valid');
        expect(result.findings[0].evidence).toEqual([]);
        expect(result.findings[1].claim).toBe('');
        expect(result.findings[1].evidence[0].id).toBe('id-1');
        expect(result.findings[2].claim).toBe('');
        expect(result.findings[3].claim).toBe('');
    });

    it('should convert unknowns to strings', function () {
        var ev = {
            unknowns: ['String unknown', 123, { obj: true }, null]
        };
        var result = normalizer(ev);

        expect(result.unknowns).toEqual(['String unknown', '123', '[object Object]', 'null']);
    });

    it('should handle null unknowns', function () {
        var result = normalizer({ unknowns: null });
        expect(result.unknowns).toEqual([]);
    });

    it('should normalize recommended_actions', function () {
        var ev = {
            recommended_actions: [
                { label: 'Action 1' },
                { label: 'Action 2', tool: 'some_tool' },
                { label: 'Action 3', tool: 'some_tool', args: { key: 'value' } }
            ]
        };
        var result = normalizer(ev);

        expect(result.recommendedActions.length).toBe(3);
        expect(result.recommendedActions[0].label).toBe('Action 1');
        expect(result.recommendedActions[0].tool).toBeUndefined();
        expect(result.recommendedActions[1].tool).toBe('some_tool');
        expect(result.recommendedActions[2].args).toEqual({ key: 'value' });
    });

    it('should handle malformed recommended_actions', function () {
        var ev = {
            recommended_actions: [
                null,
                { /* missing label */ },
                'invalid',
                { label: 'Good', tool: 123, args: 'not an object' }
            ]
        };
        var result = normalizer(ev);

        expect(result.recommendedActions.length).toBe(4);
        expect(result.recommendedActions[0].label).toBe('');
        expect(result.recommendedActions[1].label).toBe('');
        expect(result.recommendedActions[2].label).toBe('');
        expect(result.recommendedActions[3].args).toEqual({});
    });

    it('should default display to summary when provided', function () {
        var ev = { summary: 'My summary' };
        var result = normalizer(ev);
        expect(result.display).toBe('My summary');
    });

    it('should default display to disposition when summary missing', function () {
        var ev = { disposition: 'true_positive' };
        var result = normalizer(ev);
        expect(result.display).toBe('true_positive');
    });

    it('should default display to verdict when disposition and summary missing', function () {
        var result = normalizer({});
        expect(result.display).toBe('verdict');
    });

    it('labels the badges in words, not enum values', function () {
        var r = normalizer({ disposition: 'true_positive', severity: 'high', confidence: 0.92 });
        expect(r.dispositionLabel).toBe('True positive');
        expect(r.severityLabel).toBe('High severity');
        expect(r.confidenceLabel).toBe('92% confidence');
        expect(normalizer({}).dispositionLabel).toBe('Needs more info');
        expect(normalizer({ severity: 'info' }).severityLabel).toBe('Informational');
    });

    it('renders sources_checked as one plain Checked line, and nothing when absent', function () {
        expect(normalizer({ sources_checked: ['FortiSIEM', 'FortiEDR'] }).sourcesLine)
            .toBe('Checked: FortiSIEM, FortiEDR');
        expect(normalizer({ sources_checked: ['FortiSIEM', '', null] }).sourcesLine)
            .toBe('Checked: FortiSIEM');
        expect(normalizer({}).sourcesLine).toBe('');
        expect(normalizer({ sources_checked: 'FortiSIEM' }).sourcesLine).toBe('');
    });

    it('X7: an uncertain verdict shows its What would help lines, confident ones never do', function () {
        var help = [
            { kind: 'tickets', state: 'not_connected', line: 'No ticket system is connected; past tickets could show whether this activity was approved.', unknown: 'Was it approved?', sources: [] },
            { kind: 'source_failed', state: 'failed', line: 'FortiSIEM returned an error this turn, so its answer is missing; fixing the connection would let me check it.', unknown: 'Which hosts?', sources: ['FortiSIEM'] }
        ];
        var r = normalizer({ disposition: 'needs_more_info', what_would_help: help });
        expect(r.whatWouldHelp.map(function (h) { return h.line; })).toEqual(help.map(function (h) { return h.line; }));
        expect(r.whatWouldHelp[1].unknown).toBe('Which hosts?');
        expect(r.whatWouldHelp[1].sources).toEqual(['FortiSIEM']);
        ['true_positive', 'false_positive', 'benign', 'suspicious'].forEach(function (d) {
            expect(normalizer({ disposition: d, what_would_help: help }).whatWouldHelp).toEqual([]);
        });
    });

    it('X7: What would help is capped at three, drops lines without text, ignores a non-list', function () {
        var mk = function (t) { return { line: t, unknown: '', sources: [] }; };
        var r = normalizer({ disposition: 'needs_more_info',
            what_would_help: [mk('a'), mk(''), null, 'x', mk('b'), mk('c'), mk('d')] });
        expect(r.whatWouldHelp.map(function (h) { return h.line; })).toEqual(['a', 'b', 'c']);
        expect(normalizer({ disposition: 'needs_more_info', what_would_help: 'nope' }).whatWouldHelp).toEqual([]);
        expect(normalizer({ disposition: 'needs_more_info' }).whatWouldHelp).toEqual([]);
    });

    it('evidence chips name the call they cite, not its id', function () {
        var R = require('../widget/widgetAssets/js/fsrPbRender.js');
        var msg = R.buildAssistantMessage([
            { type: 'tool_use', id: 'call_abc123', name: 'search_module_records',
              input: { module: 'alerts', search: '198.51.100.8' } },
            { type: 'tool_result', tool_use_id: 'call_abc123', content: '{"ok":true}' },
            { type: 'verdict_card', id: 'v1', disposition: 'benign',
              findings: [{ claim: 'c', evidence: ['call_abc123', 'call_gone'] }] }
        ], { now: function () { return 1; } });
        var vc = msg.events.filter(function (e) { return e.type === 'verdict_card'; })[0];
        expect(vc.findings[0].evidence[0]).toEqual(
            { id: 'call_abc123', missing: false, label: 'Searched alerts for 198.51.100.8' });
        expect(vc.findings[0].evidence[1].missing).toBe(true);
    });
});
