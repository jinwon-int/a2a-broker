import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkComposeText } from './docker-runtime-preflight.mjs';

const validCompose = `services:
  a2a-broker:
    container_name: \${SERVICE_NAME:-a2a-broker}
    environment:
      HOST: 0.0.0.0
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - /var/lib/a2a-broker:/var/lib/a2a-broker
`;

describe('docker runtime preflight compose checks', () => {
  it('accepts the required production compose invariants', () => {
    const checks = checkComposeText(validCompose);
    assert.equal(checks.every((check) => check.ok), true, JSON.stringify(checks, null, 2));
  });

  it('fails clearly when the state bind mount is absent', () => {
    const checks = checkComposeText(validCompose.replace('    volumes:\n      - /var/lib/a2a-broker:/var/lib/a2a-broker\n', ''));
    const bindCheck = checks.find((check) => check.check === 'state bind mount');
    assert.equal(bindCheck?.ok, false);
    assert.match(bindCheck?.detail ?? '', /volumes must include/);
  });
});
