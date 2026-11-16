/**
 * narration.noToolNames.test.js -- analyst-facing status text never names a
 * tool or a call id (snake_case identifiers), while plain status stays as is.
 */
'use strict';

const R = require('../widget/widgetAssets/js/fsrPbRender.js');

describe('narrationText (no tool internals in streaming status)', function () {
    test('a status line naming a tool falls back to the plain phrase', function () {
        expect(R.narrationText('Calling search_module_records', 'Working on it'))
            .toBe('Working on it');
        expect(R.narrationText('toolu_01abc finished', 'Working on it')).toBe('Working on it');
    });

    test('plain analyst status passes through unchanged', function () {
        expect(R.narrationText('Reading the record', 'Working on it')).toBe('Reading the record');
        expect(R.narrationText('Searched alerts for 198.51.100.8', 'Working on it'))
            .toBe('Searched alerts for 198.51.100.8');
    });

    test('an empty status is empty, not the fallback', function () {
        expect(R.narrationText('   ', 'Working on it')).toBe('');
        expect(R.narrationText(undefined, 'Working on it')).toBe('');
    });
});
