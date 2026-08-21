import { HALT_REASON_TEXT, formatE6, txUrl } from '@assay/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { failure, result, type ServerContext } from '../context.ts';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export function registerRoundTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'explain_round',
    {
      title: 'Explain an appraisal round',
      description:
        'The audit trail for one appraisal round: what each committee member returned, which answers were counted and which were rejected and why, the median, the agreement band, and how the round ended. Rejections carry the contract\'s own reason code, decided in the order the contract decides them — signature, attestation, timestamp, freshness, answer, confidence — so a round that halted explains itself. Omit the epoch for the most recent round.',
      inputSchema: {
        assetId: z.string().optional().describe('32-byte asset id'),
        assetKey: z.string().optional().describe('the string the asset was listed under'),
        epoch: z.number().int().positive().optional().describe('round number; defaults to the latest'),
      },
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const assay = context.assay();
        const assetId = context.resolveAssetId(input);
        const committee = await assay.getCommittee(assetId);
        const config = await assay.getAssetConfig(assetId).catch(() => null);

        const epoch = input.epoch ?? (await assay.peekNav(assetId)).epoch;
        if (!epoch) {
          return result({
            ok: false,
            assetId,
            reason: 'no-rounds',
            detail: 'this asset has never had an appraisal round',
          });
        }

        const round = await assay.getRound(assetId, epoch);
        const seats = committee.map((modelId, slot) => {
          const accepted = round.accepted.find((a) => a.slot === slot);
          const rejected = round.rejected.find((r) => r.slot === slot);
          if (accepted) {
            return {
              slot,
              modelId,
              outcome: 'counted',
              navUsd: accepted.value,
              confidenceBps: accepted.confidenceBps,
              deviationFromMedianBps: accepted.deviationBps ?? null,
              enclaveKey: accepted.signer,
              answeredAt: new Date(accepted.createdAt * 1000).toISOString(),
            };
          }
          if (rejected) {
            return {
              slot,
              modelId,
              outcome: 'rejected',
              reason: rejected.reason,
              why: rejected.detail,
              enclaveKey: rejected.signer === '0x0000000000000000000000000000000000000000' ? null : rejected.signer,
            };
          }
          return {
            slot,
            modelId,
            outcome: 'no record',
            why: 'no event for this seat in the scanned block range',
          };
        });

        return result({
          ok: true,
          assetId,
          epoch,
          outcome: round.outcome,
          summary: round.summary,
          seats,
          tally: {
            counted: round.accepted.length,
            rejected: round.rejected.length,
            distinctEnclaves: round.distinctSigners ?? null,
            quorumRequired: round.quorum ?? config?.quorum ?? null,
            minDistinctEnclavesRequired: round.minDistinctSigners ?? config?.minDistinctSigners ?? null,
          },
          median: round.median ?? null,
          band: round.band
            ? {
                width: `${round.band.bps / 100}%`,
                lowUsd: round.band.low,
                highUsd: round.band.high,
                meaning: 'every counted answer has to sit inside this range or the round halts',
              }
            : null,
          ...(round.haltReason
            ? { halt: { reason: round.haltReason, meaning: HALT_REASON_TEXT[round.haltReason] } }
            : {}),
          ...(round.outcome === 'ignored'
            ? {
                ignored: {
                  authenticatedAnswers: round.authenticated ?? 0,
                  meaning:
                    'too few answers carried a valid enclave signature for the round to mean anything, so it was discarded rather than recorded as a halt',
                },
              }
            : {}),
          evidenceHash: round.evidenceHash ?? null,
          observedAt: round.observedAt ? new Date(round.observedAt * 1000).toISOString() : null,
          transaction: round.txHash ?? null,
          explorer: round.txHash ? (txUrl(context.config.chainId, round.txHash) ?? null) : null,
        });
      } catch (error) {
        return failure(error, 'pass assetId or assetKey and optionally an epoch');
      }
    },
  );

  server.registerTool(
    'get_attestations',
    {
      title: 'List attested enclave keys',
      description:
        'Every enclave key the AttestationRegistry has accepted, with the measurement of the image it runs, its Intel TCB status, when the attestation expires, the models it may answer for, and the transaction where its TDX quote was verified on chain. A key that is missing, expired or revoked is why a committee seat gets rejected.',
      inputSchema: {
        modelId: z.string().optional().describe('only keys bound to this model'),
        includeExpired: z.boolean().optional().describe('include keys whose attestation has lapsed (default true)'),
      },
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const assay = context.assay();
        const signers = await assay.getAttestedSigners();
        const now = Math.floor(Date.now() / 1000);

        const filtered = signers
          .filter((s) => (input.modelId ? s.models.includes(input.modelId) : true))
          .filter((s) => (input.includeExpired === false ? !s.expired && !s.revoked : true));

        return result({
          ok: true,
          chainId: context.config.chainId,
          attestationRegistry: context.config.addresses.attestationRegistry ?? null,
          count: filtered.length,
          signers: filtered.map((s) => ({
            enclaveKey: s.signer,
            measurement: s.measurement,
            tcbStatus: s.tcbStatusText,
            tcbStatusCode: s.tcbStatus,
            models: s.models.length ? s.models : null,
            attestedAt: new Date(s.attestedAt * 1000).toISOString(),
            expiresAt: new Date(s.expiresAt * 1000).toISOString(),
            live: !s.revoked && !s.expired,
            revoked: s.revoked,
            expired: s.expired,
            secondsUntilExpiry: Math.max(0, s.expiresAt - now),
            quoteVerifiedIn: s.txHash ?? null,
            explorer: s.txUrl ?? null,
          })),
          note:
            'No operator names these keys. Each address was read out of the report_data of an Intel TDX quote that AttestationRegistry verified on chain, so the key itself derives from the Intel root of trust. Registration is owner-gated, but only for the second half of the record: a TDX quote proves which image is running and which key it holds, and says nothing about which model that image fronts, so the key-to-model binding is an explicit curator assertion rather than an attestation dressed up as one.',
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'check_vault',
    {
      title: 'Check a vault',
      description:
        'Share price, supply, liquidity and whether subscribing or redeeming is possible right now. The vault prices every movement of value off requireFreshNav, so when the oracle refuses the vault refuses too — this tool reports that as data rather than as an outage.',
      inputSchema: {
        vault: z.string().optional().describe('vault address; defaults to the deployed one'),
      },
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const assay = context.assay();
        const vault = await assay.getVault(input.vault as `0x${string}` | undefined);
        const scale = 10n ** BigInt(vault.currencyDecimals);

        return result({
          ok: true,
          vault: vault.address,
          name: vault.name,
          symbol: vault.symbol,
          assetId: vault.assetId,
          issuer: vault.issuer,
          sharePriceUsd: vault.sharePrice ?? null,
          totalShares: formatUnitsExact(vault.totalSupply, 18),
          supplyCap: vault.supplyCap === 0n ? 'uncapped' : formatUnitsExact(vault.supplyCap, 18),
          liquidity: `${formatUnitsExact(vault.liquidity, vault.currencyDecimals)} (settlement token ${vault.currency})`,
          netAssetValue:
            vault.sharePriceE6 !== undefined
              ? formatE6((vault.totalSupply * vault.sharePriceE6) / 10n ** 18n)
              : null,
          canSubscribe: vault.canTransact && !vault.subscriptionsPaused,
          canRedeem: vault.canTransact,
          subscriptionsPaused: vault.subscriptionsPaused,
          ...(vault.refusal
            ? {
                frozen: {
                  reason: vault.refusal.reason,
                  detail: vault.refusal.detail,
                  meaning:
                    'the vault has no cached price to fall back on and no operator override; while the oracle refuses, no value moves',
                },
              }
            : {}),
          redeemableNow:
            vault.sharePriceE6 && vault.sharePriceE6 > 0n
              ? `${formatUnitsExact((vault.liquidity * 10n ** 18n * 1_000_000n) / (vault.sharePriceE6 * scale), 18)} shares at the current price`
              : null,
        });
      } catch (error) {
        return failure(error, 'set ASSAY_VAULT or pass a vault address');
      }
    },
  );
}

/** Fixed-point rendering without a float anywhere in the path. */
function formatUnitsExact(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
