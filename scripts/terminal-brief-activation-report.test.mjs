import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderMarkdown,
  runTerminalBriefActivationReport,
} from './terminal-brief-activation-report.mjs';

describe('terminal brief activation report', () => {
  it('renders a safe no-live R3 report with each activation gate separated', () => {
    const report = runTerminalBriefActivationReport({
      codeMerged: 'https://github.com/jinwon-int/a2a-broker/issues/392#code-merged',
      canaryDeployed: 'https://github.com/jinwon-int/a2a-broker/issues/392#canary-deployed',
      operatorBridgeEnabled: 'https://github.com/jinwon-int/a2a-broker/issues/392#operator-bridge',
      oneShotFreshTaskSent: 'https://github.com/jinwon-int/a2a-broker/issues/392#fresh-task',
    });

    assert.equal(report.ok, true);
    assert.equal(report.issue, '#392');
    assert.equal(report.activationReady, false);
    assert.equal(report.activationDecision, 'Block');
    assert.equal(report.mode, 'no-live-read-only');
    assert.equal(report.gates.find((gate) => gate.id === 'codeMerged')?.status, 'proven');
    assert.equal(report.gates.find((gate) => gate.id === 'canaryDeployed')?.status, 'proven');
    assert.equal(report.gates.find((gate) => gate.id === 'operatorBridgeEnabled')?.status, 'proven');
    assert.equal(report.gates.find((gate) => gate.id === 'oneShotFreshTaskSent')?.status, 'proven');
    assert.equal(report.gates.find((gate) => gate.id === 'operatorVisibleReceiptProven')?.status, 'pending');
    assert.equal(report.gates.find((gate) => gate.id === 'manualAckRecorded')?.status, 'pending');
    assert.equal(report.gates.find((gate) => gate.id === 'finalNoLiveRestored')?.status, 'pending');
    assert.match(report.warnings.join('\n'), /one-shot task\/provider send evidence is not operator-visible receipt evidence/);
    assert.equal(report.safety.operatorBridgeEnabledByThisReport, false);
    assert.equal(report.safety.providerSendAttempted, false);
    assert.equal(report.safety.terminalAckAttempted, false);
  });

  it('does not count operator-visible receipt evidence as manual ACK evidence', () => {
    const report = runTerminalBriefActivationReport({
      codeMerged: 'https://github.com/jinwon-int/a2a-broker/issues/392#code-merged',
      canaryDeployed: 'https://github.com/jinwon-int/a2a-broker/issues/392#canary-deployed',
      operatorBridgeEnabled: 'https://github.com/jinwon-int/a2a-broker/issues/392#operator-bridge',
      oneShotFreshTaskSent: 'https://github.com/jinwon-int/a2a-broker/issues/392#fresh-task',
      operatorVisibleReceiptProven: 'https://github.com/jinwon-int/a2a-broker/issues/392#operator-visible-receipt',
    });

    assert.equal(report.activationReady, false);
    assert.equal(report.gates.find((gate) => gate.id === 'operatorVisibleReceiptProven')?.status, 'proven');
    assert.equal(report.gates.find((gate) => gate.id === 'manualAckRecorded')?.status, 'pending');
    assert.match(report.warnings.join('\n'), /operator-visible receipt evidence is not manual ACK evidence/);
  });

  it('requires receipt evidence and final no-live restoration around manual ACK evidence', () => {
    const report = runTerminalBriefActivationReport({
      codeMerged: 'https://github.com/jinwon-int/a2a-broker/issues/392#code-merged',
      canaryDeployed: 'https://github.com/jinwon-int/a2a-broker/issues/392#canary-deployed',
      operatorBridgeEnabled: 'https://github.com/jinwon-int/a2a-broker/issues/392#operator-bridge',
      oneShotFreshTaskSent: 'https://github.com/jinwon-int/a2a-broker/issues/392#fresh-task',
      manualAckRecorded: 'https://github.com/jinwon-int/a2a-broker/issues/392#manual-ack',
    });

    assert.equal(report.activationReady, false);
    assert.match(report.warnings.join('\n'), /manual ACK evidence requires independently proven operator-visible/);
    assert.match(report.warnings.join('\n'), /manual ACK evidence is not final no-live restoration evidence/);
  });

  it('requires all seven R3 gates before activation is ready', () => {
    const report = runTerminalBriefActivationReport({
      codeMerged: 'https://github.com/jinwon-int/a2a-broker/issues/392#code-merged',
      canaryDeployed: 'https://github.com/jinwon-int/a2a-broker/issues/392#canary-deployed',
      operatorBridgeEnabled: 'https://github.com/jinwon-int/a2a-broker/issues/392#operator-bridge',
      oneShotFreshTaskSent: 'https://github.com/jinwon-int/a2a-broker/issues/392#fresh-task',
      operatorVisibleReceiptProven: 'https://github.com/jinwon-int/a2a-broker/issues/392#operator-visible-receipt',
      manualAckRecorded: 'https://github.com/jinwon-int/a2a-broker/issues/392#manual-ack',
      finalNoLiveRestored: 'https://github.com/jinwon-int/a2a-broker/issues/392#final-no-live-restored',
    });

    assert.equal(report.activationReady, true);
    assert.equal(report.activationDecision, 'Ready');
    assert.deepEqual(report.warnings, []);
  });

  it('redacts non-http evidence and unsafe diagnostic strings from markdown', () => {
    const report = runTerminalBriefActivationReport({
      codeMerged: 'file:///work/repo/private.log',
      oneShotFreshTaskSent: 'https://github.com/jinwon-int/a2a-broker/issues/392?token=ghp_secretvalue',
    });
    const markdown = renderMarkdown(report);

    assert.equal(report.gates.find((gate) => gate.id === 'codeMerged')?.status, 'pending');
    assert.doesNotMatch(markdown, /file:\/\/|\/work\/repo|ghp_secretvalue/);
    assert.match(markdown, /token=\[redacted\]/);
  });
});
