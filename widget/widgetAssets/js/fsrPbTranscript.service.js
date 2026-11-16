'use strict';
/**
 * fsrPbTranscriptService -- decides whether a resumed or replayed transcript is
 * an echo of what is already on screen.
 *
 * Moved verbatim out of view.controller.js (no behaviour change). The scope's
 * message list is now passed in: the controller's wrapper supplies
 * $scope.messages at call time, so the guard sees the same list it always did.
 */
(function () {
    angular
        .module('cybersponse')
        .factory('fsrPbTranscriptService', fsrPbTranscriptService);

    fsrPbTranscriptService.$inject = [];

    function fsrPbTranscriptService() {
        // True while the chat is still waiting on the analyst to resolve an
        // interactive card (approve/cancel an action, pick a branch, fill an
        // input, accept/decline a playbook offer). viewState is 'idle' in this
        // window -- the turn stopped on awaiting_action_card -- so we can't rely
        // on state alone to know the conversation is actually finished.
        var _PENDING_CARD_TYPES = { action_card: 1, choice_card: 1, manual_input: 1, playbook_offer: 1, enhancement_offer: 1 };

        // Collect every tool_use id already present in the committed timeline.
        // A transcript whose tool calls are ALL already on screen is a stale
        // replay of an earlier turn (export sess-ei6esw96: the detached build
        // returned turn-1's enrichment verbatim -- same toolu_* ids -- so it
        // rendered the same enrichment twice and built no playbook).
        function _knownToolUseIds(messages) {
            var ids = {};
            messages.forEach(function (m) {
                (m.events || []).forEach(function (ev) {
                    if (ev && ev._toolUseId) ids[ev._toolUseId] = true;
                });
            });
            return ids;
        }

        // Ids of the human-actionable cards already on screen. Needed because a
        // turn can add a CARD without adding a tool call -- see _isStaleReplay.
        function _knownCardIds(messages) {
            var ids = {};
            messages.forEach(function (m) {
                (m.events || []).forEach(function (ev) {
                    if (!ev || !_PENDING_CARD_TYPES[ev.type]) return;
                    var id = ev.inputId || ev.cardId || ev.choiceId || ev.offerId
                          || ev.approvalId || ev.id;
                    if (id) ids[String(id)] = true;
                });
            });
            return ids;
        }

        // Prose already on screen, as one normalized blob. A live answer arrives
        // as ~100 incremental `text` frames and is committed MERGED, so the only
        // reliable comparison is substring containment over the whole thing.
        function _knownTextBlob(messages) {
            var parts = [];
            messages.forEach(function (m) {
                if (m && m.text) parts.push(m.text);
                (m.events || []).forEach(function (ev) {
                    if (ev && ev.type === 'text' && ev.text) parts.push(ev.text);
                });
            });
            return parts.join(' ').replace(/\s+/g, ' ');
        }

        function _isStaleReplay(transcript, messages) {
            var known = _knownToolUseIds(messages), saw = 0, fresh = 0;
            var knownCards = _knownCardIds(messages), freshCards = 0;
            (transcript || []).forEach(function (e) {
                var id = e && (e.id || e.tool_use_id || e._toolUseId);
                if (e && (e.type === 'tool_use' || e.type === 'tool_call') && id) {
                    saw++;
                    if (!known[id]) fresh++;
                }
                // A NEW human-actionable card is new content by definition, even
                // when every tool call around it is a repeat.
                if (e && _PENDING_CARD_TYPES[e.type]) {
                    var cid = e.id || e.card_id || e.input_id || e.offer_id || e.choice_id;
                    if (!cid || !knownCards[String(cid)]) freshCards++;
                }
            });
            // The guard exists to drop an ECHO of a turn already on screen. A
            // resume transcript is CUMULATIVE -- the live connector repeats every
            // pre-approval tool_use and appends the new frames -- so keying
            // "stale" on tool calls alone declared the whole turn an echo and
            // dropped it, taking the manual_input CARD with it. The analyst then
            // has no form to answer, and the approved run sits parked on the box
            // forever (that is where the orphaned manual-input records came
            // from). A transcript carrying a card nobody has seen is not an echo.
            // #91; reproduced box-free once the fixture used the real cumulative
            // shape.
            if (freshCards > 0) return false;
            // ...and so is NEW PROSE. `respond_manual_input` returns the same
            // cumulative shape as a resume, but it resolves a card rather than
            // raising one: one repeated tool_use, no new card, and ~100 text
            // frames that ARE the answer. freshCards could never rescue it, so
            // the guard threw the answer away -- which is why the analyst sees
            // nothing after submitting the form, and why the NEXT turn's history
            // has no record of the submission (the model then reports the run as
            // still awaiting input and asks the analyst to confirm what they just
            // did). #98 / #114; the #91 fix covered only the card case.
            // Containment, not presence: an echoed turn's prose is already on
            // screen, so it still reads as stale.
            var prose = (transcript || [])
                .filter(function (e) { return e && e.type === 'text' && e.text; })
                .map(function (e) { return e.text; })
                .join(' ').replace(/\s+/g, ' ').trim();
            if (prose && _knownTextBlob(messages).indexOf(prose) === -1) return false;
            return saw > 0 && fresh === 0;   // had tool calls, none of them new
        }

        return {
            PENDING_CARD_TYPES: _PENDING_CARD_TYPES,
            isStaleReplay: _isStaleReplay
        };
    }
})();
