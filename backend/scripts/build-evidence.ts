/**
 * build-evidence.ts — canonicalise every asset and emit data/evidence.json.
 *
 * This is the contract author's reference artefact: for each asset, the exact evidence
 * bytes (and their calldata hex), plus the fully assembled request body per committee slot
 * and its sha256. If `AssetRegistry.buildRequest(assetId, slot, evidence)` produces these
 * strings, the signatures will verify.
 *
 *   node --experimental-strip-types scripts/build-evidence.ts
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEvidence, loadAllAssets, evidenceHex } from '../src/evidence.ts';
import {
  buildRequestString, sha256Hex, assertJsonStringSafe, assertRequestWellFormed,
  SCHEMA, SCHEMA_ID, HEAD_TEXT, MID_TEXT, TAIL_TEXT, GRAMMAR, VERDICT_SHAPE,
} from '../src/canonical.ts';
import { SYSTEM_PROMPT, USER_PREAMBLE, PROMPT_VERSION } from '../src/prompt.ts';
import { committeeSlots } from '../src/appraise.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');

function main() {
  const assets = loadAllAssets();
  const slots = committeeSlots();

  const out = {
    generatedAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    schemaId: SCHEMA_ID,
    schema: {
      construction: 'requestBody = head || utf8(modelId) || mid || evidence || tail',
      hex: { head: SCHEMA.head, mid: SCHEMA.mid, tail: SCHEMA.tail },
      text: { head: HEAD_TEXT, mid: MID_TEXT, tail: TAIL_TEXT },
    },
    prompt: { system: SYSTEM_PROMPT, userPreamble: USER_PREAMBLE, systemSha256: sha256Hex(SYSTEM_PROMPT) },
    responseGrammar: { ...GRAMMAR, verdictShape: VERDICT_SHAPE },
    committeeSlots: slots.map((model, slot) => ({ slot, model })),
    assets: assets.map((a) => {
      const ev = buildEvidence(a);
      assertJsonStringSafe(ev.line, 'evidence');
      return {
        assetId: a.assetId,
        evidenceLine: ev.line,
        evidenceHex: evidenceHex(ev),
        evidenceSha256: ev.evidenceSha256,
        evidenceBytes: ev.byteLength,
        sources: a.sources,
        provenance: a.provenance,
        requestsPerSlot: slots.map((model, slot) => {
          assertRequestWellFormed(model, ev.line);
          const body = buildRequestString(model, ev.line);
          return { slot, model, requestBody: body, requestSha256: sha256Hex(body), requestBytes: Buffer.byteLength(body) };
        }),
      };
    }),
  };

  writeFileSync(join(DATA, 'evidence.json'), JSON.stringify(out, null, 2) + '\n');

  console.log(`schemaId: ${SCHEMA_ID}`);
  console.log(`prompt:   ${Buffer.byteLength(SYSTEM_PROMPT)} bytes  sha256=${out.prompt.systemSha256}`);
  console.log('');
  for (const a of out.assets) {
    console.log(a.assetId);
    console.log(`  evidence ${String(a.evidenceBytes).padStart(4)} bytes  sha256=${a.evidenceSha256}`);
    console.log(`  request  ${String(a.requestsPerSlot[0]!.requestBytes).padStart(4)} bytes  sha256=${a.requestsPerSlot[0]!.requestSha256}  (slot 0: ${a.requestsPerSlot[0]!.model})`);
    console.log(`  sources  ${a.sources.length}`);
  }
  console.log(`\nwrote ${join(DATA, 'evidence.json')}`);
}

main();
