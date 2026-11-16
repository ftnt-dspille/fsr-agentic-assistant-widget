'use strict';
// Direct coverage for fsrPbExportService (widgetAssets/js/fsrPbExport.service.js).
// The builders take an explicit snapshot of controller state; these tests pin
// the document shape and that the injected secret scrub is applied to the output.

global.jasmine = global.jasmine || {};
require('angular');
require('angular-mocks');
angular.module('cybersponse', []); // eslint-disable-line no-undef
require('../widget/widgetAssets/js/fsrPbExport.service.js');

function service() {
  let svc;
  window.angular.mock.module('cybersponse');   // eslint-disable-line no-undef
  window.angular.mock.inject((fsrPbExportService) => { svc = fsrPbExportService; });
  return svc;
}

function snapshot(over) {
  return Object.assign({
    modeInfo: { mode: 'mock', mock_scenario: 'happy_path' },
    messages: [
      { role: 'user', author: 'Ana', text: 'triage this', ts: '2026-10-01T10:00:00Z' },
      { role: 'assistant', text: 'done', ts: '2026-10-01T10:00:05Z',
        events: [{ type: 'tool_call', name: 'get_record', resultStatus: 'ok', inputDisplay: '{"a":1}', resultDisplay: 'ok' }] }
    ],
    currentYaml: '',
    uiIntent: 'triage',
    widgetVersion: '1.2.3',
    contractVersion: '2.8.0',
    connectorInfo: null,
    entityContext: null,
    usage: null,
    contractBanner: '',
    errorMessage: '',
    sessionId: 'sess-1',
    eventLog: [{ t: 1, kind: 'start' }],
    scrub: (s) => s.replace(/SECRET-\w+/g, '[redacted]')
  }, over || {});
}

describe('fsrPbExportService.buildMarkdown', () => {
  test('writes the header, the session facts and the transcript', () => {
    const md = service().buildMarkdown(snapshot());
    expect(md).toMatch(/^# Agentic Assistant -- chat activity export/);
    expect(md).toContain('- Session: `sess-1`');
    expect(md).toContain('- Mode: mock (scenario: happy_path)');
    expect(md).toContain('- Widget: v1.2.3 · contract v2.8.0');
    expect(md).toContain('### 1. Ana');
    expect(md).toContain('### 2. Assistant');
    expect(md).toContain('- **tool** `get_record` _(ok)_');
    expect(md).toContain('## Client event log');
  });

  test('says so when there are no messages and includes the final YAML when present', () => {
    const svc = service();
    expect(svc.buildMarkdown(snapshot({ messages: [] }))).toContain('_(no messages yet)_');
    const withYaml = svc.buildMarkdown(snapshot({ currentYaml: 'name: x' }));
    expect(withYaml).toContain('## Current playbook YAML');
    expect(withYaml).toContain('```yaml\nname: x\n```');
  });

  test('the injected scrub is applied to the whole document', () => {
    const md = service().buildMarkdown(snapshot({ messages: [{ role: 'user', text: 'SECRET-abc' }] }));
    expect(md).not.toContain('SECRET-abc');
    expect(md).toContain('[redacted]');
  });
});

describe('fsrPbExportService.buildEventsJson', () => {
  test('emits a manifest with per-tool counts and the raw client event log', () => {
    const doc = JSON.parse(service().buildEventsJson(snapshot()));
    expect(doc.manifest.session).toBe('sess-1');
    expect(doc.manifest.mode).toBe('mock');
    expect(doc.manifest.messageCount).toBe(2);
    expect(doc.manifest.toolCallCount).toBe(1);
    expect(doc.manifest.toolCallsByName).toEqual({ get_record: 1 });
    expect(doc.manifest.errorCount).toBe(0);
    expect(doc.manifest.finalYaml).toBe(false);
    expect(doc.manifest.contractVersion).toBe('2.8.0');
    expect(doc.clientEventLog).toEqual([{ t: 1, kind: 'start' }]);
    expect(doc.messages.length).toBe(2);
  });

  test('counts error events and tool errors, and applies the scrub', () => {
    const snap = snapshot({
      messages: [{ role: 'assistant', text: 'SECRET-zzz', events: [
        { type: 'tool_call', name: 'x', resultStatus: 'error' },
        { type: 'error', display: 'boom' }
      ] }]
    });
    const raw = service().buildEventsJson(snap);
    const doc = JSON.parse(raw);
    expect(doc.manifest.errorCount).toBe(2);
    expect(raw).not.toContain('SECRET-zzz');
  });
});
