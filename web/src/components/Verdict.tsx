'use client';

import type { RoundView } from '@/lib/bundle';
import { HALT_COPY } from '@/lib/enums';
import { bpsToPercent, groupDigits, splitE6 } from '@/lib/format';
import { Hallmark } from '@/components/primitives';

/**
 * The one thing a reader must not be able to misread.
 *
 * A published valuation is an enormous figure with the hallmark struck beside it. A refusal
 * is the same real estate given over to the refusal itself, set in the alarm colour, with the
 * cause written out in a sentence that assumes no prior knowledge — and the hallmark withheld
 * as an empty punch, so the absence is visibly a decision.
 */
export function Verdict({ round }: { round: RoundView }) {
  return round.published && round.navE6 !== null ? (
    <Published round={round} navE6={round.navE6} />
  ) : (
    <Refused round={round} />
  );
}

function Published({ round, navE6 }: { round: RoundView; navE6: bigint }) {
  const { whole, fraction } = splitE6(navE6);

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-6">
      <div className="rise">
        <div className="legend" style={{ letterSpacing: '0.2em' }}>
          Net asset value · one unit · US dollars
        </div>
        <div className="mt-3 flex items-start">
          <span
            className="display mt-[0.28em] mr-1 text-[clamp(2rem,4vw,3.4rem)]"
            style={{ color: 'var(--ink-3)', fontWeight: 600 }}
          >
            $
          </span>
          <span
            className="display figure text-[clamp(4.5rem,11.5vw,9.5rem)]"
            style={{ fontWeight: 800 }}
          >
            {whole}
          </span>
          <span
            className="display figure text-[clamp(4.5rem,11.5vw,9.5rem)]"
            style={{ fontWeight: 600, color: 'var(--ink-2)' }}
          >
            .{fraction}
          </span>
        </div>
        <p className="note mt-4 max-w-[58ch]">
          Struck at epoch {round.epoch ?? '—'}. {round.accepted.length} independent enclaves
          appraised the same evidence and agreed to within{' '}
          {groupDigits(String(round.maxDeviationBps ?? 0))} basis points of the median, inside the{' '}
          {bpsToPercent(round.policy.bandBps)} band this asset permits.
        </p>
      </div>

      <div className="flex items-start gap-6">
        <Hallmark struck epoch={round.epoch} />
      </div>
    </div>
  );
}

function Refused({ round }: { round: RoundView }) {
  const reason = round.haltReason ?? 'Disagreement';
  const outliers = round.readings.filter((r) => r.outsideBand);
  const rejected = round.readings.filter((r) => !r.accepted);

  // An ignored round is not a refusal. Nobody disagreed; somebody posted noise, and the contract
  // declined to record anything at all. Saying "halted" here would overstate what happened.
  const headline = round.ignored ? ['ROUND', 'IGNORED'] : ['NO PRICE', 'STRUCK'];

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-6">
      <div className="rise">
        <div className="legend" style={{ letterSpacing: '0.2em', color: 'var(--alarm)' }}>
          Net asset value · one unit · US dollars
        </div>

        <div className="relative mt-3 inline-block">
          <span
            className="display block text-[clamp(3.2rem,8.4vw,7rem)]"
            style={{ color: 'var(--alarm)', fontWeight: 800, letterSpacing: '-0.015em' }}
          >
            {headline[0]}
          </span>
          <span
            className="display block text-[clamp(3.2rem,8.4vw,7rem)]"
            style={{ color: 'var(--alarm)', fontWeight: 600, letterSpacing: '-0.015em' }}
          >
            {headline[1]}
          </span>
          {/* The entry is struck out, the way a cancelled line in a register is struck out. */}
          <span
            aria-hidden
            className="sweep mt-3 block h-[4px] w-full"
            style={{ background: 'var(--alarm)', animationDelay: '260ms' }}
          />
          <span
            aria-hidden
            className="sweep mt-[3px] block h-[1px] w-full"
            style={{ background: 'var(--alarm)', opacity: 0.5, animationDelay: '360ms' }}
          />
        </div>

        <p className="note mt-5 max-w-[62ch]" style={{ color: 'var(--ink)' }}>
          {HALT_COPY[reason]}
        </p>

        <p className="note mt-2 max-w-[62ch]">
          {reason === 'Disagreement' && outliers.length > 0 ? (
            <>
              {round.accepted.length} answers verified, but the widest sat{' '}
              {groupDigits(String(round.maxDeviationBps ?? 0))} basis points from the median against
              a {groupDigits(String(round.policy.bandBps))} basis point band — roughly{' '}
              {bpsToPercent(round.maxDeviationBps ?? 0)} against a permitted{' '}
              {bpsToPercent(round.policy.bandBps)}.
            </>
          ) : null}
          {reason === 'InsufficientQuorum' ? (
            <>
              {round.accepted.length} of {round.readings.length} answers survived verification, and
              this asset requires {round.policy.quorum} from at least{' '}
              {round.policy.minDistinctSigners} distinct enclave keys.{' '}
              {rejected.length > 0
                ? `${rejected.length} were rejected outright and are itemised below.`
                : ''}
            </>
          ) : null}
        </p>

        <p className="legend mt-5" style={{ color: 'var(--alarm)', letterSpacing: '0.16em' }}>
          {round.ignored ? (
            <>
              Emitted as RoundIgnored · epoch {round.epoch ?? '—'} · no state was written, and the
              previous valuation is untouched
            </>
          ) : (
            <>
              Recorded on chain as {reason} · epoch {round.epoch ?? '—'} · every value-moving call
              reverts while this stands
            </>
          )}
        </p>
      </div>

      <div className="flex items-start gap-6">
        <Hallmark struck={false} epoch={round.epoch} />
      </div>
    </div>
  );
}
