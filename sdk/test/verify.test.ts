import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import {
  bandAround,
  buildRequestBytes,
  checkBundle,
  checkVerdict,
  DEFAULT_GRAMMAR,
  eip191Preimage,
  findOffsets,
  firstUnsafeByte,
  formatE6,
  isJsonStringSafe,
  matchAt,
  median,
  OffsetNotFoundError,
  packVerdict,
  parseE6,
  parseResponse,
  recoverEnclaveSigner,
  sha256Hex,
  signedText,
  utf8Bytes,
  type PromptSchema,
} from '../src/verify.ts';

interface FixtureMember {
  slot: number;
  modelId: string;
  signer: Hex;
  privateKey: Hex;
  responseBody: string;
  signature: Hex;
  offsets: { contentOffset: number; finishOffset: number; createdOffset: number };
  note?: string;
}

interface Fixture {
  schema: PromptSchema;
  evidence: string;
  createdAt: number;
  now: number;
  committee: string[];
  policy: { quorum: number; minDistinctSigners: number; bandBps: number; minConfidenceBps: number; maxAgeSec: number };
  members: FixtureMember[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'bundle.json'), 'utf8')) as Fixture;

const honest = fixture.members.filter((m) => m.slot <= 2 && !m.note);
const prose = fixture.members.find((m) => m.slot === 3)!;
const truncated = fixture.members.find((m) => m.slot === 4)!;
const wrongKey = fixture.members.find((m) => m.note)!;

const bodyOf = (m: FixtureMember) => utf8Bytes(m.responseBody);
const requestFor = (m: FixtureMember, evidence = fixture.evidence) =>
  buildRequestBytes(fixture.schema.head, m.modelId, fixture.schema.mid, evidence, fixture.schema.tail);

// ---------------------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------------------

test('buildRequestBytes concatenates head, model, mid, evidence, tail in that order', () => {
  const bytes = requestFor(honest[0]!);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('{"model":"'), 'request must open with the head fragment');
  assert.ok(text.endsWith('"}]}'), 'request must close with the tail fragment');

  const parsed = JSON.parse(text) as { model: string; messages: { content: string }[] };
  assert.equal(parsed.model, honest[0]!.modelId);
  assert.ok(parsed.messages[1]!.content.endsWith(fixture.evidence));
});

test('a different model id in the same slot changes the request bytes', () => {
  const a = requestFor(honest[0]!);
  const b = buildRequestBytes(fixture.schema.head, 'other/model', fixture.schema.mid, fixture.evidence, fixture.schema.tail);
  assert.notEqual(sha256Hex(a), sha256Hex(b));
});

test('isJsonStringSafe mirrors the on-chain charset', () => {
  assert.ok(isJsonStringSafe('registry=Verra;vintage=2023'));
  assert.ok(!isJsonStringSafe('has a " quote'));
  assert.ok(!isJsonStringSafe('has a \\ backslash'));
  assert.ok(!isJsonStringSafe('has a\nnewline'));
  assert.ok(!isJsonStringSafe('has a non-ascii é'));
  assert.deepEqual(firstUnsafeByte('ok"bad'), { index: 2, byte: 0x22 });
  assert.equal(firstUnsafeByte('all fine'), null);
});

// ---------------------------------------------------------------------------------------
// The signed text
// ---------------------------------------------------------------------------------------

test('signedText is sha256hex(request):sha256hex(response) and exactly 129 characters', () => {
  const member = honest[0]!;
  const request = requestFor(member);
  const response = bodyOf(member);
  const text = signedText(request, response);

  assert.equal(text.length, 129);
  assert.equal(text[64], ':');
  assert.equal(text.slice(0, 64), sha256Hex(request));
  assert.equal(text.slice(65), sha256Hex(response));
  assert.equal(eip191Preimage(text).length, 129 + '\x19Ethereum Signed Message:\n129'.length);
});

test('recoverEnclaveSigner returns the key that signed the pair', async () => {
  for (const member of honest) {
    const recovered = await recoverEnclaveSigner(requestFor(member), bodyOf(member), member.signature);
    assert.equal(recovered?.toLowerCase(), member.signer.toLowerCase(), `slot ${member.slot}`);
  }
});

test('a signature over different evidence does not recover against this round', async () => {
  const recovered = await recoverEnclaveSigner(requestFor(wrongKey), bodyOf(wrongKey), wrongKey.signature);
  assert.notEqual(recovered?.toLowerCase(), wrongKey.signer.toLowerCase());
});

test('recoverEnclaveSigner returns null rather than throwing on a malformed signature', async () => {
  const member = honest[0]!;
  assert.equal(await recoverEnclaveSigner(requestFor(member), bodyOf(member), '0xdead'), null);
  assert.equal(await recoverEnclaveSigner(requestFor(member), bodyOf(member), '0x' as Hex), null);
});

// ---------------------------------------------------------------------------------------
// Offsets
// ---------------------------------------------------------------------------------------

test('findOffsets locates the three literals by scanning the raw bytes', () => {
  for (const member of honest) {
    const body = bodyOf(member);
    const offsets = findOffsets(body);
    assert.deepEqual(offsets, member.offsets, `slot ${member.slot}`);
    assert.ok(matchAt(body, offsets.contentOffset, DEFAULT_GRAMMAR.contentPrefix));
    assert.ok(matchAt(body, offsets.finishOffset, DEFAULT_GRAMMAR.finishPattern));
    assert.ok(matchAt(body, offsets.createdOffset, DEFAULT_GRAMMAR.createdPattern));
  }
});

test('offsets differ between members, so they cannot have been hardcoded', () => {
  const contentOffsets = new Set(honest.map((m) => findOffsets(bodyOf(m)).contentOffset));
  assert.ok(contentOffsets.size > 1, 'model ids of different length must move the content offset');
});

test('findOffsets throws when a literal is absent', () => {
  assert.throws(() => findOffsets(bodyOf(truncated)), OffsetNotFoundError);
  assert.throws(() => findOffsets(utf8Bytes('{}')), (error: unknown) => {
    assert.ok(error instanceof OffsetNotFoundError);
    assert.equal(error.field, 'contentOffset');
    return true;
  });
});

test('packVerdict zeroes the offsets it cannot find, and empties an absent seat', () => {
  const packed = packVerdict(4, bodyOf(truncated), truncated.signature);
  assert.deepEqual(
    { c: packed.contentOffset, f: packed.finishOffset, cr: packed.createdOffset },
    { c: 0, f: 0, cr: 0 },
  );
  const absent = packVerdict(2, null, null);
  assert.equal(absent.responseBody, '0x');
  assert.equal(absent.signature, '0x');
});

// ---------------------------------------------------------------------------------------
// The strict parser
// ---------------------------------------------------------------------------------------

test('parseResponse reads the marker line out of a well-formed answer', () => {
  const outcome = parseResponse(bodyOf(honest[0]!));
  assert.ok(outcome.ok);
  assert.equal(outcome.parsed!.navE6, 4_210_000n);
  assert.equal(outcome.parsed!.confidenceBps, 8200);
  assert.equal(outcome.parsed!.createdAt, fixture.createdAt);
});

test('prose after the number is Malformed, not tolerated', () => {
  const outcome = parseResponse(bodyOf(prose));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'Malformed');
  assert.match(outcome.detail!, /after confidence_bps/);
});

test('an unfinished generation is Truncated', () => {
  const outcome = parseResponse(bodyOf(truncated));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'Truncated');
});

test('an empty body is Malformed', () => {
  const outcome = parseResponse(new Uint8Array());
  assert.equal(outcome.reason, 'Malformed');
  assert.match(outcome.detail!, /returned nothing/);
});

test('values outside the permitted range are OutOfRange', () => {
  const zero = bodyOf(honest[0]!);
  const text = new TextDecoder().decode(zero).replace('nav_usd_e6=4210000', 'nav_usd_e6=0');
  assert.equal(parseResponse(utf8Bytes(text)).reason, 'OutOfRange');

  const overConfident = new TextDecoder()
    .decode(zero)
    .replace('confidence_bps=8200', 'confidence_bps=20000');
  assert.equal(parseResponse(utf8Bytes(overConfident)).reason, 'OutOfRange');
});

test('a wrong offset hint is rejected rather than misread', () => {
  const body = bodyOf(honest[0]!);
  const offsets = findOffsets(body);
  const outcome = parseResponse(body, { ...offsets, contentOffset: offsets.contentOffset + 1 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'Malformed');
});

// ---------------------------------------------------------------------------------------
// Whole verdicts and whole rounds
// ---------------------------------------------------------------------------------------

test('checkVerdict passes an honest seat and names the failing check otherwise', async () => {
  const member = honest[0]!;
  const pass = await checkVerdict({
    slot: member.slot,
    modelId: member.modelId,
    schema: fixture.schema,
    evidence: fixture.evidence,
    responseBody: bodyOf(member),
    signature: member.signature,
    attestedSigners: [member.signer],
    minConfidenceBps: fixture.policy.minConfidenceBps,
    maxAgeSec: fixture.policy.maxAgeSec,
    now: fixture.now,
  });
  assert.ok(pass.ok, pass.detail ?? '');
  assert.equal(pass.signer?.toLowerCase(), member.signer.toLowerCase());
  assert.equal(pass.navE6, 4_210_000n);
  assert.equal(pass.value, '4.210000');

  const stale = await checkVerdict({
    slot: member.slot,
    modelId: member.modelId,
    schema: fixture.schema,
    evidence: fixture.evidence,
    responseBody: bodyOf(member),
    signature: member.signature,
    maxAgeSec: 60,
    now: fixture.now,
  });
  assert.equal(stale.reason, 'Stale');
  assert.match(stale.failedCheck!, /maxAgeSec/);

  const shy = await checkVerdict({
    slot: member.slot,
    modelId: member.modelId,
    schema: fixture.schema,
    evidence: fixture.evidence,
    responseBody: bodyOf(member),
    signature: member.signature,
    minConfidenceBps: 9000,
    now: fixture.now,
  });
  assert.equal(shy.reason, 'LowConfidence');

  const unknown = await checkVerdict({
    slot: member.slot,
    modelId: member.modelId,
    schema: fixture.schema,
    evidence: fixture.evidence,
    responseBody: bodyOf(member),
    signature: member.signature,
    attestedSigners: ['0x0000000000000000000000000000000000000001'],
    now: fixture.now,
  });
  assert.equal(unknown.reason, 'UnknownSigner');
});

test('checkVerdict rejects a signature made over different evidence', async () => {
  const result = await checkVerdict({
    slot: wrongKey.slot,
    modelId: wrongKey.modelId,
    schema: fixture.schema,
    evidence: fixture.evidence,
    responseBody: bodyOf(wrongKey),
    signature: wrongKey.signature,
    attestedSigners: [wrongKey.signer],
    now: fixture.now,
  });
  assert.equal(result.reason, 'UnknownSigner');
  assert.notEqual(result.signer?.toLowerCase(), wrongKey.signer.toLowerCase());
});

test('checkBundle publishes when quorum agrees inside the band', async () => {
  const result = await checkBundle(
    fixture.members.slice(0, 5).map((m) => ({
      slot: m.slot,
      modelId: m.modelId,
      responseBody: bodyOf(m),
      signature: m.signature,
      attestedSigners: [m.signer],
    })),
    fixture.schema,
    fixture.evidence,
    fixture.policy,
    { now: fixture.now },
  );

  assert.equal(result.wouldPublish, true);
  assert.equal(result.accepted, 3);
  assert.equal(result.distinctSigners, 3);
  assert.equal(result.medianE6, 4_210_000n);
  assert.equal(result.members.find((m) => m.slot === 3)!.reason, 'Malformed');
  assert.equal(result.members.find((m) => m.slot === 4)!.reason, 'Truncated');
});

test('checkBundle halts on disagreement when one seat leaves the band', async () => {
  const outlier = await signOutlier(3, 9_000_000n);
  const members = fixture.members.slice(0, 3).map((m) => ({
    slot: m.slot,
    modelId: m.modelId,
    responseBody: bodyOf(m),
    signature: m.signature,
    attestedSigners: [m.signer],
  }));
  members.push(outlier);

  const result = await checkBundle(members, fixture.schema, fixture.evidence, fixture.policy, {
    now: fixture.now,
  });
  assert.equal(result.wouldPublish, false);
  assert.equal(result.haltReason, 'Disagreement');
  assert.deepEqual(result.outliers, [3]);
  assert.match(result.summary, /10% band/);
});

test('checkBundle reports insufficient quorum rather than publishing a thin round', async () => {
  const result = await checkBundle(
    fixture.members.slice(0, 5).map((m) => ({
      slot: m.slot,
      modelId: m.modelId,
      responseBody: bodyOf(m),
      signature: m.signature,
      attestedSigners: [m.signer],
    })),
    fixture.schema,
    fixture.evidence,
    { ...fixture.policy, quorum: 4 },
    { now: fixture.now },
  );
  assert.equal(result.wouldPublish, false);
  assert.equal(result.haltReason, 'InsufficientQuorum');
});

test('checkBundle rejects a repeated slot the way the contract does', async () => {
  const members = [0, 0, 1, 2].map((slot) => {
    const m = fixture.members[slot]!;
    return {
      slot: m.slot,
      modelId: m.modelId,
      responseBody: bodyOf(m),
      signature: m.signature,
      attestedSigners: [m.signer],
    };
  });
  const result = await checkBundle(members, fixture.schema, fixture.evidence, fixture.policy, {
    now: fixture.now,
  });
  assert.equal(result.members.filter((m) => m.reason === 'DuplicateSlot').length, 1);
  assert.equal(result.accepted, 3);
});

// ---------------------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------------------

test('median matches the contract for odd and even counts', () => {
  assert.equal(median([3n, 1n, 2n]), 2n);
  assert.equal(median([4n, 1n, 2n, 3n]), 2n); // (2 + 3) / 2, truncated like Solidity
});

test('bandAround brackets the median by the configured basis points', () => {
  const band = bandAround(4_210_000n, 1000);
  assert.equal(band.lowE6, 3_789_000n);
  assert.equal(band.highE6, 4_631_000n);
  assert.equal(band.low, '3.789000');
});

test('formatE6 and parseE6 round-trip without floats', () => {
  assert.equal(formatE6(4_210_000n), '4.210000');
  assert.equal(formatE6(1n), '0.000001');
  assert.equal(parseE6('4.21'), 4_210_000n);
  assert.equal(parseE6(formatE6(123_456_789n)), 123_456_789n);
});

async function signOutlier(slot: number, navE6: bigint) {
  const member = fixture.members[slot]!;
  const body = member.responseBody.replace(
    /nav_usd_e6=\d+\|confidence_bps=\d+[^"]*/,
    `nav_usd_e6=${navE6}|confidence_bps=7000`,
  );
  const account = privateKeyToAccount(member.privateKey);
  const request = buildRequestBytes(
    fixture.schema.head,
    member.modelId,
    fixture.schema.mid,
    fixture.evidence,
    fixture.schema.tail,
  );
  const signature = await account.signMessage({ message: signedText(request, utf8Bytes(body)) });
  return {
    slot,
    modelId: member.modelId,
    responseBody: utf8Bytes(body),
    signature,
    attestedSigners: [account.address],
  };
}
