import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadReceiptGateCanaryModule } from './receipt-gate-canary.mjs';

describe('receipt-gate canary script runner', () => {
  it('loads from dependency-free runtime when dist is absent', async () => {
    const mod = await loadReceiptGateCanaryModule({
      distUrl: new URL('file:///tmp/a2a-broker-missing-receipt-gate-canary.js'),
    });

    const matrix = mod.runReceiptGateCanaryMatrix({ generatedAt: '2026-05-11T08:02:11.000Z' });
    assert.equal(matrix.overallVerdict, 'pass');
    assert.equal(matrix.cells.every((cell) => cell.providerCalled === false), true);
    assert.equal(matrix.cells.every((cell) => cell.productionAckAttempted === false), true);
    assert.match(mod.renderReceiptGateCanaryMarkdown(matrix), /Run mode: no-live/);
  });

  it('returns the compiled dist module when present and otherwise still runs safely', async () => {
    const mod = await loadReceiptGateCanaryModule({
      distUrl: new URL('./dist/core/receipt-gate-canary.js', pathToFileURL(`${resolve('.')}/`)),
    });

    const matrix = mod.runReceiptGateCanaryMatrix({ generatedAt: '2026-05-11T08:02:11.000Z' });
    assert.equal(matrix.kind, 'receipt-gate.canary.matrix');
    assert.equal(matrix.overallVerdict, 'pass');
  });
});
