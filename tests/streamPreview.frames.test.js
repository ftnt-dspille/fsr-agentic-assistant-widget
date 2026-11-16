/**
 * streamPreview.frames.test.js -- the live preview folds consecutive text
 * frames into one, and leaves tool frames alone.
 */
'use strict';

const R = require('../widget/widgetAssets/js/fsrPbRender.js');

describe('appendStreamFrame (live preview coalescing)', function () {
    test('consecutive text frames fold into one text frame', function () {
        const frames = [];
        R.appendStreamFrame(frames, { type: 'text', text: 'Hel' });
        R.appendStreamFrame(frames, { type: 'text', text: 'lo, ' });
        R.appendStreamFrame(frames, { type: 'text', text: 'world' });
        expect(frames).toEqual([{ type: 'text', text: 'Hello, world' }]);
    });

    test('a tool frame breaks the run; text either side stays separate', function () {
        const frames = [];
        R.appendStreamFrame(frames, { type: 'text', text: 'Checking. ' });
        R.appendStreamFrame(frames, { type: 'tool_use', id: 'c1', name: 'get_record', input: {} });
        R.appendStreamFrame(frames, { type: 'text', text: 'Found it.' });
        expect(frames.map(function (f) { return f.type; })).toEqual(['text', 'tool_use', 'text']);
        expect(frames[0].text).toBe('Checking. ');
        expect(frames[2].text).toBe('Found it.');
    });

    test('the folded preview renders the same prose as the unfolded frames', function () {
        const raw = [
            { type: 'text', text: 'Alpha ' },
            { type: 'text', text: 'beta' }
        ];
        const folded = [];
        raw.forEach(function (f) { R.appendStreamFrame(folded, f); });
        const opts = { now: function () { return 1; } };
        const a = R.buildAssistantMessage(raw, opts);
        const b = R.buildAssistantMessage(folded, opts);
        expect(b.text).toBe(a.text);
        expect(b.text).toBe("Alpha beta");
        expect(folded.length).toBe(1);
    });
});
