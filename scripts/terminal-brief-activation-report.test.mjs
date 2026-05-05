import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderMarkdown,
  runTerminalBriefActivationReport,
} from './terminal-brief-activation-report.mjs';

describe('terminal brief activation report', () => {
  it('renders a safe no-live report with each activation gate separated', () => {
    const report = runTerminalBriefActivationReport({
      codeMerged: 'https://github.com/jinwon-int/a2a-broker/pull/219',
      productionDeployed: 'https://github.com/jinwon-int/a2a-broker/issues/385#deployment-evidence',
      liveProviderSendAttempted: 'https://github.com/jinwon-int/a2a-broker/issues/385#provider-send',
    });

    assert.equal(report.ok, true);
    assert.equal(report.activationReady, false);
    assert.equal(report.activationDecision, 'Block');
    assert.equal(report.mode, 'no-live-read-only');
    assert.equal(report.gates.find((gate) => gate.id === 'codeMerged')?.status, 'proven');
    assert.equal(report.gates.find((gate) => gate.id === 'productionDeployed')?.status, 'proven');
    assert.equal(report.gates.find((gate) => gate.id === 'liveProviderSendAttempted')?.status, 'proven');
    assert.equal(report.gates.find((gate) => gate.id === 'operatorVisibleReceiptProven')?.status, 'pending');
    assert.equal(report.gates.find((gate) => gate.id === 'terminalAckPerformed')?.status, 'pending');
    assert.match(report.warnings.join('\n'), /provider send evidence is not operator-visible receipt evidence/);
    assert.equal(report.safety.providerSendAttempted, false);
    assert.equal(report.safety.terminalAckAttempted, false);
  });

  it('does not count operator-visible receipt evidence as terminal ACK evidence', () => {
    const report = runTerminalBriefActivationReport({
      codeMerged: 'https://github.com/jinwon-int/a2a-broker/pull/219',
      productionDeployed: 'https://github.com/jinwon-int/a2a-broker/issues/385#deployment-evidence',
      liveProviderSendAttempted: 'https://github.com/jinwon-int/a2a-broker/issues/385#provider-send',
      operatorVisibleReceiptProven: 'https://github.com/jinwon-int/a2a-broker/issues/385#operator-visible-receipt',
    });

    assert.equal(report.activationReady, false);
    assert.equal(report.gates.find((gate) => gate.id === 'operatorVisibleReceiptProven')?.status, 'proven');
    assert.equal(report.gates.find((gate) => gate.id === 'terminalAckPerformed')?.status, 'pending');
    assert.match(report.warnings.join('\n'), /operator-visible receipt evidence is not terminal ACK evidence/);
  });

  it('requires all five gates before activation is ready', () => {
    const report = runTerminalBriefActivationReport({
      codeMerged: 'https://github.com/jinwon-int/a2a-broker/pull/219',
      productionDeployed: 'https://github.com/jinwon-int/a2a-broker/issues/385#deployment-evidence',
      liveProviderSendAttempted: 'https://github.com/jinwon-int/a2a-broker/issues/385#provider-send',
      operatorVisibleReceiptProven: 'https://github.com/jinwon-int/a2a-broker/issues/385#operator-visible-receipt',
      terminalAckPerformed: 'https://github.com/jinwon-int/a2a-broker/issues/385#terminal-ack',
    });

    assert.equal(report.activationReady, true);
    assert.equal(report.activationDecision, 'Ready');
    assert.deepEqual(report.warnings, []);
  });

  it('redacts non-http evidence and unsafe diagnostic strings from markdown', () => {
    const report = runTerminalBriefActivationReport({
      codeMerged: 'file:///work/repo/private.log',
      liveProviderSendAttempted: 'https://github.com/jinwon-int/a2a-broker/issues/385?token=ghp_secretvalue',
    });
    const markdown = renderMarkdown(report);

    assert.equal(report.gates.find((gate) => gate.id === 'codeMerged')?.status, 'pending');
    assert.doesNotMatch(markdown, /file:\/\/|\/work\/repo|ghp_secretvalue/);
    assert.match(markdown, /token=\[redacted\]/);
  });
});
