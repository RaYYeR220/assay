/**
 * slots.ts — the committee slot order, read from the contract that will enforce it.
 *
 * `AssayOracle._checkVerdict` calls `assets.modelAt(assetId, v.slot)` and requires the
 * recovered signer to be attested for THAT model. So slot index is consensus-critical: if
 * the backend appraises in a different order than the contract expects, every signature
 * verifies against the wrong model id and the whole round is rejected.
 *
 * Rather than keep a second copy and hope it stays in sync, this parses the committee out
 * of `script/Deploy.s.sol` — the same literal array that gets deployed. Discovery may
 * SUGGEST a committee; the contract DECIDES it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEPLOY_SCRIPT_PATH =
  process.env.ASSAY_DEPLOY_SCRIPT ?? join(HERE, '..', '..', 'script', 'Deploy.s.sol');

/**
 * Parse `c[0] = "model/id";` style assignments into a dense, index-ordered array.
 * Throws rather than guessing if the array is sparse or empty — a silently wrong slot
 * order is the single most expensive failure mode available here.
 */
export function parseDeployCommittee(source: string): string[] {
  const byIndex = new Map<number, string>();
  const re = /\bc\s*\[\s*(\d+)\s*\]\s*=\s*"([^"]+)"\s*;/g;
  for (const m of source.matchAll(re)) {
    byIndex.set(Number(m[1]), m[2]!);
  }
  if (byIndex.size === 0) throw new Error(`no committee assignments found in ${DEPLOY_SCRIPT_PATH}`);
  const out: string[] = [];
  for (let i = 0; i < byIndex.size; i++) {
    const v = byIndex.get(i);
    if (v === undefined) throw new Error(`committee slot ${i} is missing — the deploy array is sparse`);
    out.push(v);
  }
  return out;
}

/** The deployed slot order, or null when the deploy script is not available. */
export function deployCommittee(): string[] | null {
  if (!existsSync(DEPLOY_SCRIPT_PATH)) return null;
  return parseDeployCommittee(readFileSync(DEPLOY_SCRIPT_PATH, 'utf8'));
}
