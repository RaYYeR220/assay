import { checkBundle, type BundleMember, type BundlePolicy, type PromptSchema } from '@assay/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hexToBytes, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { failure, result, type ServerContext } from '../context.ts';

const encoder = new TextEncoder();

const memberSchema = z.object({
  slot: z.number().int().min(0).max(15).describe('committee slot; fixes which model the answer must come from'),
  modelId: z.string().optional().describe('model id; taken from the on-chain committee when an assetId is given'),
  responseBody: z
    .string()
    .describe('the raw HTTP response body, verbatim. Hex (0x...) or the exact UTF-8 text.'),
  signature: z.string().describe('65-byte enclave signature, 0x-prefixed'),
});

export function registerBundleTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'verify_bundle',
    {
      title: 'Verify an appraisal bundle locally',
      description:
        'Re-run the entire on-chain verification off chain and report per-member pass or fail with reasons. For each committee seat it rebuilds the exact request bytes from the prompt fragments, hashes both bodies, reconstructs the 129-character text the enclave signed, recovers the key, parses the answer under the contract\'s strict grammar, and applies the confidence floor and freshness window. Then it applies quorum, distinct-signer and band rules to the round as a whole and says whether the oracle would publish. Read-only: nothing is sent to the chain.',
      inputSchema: {
        evidence: z.string().describe('the evidence document the committee was shown, verbatim'),
        members: z.array(memberSchema).min(1).describe('one entry per committee seat'),
        assetId: z
          .string()
          .optional()
          .describe('when given, the schema, policy, committee and attested keys are read from the chain'),
        assetKey: z.string().optional(),
        schema: z
          .object({ head: z.string(), mid: z.string(), tail: z.string() })
          .optional()
          .describe('prompt fragments, if not reading them from the chain'),
        policy: z
          .object({
            quorum: z.number().int().positive(),
            minDistinctSigners: z.number().int().nonnegative(),
            bandBps: z.number().int().positive(),
            minConfidenceBps: z.number().int().nonnegative(),
            maxAgeSec: z.number().int().positive(),
          })
          .optional()
          .describe('appraisal policy, if not reading it from the chain'),
        now: z.number().int().optional().describe('unix seconds to evaluate freshness against'),
        checkAttestation: z
          .boolean()
          .optional()
          .describe('check recovered keys against the registry (default true when an assetId is given)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        let schema: PromptSchema | undefined = input.schema
          ? { head: asHex(input.schema.head), mid: asHex(input.schema.mid), tail: asHex(input.schema.tail) }
          : undefined;
        let policy: BundlePolicy | undefined = input.policy;
        let committee: string[] = [];
        let attested: Address[] | undefined;
        let assetId: Hex | undefined;
        const sources: string[] = [];

        if (input.assetId || input.assetKey || (!schema && !policy)) {
          const assay = context.assay();
          assetId = context.resolveAssetId(input);
          const config = await assay.getAssetConfig(assetId);
          committee = await assay.getCommittee(assetId);
          schema = schema ?? (await assay.getSchema(config.schemaId));
          policy = policy ?? {
            quorum: config.quorum,
            minDistinctSigners: config.minDistinctSigners,
            bandBps: config.bandBps,
            minConfidenceBps: config.minConfidenceBps,
            maxAgeSec: config.maxAgeSec,
          };
          sources.push(`schema, policy and committee read from the registry for ${assetId}`);

          if (input.checkAttestation !== false) {
            const signers = await assay.getAttestedSigners();
            attested = signers.filter((s) => !s.revoked && !s.expired).map((s) => s.signer);
            sources.push(`${attested.length} live enclave key(s) read from the attestation registry`);
          }
        }

        if (!schema || !policy) {
          throw new Error('provide assetId (to read them from the chain) or both schema and policy');
        }

        const members: BundleMember[] = input.members.map((member) => {
          const modelId = member.modelId ?? committee[member.slot];
          if (!modelId) {
            throw new Error(
              `no model id for slot ${member.slot}: pass modelId, or an assetId whose committee covers that slot`,
            );
          }
          return {
            slot: member.slot,
            modelId,
            responseBody: toBytes(member.responseBody),
            signature: asHex(member.signature),
            ...(attested ? { attestedSigners: attested } : {}),
          };
        });

        const outcome = await checkBundle(members, schema, input.evidence, policy, {
          ...(input.now !== undefined ? { now: input.now } : {}),
        });

        return result({
          ok: true,
          wouldPublish: outcome.wouldPublish,
          verdict: outcome.summary,
          ...(outcome.wouldPublish ? {} : { haltReason: outcome.haltReason }),
          medianUsd: outcome.median,
          band: outcome.band
            ? { width: `${outcome.band.bps / 100}%`, lowUsd: outcome.band.low, highUsd: outcome.band.high }
            : null,
          tally: {
            submitted: members.length,
            counted: outcome.accepted,
            authenticated: outcome.authenticated,
            distinctEnclaves: outcome.distinctSigners,
            quorumRequired: policy.quorum,
            minDistinctEnclavesRequired: policy.minDistinctSigners,
          },
          outlierSlots: outcome.outliers,
          members: outcome.members.map((m) => ({
            slot: m.slot,
            modelId: m.modelId,
            pass: m.ok,
            reason: m.reason,
            why: m.detail,
            failedCheck: m.failedCheck,
            recoveredKey: m.signer,
            navUsd: m.value,
            confidenceBps: m.confidenceBps,
            answeredAt: m.createdAt ? new Date(m.createdAt * 1000).toISOString() : null,
            ageSec: m.ageSec,
            requestSha256: m.requestSha256 || null,
            responseSha256: m.responseSha256 || null,
            signedText: m.signedText || null,
            offsets: m.offsets,
          })),
          sources: sources.length ? sources : ['schema and policy supplied by the caller'],
          note:
            'Not checked here because it needs live chain state: sequencer uptime, and whether the evidence document was pre-committed. Everything else matches what postAppraisal would do.',
        });
      } catch (error) {
        return failure(
          error,
          'responseBody must be the raw bytes the gateway served, not a re-serialised JSON object; a single reordered key changes the hash and every signature fails',
        );
      }
    },
  );
}

function asHex(value: string): Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`expected 0x-prefixed hex, got ${value.slice(0, 24)}`);
  return value as Hex;
}

/** A response body arrives either as hex or as the exact text; both must survive verbatim. */
function toBytes(value: string): Uint8Array {
  return /^0x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0
    ? hexToBytes(value as Hex)
    : encoder.encode(value);
}
