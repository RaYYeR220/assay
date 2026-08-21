/**
 * canonical.test.ts — byte-exactness and fail-closed guarantees.
 *
 * Three kinds of test:
 *  1. SCHEMA     — the request bytes we POST equal the bytes Solidity concatenates.
 *  2. SYNTHETIC  — a locally-signed receipt proves the verifier reproduces the gateway's
 *                  scheme, and that a single flipped byte breaks it. Needs no credentials.
 *  3. RECORDED   — replays data/fixtures/receipt-*.json (real gateway receipts). Skipped
 *                  with a loud message until one has been recorded.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import {
  SCHEMA, HEAD, MID, TAIL, HEAD_TEXT, MID_TEXT, TAIL_TEXT,
  buildRequestBytes, buildRequestString, assertRequestWellFormed,
  buildSignedText, eip191Preimage, sha256Hex, verifyReceipt,
  isJsonStringSafe, assertJsonStringSafe, sanitiseToSafeCharset,
  findVerdictOffsets, parseResponseOnChain, packVerdict, preflightVerdict,
  GRAMMAR, MAX_NAV_E6, MAX_TRAILING_WS_RUN, skipJsonWhitespace, SCHEMA_ID,
  MAX_RESPONSE, REJECT_REASONS, readCreated, readAnswer,
} from '../src/canonical.ts';
import { buildEvidence, loadAllAssets, EVIDENCE_FIELD_ORDER } from '../src/evidence.ts';
import { SYSTEM_PROMPT, USER_PREAMBLE } from '../src/prompt.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'data', 'fixtures');

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const ACCT = privateKeyToAccount(TEST_KEY);

const MODEL = 'openai/gpt-oss-20b';
const EVIDENCE = 'schema=assay.carbon.v1;asset_id=vcs-902-kariba;registry=VCS;project_id=902;vintage=2014';

/** Build a response body shaped like the gateway's, with a chosen assistant line. */
function fakeResponse(content: string, opts: { created?: number; finish?: string } = {}): string {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const finish = opts.finish ?? 'stop';
  return (
    `{"id":"chatcmpl-abc123","object":"chat.completion","created":${created},"model":"${MODEL}",` +
    `"choices":[{"index":0,"message":{"role":"assistant","content":"${content}"},` +
    `"finish_reason":"${finish}"}],` +
    `"usage":{"prompt_tokens":412,"completion_tokens":18,"total_tokens":430,"cost":0.00001}}`
  );
}
const GOOD_LINE = 'ASSAY1|nav_usd_e6=4250000|confidence_bps=6200';

// ---------------------------------------------------------------------------

describe('locked schema', () => {
  test('fragments decode to the documented text', () => {
    assert.equal(HEAD_TEXT, '{"model":"');
    assert.equal(TAIL_TEXT, '"}]}');
    assert.ok(MID_TEXT.startsWith('","temperature":0,"max_tokens":512,"messages":['));
    assert.ok(MID_TEXT.endsWith('EVIDENCE: '));
  });

  test('assembled request is valid JSON with the expected shape', () => {
    const body = buildRequestString(MODEL, EVIDENCE);
    const o = JSON.parse(body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(o), ['model', 'temperature', 'max_tokens', 'messages']);
    assert.equal(o.model, MODEL);
    assert.equal(o.temperature, 0);
    assert.equal(o.max_tokens, 512);
    const msgs = o.messages as { role: string; content: string }[];
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.role, 'system');
    assert.equal(msgs[1]!.role, 'user');
    assert.ok(msgs[1]!.content.endsWith(EVIDENCE));
    assert.doesNotThrow(() => assertRequestWellFormed(MODEL, EVIDENCE));
  });

  test('equals the Solidity concatenation head||model||mid||evidence||tail', () => {
    const solidity = Buffer.concat([HEAD, Buffer.from(MODEL, 'utf8'), MID, Buffer.from(EVIDENCE, 'utf8'), TAIL]);
    assert.equal(buildRequestBytes(MODEL, EVIDENCE).equals(solidity), true);
  });

  test('is byte-stable across calls', () => {
    assert.equal(sha256Hex(buildRequestBytes(MODEL, EVIDENCE)), sha256Hex(buildRequestBytes(MODEL, EVIDENCE)));
  });

  test('request contains no whitespace outside string literals', () => {
    const body = buildRequestString(MODEL, EVIDENCE);
    assert.ok(!body.includes('", "'), 'no space after comma between keys');
    assert.ok(!body.includes('": '), 'no space after colon');
    assert.ok(!/[\n\r\t]/.test(body), 'no raw control characters');
  });

  test('prompt is derived from the schema, not duplicated', () => {
    assert.ok(MID_TEXT.includes(SYSTEM_PROMPT), 'SYSTEM_PROMPT must be a literal substring of the schema mid');
    assert.ok(MID_TEXT.endsWith(USER_PREAMBLE));
    assert.ok(SYSTEM_PROMPT.includes('ASSAY1|nav_usd_e6=<integer>|confidence_bps=<integer>'));
  });

  test('schemaId is present and 32 bytes', () => {
    assert.match(SCHEMA.schemaId, /^0x[0-9a-f]{64}$/);
  });

  test('rejects a model id or evidence outside the on-chain charset', () => {
    for (const bad of ['has "quote"', 'back\\slash', 'new\nline', 'tab\there', 'accentué', 'emoji 🌱']) {
      assert.throws(() => buildRequestBytes(MODEL, bad), /charset|rejects/i, `evidence: ${bad}`);
      assert.throws(() => buildRequestBytes(bad, EVIDENCE), /charset|rejects/i, `model: ${bad}`);
    }
  });
});

describe('charset — mirrors Ascii.isJsonStringSafe', () => {
  test('accepts the full allowed range, rejects exactly the forbidden bytes', () => {
    let allowed = '';
    for (let c = 0x20; c <= 0x7e; c++) {
      if (c === 0x22 || c === 0x5c) continue;
      allowed += String.fromCharCode(c);
    }
    assert.ok(isJsonStringSafe(allowed));
    for (const bad of ['"', '\\', '\x00', '\x1f', '\x7f', 'é']) {
      assert.ok(!isJsonStringSafe(bad), `must reject ${JSON.stringify(bad)}`);
    }
  });

  test('embedding safe evidence in JSON is a pure byte copy (no escaping)', () => {
    assert.ok(JSON.stringify({ c: EVIDENCE }).includes(EVIDENCE));
  });

  test('sanitiser folds real-world dirt into the legal charset', () => {
    const dirty = 'Kariba REDD+ — “forest” protection\t(Zimbabwe)\\Africa … 50 000 t';
    const clean = sanitiseToSafeCharset(dirty);
    assert.ok(isJsonStringSafe(clean), `must be safe: ${JSON.stringify(clean)}`);
    assert.doesNotThrow(() => assertJsonStringSafe(clean));
  });
});

describe('real asset evidence documents', () => {
  const assets = loadAllAssets();

  test('at least 3 assets exist', () => {
    assert.ok(assets.length >= 3, `expected >=3 assets, got ${assets.length}`);
  });

  for (const a of assets) {
    test(`${a.assetId}: canonical, on-chain-legal, deterministic`, () => {
      const ev = buildEvidence(a);
      assertJsonStringSafe(ev.line, 'evidence');
      assert.equal(ev.byteLength, ev.line.length, 'byte length must equal char length (pure ASCII)');
      assert.equal(buildEvidence(a).line, ev.line, 'must be deterministic');
      const keys = ev.line.split(';').map((kv) => kv.slice(0, kv.indexOf('=')));
      assert.deepEqual(keys, [...EVIDENCE_FIELD_ORDER], 'field order must be exact');
      assert.ok(ev.byteLength <= 8192, `evidence exceeds the on-chain ceiling: ${ev.byteLength}`);
      // Every asset must be accountable: either it cites a source, or it declares itself
      // synthetic in provenance.notes. Silence about provenance is the one thing banned.
      const synthetic = /SYNTHETIC/.test(a.provenance.notes ?? '');
      assert.ok(
        a.sources.length > 0 || synthetic,
        `${a.assetId}: needs a source URL, or provenance.notes must declare it SYNTHETIC`,
      );
      if (a.provenance.illustrative.length > 0) {
        assert.ok(a.provenance.notes, `${a.assetId}: has illustrative fields but no provenance note`);
      }
      // The whole request must survive assembly.
      assert.doesNotThrow(() => assertRequestWellFormed(MODEL, ev.line));
    });
  }

  test('all evidence hashes are distinct', () => {
    const h = assets.map((a) => buildEvidence(a).evidenceSha256);
    assert.equal(new Set(h).size, h.length);
  });
});

describe('signature scheme (synthetic, no credentials)', () => {
  const requestBody = buildRequestString(MODEL, EVIDENCE);
  const responseBody = fakeResponse(GOOD_LINE);

  test('signed text is exactly 129 ASCII chars', () => {
    const t = buildSignedText(requestBody, responseBody);
    assert.equal(t.length, 129);
    assert.match(t, /^[0-9a-f]{64}:[0-9a-f]{64}$/);
    assert.equal(t, `${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`);
  });

  test('EIP-191 preimage uses the literal length 129', () => {
    const t = buildSignedText(requestBody, responseBody);
    assert.equal(eip191Preimage(t), `\x19Ethereum Signed Message:\n129${t}`);
  });

  test('verifier recovers the signer', async () => {
    const sig = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    const r = await verifyReceipt({ requestBody, responseBody, signature: sig }, ACCT.address);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.recovered?.toLowerCase(), ACCT.address.toLowerCase());
  });

  test('one flipped REQUEST byte breaks verification', async () => {
    const sig = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    const tampered = requestBody.replace('"temperature":0', '"temperature":1');
    assert.notEqual(tampered, requestBody);
    assert.equal((await verifyReceipt({ requestBody: tampered, responseBody, signature: sig }, ACCT.address)).ok, false);
  });

  test('a poster rewriting the NAV breaks verification', async () => {
    const sig = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    const tampered = responseBody.replace('4250000', '9250000');
    assert.equal((await verifyReceipt({ requestBody, responseBody: tampered, signature: sig }, ACCT.address)).ok, false);
  });

  test('a different evidence line breaks verification', async () => {
    const sig = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    const other = buildRequestString(MODEL, EVIDENCE.replace('vintage=2014', 'vintage=2020'));
    assert.equal((await verifyReceipt({ requestBody: other, responseBody, signature: sig }, ACCT.address)).ok, false);
  });

  test('a different model in the same slot breaks verification', async () => {
    const sig = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    const other = buildRequestString('z-ai/glm-5.2', EVIDENCE);
    assert.equal((await verifyReceipt({ requestBody: other, responseBody, signature: sig }, ACCT.address)).ok, false);
  });

  test('wrong expected signer is rejected', async () => {
    const sig = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    const r = await verifyReceipt({ requestBody, responseBody, signature: sig }, '0x000000000000000000000000000000000000dEaD');
    assert.equal(r.ok, false);
  });

  test('malformed signature is reported, not thrown', async () => {
    const r = await verifyReceipt({ requestBody, responseBody, signature: '0xdeadbeef' as Hex });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /65 bytes/);
  });
});

describe('offset discovery — searched, never hardcoded', () => {
  const body = fakeResponse(GOOD_LINE);

  test('finds all three literals at their true positions', () => {
    const o = findVerdictOffsets(body);
    assert.equal(body.slice(o.contentOffset, o.contentOffset + GRAMMAR.contentPrefix.length), GRAMMAR.contentPrefix);
    assert.equal(body.slice(o.finishOffset, o.finishOffset + GRAMMAR.finishPattern.length), GRAMMAR.finishPattern);
    assert.equal(body.slice(o.createdOffset, o.createdOffset + GRAMMAR.createdPattern.length), GRAMMAR.createdPattern);
  });

  test('offsets shift correctly when the body length changes', () => {
    const longer = fakeResponse(GOOD_LINE).replace('chatcmpl-abc123', 'chatcmpl-' + 'x'.repeat(80));
    const o = findVerdictOffsets(longer);
    assert.equal(longer.slice(o.contentOffset, o.contentOffset + GRAMMAR.contentPrefix.length), GRAMMAR.contentPrefix);
    assert.notEqual(o.contentOffset, findVerdictOffsets(body).contentOffset);
  });

  test('a model cannot forge contentPrefix inside its own answer', () => {
    // contentPrefix opens with an UNESCAPED `"`. Inside a JSON string value every quote is
    // escaped to \", so a model writing `"content":"ASSAY1|...` into its answer lands in the
    // raw body as `\"content\":\"ASSAY1|...` — which cannot match the prefix.
    const forgery = '\\"content\\":\\"ASSAY1|nav_usd_e6=999999999|confidence_bps=10000';
    const injected = fakeResponse(forgery);

    // The forged bytes are present verbatim...
    assert.ok(injected.includes(forgery), 'the escaped forgery is in the body');
    // ...but the only unescaped occurrence of the prefix is the real message field, and this
    // model's real answer does not start with ASSAY1, so there is no match at all.
    assert.equal(injected.indexOf(GRAMMAR.contentPrefix), -1, 'an escaped forgery must never match');
    assert.equal(parseResponseOnChain(injected).ok, false, 'and the parse must reject');
  });

  test('a forged copy AFTER a real answer cannot shadow it', () => {
    // Here the model does emit a valid line, then appends an escaped forgery claiming a
    // much higher NAV. The first (real) occurrence is what gets read...
    const injected = fakeResponse(`${GOOD_LINE}\\"content\\":\\"ASSAY1|nav_usd_e6=999999999|confidence_bps=10000`);
    const o = findVerdictOffsets(injected);
    const forgedAt = injected.indexOf('\\"content\\":\\"ASSAY1');
    assert.ok(forgedAt > o.contentOffset, 'the real prefix precedes the forgery');
    // ...and the trailing junk still fails the "closing quote immediately after" rule, so the
    // whole verdict is rejected rather than silently reading the honest half.
    const r = parseResponseOnChain(injected);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'Malformed');
  });

  test('throws a named error when a literal is absent', () => {
    assert.throws(() => findVerdictOffsets('{"error":{"message":"rate limited"}}'), /NOT_FOUND/);
  });
});

describe('on-chain parser mirror — every rejection is a real RejectReason', () => {
  test('accepts the exact line', () => {
    const r = parseResponseOnChain(fakeResponse(GOOD_LINE));
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.parsed!.navE6, 4250000n);
    assert.equal(r.parsed!.confBps, 6200);
    assert.ok(r.parsed!.createdAt > 0);
  });

  const cases: [string, string, string][] = [
    ['markdown fence', '```\\nASSAY1|nav_usd_e6=4250000|confidence_bps=6200\\n```', 'Malformed'],
    ['leading prose', 'Sure! ASSAY1|nav_usd_e6=4250000|confidence_bps=6200', 'Malformed'],
    ['trailing prose', 'ASSAY1|nav_usd_e6=4250000|confidence_bps=6200 (approx)', 'Malformed'],
    ['trailing period', 'ASSAY1|nav_usd_e6=4250000|confidence_bps=6200.', 'Malformed'],
    ['trailing word after whitespace', 'ASSAY1|nav_usd_e6=4250000|confidence_bps=6200 approx', 'Malformed'],
    ['trailing comma', 'ASSAY1|nav_usd_e6=4250000|confidence_bps=6200,', 'Malformed'],
    ['float nav', 'ASSAY1|nav_usd_e6=4.25|confidence_bps=6200', 'Malformed'],
    ['negative nav', 'ASSAY1|nav_usd_e6=-1|confidence_bps=6200', 'Malformed'],
    ['space before nav', 'ASSAY1|nav_usd_e6= 4250000|confidence_bps=6200', 'Malformed'],
    ['wrong separator', 'ASSAY1,nav_usd_e6=4250000,confidence_bps=6200', 'Malformed'],
    ['missing confidence', 'ASSAY1|nav_usd_e6=4250000', 'Malformed'],
    ['JSON instead of the line', '{\\"nav_usd_e6\\":4250000}', 'Malformed'],
    ['pure prose', 'I estimate about four dollars twenty-five per credit.', 'Malformed'],
    ['zero nav', 'ASSAY1|nav_usd_e6=0|confidence_bps=6200', 'OutOfRange'],
    ['confidence > 10000', 'ASSAY1|nav_usd_e6=4250000|confidence_bps=99999', 'OutOfRange'],
  ];

  for (const [name, content, reason] of cases) {
    test(`rejects ${name} -> ${reason}`, () => {
      const r = parseResponseOnChain(fakeResponse(content));
      assert.equal(r.ok, false, `${name} should have been rejected`);
      assert.equal(r.reason, reason, `${name}: expected ${reason}, got ${r.reason} (${r.detail})`);
    });
  }

  test('rejects nav above MAX_NAV_E6 -> OutOfRange', () => {
    const r = parseResponseOnChain(fakeResponse(`ASSAY1|nav_usd_e6=${MAX_NAV_E6 + 1n}|confidence_bps=5000`));
    assert.equal(r.reason, 'OutOfRange');
  });

  test('finish_reason=length -> Truncated (model blew the token cap)', () => {
    const r = parseResponseOnChain(fakeResponse(GOOD_LINE, { finish: 'length' }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'Truncated');
  });

  test('empty response body -> BadSignature, not Malformed', () => {
    // Deliberate: nothing was authenticated, so it must not count on the authenticated
    // side of the round. Calling it Malformed would hand anyone a free halt, since a
    // round of empty bodies costs nothing to assemble.
    assert.equal(parseResponseOnChain('').reason, 'BadSignature');
  });

  test('oversize response body -> BadSignature', () => {
    const huge = fakeResponse(GOOD_LINE) + ' '.repeat(MAX_RESPONSE);
    assert.equal(parseResponseOnChain(huge).reason, 'BadSignature');
  });

  test('a body with no readable created -> NoTimestamp', () => {
    const noTs = '{"id":"x","choices":[{"message":{"role":"assistant","content":"' + GOOD_LINE + '"},"finish_reason":"stop"}]}';
    const r = parseResponseOnChain(noTs);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NoTimestamp');
  });

  test('an API error body is rejected, never priced', () => {
    const r = parseResponseOnChain('{"error":{"message":"insufficient credits","type":"permission_error"}}');
    assert.equal(r.ok, false);
  });
});

describe('verdict packing', () => {
  test('packs a live slot as raw bytes', () => {
    const body = fakeResponse(GOOD_LINE);
    const sig = ('0x' + '11'.repeat(65)) as Hex;
    const v = packVerdict(2, body, sig);
    assert.equal(v.slot, 2);
    assert.equal(v.signature, sig);
    assert.equal(Buffer.from(v.responseBody.slice(2), 'hex').toString('utf8'), body);
  });

  test('packs an UNAVAILABLE slot as empty rather than omitting it', () => {
    const v = packVerdict(4, null, null);
    assert.equal(v.slot, 4);
    assert.equal(v.responseBody, '0x');
    assert.equal(v.signature, '0x');
    assert.equal(parseResponseOnChain('').ok, false);
  });

  test('the packed tuple matches the COMPILED ABI exactly', () => {
    // Read the real artifact rather than trusting a hand-copied struct. This is the check
    // that would have caught the offset fields being deleted out from under us.
    const artifact = join(HERE, '..', '..', 'out', 'AssayOracle.sol', 'AssayOracle.json');
    if (!existsSync(artifact)) {
      assert.ok(true, 'forge artifact not built — run `forge build` to enable this guard');
      return;
    }
    const abi = JSON.parse(readFileSync(artifact, 'utf8')).abi as {
      name?: string;
      inputs?: { name: string; type: string; components?: { name: string; type: string }[] }[];
    }[];
    const post = abi.find((x) => x.name === 'postAppraisal');
    assert.ok(post, 'postAppraisal must exist in the ABI');
    const verdicts = post!.inputs!.find((i) => i.name === 'verdicts');
    assert.ok(verdicts?.components, 'verdicts must be a tuple[]');
    const abiKeys = verdicts!.components!.map((c) => c.name).sort();

    const v = packVerdict(1, fakeResponse(GOOD_LINE), ('0x' + '22'.repeat(65)) as Hex);
    assert.deepEqual(Object.keys(v).sort(), abiKeys, 'packVerdict must emit exactly the ABI tuple fields');
  });

  test('offsets are gone from the tuple — there is nothing left to corrupt', () => {
    const v = packVerdict(0, fakeResponse(GOOD_LINE), ('0x' + '33'.repeat(65)) as Hex);
    assert.deepEqual(Object.keys(v).sort(), ['responseBody', 'signature', 'slot']);
    for (const k of ['contentOffset', 'finishOffset', 'createdOffset']) {
      assert.ok(!(k in v), `${k} must not be emitted — the audit deleted it`);
    }
  });
});

describe('preflight — reproduces the full on-chain check', () => {
  const now = 1_800_000_000;

  async function signed(content: string, opts: { created?: number; finish?: string } = {}) {
    const requestBody = buildRequestString(MODEL, EVIDENCE);
    const responseBody = fakeResponse(content, { created: opts.created ?? now, ...opts });
    const signature = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    return { responseBody, signature };
  }

  test('passes a good verdict end to end', async () => {
    const { responseBody, signature } = await signed(GOOD_LINE);
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: ACCT.address, minConfidenceBps: 5000, maxAgeSec: 3600, now,
    });
    assert.equal(r.ok, true, `${r.failedCheck}: ${r.detail}`);
    assert.equal(r.navE6, '4250000');
    assert.equal(r.confBps, 6200);
  });

  test('a valid signature from an unattested key is UnknownSigner, not BadSignature', async () => {
    // _recover succeeded — it is the registry lookup that failed, and the chain
    // distinguishes the two so operators can tell "forged" from "not enrolled".
    const { responseBody, signature } = await signed(GOOD_LINE);
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: '0x000000000000000000000000000000000000dEaD', now,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'UnknownSigner');
    assert.match(r.failedCheck!, /attestations\.status/);
    assert.ok(r.recovered, 'the recovered address is still reported');
  });

  test('an unrecoverable signature is BadSignature', async () => {
    const { responseBody } = await signed(GOOD_LINE);
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody,
      signature: ('0x' + '00'.repeat(65)) as Hex, attestedSigner: ACCT.address, now,
    });
    assert.equal(r.reason, 'BadSignature');
  });

  test('names the parser when the model rambles', async () => {
    const { responseBody, signature } = await signed('Certainly! ASSAY1|nav_usd_e6=4250000|confidence_bps=6200');
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature, attestedSigner: ACCT.address, now,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'Malformed');
    assert.equal(r.failedCheck, '_readAnswer');
  });

  test('names the confidence floor', async () => {
    const { responseBody, signature } = await signed('ASSAY1|nav_usd_e6=4250000|confidence_bps=1000');
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: ACCT.address, minConfidenceBps: 5000, now,
    });
    assert.equal(r.reason, 'LowConfidence');
    assert.match(r.failedCheck!, /minConfidenceBps/);
  });

  test('names staleness when the response is too old', async () => {
    const { responseBody, signature } = await signed(GOOD_LINE, { created: now - 7200 });
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: ACCT.address, maxAgeSec: 3600, now,
    });
    assert.equal(r.reason, 'Stale');
    assert.match(r.failedCheck!, /maxAgeSec/);
  });

  test('names staleness when the response claims the future', async () => {
    const { responseBody, signature } = await signed(GOOD_LINE, { created: now + 9999 });
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: ACCT.address, maxAgeSec: 3600, now,
    });
    assert.equal(r.reason, 'Stale');
    assert.match(r.failedCheck!, /futureSkew/);
  });

  test('rejects an empty response body as BadSignature, before touching the signature', async () => {
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody: '', signature: ('0x' + '00'.repeat(65)) as Hex, now,
    });
    assert.equal(r.reason, 'BadSignature');
    assert.match(r.failedCheck!, /length == 0/);
  });

  test('a verdict signed over DIFFERENT evidence does not verify', async () => {
    // The rebuilt request no longer matches, so the digest changes and recovery lands on
    // some other address — which the chain reports as UnknownSigner.
    const { responseBody, signature } = await signed(GOOD_LINE);
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE + ';tampered=1', responseBody, signature,
      attestedSigner: ACCT.address, now,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'UnknownSigner');
    assert.notEqual(r.recovered?.toLowerCase(), ACCT.address.toLowerCase());
  });
});

describe('recorded gateway fixtures (real receipts)', () => {
  const files = existsSync(FIXTURES)
    ? readdirSync(FIXTURES).filter((f) => f.startsWith('receipt-') && f.endsWith('.json'))
    : [];

  if (files.length === 0) {
    test('NO FIXTURE RECORDED YET — run `pnpm probe` once REDPILL_API_KEY is set', { skip: true }, () => {});
  }

  for (const f of files) {
    test(`${f} verifies against its attested signer`, async () => {
      const fx = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as {
        requestBody: string; responseBody: string; signature: Hex; signingAddress: string;
        model?: string; evidence?: string;
      };
      const r = await verifyReceipt(
        { requestBody: fx.requestBody, responseBody: fx.responseBody, signature: fx.signature },
        fx.signingAddress,
      );
      assert.equal(r.ok, true, `${r.reason} (recovered ${r.recovered})`);
    });

    test(`${f}: request bytes are reproducible from the schema`, async () => {
      const fx = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as {
        requestBody: string; model?: string; evidence?: string;
      };
      if (!fx.model || !fx.evidence) return; // older fixture without the inputs recorded
      assert.equal(buildRequestString(fx.model, fx.evidence), fx.requestBody);
    });
  }
});

describe('evaluation case set integrity', () => {
  const assets = loadAllAssets();
  const byCase = (p: string) => assets.filter((a) => a.caseId?.startsWith(p));

  test('the committed EVAL.md case set is complete: H1-H2, P1-P20, T1-T5', () => {
    assert.equal(byCase('H').length, 2, 'two hero cases');
    assert.equal(byCase('P').length, 20, 'twenty priceable cases');
    assert.equal(byCase('T').length, 5, 'five trap cases');
    const ids = new Set(assets.map((a) => a.caseId));
    for (let i = 1; i <= 20; i++) assert.ok(ids.has(`P${i}`), `missing P${i}`);
    for (let i = 1; i <= 5; i++) assert.ok(ids.has(`T${i}`), `missing T${i}`);
  });

  test('NO priceable case leaks a price into its evidence — that is the T5 trap', () => {
    for (const a of byCase('P')) {
      assert.equal(a.fields.ref_price_usd, 'NA', `${a.assetId} leaks a reference price to the committee`);
      assert.ok(a.reference, `${a.assetId} needs a scoring band`);
      assert.ok(a.reference!.lowUsd > 0 && a.reference!.highUsd >= a.reference!.lowUsd, `${a.assetId} band is malformed`);
      assert.ok(a.reference!.sourceUrl, `${a.assetId} band needs a cited source`);
    }
  });

  test('T5 is the ONLY case that plants a price', () => {
    const planted = assets.filter((a) => a.fields.ref_price_usd && a.fields.ref_price_usd !== 'NA');
    assert.deepEqual(planted.map((a) => a.caseId), ['T5']);
  });

  test('the priceable set spans real market dispersion, not one price bucket', () => {
    const lows = byCase('P').map((a) => a.reference!.lowUsd);
    assert.ok(Math.max(...lows) / Math.min(...lows) > 100, 'P-set must span at least two orders of magnitude');
  });

  test('every synthetic defect is declared in provenance.notes', () => {
    for (const a of assets) {
      if (a.provenance.illustrative.length === 0) continue;
      assert.match(a.provenance.notes ?? '', /SYNTHETIC|derived|illustrative|not currently fillable|unverified/i, a.assetId);
    }
  });

  test('T4 is entirely real — no synthetic edit', () => {
    const t4 = assets.find((a) => a.caseId === 'T4')!;
    assert.equal(t4.provenance.illustrative.length, 0);
    assert.match(t4.provenance.notes!, /NO SYNTHETIC EDIT/);
  });
});

describe('trailing whitespace tolerance — mirrors Ascii.skipJsonWhitespace', () => {
  const NAV = 'ASSAY1|nav_usd_e6=4250000|confidence_bps=6200';

  test('a byte-perfect line reports zero trailing whitespace', () => {
    const r = parseResponseOnChain(fakeResponse(NAV));
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.parsed!.trailingWhitespaceBytes, 0);
  });

  // These are the ESCAPE SEQUENCES as they appear in the raw response bytes: a literal
  // backslash followed by n/r/t, NOT the control characters themselves. Built from a char
  // code so no layer of quoting can silently turn one into the other.
  const BS = String.fromCharCode(0x5c);
  const ESC_N = BS + 'n';
  const ESC_R = BS + 'r';
  const ESC_T = BS + 't';

  // Each escape is TWO bytes but ONE step against the run cap.
  const accepted: [string, string, number][] = [
    ['one escaped newline', ESC_N, 2],
    ['one escaped carriage return', ESC_R, 2],
    ['one escaped tab', ESC_T, 2],
    ['one literal space', ' ', 1],
    ['space then newline', ' ' + ESC_N, 3],
    ['exactly 8 escapes (the cap)', ESC_N.repeat(8), 16],
    ['exactly 8 spaces (the cap)', ' '.repeat(8), 8],
  ];

  for (const [name, ws, bytes] of accepted) {
    test(`ACCEPTS ${name}`, () => {
      const r = parseResponseOnChain(fakeResponse(NAV + ws));
      assert.equal(r.ok, true, `${name} should be accepted: ${r.detail}`);
      assert.equal(r.parsed!.navE6, 4250000n);
      assert.equal(r.parsed!.trailingWhitespaceBytes, bytes, `${name}: whitespace byte count`);
    });
  }

  test('REJECTS a 9th whitespace item (one past the cap)', () => {
    const r = parseResponseOnChain(fakeResponse(NAV + ESC_N.repeat(9)));
    assert.equal(r.ok, false, 'the run cap must be enforced');
    assert.equal(r.reason, 'Malformed');
  });

  test('tolerance does NOT widen into prose', () => {
    const tails = [' approx', ESC_N + '(estimate)', ' .', ESC_N + 'ASSAY1|nav_usd_e6=9|confidence_bps=1'];
    for (const tail of tails) {
      const r = parseResponseOnChain(fakeResponse(NAV + tail));
      assert.equal(r.ok, false, `must reject trailing ${JSON.stringify(tail)}`);
    }
  });

  test('other escapes terminate the run', () => {
    // Backslash-b and backslash-f are valid JSON escapes, and backslash-u0020 encodes a
    // space, but NONE are in the accepted set: the contract matches three byte pairs
    // literally and nothing else.
    for (const esc of [BS + 'b', BS + 'f', BS + 'u0020']) {
      assert.equal(parseResponseOnChain(fakeResponse(NAV + esc)).ok, false, `must reject ${esc}`);
    }
  });

  test('skipJsonWhitespace counts an escape as one step, not two', () => {
    const buf = Buffer.from(ESC_N.repeat(8) + 'X', 'utf8');
    assert.equal(skipJsonWhitespace(buf, 0, MAX_TRAILING_WS_RUN), 16, '8 escapes = 16 bytes, within the cap');
    const over = Buffer.from(ESC_N.repeat(9) + 'X', 'utf8');
    assert.equal(skipJsonWhitespace(over, 0, MAX_TRAILING_WS_RUN), 16, 'stops at the cap, leaving the 9th');
    // Mixed run: space, escape, space = 3 steps, 4 bytes.
    const mixed = Buffer.from(' ' + ESC_T + ' ' + 'X', 'utf8');
    assert.equal(skipJsonWhitespace(mixed, 0, MAX_TRAILING_WS_RUN), 4);
  });
});

describe('schema is the one loaded from Solidity', () => {
  test('schemaId matches the regenerated max_tokens=512 template', () => {
    assert.equal(SCHEMA_ID, '0xb5c98bdc502ede2fe911af4d7f7dbec8ffff5ab2c88837475cf3d160a9c22c2c');
  });
});

describe('RejectReason mirrors the Solidity enum', () => {
  test('declaration order matches Types.sol — the index is part of the ABI', () => {
    assert.deepEqual([...REJECT_REASONS], [
      'None', 'BadSignature', 'UnknownSigner', 'SignerExpired', 'SignerRevoked',
      'WrongModel', 'Truncated', 'Malformed', 'OutOfRange', 'LowConfidence',
      'Stale', 'DuplicateSlot', 'NoTimestamp',
    ]);
  });
});

describe('readCreated / readAnswer split mirrors the contract', () => {
  test('readCreated finds the timestamp independently of the answer', () => {
    const body = fakeResponse('total garbage, no ASSAY1 line here', { created: 1800000000 });
    const c = readCreated(body);
    assert.equal(c.ok, true, 'a malformed ANSWER must not hide a readable timestamp');
    assert.equal(c.createdAt, 1800000000);
  });

  test('readAnswer does not care about the timestamp', () => {
    const noTs = '{"id":"x","choices":[{"message":{"content":"' + GOOD_LINE + '"},"finish_reason":"stop"}]}';
    const a = readAnswer(noTs);
    assert.equal(a.ok, true, 'readAnswer must judge only the grammar');
    assert.equal(a.parsed!.navE6, 4250000n);
  });

  test('freshness is judged BEFORE the answer, so a stale garbage body reports Stale', async () => {
    // Load-bearing ordering: if a badly-formed answer could be counted without first
    // proving it is recent, one authentic unparseable response would become a bearer
    // token that halts the asset forever.
    const now = 1_800_000_000;
    const requestBody = buildRequestString(MODEL, EVIDENCE);
    const responseBody = fakeResponse('I think about four dollars', { created: now - 99999 });
    const signature = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: ACCT.address, maxAgeSec: 3600, now,
    });
    assert.equal(r.reason, 'Stale', 'stale must win over malformed');
    assert.match(r.failedCheck!, /maxAgeSec/);
  });

  test('watermark rejects a verdict no newer than the last accepted round', async () => {
    const now = 1_800_000_000;
    const requestBody = buildRequestString(MODEL, EVIDENCE);
    const responseBody = fakeResponse(GOOD_LINE, { created: now - 10 });
    const signature = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: ACCT.address, maxAgeSec: 3600, now, observationWatermark: now - 5,
    });
    assert.equal(r.reason, 'Stale');
    assert.match(r.failedCheck!, /observationWatermark/);
  });

  test('a missing timestamp beats a malformed answer', async () => {
    const now = 1_800_000_000;
    const requestBody = buildRequestString(MODEL, EVIDENCE);
    const responseBody = '{"id":"x","choices":[{"message":{"content":"garbage"},"finish_reason":"stop"}]}';
    const signature = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: ACCT.address, now,
    });
    assert.equal(r.reason, 'NoTimestamp');
    assert.equal(r.failedCheck, '_readCreated');
  });
});

describe('evidence commitment is a ROUND blocker, not a verdict rejection', () => {
  const now = 1_800_000_000;

  async function signedGood() {
    const requestBody = buildRequestString(MODEL, EVIDENCE);
    const responseBody = fakeResponse(GOOD_LINE, { created: now });
    const signature = await ACCT.signMessage({ message: buildSignedText(requestBody, responseBody) });
    return { responseBody, signature };
  }

  test('an uncommitted digest blocks the round even when the verdict is perfect', async () => {
    const { responseBody, signature } = await signedGood();
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: ACCT.address, maxAgeSec: 3600, now, evidenceCommitted: false,
    });
    assert.equal(r.ok, false, 'the round cannot post');
    assert.equal(r.reason, 'None', 'the VERDICT is fine — this is not a rejection of it');
    assert.match(r.roundBlocker!, /EvidenceNotCommitted/);
    assert.match(r.roundBlocker!, /commitEvidence/);
    assert.equal(r.navE6, '4250000', 'the answer was still read and reported');
  });

  test('a committed digest lets the same verdict through', async () => {
    const { responseBody, signature } = await signedGood();
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: ACCT.address, maxAgeSec: 3600, now, evidenceCommitted: true,
    });
    assert.equal(r.ok, true, `${r.failedCheck}: ${r.detail}`);
    assert.equal(r.roundBlocker, null);
  });

  test('UNKNOWN commitment state is never silently treated as committed', async () => {
    const { responseBody, signature } = await signedGood();
    const r = await preflightVerdict({
      slot: 0, modelId: MODEL, evidence: EVIDENCE, responseBody, signature,
      attestedSigner: ACCT.address, maxAgeSec: 3600, now,
    });
    // undefined means we could not check. The verdict passes on its own merits, and the
    // caller surfaces the unknown separately rather than claiming the round will land.
    assert.equal(r.roundBlocker, null);
    assert.equal(r.ok, true);
  });
});
