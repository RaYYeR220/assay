import { HALT_REASON_TEXT, NAV_STATE_TEXT, formatE6 } from '@assay/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { failure, result, type ServerContext } from '../context.ts';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export function registerAssetTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'list_assets',
    {
      title: 'List appraised assets',
      description:
        'Every asset listed with the Assay oracle, with the policy it is priced under: the committee of models seated on it, how many must agree, how tightly, how fresh their answers must be, and what challenging the price costs. Also reports whether a usable price exists right now.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const assay = context.assay();
        const assets = await assay.listAssets();

        const listed = await Promise.all(
          assets.map(async (asset) => {
            const nav = await assay.peekNav(asset.assetId);
            return {
              assetId: asset.assetId,
              metadataURI: asset.metadataURI || null,
              issuer: asset.config.issuer,
              active: asset.config.active,
              committee: asset.committee.map((modelId, slot) => ({ slot, modelId })),
              policy: {
                quorum: `${asset.config.quorum} of ${asset.committee.length}`,
                minDistinctEnclaves: asset.config.minDistinctSigners,
                agreementBand: `${asset.config.bandBps / 100}%`,
                confidenceFloorBps: asset.config.minConfidenceBps,
                freshnessWindowSec: asset.config.maxAgeSec,
                disputeBand: `${asset.config.disputeBandBps / 100}%`,
                disputeBondWei: asset.config.disputeBond.toString(),
                evidence:
                  'must be committed by the issuer before a round can price it; an uncommitted document is rejected on chain',
                schemaId: asset.config.schemaId,
              },
              state: {
                nav: nav.state === 'Live' ? nav.value : null,
                navState: nav.state,
                navStateMeaning: NAV_STATE_TEXT[nav.state],
                usable: nav.usable,
                epoch: asset.epoch,
                haltsRecorded: asset.haltCount,
                lastHaltReason: asset.lastHaltReason,
                ...(nav.refusal ? { refusal: nav.refusal.detail } : {}),
              },
            };
          }),
        );

        return result({ ok: true, chainId: context.config.chainId, count: listed.length, assets: listed });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'get_nav',
    {
      title: 'Get the attested unit price',
      description:
        'The current net asset value for one unit of an asset, in US dollars, as published by a quorum of attested enclaves. When there is no usable price this returns a structured refusal explaining exactly why — a halt, a stale valuation, an open challenge, an unhealthy sequencer or an asset that has never been priced. A refusal is the oracle working, not an error.',
      inputSchema: {
        assetId: z.string().optional().describe('32-byte asset id, e.g. 0x1c55...'),
        assetKey: z.string().optional().describe('the string the asset was listed under, hashed to the id'),
      },
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const assay = context.assay();
        const assetId = context.resolveAssetId(input);
        const nav = await assay.peekNav(assetId);
        const config = await assay.getAssetConfig(assetId).catch(() => null);

        const common = {
          assetId,
          chainId: context.config.chainId,
          epoch: nav.epoch,
          state: nav.state,
          stateMeaning: NAV_STATE_TEXT[nav.state],
          evidenceHash: nav.evidenceHash,
          observedAt: nav.observedAt > 0n ? new Date(Number(nav.observedAt) * 1000).toISOString() : null,
          postedAt: nav.postedAt > 0n ? new Date(Number(nav.postedAt) * 1000).toISOString() : null,
          acceptedVerdicts: nav.accepted,
          distinctEnclaves: nav.distinctSigners,
          ...(config
            ? {
                policy: {
                  quorum: config.quorum,
                  agreementBand: `${config.bandBps / 100}%`,
                  freshnessWindowSec: config.maxAgeSec,
                },
              }
            : {}),
        };

        if (nav.usable) {
          return result({
            ok: true,
            navUsd: nav.value,
            navUsdE6: nav.valueE6.toString(),
            ageSec: nav.ageSec ?? null,
            staleAfter: nav.staleAfter ? new Date(nav.staleAfter * 1000).toISOString() : null,
            ...common,
          });
        }

        return result({
          ok: false,
          refusal: {
            reason: nav.refusal?.reason ?? 'no-nav',
            detail: nav.refusal?.detail ?? NAV_STATE_TEXT[nav.state],
            ...(nav.haltReason ? { haltReason: nav.haltReason, haltMeaning: HALT_REASON_TEXT[nav.haltReason] } : {}),
            isRefusalToPrice: nav.refusal?.isRefusalToPrice ?? true,
          },
          lastKnownNavUsd: nav.valueE6 > 0n ? formatE6(nav.valueE6) : null,
          lastKnownNavIsNotUsable:
            'shown only for context. It is not a price: the oracle has declined to stand behind it, and no consumer contract will accept it.',
          ...common,
        });
      } catch (error) {
        return failure(error, 'pass assetId or assetKey; list_assets shows what is listed');
      }
    },
  );
}
