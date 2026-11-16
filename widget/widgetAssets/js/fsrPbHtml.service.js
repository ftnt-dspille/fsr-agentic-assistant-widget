'use strict';
/**
 * fsrPbHtmlService -- card-text HTML helpers: strip, the allow-list sanitizer,
 * the info-card HTML builder and truncation.
 *
 * Moved verbatim out of view.controller.js (no behaviour change). Pure string
 * work: no scope, no DOM, no $sce. The controller and fsrPbEntityCardsService
 * use these through the names they always had.
 */
(function () {
    angular
        .module('cybersponse')
        .factory('fsrPbHtmlService', fsrPbHtmlService);

    fsrPbHtmlService.$inject = [];

    function fsrPbHtmlService() {
        // Record free-text fields (description/summary) frequently carry HTML --
        // AWS GuardDuty / many detectors emit `<p>…<b>…</b></p>`. The summary
        // card renders its text block ESCAPED (`{{blk.text}}`) and the connector
        // receives `summary_seed` as plain text, so raw HTML shows as literal
        // <p>/<b> tags on the card and as tag noise to the model. Strip tags to
        // readable text (block tags → newlines) and decode the common entities.
        // Regex-based (never assigns to innerHTML) so untrusted markup is never
        // live-parsed. A no-op when the value has no markup.
        function _stripHtml(s) {
            if (!s || typeof s !== 'string' || (s.indexOf('<') < 0 && s.indexOf('&') < 0)) return s;
            return s
                .replace(/<\s*br\s*\/?>/gi, '\n')
                .replace(/<\/\s*(?:p|div|li|tr|h[1-6]|ul|ol|table)\s*>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&lt;/gi, '<')
                .replace(/&gt;/gi, '>')
                .replace(/&quot;/gi, '"')
                .replace(/&#0*39;|&apos;/gi, "'")
                .replace(/&amp;/gi, '&')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .replace(/[ \t]{2,}/g, ' ')
                .trim();
        }

        // Record HTML → the bare-tag subset _sanitizeHtml re-enables. Detectors
        // style everything (FortiSIEM: `<p style=…>` + a key/value `<table>`), and
        // the sanitizer only un-escapes BARE tags, so styled markup showed as
        // literal `<p style="…">`/`<td …>` on the card. Key/value rows become
        // `Key: value` lines, attributes drop off whitelisted tags, other tags go,
        // entities decode. Still escape-first afterwards (_sanitizeHtml), so
        // decoding `&lt;` here can't smuggle markup through.
        function _cardHtml(s) {
            if (!s || typeof s !== 'string' || (s.indexOf('<') < 0 && s.indexOf('&') < 0)) return s;
            var bare = new RegExp('<(\\/?)(' + _SANITIZE_TAGS + ')\\b[^>]*>', 'gi');
            var other = new RegExp('<(?!\\/?(?:' + _SANITIZE_TAGS + ')>)[^>]*>', 'gi');
            return s
                .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi, function (_m, row) {
                    var cells = [];
                    row.replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi, function (_c, cell) {
                        var t = cell.replace(/<[^>]+>/g, '').trim();
                        if (t) cells.push(t);
                        return '';
                    });
                    if (!cells.length) return '';
                    var line = cells.length > 1 ? '<b>' + cells[0] + '</b>: ' + cells.slice(1).join(' · ') : cells[0];
                    return line + '<br>';
                })
                .replace(/<\/?(?:table|thead|tbody|tfoot)\b[^>]*>/gi, '')
                .replace(/<\/?(?:div|h[1-6])\b[^>]*>/gi, '<br>')
                .replace(bare, '<$1$2>')
                .replace(other, '')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&lt;/gi, '<')
                .replace(/&gt;/gi, '>')
                .replace(/&quot;/gi, '"')
                .replace(/&#0*39;|&apos;/gi, "'")
                .replace(/&amp;/gi, '&')
                .replace(/(?:<br>\s*){3,}/gi, '<br><br>')
                .replace(/^(?:\s*<br>)+|(?:<br>\s*)+$/gi, '')
                .trim();
        }

        // Cut card HTML at n chars without leaving half a tag behind.
        // Clip record text for a card. Ends on a sentence when one finishes in
        // the back half of the budget, otherwise on a whole word -- a hard cut
        // left "captured in the aler…" on the opener card.
        function _truncateCardHtml(s, n) {
            if (!s || s.length <= n) return s;
            var cut = s.slice(0, n).replace(/<[^>]*$/, '');
            var sentence = cut.match(/^[^]*[.!?](?=\s|<|$)/);
            if (sentence && sentence[0].length >= n / 2) return sentence[0];
            return cut.replace(/\s+\S*$/, '') + '…';
        }

        // Sanitize record HTML for the summary card, escape-FIRST then re-enable
        // a whitelist of bare formatting tags (mirrors renderMarkdown's S3 escape
        // posture). Because everything is escaped up front, nothing that isn't
        // explicitly un-escaped can survive -- no <script>, no on*=handlers, no
        // attributes at all (we un-escape only the BARE tag `<b>`/`</b>`, never
        // one carrying attributes), and no `a`/`href`. Provably safe to
        // $sce.trustAsHtml. A no-op for plain text (nothing to un-escape).
        var _SANITIZE_TAGS = 'b|strong|i|em|u|p|ul|ol|li|code|pre|span|br';

        var _SANITIZE_RE = new RegExp('&lt;(\\/?(?:' + _SANITIZE_TAGS + '))\\s*\\/?&gt;', 'gi');

        function _sanitizeHtml(s) {
            if (s == null) return '';
            var esc = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return esc.replace(_SANITIZE_RE, function (_m, tag) {
                tag = tag.toLowerCase();
                return tag === 'br' ? '<br/>' : '<' + tag + '>';
            });
        }

        function _truncate(s, n) {
            s = String(s);
            return s.length > n ? s.slice(0, n) + '…' : s;
        }

        return {
            stripHtml: _stripHtml,
            cardHtml: _cardHtml,
            truncateCardHtml: _truncateCardHtml,
            sanitizeHtml: _sanitizeHtml,
            truncate: _truncate
        };
    }
})();
