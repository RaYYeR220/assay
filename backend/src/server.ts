/**
 * server.ts — the Assay appraisal API.
 *
 * Every read endpoint works with ZERO credentials (it replays persisted bundles and
 * re-verifies their signatures locally). Only POST /appraise needs REDPILL_API_KEY, and it
 * degrades to a clear 503 rather than a mystery when the key is absent.
 *
 *   node --experimental-strip-types src/server.ts
 */

import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appraise,
  loadCommittee,
  listBundles,
  loadBundle,
  reverifyBundle,
  committeeSlots,
  committeeDrift,
  type AppraisalBundle,
} from './appraise.ts';
import { buildEvidence, loadAllAssets, loadAsset, listAssets, evidenceHex } from './evidence.ts';
import { assetIdHex } from './appraise.ts';
import {
  buildRequestString, sha256Hex, verifyReceipt, VERDICT_SHAPE, GRAMMAR,
  SCHEMA, SCHEMA_ID, HEAD_TEXT, MID_TEXT, TAIL_TEXT, findVerdictOffsets, parseResponseOnChain,
} from './canonical.ts';
import { SYSTEM_PROMPT, USER_PREAMBLE, PROMPT_VERSION } from './prompt.ts';
import { getAttestation } from './redpill.ts';
import { precheckRound, commitEvidenceCall, chainConfigured } from './chain.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const PORT = Number(process.env.PORT ?? 8787);

function apiKey(): string | null {
  if (process.env.REDPILL_API_KEY) return process.env.REDPILL_API_KEY;
  for (const p of [join(HERE, '..', '..', '..', 'internal', '.env'), join(HERE, '..', '.env')]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^REDPILL_API_KEY=(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((_req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  next();
});
app.options(/.*/, (_req, res) => { res.sendStatus(204); });

const json = (res: express.Response, code: number, body: unknown) =>
  res.status(code).type('application/json').send(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

// --- health -----------------------------------------------------------------

app.get('/health', (_req, res) => {
  json(res, 200, {
    ok: true,
    promptVersion: PROMPT_VERSION,
    schemaId: SCHEMA_ID,
    liveAppraisalAvailable: Boolean(apiKey()),
    chainReadsConfigured: chainConfigured(),
    assets: listAssets(),
    bundles: listBundles().length,
  });
});

// --- committee --------------------------------------------------------------

app.get('/committee', async (_req, res) => {
  try {
    const c = loadCommittee() as ReturnType<typeof loadCommittee> & Record<string, unknown>;
    // Freshness: re-pull the attestation for each selected member.
    const freshness = await Promise.all(
      committeeSlots().map(async (id) => {
        try {
          const a = await getAttestation(id);
          const notAfter = a.attestation?.workload_keyset?.not_after ?? null;
          return {
            model: id,
            signingAddress: a.signing_address ?? null,
            teeType: a.attestation?.tee_type ?? null,
            serving: a.service_capabilities?.serving ?? null,
            quoteBytes: (a.intel_quote ?? '').length / 2,
            reportData: a.attestation?.report_data ?? null,
            repoCommit: a.attestation?.source_provenance?.repo_commit ?? null,
            keysetNotAfter: notAfter,
            keysetExpiresInSeconds: notAfter ? notAfter - Math.floor(Date.now() / 1000) : null,
            keysetExpired: notAfter ? notAfter * 1000 < Date.now() : null,
            fetchedAt: new Date().toISOString(),
          };
        } catch (e) {
          return { model: id, error: (e as Error).message };
        }
      }),
    );
    json(res, 200, { ...c, slotOrder: committeeSlots(), drift: committeeDrift(), freshness });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

// --- assets & evidence ------------------------------------------------------

app.get('/assets', (_req, res) => {
  const assets = loadAllAssets().map((a) => {
    const ev = buildEvidence(a);
    return {
      assetId: a.assetId,
      registry: a.fields.registry ?? null,
      projectId: a.fields.project_id ?? null,
      projectName: a.fields.project_name ?? null,
      vintage: a.fields.vintage ?? null,
      evidenceSha256: ev.evidenceSha256,
      evidenceBytes: ev.byteLength,
      sources: a.sources,
      provenance: a.provenance,
    };
  });
  json(res, 200, { assets });
});

app.get('/assets/:assetId', async (req, res) => {
  try {
    const a = loadAsset(req.params.assetId);
    const ev = buildEvidence(a);
    const idHex = assetIdHex(a.assetId);
    const evHashHex = `0x${ev.evidenceSha256}` as `0x${string}`;
    const chain = await precheckRound(idHex, evHashHex);
    json(res, 200, {
      asset: a,
      evidence: ev,
      assetIdHex: idHex,
      chain,
      // Always shown unless we positively know it is committed, so the step is never
      // discovered for the first time as an opaque revert.
      commitEvidenceCall: chain.evidenceCommitted === true ? null : commitEvidenceCall(idHex, evHashHex),
    });
  } catch (e) {
    json(res, 404, { error: (e as Error).message });
  }
});

/**
 * The exact bytes the Solidity contract must reconstruct. This endpoint is the contract
 * author's reference: it returns the template parts, the variable spans, and a fully
 * assembled example with its sha256.
 */
app.get('/request-template', (req, res) => {
  // Slot 0 as the CONTRACT defines it, not as discovery suggests it.
  const model = String(req.query.model ?? committeeSlots()[0]);
  const assetId = String(req.query.assetId ?? listAssets()[0] ?? '');
  try {
    const ev = buildEvidence(loadAsset(assetId));
    const body = buildRequestString(model, ev.line);
    json(res, 200, {
      promptVersion: PROMPT_VERSION,
      schemaId: SCHEMA_ID,
      construction: 'requestBody = head || utf8(modelId) || mid || evidence || tail',
      hex: { head: SCHEMA.head, mid: SCHEMA.mid, tail: SCHEMA.tail },
      text: { head: HEAD_TEXT, mid: MID_TEXT, tail: TAIL_TEXT },
      prompt: { system: SYSTEM_PROMPT, userPreamble: USER_PREAMBLE },
      slotOrder: committeeSlots(),
      variables: { model, slot: committeeSlots().indexOf(model), evidenceLine: ev.line, evidenceHex: evidenceHex(ev) },
      example: { requestBody: body, requestSha256: sha256Hex(body), byteLength: Buffer.byteLength(body) },
      verdictShape: VERDICT_SHAPE,
      responseGrammar: GRAMMAR,
    });
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
});

/** Offsets + on-chain parse for an arbitrary response body. No key, pure function. */
app.post('/inspect', (req, res) => {
  const body = req.body?.responseBody;
  if (typeof body !== 'string') return json(res, 400, { error: 'responseBody (string) required' });
  let offsets = null;
  try { offsets = findVerdictOffsets(body); } catch (e) { offsets = { error: (e as Error).message }; }
  json(res, 200, { offsets, parse: parseResponseOnChain(body) });
});

// --- appraisal --------------------------------------------------------------

app.post('/appraise', async (req, res) => {
  const key = apiKey();
  const assetId = String(req.body?.assetId ?? '');
  if (!assetId) return json(res, 400, { error: 'assetId required' });

  if (!key) {
    const cached = existsSync(join(DATA, 'bundles', `${assetId}-latest.json`))
      ? loadBundle(`${assetId}-latest.json`)
      : null;
    return json(res, 503, {
      error: 'REDPILL_API_KEY not configured — live appraisal unavailable',
      hint: 'GET /bundles/:name replays a recorded attested bundle and re-verifies it with zero credentials',
      cachedBundleAvailable: Boolean(cached),
      cachedBundleId: cached?.bundleId ?? null,
    });
  }

  try {
    const bundle = await appraise(assetId, {
      apiKey: key,
      models: Array.isArray(req.body?.models) ? (req.body.models as string[]) : undefined,
      quorum: req.body?.quorum,
      bandBps: req.body?.bandBps,
      minConfidenceBps: req.body?.minConfidenceBps,
      maxAgeSec: req.body?.maxAgeSec,
    });
    json(res, 200, bundle);
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

// --- bundles (zero-credential replay) --------------------------------------

app.get('/bundles', (_req, res) => json(res, 200, { bundles: listBundles() }));

app.get('/bundles/:name', (req, res) => {
  try {
    json(res, 200, loadBundle(req.params.name));
  } catch (e) {
    json(res, 404, { error: (e as Error).message });
  }
});

app.get('/bundles/:name/verify', async (req, res) => {
  try {
    const b = loadBundle(req.params.name);
    json(res, 200, await reverifyBundle(b));
  } catch (e) {
    json(res, 404, { error: (e as Error).message });
  }
});

/** Verify an arbitrary receipt the caller supplies. Pure function, no key, no state. */
app.post('/verify', async (req, res) => {
  const { requestBody, responseBody, signature, expectedSigner } = req.body ?? {};
  if (typeof requestBody !== 'string' || typeof responseBody !== 'string' || typeof signature !== 'string') {
    return json(res, 400, { error: 'requestBody, responseBody, signature (strings) required' });
  }
  try {
    json(res, 200, await verifyReceipt({ requestBody, responseBody, signature: signature as `0x${string}` }, expectedSigner));
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`assay backend on http://127.0.0.1:${PORT}`);
  console.log(`  schemaId: ${SCHEMA_ID}`);
  console.log(`  live appraisal: ${apiKey() ? 'ENABLED' : 'DISABLED (no REDPILL_API_KEY)'}`);
  console.log('  GET  /health  /committee  /assets  /request-template  /bundles  /bundles/:n/verify');
  console.log('  POST /appraise {assetId}   /verify {requestBody,responseBody,signature}   /inspect {responseBody}');
});

/**
 * Fail loudly on a port clash.
 *
 * Node's default is to emit an unhandled 'error' and die quietly when backgrounded, which
 * means a STALE server from an earlier run keeps serving an OLD schema while a fresh start
 * appears to have succeeded. That silently invalidates any verification done against it, so
 * this exits non-zero with the reason spelled out.
 */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`FATAL: port ${PORT} is already in use — another assay backend is probably still running.`);
    console.error('It may be serving a STALE schema. Kill it before trusting anything this server returns:');
    console.error(`  netstat -ano | grep ":${PORT}"   then   powershell Stop-Process -Id <pid> -Force`);
  } else {
    console.error(`FATAL: server failed to start: ${err.message}`);
  }
  process.exit(1);
});

export type { AppraisalBundle };
