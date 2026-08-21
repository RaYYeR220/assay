/**
 * prompt.ts — the prompt is NOT defined here.
 *
 * It lives inside the `mid` span of `assay/schema.appraisal.v1.json`, which is exported
 * from `script/Schema.sol`. The contract stores it and rebuilds it; the backend only reads
 * it back out so it can be logged, diffed and shown in the dashboard.
 *
 * Deriving it here (rather than keeping a second copy) means the two can never drift.
 */

import { MID_TEXT, SCHEMA_ID, sha256Hex } from './canonical.ts';

export const PROMPT_VERSION = 'assay.appraisal.v1';
export const PROMPT_SCHEMA_ID = SCHEMA_ID;

function between(hay: string, open: string, close: string): string {
  const a = hay.indexOf(open);
  if (a < 0) throw new Error(`prompt extraction failed: no ${JSON.stringify(open)} in schema mid`);
  const b = hay.indexOf(close, a + open.length);
  if (b < 0) throw new Error(`prompt extraction failed: no ${JSON.stringify(close)} in schema mid`);
  return hay.slice(a + open.length, b);
}

/** The system message, read straight out of the on-chain schema bytes. */
export const SYSTEM_PROMPT = between(MID_TEXT, '"role":"system","content":"', '"}');

/** The user-message preamble that the evidence line is appended to. */
export const USER_PREAMBLE = MID_TEXT.slice(MID_TEXT.lastIndexOf('"content":"') + '"content":"'.length);

export const SYSTEM_PROMPT_SHA256 = sha256Hex(SYSTEM_PROMPT);

/**
 * Why we do NOT send `response_format`.
 *
 * The required answer is a single plain line — `ASSAY1|nav_usd_e6=<int>|confidence_bps=<int>`
 * — not JSON, so `json_schema` mode cannot express it and `json_object` mode would actively
 * fight it. More importantly, `response_format` is not in the on-chain schema, so sending it
 * would change the request bytes and every signature would fail to verify.
 *
 * Compliance is therefore a PROMPT-ADHERENCE property of each model, measured empirically
 * by scripts/compliance.ts. Non-compliance is not a bug to paper over: it becomes a visible
 * on-chain rejection. We only need to know which models are reliable enough to seat.
 */
export const RESPONSE_FORMAT_POLICY = 'not-sent: absent from the on-chain schema; adding it would break every signature' as const;
