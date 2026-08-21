// Regenerates test/fixtures/bundle.json.
//
// The fixture is a whole committee round signed by throwaway keys: three seats that agree,
// plus the failure modes the contract has to reject. Keys and bodies are committed so the
// tests are deterministic and anyone can re-derive them.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { buildRequestBytes, findOffsetsOrZero, signedText } from '../src/verify.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// The schema fragments come from Solidity's own export, never retyped by hand.
const SCHEMA = JSON.parse(
  readFileSync(process.env.ASSAY_SCHEMA_PATH ?? join(HERE, '..', '..', 'schema.appraisal.v1.json'), 'utf8'),
);

const EVIDENCE =
  'registry=Verra;project=VCS-1234;vintage=2023;methodology=VM0007;quantity=1 tCO2e;retired=false;last_trade_usd=4.21;observed=2026-08-20T22:00:00Z';

const CREATED = 1_787_000_000;
const NOW = CREATED + 300;

const COMMITTEE = [
  'deepseek/deepseek-v4-flash-0731',
  'openai/gpt-oss-20b',
  'meta-llama/llama-3.3-70b-instruct',
  'phala/qwen-2.5-7b-instruct',
  'deepseek/deepseek-chat-v3-0324',
];

/** One private key per seat, so distinct-signer counting is exercised honestly. */
const KEYS = [
  '0x1111111111111111111111111111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333333333333333333333333333',
  '0x4444444444444444444444444444444444444444444444444444444444444444',
  '0x5555555555555555555555555555555555555555555555555555555555555555',
];

function completion(model, content, { finishReason = 'stop', created = CREATED } = {}) {
  return (
    `{"id":"chatcmpl-assay-${model.replace(/[^a-z0-9]/gi, '')}","object":"chat.completion","created":${created},` +
    `"model":"${model}","choices":[{"index":0,"message":{"role":"assistant","content":"${content}"},` +
    `"finish_reason":"${finishReason}"}],"usage":{"prompt_tokens":412,"completion_tokens":21,"total_tokens":433}}`
  );
}

const BODIES = [
  // Three seats that agree inside a 10% band, which is exactly quorum.
  completion(COMMITTEE[0], 'ASSAY1|nav_usd_e6=4210000|confidence_bps=8200'),
  completion(COMMITTEE[1], 'ASSAY1|nav_usd_e6=4180000|confidence_bps=7600'),
  completion(COMMITTEE[2], 'ASSAY1|nav_usd_e6=4250000|confidence_bps=7100'),
  // Prose after the number: the contract's strictest rejection.
  completion(COMMITTEE[3], 'ASSAY1|nav_usd_e6=4200000|confidence_bps=6900 (based on recent trades)'),
  // Hit the token cap mid-answer.
  completion(COMMITTEE[4], 'ASSAY1|nav_usd_e6=4190000|confidence_bps=7400', { finishReason: 'length' }),
];

const encoder = new TextEncoder();
const members = [];

for (let slot = 0; slot < COMMITTEE.length; slot++) {
  const account = privateKeyToAccount(KEYS[slot]);
  const modelId = COMMITTEE[slot];
  const responseBody = BODIES[slot];
  const responseBytes = encoder.encode(responseBody);
  const requestBytes = buildRequestBytes(SCHEMA.head, modelId, SCHEMA.mid, EVIDENCE, SCHEMA.tail);
  const signature = await account.signMessage({ message: signedText(requestBytes, responseBytes) });

  members.push({
    slot,
    modelId,
    signer: account.address,
    privateKey: KEYS[slot],
    responseBody,
    signature,
    offsets: findOffsetsOrZero(responseBytes),
  });
}

// One extra entry signed by the wrong key, to exercise BadSignature end to end.
{
  const modelId = COMMITTEE[0];
  const responseBody = completion(modelId, 'ASSAY1|nav_usd_e6=4210000|confidence_bps=8200');
  const responseBytes = encoder.encode(responseBody);
  const requestBytes = buildRequestBytes(SCHEMA.head, modelId, SCHEMA.mid, 'different evidence', SCHEMA.tail);
  const wrong = privateKeyToAccount(KEYS[1]);
  members.push({
    slot: 0,
    modelId,
    signer: wrong.address,
    privateKey: KEYS[1],
    responseBody,
    signature: await wrong.signMessage({ message: signedText(requestBytes, responseBytes) }),
    offsets: findOffsetsOrZero(responseBytes),
    note: 'signed over evidence the round did not use; must recover to an unexpected address',
  });
}

const fixture = {
  schema: SCHEMA,
  evidence: EVIDENCE,
  createdAt: CREATED,
  now: NOW,
  committee: COMMITTEE,
  policy: {
    quorum: 3,
    minDistinctSigners: 2,
    bandBps: 1000,
    minConfidenceBps: 5000,
    maxAgeSec: 3600,
  },
  members,
};

const path = join(HERE, '..', 'test', 'fixtures', 'bundle.json');
writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${path} with ${members.length} members`);
