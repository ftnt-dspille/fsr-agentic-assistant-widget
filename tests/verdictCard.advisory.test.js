/**
 * verdictCard.advisory.test.js -- Phase 2 step 3a (advisory only). The verdict
 * card shows plain lines about the subject's records when the framework says a
 * record exists that the investigation did not read, or one it read conflicts
 * with the verdict. The card words a record kind and a state; no field names,
 * ids or enum values reach the analyst, and the verdict itself is untouched.
 */
describe('verdict card advisory lines', function () {
    var normalize;
    beforeAll(function () {
        normalize = require('../widget/widgetAssets/js/fsrPbRender.js').normalizeVerdictCard;
    });
    function lines(premise) {
        return normalize({ id: 'v', disposition: 'true_positive', premise: premise }).advisoryLines;
    }

    it('words an unread change record by kind', function () {
        expect(lines({ status: 'unread_exists', advisory: [{ kind: 'change', state: 'unread' }] }))
            .toEqual(['A change record for this host exists that this investigation did not read.']);
    });

    it('words an unread asset record and a conflicting asset record', function () {
        expect(lines({ advisory: [{ kind: 'asset', state: 'unread' }] }))
            .toEqual(['An asset record for this host exists that this investigation did not read.']);
        expect(lines({ advisory: [{ kind: 'asset', state: 'conflict' }] }))
            .toEqual(['The asset record for this host conflicts with this verdict.']);
        expect(lines({ advisory: [{ kind: 'change', state: 'conflict' }] }))
            .toEqual(['A change record for this host conflicts with this verdict.']);
    });

    it('shows both kinds, in the order the framework gave', function () {
        expect(lines({ advisory: [{ kind: 'change', state: 'unread' }, { kind: 'asset', state: 'conflict' }] }))
            .toEqual([
                'A change record for this host exists that this investigation did not read.',
                'The asset record for this host conflicts with this verdict.'
            ]);
    });

    it('says nothing without an advisory, whatever else the premise holds', function () {
        expect(lines(undefined)).toEqual([]);
        expect(lines(null)).toEqual([]);
        expect(lines('x')).toEqual([]);
        expect(lines({ status: 'unread_exists', unread_kinds_exist: ['change'], exists: { change: true } })).toEqual([]);
        expect(lines({ advisory: [] })).toEqual([]);
        expect(lines({ advisory: 'change' })).toEqual([]);
    });

    it('drops unknown kinds and states, repeats and junk; two lines at most', function () {
        expect(lines({ advisory: [null, 3, {}, { kind: 'ticket', state: 'unread' },
            { kind: 'change', state: 'maybe' }, { kind: 'change' }] })).toEqual([]);
        var dup = { kind: 'change', state: 'unread' };
        expect(lines({ advisory: [dup, dup] }).length).toBe(1);
        expect(lines({ advisory: [dup, { kind: 'asset', state: 'unread' },
            { kind: 'asset', state: 'conflict' }, { kind: 'change', state: 'conflict' }] }).length).toBe(2);
    });

    it('never leaks a tool name, id, enum value or json path into the text', function () {
        var all = lines({ advisory: [{ kind: 'change', state: 'unread' }, { kind: 'asset', state: 'conflict' }] }).join(' ');
        expect(all).not.toMatch(/unread|conflict\b|premise|advisory|_|\/|\.\w+\(/);
        expect(all).not.toMatch(/[–—]/);
    });

    it('leaves the verdict itself unchanged', function () {
        var base = { id: 'v', disposition: 'benign', severity: 'low', confidence: 0.9, summary: 's' };
        var a = normalize(base);
        var b = normalize(Object.assign({}, base, { premise: { advisory: [{ kind: 'change', state: 'unread' }] } }));
        delete a.advisoryLines; delete b.advisoryLines;
        expect(b).toEqual(a);
    });
});
