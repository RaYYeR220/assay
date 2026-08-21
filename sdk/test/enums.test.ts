import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HALT_REASONS, NAV_STATES, REJECT_REASONS } from '../src/enums.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES_SOL = resolve(join(HERE, '..', '..', 'src', 'Types.sol'));

/**
 * Solidity encodes an enum as its index, so a reordering in Types.sol would silently make
 * every decoded reason in this SDK wrong. When the contracts are in the tree, check.
 */
test('the enum tables match Types.sol', { skip: existsSync(TYPES_SOL) ? false : 'contracts not in this tree' }, () => {
  const source = readFileSync(TYPES_SOL, 'utf8');

  const members = (name: string): string[] => {
    const match = source.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `enum ${name} not found in Types.sol`);
    return match[1]!
      .split(',')
      .map((entry) => entry.replace(/\/\/.*$/gm, '').trim())
      .filter(Boolean);
  };

  assert.deepEqual(members('RejectReason'), [...REJECT_REASONS]);
  assert.deepEqual(members('HaltReason'), [...HALT_REASONS]);
  assert.deepEqual(members('NavState'), [...NAV_STATES]);
});

test('index zero is the no-op member of every enum', () => {
  assert.equal(REJECT_REASONS[0], 'None');
  assert.equal(HALT_REASONS[0], 'None');
  assert.equal(NAV_STATES[0], 'Empty');
});
