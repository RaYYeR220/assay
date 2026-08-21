/**
 * redpill.ts — thin, typed client for the Phala Confidential AI gateway (api.redpill.ai).
 *
 * Three of the four endpoints need NO API key: /v1/models, /v1/attestation/report and
 * /v1/signature/{id}. Only /v1/chat/completions costs credits. That is why the demo can
 * replay attested bundles with ZERO keys — everything a judge needs to re-verify is public.
 */

export const REDPILL_BASE = process.env.REDPILL_BASE_URL ?? 'https://api.redpill.ai/v1';

export interface ModelEntry {
  id: string;
  name: string;
  created: number;
  context_length: number;
  max_output_length: number;
  pricing: { prompt?: string; completion?: string; input_cache_read?: string };
  supported_parameters: string[];
  supported_features: string[];
  is_tee: boolean;
  providers: string[];
  description?: string;
}

export interface AttestationReport {
  /** Present only for aggregator-served models. Absent for chutes-routed ones. */
  signing_address?: string;
  signing_public_key?: string;
  signing_algo?: string;
  intel_quote?: string;
  nvidia_payload?: string;
  api_version?: string;
  workload_keyset_digest?: string;
  attestation?: {
    tee_type?: string;
    report_data?: string;
    workload_keyset?: { not_after?: number };
    source_provenance?: { repo_url?: string; repo_commit?: string };
    evidence?: { quote?: string; quote_report_data?: string };
  };
  service_capabilities?: { serving?: string; supported_e2ee_versions?: string[] };
  all_attestations?: unknown[];
  /** chutes-shaped reports carry this instead */
  attestation_type?: string;
  error?: { message?: string; type?: string };
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${REDPILL_BASE}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok && !text.trimStart().startsWith('{')) {
    throw new Error(`GET ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

export async function listModels(): Promise<ModelEntry[]> {
  const j = await getJson<{ data: ModelEntry[] }>('/models');
  return j.data;
}

export async function getAttestation(model: string): Promise<AttestationReport> {
  return getJson<AttestationReport>(`/attestation/report?model=${encodeURIComponent(model)}`);
}

export interface SignatureResponse {
  api_version?: string;
  /** "<64hex>:<64hex>" — the 129-char text that was personal_sign'd. */
  text?: string;
  /** 0x + 130 hex, r||s||v with v in {27,28}. */
  signature?: string;
  signing_address?: string;
  signing_algo?: string;
  /** The full signed ACI receipt document (event_log etc). */
  receipt?: unknown;
  error?: { message?: string; type?: string };
  [k: string]: unknown;
}

/**
 * Fetch the ECDSA receipt signature.
 *
 * ⚠️ THE BEARER TOKEN IS REQUIRED. Receipts created by an authenticated completion are
 * OWNED by sha256(bearer token). Fetching without that exact token returns 401; fetching
 * with a *different* token returns 404 ("no existence oracle"). Verified in
 * private-ai-gateway src/http/app/util.rs (ReceiptOwner::from_bearer).
 *
 * ⚠️ TTL is 3600s and the receipt store is IN-MEMORY ONLY — a gateway restart drops every
 * receipt. Fetch the signature immediately after the completion, never lazily.
 *
 * The path segment accepts either the `x-receipt-id` value (`rcpt-<24hex>`) or the chat
 * completion `id` from the response body.
 */
export async function getSignature(
  receiptId: string,
  signingAlgo: 'ecdsa' | 'ed25519' = 'ecdsa',
  apiKey?: string,
): Promise<SignatureResponse> {
  return getJson<SignatureResponse>(
    `/signature/${encodeURIComponent(receiptId)}?signing_algo=${signingAlgo}`,
    apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : undefined,
  );
}

/**
 * POST a chat completion using RAW pre-serialised bytes.
 *
 * We deliberately pass a string body and set Content-Type ourselves so that no layer
 * between us and the socket re-serialises the JSON. The exact bytes in `bodyBytes` are
 * the exact bytes the gateway receives — which is the whole point.
 */
export async function chatRaw(
  bodyBytes: string,
  apiKey: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ status: number; receiptId: string | null; responseBody: string; headers: Record<string, string> }> {
  const res = await fetch(`${REDPILL_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: bodyBytes,
    signal: opts.signal ?? null,
  });
  // .text() gives us the raw body verbatim — never .json(), which would lose the bytes.
  const responseBody = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return {
    status: res.status,
    receiptId: res.headers.get('x-receipt-id'),
    responseBody,
    headers,
  };
}
