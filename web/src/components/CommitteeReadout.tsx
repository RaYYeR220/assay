'use client';

import type { RoundReading } from '@/lib/bundle';
import { REJECT_COPY } from '@/lib/enums';
import { formatBps, formatE6, groupDigits, splitModelId } from '@/lib/format';
import { AddressRef } from '@/components/primitives';

/**
 * The committee, one readout per seat.
 *
 * Every seat is listed whether or not it produced anything, because the contract requires the
 * whole committee to be submitted: an absent member has to be posted as an empty answer and
 * counted as a rejection. Hiding the seats that failed would hide the mechanism.
 */
export function CommitteeReadout({
  readings,
  chainId,
  bandBps,
}: {
  readings: RoundReading[];
  chainId: number;
  bandBps: number;
}) {
  return (
    <div>
      <div
        className="legend hidden grid-cols-[2.5rem_minmax(0,3fr)_minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,2fr)] gap-x-5 pb-2 lg:grid"
        style={{ borderBottom: '1px solid var(--rule)' }}
      >
        <span>Slot</span>
        <span>Model</span>
        <span className="text-right">Value · usd</span>
        <span className="text-right">Confidence</span>
        <span className="text-right">Deviation</span>
        <span className="text-right">Attested signer</span>
      </div>

      <div className="ruled">
        {readings.map((r, i) => (
          <Row key={r.slot} reading={r} chainId={chainId} bandBps={bandBps} index={i} />
        ))}
      </div>
    </div>
  );
}

function Row({
  reading: r,
  chainId,
  bandBps,
  index,
}: {
  reading: RoundReading;
  chainId: number;
  bandBps: number;
  index: number;
}) {
  const { vendor, name } = splitModelId(r.model);
  const bad = !r.accepted;
  const flagged = bad || r.outsideBand;
  const accent = flagged ? 'var(--alarm)' : 'var(--ink)';

  return (
    <div
      className="rise grid grid-cols-2 gap-x-5 gap-y-1 py-3.5 lg:grid-cols-[2.5rem_minmax(0,3fr)_minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,2fr)]"
      style={{
        animationDelay: `${120 + index * 55}ms`,
        background: flagged ? 'var(--alarm-wash)' : undefined,
        boxShadow: flagged ? 'inset 3px 0 0 0 var(--alarm)' : undefined,
        paddingLeft: flagged ? 12 : undefined,
      }}
    >
      <div className="figure text-[13px]" style={{ color: 'var(--ink-4)' }}>
        {String(r.slot).padStart(2, '0')}
      </div>

      <div className="col-span-2 lg:col-span-1">
        <div className="text-[13.5px] leading-tight" style={{ fontWeight: 500 }}>
          <span style={{ color: 'var(--ink-4)' }}>{vendor}/</span>
          {name}
        </div>
        <div className="legend mt-1" style={{ color: accent }}>
          {r.accepted ? (r.outsideBand ? 'accepted · outside band' : 'accepted') : `rejected · ${r.rejectReason}`}
        </div>
      </div>

      <div className="figure text-right text-[15px]" style={{ color: accent, fontWeight: bad ? 400 : 600 }}>
        {r.navE6 !== null ? formatE6(r.navE6) : <span style={{ color: 'var(--ink-4)' }}>no reading</span>}
      </div>

      <div className="figure text-right text-[13px]" style={{ color: 'var(--ink-2)' }}>
        {r.confidenceBps !== null ? formatBps(r.confidenceBps) : '—'}
      </div>

      <div
        className="figure text-right text-[13px]"
        style={{ color: r.outsideBand ? 'var(--alarm)' : 'var(--ink-2)', fontWeight: r.outsideBand ? 700 : 400 }}
      >
        {r.deviationBps === null
          ? '—'
          : `${r.deviationBps > 0 ? '+' : ''}${groupDigits(String(r.deviationBps))} bps`}
        {r.outsideBand ? (
          <span className="legend mt-0.5 block" style={{ color: 'var(--alarm)' }}>
            over {groupDigits(String(bandBps))}
          </span>
        ) : null}
      </div>

      <div className="text-right">
        <AddressRef chainId={chainId} address={r.signer} />
        <div className="legend mt-1" style={{ color: 'var(--ink-4)' }}>
          {r.latencyMs ? `${(r.latencyMs / 1000).toFixed(2)} s` : ''}
        </div>
      </div>

      {bad ? (
        <p
          className="note col-span-2 mt-1 max-w-[80ch] text-[13px] lg:col-span-6"
          style={{ color: 'var(--ink-2)' }}
        >
          {REJECT_COPY[r.rejectReason ?? 'Malformed']}
        </p>
      ) : null}
    </div>
  );
}
