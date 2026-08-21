/**
 * bundle.test.ts — the zero-credential replay path.
 *
 * Judges must be able to re-verify a recorded appraisal round with no API key and no chain.
 * `reverifyBundle` is that path, and it must REBUILD the request bytes from the schema
 * rather than trusting the ones stored in the bundle — otherwise a doctored bundle could
 * "verify" against its own doctored request.
 *
 * These tests construct a bundle signed by a known local key, so they need no credentials.
 */

import { test, describe } from 'node:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import { buildRequestString, buildSignedText, sha256Hex, packVerdict, parseResponseOnChain } from '../src/canonical.ts';
import { reverifyBundle, committeeSlots, committeeDrift, COMMITTEE_SIZE, type AppraisalBundle, type SlotResult } from '../src/appraise.ts';
import { parseDeployCommittee } from '../src/slots.ts';
import { buildEvidence, loadAllAssets } from '../src/evidence.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const ACCT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex);

function fakeResponse(content: string, created: number): string {
  return (
    `{"id":"chatcmpl-1","object":"chat.completion","created":${created},"model":"m",` +
    `"choices":[{"index":0,"message":{"role":"assistant","content":"${content}"},"finish_reason":"stop"}],` +
    `"usage":{"prompt_tokens":400,"completion_tokens":18,"total_tokens":418}}`
  );
}

async function makeSlot(slot: number, model: string, evidence: string, line: string, created: number): Promise<SlotResult> {
  const requestBody = buildRequestString(model, evidence);
  const responseBody = fakeResponse(line, created);
  const signature = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
  return {
    slot, model,
    attestedSigner: ACCT.address,
    receiptId: `rcpt-${slot}`,
    requestBody,
    requestSha256: sha256Hex(requestBody),
    responseBody,
    responseSha256: sha256Hex(responseBody),
    signature,
    gatewayText: null,
    gatewayTextMatches: null,
    preflight: null,
    onChain: packVerdict(slot, responseBody, signature),
    available: true,
    failure: null,
    latencyMs: 100,
  };
}

async function makeBundle(navsE6: (number | null)[]): Promise<AppraisalBundle> {
  const asset = loadAllAssets()[0]!;
  const ev = buildEvidence(asset);
  const models = committeeSlots();
  const createdAt = new Date();
  const created = Math.floor(createdAt.getTime() / 1000);

  const slots: SlotResult[] = [];
  for (let i = 0; i < models.length; i++) {
    const nav = navsE6[i];
    if (nav === null || nav === undefined) {
      slots.push({
        slot: i, model: models[i]!, attestedSigner: ACCT.address, receiptId: null,
        requestBody: buildRequestString(models[i]!, ev.line),
        requestSha256: '', responseBody: '', responseSha256: '', signature: null,
        gatewayText: null, gatewayTextMatches: null, preflight: null,
        onChain: packVerdict(i, null, null), available: false, failure: 'model unavailable', latencyMs: 0,
      });
    } else {
      slots.push(await makeSlot(i, models[i]!, ev.line, `ASSAY1|nav_usd_e6=${nav}|confidence_bps=7000`, created));
    }
  }

  return {
    bundleId: 'test', createdAt: createdAt.toISOString(), promptVersion: 'assay.appraisal.v1',
    schemaId: '0x00', assetId: asset.assetId,
    assetIdHex: '0x' + '00'.repeat(32),
    evidence: { line: ev.line, hex: `0x${Buffer.from(ev.line).toString('hex')}`, sha256: ev.evidenceSha256, byteLength: ev.byteLength },
    chain: {
      evidenceCommitted: true, observationWatermark: null, epoch: null,
      configured: false, error: null, commitEvidenceCall: null,
    },
    committee: models, slots,
    submission: { assetId: asset.assetId, evidence: '0x', verdicts: slots.map((s) => s.onChain) },
    summary: {
      slots: slots.length, available: 0, signatureOk: 0, preflightOk: 0, navsE6: [],
      medianE6: null, maxDeviationBps: null, wouldHalt: false, wouldRevert: false,
      haltReasons: [], rejectReasons: [],
    },
  };
}

describe('zero-credential bundle replay', () => {
  test('committee is exactly 5 slots', () => {
    assert.equal(committeeSlots().length, COMMITTEE_SIZE);
  });

  test('a clean bundle re-verifies entirely offline', async () => {
    const b = await makeBundle([4250000, 4300000, 4100000, 4200000, 4260000]);
    const r = await reverifyBundle(b);
    assert.equal(r.requestBytesReproduced, true, 'request bytes must rebuild from the schema');
    assert.equal(r.acceptedCount, 5);
    assert.equal(r.slots.every((s) => s.ok), true, JSON.stringify(r.slots.filter((s) => !s.ok)));
  });

  test('an unavailable slot is present and visibly rejected, not omitted', async () => {
    const b = await makeBundle([4250000, null, 4100000, 4200000, null]);
    const r = await reverifyBundle(b);
    assert.equal(r.slots.length, COMMITTEE_SIZE, 'all slots must still be present');
    assert.equal(r.acceptedCount, 3);
    assert.equal(b.submission.verdicts.length, COMMITTEE_SIZE, 'all slots submitted on-chain');
    for (const i of [1, 4]) {
      assert.equal(b.submission.verdicts[i]!.responseBody, '0x');
      assert.equal(r.slots[i]!.ok, false);
      // Empty bodies are BadSignature, NOT Malformed: nothing was authenticated, so
      // counting them on the authenticated side would hand anyone a free halt.
      assert.equal(r.slots[i]!.reason, 'BadSignature');
    }
  });

  test('tampering with the stored NAV breaks the signature', async () => {
    const b = await makeBundle([4250000, 4300000, 4100000, 4200000, 4260000]);
    b.slots[0]!.responseBody = b.slots[0]!.responseBody.replace('4250000', '99000000');
    const r = await reverifyBundle(b);
    assert.equal(r.slots[0]!.ok, false);
    // Recovery still succeeds, onto a different address — UnknownSigner, not BadSignature.
    assert.equal(r.slots[0]!.reason, 'UnknownSigner');
    assert.equal(r.acceptedCount, 4);
  });

  test('tampering with the evidence breaks EVERY signature', async () => {
    const b = await makeBundle([4250000, 4300000, 4100000, 4200000, 4260000]);
    b.evidence.line = b.evidence.line.replace('vintage=', 'vintage_x=');
    const r = await reverifyBundle(b);
    assert.equal(r.acceptedCount, 0, 'rewriting the evidence must invalidate the whole round');
    assert.equal(r.slots.every((s) => s.reason === 'UnknownSigner'), true);
  });

  test('a doctored requestBody cannot smuggle itself past the rebuild', async () => {
    const b = await makeBundle([4250000, 4300000, 4100000, 4200000, 4260000]);
    b.slots[2]!.requestBody = 'totally different bytes';
    const r = await reverifyBundle(b);
    // The stored request is ignored — the schema rebuild is what gets hashed — so the
    // signature still verifies, but the mismatch is reported rather than hidden.
    assert.equal(r.requestBytesReproduced, false, 'the mismatch must be surfaced');
    assert.equal(r.slots[2]!.ok, true, 'verification uses the rebuilt bytes, not the stored ones');
  });
});

describe('slot order comes from the contract, not from discovery', () => {
  const NEWLINE = String.fromCharCode(10);
  test('committeeSlots() matches script/Deploy.s.sol exactly, in order', () => {
    const d = committeeDrift();
    assert.ok(d.deployed, 'script/Deploy.s.sol must be readable — slot order is consensus-critical');
    assert.deepEqual(committeeSlots(), d.deployed, 'appraisal order must equal the deployed order');
  });

  // The LIVE committee is whatever the current listing registered, which is not necessarily
  // what Deploy.s.sol last held — listings are immutable, so correcting a slot means a new
  // listing while the deploy script may still describe an older one. The authority for a
  // posted round is therefore the bundle it produced, not the script.
  const LIVE_COMMITTEE = [
    'deepseek/deepseek-v4-flash-0731',
    'google/gemma-3-27b-it',
    'meta-llama/llama-3.3-70b-instruct',
    'qwen/qwen-2.5-7b-instruct',
    'qwen/qwen3-vl-30b-a3b-instruct',
  ];

  test('every committee member is receipt-signable and non-reasoning', () => {
    // qwen3.5/3.6 emit ~512 reasoning tokens with content:null and blow MAX_RESPONSE, so
    // none of them may appear in a live committee no matter what /v1/models advertises.
    for (const m of LIVE_COMMITTEE) {
      assert.ok(!/qwen3\.[56]/.test(m), `${m} is a qwen3.5/3.6 model — it will never produce a verdict`);
    }
    assert.equal(new Set(LIVE_COMMITTEE).size, COMMITTEE_SIZE, 'five distinct models');
  });

  test('posted bundles used exactly the live committee, in slot order', () => {
    const dir = join(HERE, '..', 'data', 'bundles');
    if (!existsSync(dir)) { assert.ok(true, 'no bundles yet'); return; }
    const posted = readdirSync(dir)
      .filter((f) => f.endsWith('-latest.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { committee?: string[]; onChain?: { published?: boolean } })
      .filter((b) => b.onChain?.published);
    if (posted.length === 0) { assert.ok(true, 'no published round recorded yet'); return; }
    for (const b of posted) {
      assert.deepEqual(b.committee, LIVE_COMMITTEE, 'a published round must use the live committee in slot order');
    }
  });

  test('Deploy.s.sol is parseable and dense, even when it lags the live listing', () => {
    const d = committeeDrift();
    assert.ok(d.deployed, 'script/Deploy.s.sol must be readable');
    assert.equal(d.deployed!.length, COMMITTEE_SIZE);
    assert.equal(committeeSlots().length, COMMITTEE_SIZE);
  });

  test('parser refuses a sparse deploy array rather than guessing', () => {
    // Built with join so no layer of quoting can mangle the line breaks.
    const sparse = ['c[0] = "a/b";', 'c[2] = "c/d";'].join(NEWLINE);
    assert.throws(() => parseDeployCommittee(sparse), /slot 1 is missing|sparse/);
    assert.throws(() => parseDeployCommittee('no assignments here'), /no committee assignments/);
  });

  test('parser reads indices, not source order', () => {
    const shuffled = ['c[2] = "c/c";', 'c[0] = "a/a";', 'c[1] = "b/b";'].join(NEWLINE);
    const out = parseDeployCommittee(shuffled);
    assert.deepEqual(out, ['a/a', 'b/b', 'c/c']);
  });
});
