/**
 * evidence.ts — build, canonicalise and hash the carbon-credit evidence document.
 *
 * The evidence is the ONLY variable payload the contract splices into the request bytes,
 * so it is constrained hard:
 *   - a single line of `key=value;key=value` pairs
 *   - fixed field order (so the bytes are reproducible, not merely equivalent)
 *   - charset = printable ASCII 0x20-0x7E minus `"` and `\`, so it embeds into a JSON
 *     string with ZERO escaping — the bytes on-chain, on the wire, and inside the JSON
 *     string are all literally identical
 *
 * The contract receives these exact evidence bytes as calldata, checks the charset with
 * `Ascii.isJsonStringSafe`, and splices them into the request it rebuilds. So the evidence
 * line IS consensus-critical data: the same bytes must reach the model and the chain.
 *
 * `evidenceSha256` is simply sha256 of the line. The model is NOT asked to echo it — the
 * answer grammar (`ASSAY1|nav_usd_e6=..|confidence_bps=..`) has no room for it, and it
 * would be redundant anyway: the signature already covers the request bytes, which contain
 * the evidence verbatim. Binding is by construction, not by the model's cooperation.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, assertJsonStringSafe, sanitiseToSafeCharset, isJsonStringSafe } from './canonical.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = join(HERE, '..', 'data', 'assets');

/**
 * Field order of the canonical evidence line. APPEND-ONLY: inserting a field in the middle
 * changes every historical evidence hash, and therefore every request hash.
 */
export const EVIDENCE_FIELD_ORDER = [
  'schema',
  'asset_id',
  'registry',
  'project_id',
  'project_name',
  'project_type',
  'methodology',
  'vintage',
  'country',
  'region',
  'registry_status',
  'credits_issued',
  'credits_retired',
  'credits_remaining',
  'buffer_deposited',
  'first_vintage',
  'durability',
  'integrity_flags',
  'ref_price_usd',
  'ref_price_source',
  'ref_price_date',
  'observed_at',
] as const;

export type EvidenceField = (typeof EVIDENCE_FIELD_ORDER)[number];

export const EVIDENCE_SCHEMA_ID = 'assay.carbon.v1';

export interface AssetRecord {
  assetId: string;
  /** Case label: H1/H2 heroes, P1-P20 priceable set, T1-T5 trap set. */
  caseId?: string;
  /** Everything here IS shown to the models and IS hashed into the request. */
  fields: Partial<Record<EvidenceField, string | number>>;
  /**
   * Scoring band — deliberately NOT part of the evidence and NEVER shown to a model.
   *
   * Putting a reference price in front of the committee is precisely the T5 anchoring
   * trap. Priceable cases therefore carry `ref_price_usd=NA` in their evidence and keep
   * the band out here, where only the scorer can see it.
   */
  reference?: { lowUsd: number; highUsd: number; basis: string; sourceUrl: string };
  /** Provenance — NOT hashed, NOT sent to the model. */
  sources: { label: string; url: string }[];
  /** Honest marker: which fields are verified vs illustrative. */
  provenance: { verified: string[]; illustrative: string[]; notes?: string };
}

export interface CanonicalEvidence {
  assetId: string;
  /** The exact bytes handed to the contract and spliced into the request JSON. */
  line: string;
  /** sha256 of `line` — the evidence commitment. */
  evidenceSha256: string;
  byteLength: number;
}

const MISSING = 'NA';

/** Normalise one value into the safe charset. `;` and `=` are reserved separators. */
function normaliseValue(v: string | number | undefined): string {
  if (v === undefined || v === null || v === '') return MISSING;
  let s = String(v);
  if (!isJsonStringSafe(s)) s = sanitiseToSafeCharset(s);
  // Reserved separators must not appear inside a value.
  s = s.replace(/;/g, ',').replace(/=/g, '-');
  s = s.replace(/\s+/g, ' ').trim();
  if (s === '') return MISSING;
  assertJsonStringSafe(s, 'evidence value');
  return s;
}

/**
 * Build the canonical evidence line for one asset.
 *
 * Deterministic: same AssetRecord -> same bytes -> same hash, forever.
 */
export function buildEvidence(asset: AssetRecord): CanonicalEvidence {
  const parts: string[] = [];
  for (const key of EVIDENCE_FIELD_ORDER) {
    const raw = key === 'schema' ? EVIDENCE_SCHEMA_ID : key === 'asset_id' ? asset.assetId : asset.fields[key];
    parts.push(`${key}=${normaliseValue(raw)}`);
  }
  const line = parts.join(';');

  assertJsonStringSafe(line, 'evidence line');
  return {
    assetId: asset.assetId,
    line,
    evidenceSha256: sha256Hex(line),
    byteLength: Buffer.byteLength(line, 'utf8'),
  };
}

/** Load one asset record from data/assets/<id>.json. */
export function loadAsset(assetId: string): AssetRecord {
  const path = join(ASSETS_DIR, `${assetId}.json`);
  const rec = JSON.parse(readFileSync(path, 'utf8')) as AssetRecord;
  if (rec.assetId !== assetId) throw new Error(`assetId mismatch in ${path}: ${rec.assetId} != ${assetId}`);
  return rec;
}

export function listAssets(): string[] {
  return readdirSync(ASSETS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function loadAllAssets(): AssetRecord[] {
  return listAssets().map(loadAsset);
}

/** Evidence bytes as calldata hex, ready for `postAppraisal(assetId, evidence, verdicts)`. */
export function evidenceHex(ev: CanonicalEvidence): `0x${string}` {
  return `0x${Buffer.from(ev.line, 'utf8').toString('hex')}`;
}
