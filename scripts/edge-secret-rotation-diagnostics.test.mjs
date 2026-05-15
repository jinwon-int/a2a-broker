import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRotationDiagnostics,
  inspectConfigText,
  renderMarkdown,
} from './edge-secret-rotation-diagnostics.mjs';

describe('edge-secret rotation diagnostics', () => {
  it('records broker and worker secret locations without recording secret values', () => {
    const broker = inspectConfigText({
      component: 'broker',
      source: 'systemd-cat',
      location: '/etc/systemd/system/a2a-broker.service.d/edge.conf',
      text: [
        '[Service]',
        'Environment="EDGE_SECRET=broker-plain-secret-must-not-leak"',
        'EnvironmentFile=-/etc/a2a-broker/edge.env',
      ].join('\n'),
    });
    const worker = inspectConfigText({
      component: 'worker',
      source: 'env-file',
      location: '/etc/a2a-worker/worker.env',
      text: 'BROKER_EDGE_SECRET_FILE=/run/secrets/a2a-worker-edge\n',
    });

    assert.deepEqual(broker.edgeSecretVariables, ['EDGE_SECRET']);
    assert.deepEqual(broker.referencedEnvFiles, ['/etc/a2a-broker/edge.env']);
    assert.deepEqual(worker.edgeSecretFileVariables, ['BROKER_EDGE_SECRET_FILE']);
    assert.deepEqual(worker.referencedSecretFiles, ['/run/secrets/a2a-worker-edge']);

    const serialized = JSON.stringify({ broker, worker });
    assert.doesNotMatch(serialized, /broker-plain-secret-must-not-leak/);
    assert.doesNotMatch(serialized, /EDGE_SECRET=broker-plain-secret/);
  });

  it('reports process-env presence and redacts direct env/config values', () => {
    const report = buildRotationDiagnostics({
      generatedAt: '2026-05-14T00:00:00.000Z',
      env: {
        A2A_EDGE_SECRET: 'direct-env-secret-must-not-leak',
        BROKER_EDGE_SECRET_FILE: '/run/secrets/broker-edge',
      },
    });

    assert.equal(report.ok, true);
    assert.equal(report.safety.secretValuesRecorded, false);
    assert.equal(report.safety.restartAttempted, false);
    assert.equal(report.safety.providerSendAttempted, false);
    assert.equal(report.safety.dbMutationAttempted, false);
    assert.equal(report.safety.terminalAckAttempted, false);
    assert.ok(report.locations.some((location) => location.edgeSecretVariables.includes('A2A_EDGE_SECRET')));
    assert.ok(report.locations.some((location) => location.referencedSecretFiles.includes('/run/secrets/broker-edge')));

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /direct-env-secret-must-not-leak/);
    assert.doesNotMatch(serialized, /A2A_EDGE_SECRET=direct/);
  });

  it('redacts malformed *_FILE values instead of treating them as locations', () => {
    const report = buildRotationDiagnostics({
      generatedAt: '2026-05-14T00:00:00.000Z',
      env: { BROKER_EDGE_SECRET_FILE: 'not-a-path-secret-material' },
    });

    assert.ok(report.locations.some((location) => location.referencedSecretFiles.includes('<non-path-redacted>')));
    assert.doesNotMatch(JSON.stringify(report), /not-a-path-secret-material/);
  });

  it('renders markdown with handling rules and without values or hashes', () => {
    const report = buildRotationDiagnostics({
      generatedAt: '2026-05-14T00:00:00.000Z',
      sample: true,
      env: { EDGE_SECRET: 'sample-secret-value-must-not-leak' },
    });
    const markdown = renderMarkdown(report);

    assert.match(markdown, /values=<not recorded>/);
    assert.match(markdown, /Do not print, hash, screenshot, or persist edge-secret values/);
    assert.match(markdown, /no rotation, config mutation, deploy, restart/);
    assert.doesNotMatch(markdown, /sample-secret-value-must-not-leak/);
    assert.doesNotMatch(markdown, /[a-f0-9]{64}/i);
  });

  it('fails closed when no edge-secret locations are discovered', () => {
    const report = buildRotationDiagnostics({
      generatedAt: '2026-05-14T00:00:00.000Z',
      env: {},
    });

    assert.equal(report.ok, false);
    assert.match(report.checks[0].detail, /no edge-secret locations/);
    assert.deepEqual(report.locations, []);
  });
});
