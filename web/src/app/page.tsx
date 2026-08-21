'use client';

import { useApp } from '@/state/AppContext';
import { useNow, useOracleState } from '@/hooks/useChain';
import { Verdict } from '@/components/Verdict';
import { ToleranceRule } from '@/components/ToleranceRule';
import { CommitteeReadout } from '@/components/CommitteeReadout';
import { RoundTimeline } from '@/components/RoundTimeline';
import { RoundPicker } from '@/components/RoundPicker';
import { Caption, Notice, SectionHead, Spec, TxRef } from '@/components/primitives';
import { NAV_STATE_COPY } from '@/lib/enums';
import { bpsToPercent, formatE6, groupDigits, relativeAge, truncateHex } from '@/lib/format';

/**
 * Section I — the oracle.
 *
 * The published valuation or the recorded refusal, the committee that produced it, and the
 * band it was judged against. Everything on this page is derived from the round's own
 * integers; where the chain is reachable its state is shown alongside, never instead of.
 */
export default function OraclePage() {
  const { round, chainId, deployment } = useApp();
  const live = useOracleState();
  const now = useNow();

  if (!round) {
    return (
      <Notice title="No rounds recorded">
        Nothing has been appraised yet. Once the appraisal service writes a round to
        <span className="hex"> backend/data/bundles/</span>, it appears here without any further
        configuration.
      </Notice>
    );
  }

  const b = round.bundle;
  const chain = b.onChain;
  // Freshness is judged as the contract judged it: against the moment the round was posted.
  const reference = deployment && live.data ? live.data.blockTimestamp : (chain?.timestamp ?? now);
  const observedAgo =
    chain?.observedAt && reference !== null ? reference - chain.observedAt : null;

  return (
    <div data-verdict={round.published ? 'struck' : 'halted'}>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 pb-6">
        <div>
          <div className="legend">Specimen under appraisal</div>
          <h2 className="display mt-1.5 text-[26px]" style={{ fontWeight: 700, letterSpacing: '-0.005em' }}>
            {b.assetLabel ?? b.assetId}
          </h2>
        </div>
        <RoundPicker />
      </div>

      <hr className="rule-heavy" />

      {/* A round that no chain has seen is never allowed to read like one that has. */}
      {b.source === 'fixture' ? (
        <div
          className="mt-6 border-y-2 px-5 py-4"
          style={{ borderColor: 'var(--ink)', background: 'var(--paper-sunk)' }}
        >
          <div className="legend legend-strong">Worked example — never posted to a chain</div>
          <div className="note mt-2 max-w-[86ch]" style={{ color: 'var(--ink)' }}>
            This entry is kept so the published outcome can be read alongside the refusals: the
            same arithmetic, on answers that agree. The answers are fabricated and no transaction
            exists for it, so it carries no epoch and no links. Every other entry in the register
            was posted on chain {chainId} and links to the transaction that recorded it.
          </div>
        </div>
      ) : null}

      {/* ---- I · the verdict ------------------------------------------------------------- */}
      <section className="py-11">
        <Verdict round={round} />
      </section>

      <hr className="rule" />

      {/* ---- the round record ------------------------------------------------------------ */}
      <section className="grid grid-cols-2 gap-x-8 gap-y-6 py-6 md:grid-cols-4 lg:grid-cols-7">
        <Spec label="Epoch">{round.epoch ?? '—'}</Spec>
        <Spec label="Accepted" alarm={round.accepted.length < round.policy.quorum}>
          {round.accepted.length} of {round.readings.length}
        </Spec>
        <Spec label="Distinct signers" alarm={round.distinctSigners < round.policy.minDistinctSigners}>
          {round.distinctSigners} of {round.policy.minDistinctSigners} required
        </Spec>
        <Spec label="Widest deviation" alarm={(round.maxDeviationBps ?? 0) > round.policy.bandBps}>
          {round.maxDeviationBps === null ? '—' : `${groupDigits(String(round.maxDeviationBps))} / ${groupDigits(String(round.policy.bandBps))} bps`}
        </Spec>
        <Spec label="Evidence age" alarm={observedAgo !== null && observedAgo > round.policy.maxAgeSec}>
          {observedAgo === null ? '—' : `${relativeAge(observedAgo)} of ${relativeAge(round.policy.maxAgeSec)}`}
        </Spec>
        <Spec label="Evidence sha256">
          <span className="hex" title={b.evidence.evidenceSha256}>
            {truncateHex(`0x${b.evidence.evidenceSha256}`, 10, 6)}
          </span>
        </Spec>
        {/* The link follows the network the round was posted on, which is not always the one
            selected above, so the network is named rather than left to be inferred. */}
        <Spec label={round.published ? 'Posted in' : 'Halt recorded in'}>
          {chain ? (
            <>
              <TxRef chainId={chain.chainId} hash={chain.txHash} />
              <span className="legend ml-2" style={{ color: 'var(--ink-4)' }}>
                {chain.chainId === 196 ? 'mainnet' : 'testnet'}
              </span>
            </>
          ) : (
            <span style={{ color: 'var(--ink-4)' }}>pending</span>
          )}
        </Spec>
      </section>

      <hr className="rule" />

      {/* ---- II · the band ---------------------------------------------------------------- */}
      <section className="py-10">
        <SectionHead
          index="II"
          title="Agreement band"
          aside={
            <>
              tolerance ±{groupDigits(String(round.policy.bandBps))} bps ({bpsToPercent(round.policy.bandBps)}) ·
              quorum {round.policy.quorum} of {round.readings.length}
            </>
          }
        />
        <hr className="rule mb-8" />
        <ToleranceRule
          readings={round.readings}
          bandBps={round.policy.bandBps}
          medianE6={round.medianE6}
          published={round.published}
        />
      </section>

      <hr className="rule" />

      {/* ---- III · the committee ---------------------------------------------------------- */}
      <section className="py-10">
        <SectionHead
          index="III"
          title="Committee readings"
          aside={<>{round.readings.length} seats · one model each · each answer separately signed</>}
        />
        <Caption>
          Every seat is listed. The contract will not accept a partial committee, so a member that
          answered badly — or did not answer at all — is submitted, rejected on chain with a reason,
          and counted against the quorum rather than quietly dropped.
        </Caption>
        <div className="mt-6">
          <CommitteeReadout readings={round.readings} chainId={chainId} bandBps={round.policy.bandBps} />
        </div>
      </section>

      <hr className="rule" />

      {/* ---- live chain state ------------------------------------------------------------- */}
      <section className="py-10">
        <SectionHead
          index="IV"
          title="Chain state"
          aside={deployment ? `read from ${truncateHex(deployment.assayOracle, 8, 6)}` : 'awaiting deployment'}
        />
        <hr className="rule mb-6" />
        {!deployment ? (
          <Notice title="Not deployed on this network yet">
            The contracts have not been published to chain {chainId}. Everything above is a recorded
            round replayed locally, which is complete and verifiable on its own. As soon as{' '}
            <span className="hex">deployments/{chainId}.json</span> exists, this section fills in
            with the live oracle, and every figure above gains a link to the transaction that wrote
            it.
          </Notice>
        ) : live.error ? (
          <Notice title="Endpoint not answering">
            {live.error}. The recorded round above is unaffected.
          </Notice>
        ) : !live.data ? (
          <p className="note">Reading the oracle…</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-3 lg:grid-cols-6">
            <Spec label="Nav state" alarm={live.data.nav.state !== 'Live'}>
              {live.data.nav.state}
            </Spec>
            <Spec label="Stored value">
              {live.data.nav.valueE6 > 0n ? formatE6(live.data.nav.valueE6) : '—'}
            </Spec>
            <Spec label="Current epoch">{live.data.epoch}</Spec>
            <Spec label="Refusals to date" alarm={live.data.haltCount > 0}>
              {live.data.haltCount}
            </Spec>
            <Spec label="Consumer read" alarm={Boolean(live.data.consumerRevert)}>
              {live.data.consumerRevert ? 'reverts' : 'succeeds'}
            </Spec>
            <Spec label="Last halt reason" alarm={live.data.lastHaltReason !== 'None'}>
              {live.data.lastHaltReason}
            </Spec>
            <div className="col-span-2 md:col-span-3 lg:col-span-6">
              <Caption>
                {NAV_STATE_COPY[live.data.nav.state]}{' '}
                {live.data.consumerRevert ? (
                  <>
                    A consumer calling <span className="hex">requireFreshNav</span> right now gets{' '}
                    <span className="hex" style={{ color: 'var(--alarm)' }}>
                      {live.data.consumerRevert.signature}
                    </span>
                    , which is what stops the vault.
                  </>
                ) : null}
              </Caption>
            </div>
          </div>
        )}
      </section>

      <hr className="rule" />

      {/* ---- the replay ------------------------------------------------------------------- */}
      <section className="py-10">
        <RoundTimeline round={round} />
      </section>
    </div>
  );
}
