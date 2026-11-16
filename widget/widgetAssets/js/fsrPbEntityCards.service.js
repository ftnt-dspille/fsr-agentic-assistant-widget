'use strict';
/**
 * fsrPbEntityCardsService -- turns a platform entity record into the seed
 * card, its one-line summary and its display fields.
 *
 * Moved verbatim out of view.controller.js (no behaviour change). Reads only
 * the record it is given; the HTML helpers come from fsrPbHtmlService.
 */
(function () {
    angular
        .module('cybersponse')
        .factory('fsrPbEntityCardsService', fsrPbEntityCardsService);

    fsrPbEntityCardsService.$inject = ['fsrPbHtmlService'];

    function fsrPbEntityCardsService(fsrPbHtmlService) {
        var _cardHtml = fsrPbHtmlService.cardHtml;
        var _stripHtml = fsrPbHtmlService.stripHtml;
        var _truncate = fsrPbHtmlService.truncate;
        var _truncateCardHtml = fsrPbHtmlService.truncateCardHtml;

        // Interpolate a persona greeting template ({module}/{name} tokens) and
        // pick the right headline for the entity seed card / summary. Persona
        // with an explicit greeting → that; persona without → neutral "Working
        // on …"; no persona → the original "Triaging …", except over a record
        // that is not a triage record (nonTriage): a device, indicator or custom
        // module is worked on, not triaged, so it gets the neutral line too.
        function _entityHeadline(persona, moduleLabel, name, nonTriage) {
            var p = persona;
            if (p && p.greeting) {
                return String(p.greeting)
                    .replace(/\{module\}/g, moduleLabel)
                    .replace(/\{name\}/g, name);
            }
            if (p || nonTriage) return 'Working on ' + moduleLabel + (name ? ': ' + name : '');
            return 'Triaging ' + moduleLabel + ': ' + name;
        }

        // Convert a FormEntityService entity (fields keyed by name, each
        // { value: … } with picklist values wrapped as { itemValue }) into the
        // flat record shape (_recordHasFields / _displayField / _composeEntity*).
        function _flattenEntityFields(entity) {
            var fields = (entity && entity.fields) || null;
            if (!fields) return entity || null;
            var out = {};
            angular.forEach(fields, function (f, key) {
                if (!f) return;
                var v = f.value;
                if (v && typeof v === 'object' && v.itemValue !== undefined) v = v.itemValue;
                out[key] = v;
            });
            if (entity['@id']) out['@id'] = entity['@id'];
            if (entity.iri) out.iri = entity.iri;
            if (entity.uuid) out.uuid = entity.uuid;
            if (entity.recordTags) out.recordTags = entity.recordTags;
            return out;
        }

        function _recordHasFields(rec) {
            return !!(rec && typeof rec === 'object'
                && (rec.name || rec.title || rec.subject || rec.description
                    || rec.summary || rec.severity || rec.status || rec.type));
        }

        // Build a markdown summary of the host record. Pure (no scope writes
        // beyond stamping e.displayName) so it can feed both the auto-seed and
        // the on-demand composer fill.
        function _composeEntitySummary(e, rec, persona, nonTriage) {
            var moduleLabel = _singularize(e.module) || 'record';
            var name = _displayField(rec, ['name', 'title', 'subject', 'displayName']) || e.iri;
            var lines = ['**' + _entityHeadline(persona, moduleLabel, name, nonTriage) + '**'];
            var meta = [];
            var sev    = _displayField(rec, ['severity']);
            var status = _displayField(rec, ['status', 'state']);
            var source = _displayField(rec, ['source', 'sensor', 'detectedBy']);
            var type   = _displayField(rec, ['type', 'alertType', 'category', 'kind']);
            if (sev)    meta.push('Severity: ' + sev);
            if (status) meta.push('Status: ' + status);
            if (source) meta.push('Source: ' + source);
            if (type)   meta.push('Type: ' + type);
            if (meta.length) lines.push(meta.join(' · '));
            var desc = _stripHtml(_displayField(rec, ['description', 'summary', 'aiSummary', 'analystSummary', 'details']));
            if (desc) { lines.push(''); lines.push(_truncate(desc, 1200)); }
            e.displayName = name;
            return lines.join('\n');
        }

        // Map a SOAR severity picklist value to a card severity bucket.
        function _severityBucket(rec) {
            var s = (_stringifyFieldValue(rec && rec.severity) || '').toLowerCase();
            if (/crit|high/.test(s)) return 'error';
            if (/med|moderate/.test(s)) return 'warning';
            if (/low|info/.test(s)) return 'info';
            return 'info';
        }

        // Build a structured info_card view of the host record for the detail
        // (drawer) view -- far more scannable than dumping the raw markdown
        // `description`/`impactAssessments` (which carry GFM tables + <br> that
        // render badly). Concise: a one-line summary + key fields + tags.
        function _composeEntityCard(e, rec, persona, nonTriage) {
            var moduleLabel = _singularize(e.module) || 'record';
            var name = _displayField(rec, ['name', 'title', 'subject', 'displayName']) || e.iri;
            e.displayName = name;
            var blocks = [];

            // Raw value (may be HTML) -- the on-screen text block is rendered via
            // renderCardText (escape-first whitelist sanitizer) so meaningful
            // emphasis (<b> around the finding/instance/pool/role) survives while
            // scripts/handlers/attributes are stripped. summary_seed to the
            // connector is plain-text (stripped) -- see _composeEntitySummary.
            var summary = _displayField(rec, ['incidentsummary', 'summary', 'description', 'aiSummary', 'analystSummary', 'details']);
            // A lead, not the whole description: in the drawer the record
            // itself is open beside the chat, so repeating it in full was noise.
            var lead = summary ? _truncateCardHtml(_cardHtml(summary), 280) : '';
            if (lead) blocks.push({ kind: 'text', text: lead });
            // Plain text of the lead, to skip a row it already states: record
            // descriptions often carry "Status: Open" themselves, and the card
            // repeated it underneath.
            var leadText = String(lead).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase();

            // Key fields -- only the rows that are actually present.
            var rows = [];
            function add(label, val, sev) {
                if (!val) return;
                if (leadText.indexOf((label + ': ' + val).toLowerCase()) >= 0) return;
                rows.push({ label: label, value: val, severity: sev || null });
            }
            // Severity is shown as the badge (severity_label below), so it's not
            // duplicated as a row.
            add('Status', _displayField(rec, ['status', 'state']));
            add('Phase', _displayField(rec, ['phase', 'incidentphase']));
            add('Source', _displayField(rec, ['source', 'sensor', 'detectedBy']));
            add('Source IP', _displayField(rec, ['sourceIP', 'sourceip', 'src_ip']));
            add('Dest IP', _displayField(rec, ['destinationIP', 'destinationip', 'dest_ip']));
            add('MITRE', _displayField(rec, ['mitreattackid', 'mitreTactic', 'technique']));
            if (rows.length) blocks.push({ kind: 'rows', rows: rows });

            // Tags as chips.
            var tags = rec && rec.recordTags;
            if (angular.isArray(tags) && tags.length) {
                blocks.push({ kind: 'tags', tags: tags.slice(0, 12).map(function (t) {
                    return angular.isString(t) ? t : (t && (t.value || t.name || t.itemValue)) || '';
                }).filter(Boolean) });
            }

            return {
                type: 'info_card',
                id: 'entity-' + (rec && (rec.id || rec.uuid) || 'seed'),
                variant: 'entity_summary',
                severity: _severityBucket(rec),
                severity_label: _displayField(rec, ['severity']),
                title: _entityHeadline(persona, moduleLabel, name, nonTriage),
                blocks: blocks
            };
        }

        function _displayField(rec, keys) {
            for (var i = 0; i < keys.length; i++) {
                var v = rec ? rec[keys[i]] : undefined;
                if (v == null || v === '') continue;
                var s = _cleanFieldText(_stringifyFieldValue(v));
                if (s) return s;
            }
            return '';
        }

        // SOAR sometimes hands us field values that still contain unrendered
        // Jinja (e.g. "{{vars.input.records[0].eventTime }}") when the source
        // playbook didn't resolve them. Strip those tokens; if nothing real is
        // left, treat the field as empty so we fall through to a usable value
        // (or omit the row) rather than rendering raw template syntax.
        function _cleanFieldText(s) {
            if (!s) return '';
            var cleaned = String(s)
                .replace(/\{%[^]*?%\}/g, '')   // {% ... %} statements
                .replace(/\{\{[^]*?\}\}/g, '') // {{ ... }} expressions
                .replace(/\s{2,}/g, ' ')
                .trim();
            return cleaned;
        }

        // SOAR picklist/relationship fields arrive as objects, not scalars.
        function _stringifyFieldValue(v) {
            if (v == null) return '';
            if (typeof v === 'string' || typeof v === 'number') return String(v);
            if (typeof v === 'object') {
                return v.itemValue || v.value || v.name || v.displayName || v.title || '';
            }
            return String(v);
        }

        // Keys that are SOAR plumbing / never useful to the agent. Anything
        // starting with '@' is also dropped (JSON-LD: @id/@context/@type/...).
        var _ENTITY_FIELD_DENYLIST = {
            uuid: 1, id: 1, tenant: 1, tenantRecordId: 1, sourceId: 1, deviceUID: 1,
            createUser: 1, modifyUser: 1, createDate: 1, modifyDate: 1, importedBy: 1,
            conflict: 1, isActive: 1, volatileData: 1, metrics: 1, sourcedata: 1,
            recordTags: 1,                 // sent separately as `tags`
            slaPercentage: 1, resPercentSla: 1, orderIndex: 1, listName: 1,
            color: 1, icon: 1, fsrQueue: 1, '@settings': 1
        };

        // Date-ish field names whose epoch value is worth converting to ISO so
        // the agent gets real timestamps instead of a raw float.
        var _ENTITY_DATE_KEY = /date|time|due|on$|sla/i;

        function _isoIfEpoch(n, key) {
            // Unix seconds in a plausible window (2001..2033). Only for date-ish
            // keys so we don't mangle counts/ids that happen to be large.
            if (typeof n === 'number' && n > 1e9 && n < 2e9 && _ENTITY_DATE_KEY.test(key)) {
                try { return new Date(n * 1000).toISOString(); } catch (e) { /* fall through */ }
            }
            return null;
        }

        // Build a compact, cleaned key/value map of the record's substantive
        // fields to ship in the entity block -- so quick-actions (timeline,
        // blast radius, IOCs) have real data, not just the one-line seed.
        // Strips: nulls/empties, SOAR plumbing (denylist + @-keys), unrendered
        // Jinja, picklist plumbing (flattened to itemValue), and over-long
        // values. Caps total fields so the payload stays bounded.
        function _buildEntityFields(rec) {
            if (!rec || typeof rec !== 'object') return {};
            var out = {};
            var count = 0;
            var MAX_FIELDS = 50;
            var MAX_LEN = 2000;
            Object.keys(rec).forEach(function (key) {
                if (count >= MAX_FIELDS) return;
                if (key.charAt(0) === '@' || _ENTITY_FIELD_DENYLIST[key]) return;
                var v = rec[key];
                if (v == null || v === '') return;

                var val;
                if (typeof v === 'number') {
                    var iso = _isoIfEpoch(v, key);
                    val = iso || String(v);
                } else if (typeof v === 'boolean') {
                    val = v;
                } else if (angular.isArray(v)) {
                    // arrays of scalars → joined; arrays of objects → skip (noise)
                    var scal = v.filter(function (x) { return typeof x === 'string' || typeof x === 'number'; });
                    if (!scal.length) return;
                    val = scal.join(', ');
                } else if (typeof v === 'object') {
                    val = _cleanFieldText(_stringifyFieldValue(v)); // flatten picklist/relationship
                } else {
                    val = _cleanFieldText(String(v));
                }

                if (typeof val === 'string') {
                    // Free-text fields (description/summary) routinely carry HTML --
                    // FortiSIEM/FortiGate emit styled <div>/<table> blocks. Strip
                    // tags to readable text so raw `<div class=…>`/`<table>` markup
                    // never lands in entity.fields, where it shows as literal tag
                    // noise in the widget (the model echoes it into an answer
                    // rendered by renderMarkdown) and is pure noise to the model.
                    // (The seed-display path keeps sanitized <b> via _sanitizeHtml;
                    // this fields path is plain-text only.)
                    val = _cleanFieldText(_stripHtml(val));
                    if (!val) return;                 // empty after stripping HTML/Jinja
                    if (val.length > MAX_LEN) val = val.slice(0, MAX_LEN) + '…';
                }
                out[key] = val;
                count++;
            });
            return out;
        }

        function _singularize(module) {
            if (!module) return '';
            return module.replace(/ies$/, 'y').replace(/s$/, '');
        }

        return {
            entityHeadline: _entityHeadline,
            flattenEntityFields: _flattenEntityFields,
            recordHasFields: _recordHasFields,
            composeEntitySummary: _composeEntitySummary,
            severityBucket: _severityBucket,
            composeEntityCard: _composeEntityCard,
            displayField: _displayField,
            cleanFieldText: _cleanFieldText,
            stringifyFieldValue: _stringifyFieldValue,
            isoIfEpoch: _isoIfEpoch,
            buildEntityFields: _buildEntityFields,
            singularize: _singularize
        };
    }
})();
