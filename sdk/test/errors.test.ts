import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeErrorResult, type Hex } from 'viem';
import { ASSAY_ERROR_ABI, explainRevert, explainRevertData, extractRevertData, formatBps } from '../src/errors.ts';

const ASSET_ID = '0x1c558fe39967231fd46177180f991b4ddec428a2ad03dbf4a32493d8a9092dcb' as Hex;

const encode = (errorName: string, args: readonly unknown[] = []) =>
  encodeErrorResult({ abi: ASSAY_ERROR_ABI, errorName, args } as never);

/** How a viem revert actually reaches a caller, wrapped a few layers deep. */
const wrapLikeViem = (data: Hex) => ({
  name: 'ContractFunctionExecutionError',
  shortMessage: 'The contract function "requireFreshNav" reverted.',
  cause: {
    name: 'ContractFunctionRevertedError',
    raw: data,
    cause: { name: 'RawContractError', data },
  },
});

test('a halt caused by disagreement names the band the asset actually uses', () => {
  const data = encode('OracleHalted', [ASSET_ID, 2]); // 2 = HaltReason.Disagreement
  const refusal = explainRevert(wrapLikeViem(data), { bandBps: 1000 });

  assert.equal(refusal.reason, 'halted');
  assert.equal(refusal.detail, 'the committee disagreed beyond the 10% band, so no price was published');
  assert.equal(refusal.error, 'OracleHalted');
  assert.equal(refusal.args?.['haltReason'], 'Disagreement');
  assert.equal(refusal.isRefusalToPrice, true);
});

test('a halt still explains itself without any context', () => {
  const refusal = explainRevert(wrapLikeViem(encode('OracleHalted', [ASSET_ID, 1])));
  assert.equal(refusal.reason, 'halted');
  assert.match(refusal.detail, /quorum/);
});

test('every halt reason maps to a sentence', () => {
  for (let reason = 1; reason <= 5; reason++) {
    const refusal = explainRevert(wrapLikeViem(encode('OracleHalted', [ASSET_ID, reason])));
    assert.equal(refusal.reason, 'halted');
    assert.ok(refusal.detail.length > 20, `halt reason ${reason} has no explanation`);
  }
});

test('staleness is reported as an age, not a timestamp', () => {
  const observedAt = 1_787_000_000;
  const refusal = explainRevert(wrapLikeViem(encode('NavStale', [ASSET_ID, BigInt(observedAt)])), {
    maxAgeSec: 3600,
    now: observedAt + 7200,
  });
  assert.equal(refusal.reason, 'stale');
  assert.match(refusal.detail, /2h ago/);
  assert.match(refusal.detail, /60m/);
});

test('the remaining consumer-facing refusals decode', () => {
  const cases: Array<[string, readonly unknown[], string]> = [
    ['NavDisputed', [ASSET_ID], 'disputed'],
    ['NoNav', [ASSET_ID], 'no-nav'],
    ['SequencerDown', [], 'sequencer-down'],
    ['AssetNotActive', [], 'asset-inactive'],
  ];
  for (const [errorName, args, reason] of cases) {
    const refusal = explainRevert(wrapLikeViem(encode(errorName, args)));
    assert.equal(refusal.reason, reason, errorName);
    assert.equal(refusal.isRefusalToPrice, true, errorName);
  }
});

test('a caller mistake is not labelled a refusal to price', () => {
  const refusal = explainRevert(wrapLikeViem(encode('CommitteeIncomplete', [3n, 5n])));
  assert.equal(refusal.reason, 'committee-incomplete');
  assert.equal(refusal.isRefusalToPrice, false);
  assert.match(refusal.detail, /3 verdicts but the committee has 5 seats/);
});

test('bond shortfalls report both numbers', () => {
  const refusal = explainRevert(wrapLikeViem(encode('BondTooSmall', [1n, 10_000_000_000_000_000n])));
  assert.equal(refusal.reason, 'bond');
  assert.match(refusal.detail, /10000000000000000 wei/);
});

test('an uncommitted evidence document says what to do about it', () => {
  const refusal = explainRevert(wrapLikeViem(encode('EvidenceNotCommitted', [ASSET_ID])));
  assert.equal(refusal.reason, 'evidence-rejected');
  assert.match(refusal.detail, new RegExp(ASSET_ID));
  assert.match(refusal.detail, /commitEvidence/);
});

test('a re-appraisal that could not conclude reports the halt behind it', () => {
  const refusal = explainRevert(wrapLikeViem(encode('InconclusiveRound', [2])), { bandBps: 500 });
  assert.equal(refusal.reason, 'halted');
  assert.equal(refusal.args?.['haltReason'], 'Disagreement');
  assert.match(refusal.detail, /5% band/);
});

test('a dispute that cannot lapse yet reports the time it can', () => {
  const refusal = explainRevert(wrapLikeViem(encode('DisputeStillOpen', [1_787_000_000n])));
  assert.equal(refusal.reason, 'dispute-state');
  assert.match(refusal.detail, /2026-08/);
});

test('a revoked enclave key is named', () => {
  const key = '0x1563915e194D8CfBA1943570603F7606A3115508';
  const refusal = explainRevert(wrapLikeViem(encode('SignerIsRevoked', [key])));
  assert.equal(refusal.reason, 'attestation-rejected');
  assert.match(refusal.detail, new RegExp(key, 'i'));
});

test('an unauthenticated round is distinguished from a halt', () => {
  const refusal = explainRevert(wrapLikeViem(encode('UnauthenticatedRound', [1])));
  assert.equal(refusal.reason, 'unauthenticated');
  assert.match(refusal.detail, /ignored rather than recorded as a halt/);
});

test('a plain require string comes back as text', () => {
  const data = encodeErrorResult({
    abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }],
    errorName: 'Error',
    args: ['ERC20: transfer amount exceeds balance'],
  });
  const refusal = explainRevert(wrapLikeViem(data));
  assert.equal(refusal.reason, 'reverted');
  assert.match(refusal.detail, /transfer amount exceeds balance/);
});

test('an unknown selector is reported, never guessed at', () => {
  const refusal = explainRevert(wrapLikeViem('0xdeadbeef'));
  assert.equal(refusal.reason, 'unknown');
  assert.equal(refusal.selector, '0xdeadbeef');
  assert.match(refusal.detail, /no Assay contract declares/);
});

test('a transport failure is not mistaken for a refusal', () => {
  const refusal = explainRevert(new Error('fetch failed: ECONNREFUSED 127.0.0.1:8545'));
  assert.equal(refusal.reason, 'network');
  assert.equal(refusal.isRefusalToPrice, false);
});

test('revert data is found however the transport nested it', () => {
  const data = encode('SequencerDown');
  assert.equal(extractRevertData({ cause: { cause: { data } } }), data);
  assert.equal(extractRevertData({ error: { data: { originalError: { data } } } }), data);
  assert.equal(extractRevertData({ details: `execution reverted: ${data}` }), data);
  assert.equal(extractRevertData({ nothing: 'here' }), undefined);
});

test('explainRevertData works straight off the wire', () => {
  const refusal = explainRevertData(encode('NoNav', [ASSET_ID]));
  assert.equal(refusal?.reason, 'no-nav');
  assert.equal(refusal?.data, encode('NoNav', [ASSET_ID]));
});

test('viem may hand us the decoded error instead of the bytes', () => {
  const refusal = explainRevert({
    name: 'ContractFunctionExecutionError',
    cause: { data: { errorName: 'NavDisputed', args: [ASSET_ID] } },
  });
  assert.equal(refusal.reason, 'disputed');
});

test('formatBps renders whole percentages without trailing noise', () => {
  assert.equal(formatBps(1000), '10%');
  assert.equal(formatBps(500), '5%');
  assert.equal(formatBps(1), '0.01%');
});
