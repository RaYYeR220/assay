'use client';

import type { ReactNode } from 'react';
import { explorerAddress, explorerTx } from '@/lib/chains';
import { truncateHex } from '@/lib/format';

/**
 * The vocabulary the whole register is set in: legends, ruled specification rows, footnote
 * references out to the explorer, and the struck hallmark. Deliberately few pieces — a
 * document gets its structure from rules and type, not from containers.
 */

export function Legend({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return <div className={`legend${strong ? ' legend-strong' : ''}`}>{children}</div>;
}

/** A label above a value, the unit of a specification column. */
export function Spec({
  label,
  children,
  alarm,
  wide,
}: {
  label: string;
  children: ReactNode;
  alarm?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <Legend>{label}</Legend>
      <div
        className="figure mt-1 text-[15px] leading-snug"
        style={alarm ? { color: 'var(--alarm)', fontWeight: 600 } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

/** A label and value on one ruled line, the way a register lists its entries. */
export function SpecRow({
  label,
  children,
  alarm,
}: {
  label: string;
  children: ReactNode;
  alarm?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-[7px]">
      <span className="legend shrink-0">{label}</span>
      <span
        className="figure text-right text-[13.5px]"
        style={alarm ? { color: 'var(--alarm)', fontWeight: 600 } : undefined}
      >
        {children}
      </span>
    </div>
  );
}

export function SectionHead({
  index,
  title,
  aside,
}: {
  index: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-6 pb-2">
      <h2 className="legend legend-strong">
        <span style={{ color: 'var(--ink-4)' }}>{index}</span>
        <span className="mx-2" style={{ color: 'var(--ink-4)' }}>
          —
        </span>
        {title}
      </h2>
      {aside ? <div className="legend text-right">{aside}</div> : null}
    </div>
  );
}

/** Figure caption, set in the annotation italic. */
export function Caption({ children }: { children: ReactNode }) {
  return <p className="note max-w-[52ch]">{children}</p>;
}

export function TxRef({ chainId, hash, label }: { chainId: number; hash: string; label?: string }) {
  if (!hash || /^0x0*$/.test(hash)) return <span style={{ color: 'var(--ink-4)' }}>not recorded</span>;
  return (
    <a
      className="ref hex"
      href={explorerTx(chainId, hash)}
      target="_blank"
      rel="noreferrer"
      title={hash}
    >
      {label ?? truncateHex(hash, 10, 6)}
    </a>
  );
}

export function AddressRef({
  chainId,
  address,
  full,
}: {
  chainId: number;
  address: string | null | undefined;
  full?: boolean;
}) {
  if (!address) return <span style={{ color: 'var(--ink-4)' }}>—</span>;
  return (
    <a
      className="ref hex"
      href={explorerAddress(chainId, address)}
      target="_blank"
      rel="noreferrer"
      title={address}
    >
      {full ? address : truncateHex(address, 8, 6)}
    </a>
  );
}

/**
 * The hallmark. Struck when a valuation publishes; withheld — an empty punch — when it does
 * not. The withheld form is deliberately the same size and in the same place, so the absence
 * reads as a decision rather than as missing content.
 */
export function Hallmark({ struck, epoch }: { struck: boolean; epoch: number | null }) {
  const stroke = struck ? 'var(--seal)' : 'var(--alarm)';
  return (
    <div
      className="stamp-strike relative shrink-0"
      style={{ width: 116, height: 116 }}
      role="img"
      aria-label={struck ? `Hallmark struck for epoch ${epoch ?? ''}` : 'Hallmark withheld'}
    >
      <svg viewBox="0 0 116 116" width="116" height="116" aria-hidden="true">
        <circle
          cx="58"
          cy="58"
          r="54"
          fill={struck ? 'var(--seal-wash)' : 'none'}
          stroke={stroke}
          strokeWidth={struck ? 2 : 1.25}
          strokeDasharray={struck ? undefined : '5 4'}
        />
        <circle cx="58" cy="58" r="46" fill="none" stroke={stroke} strokeWidth="0.75" opacity={0.6} />
        {/* Calibration ticks around the punch, twelve of them, as on a struck die. */}
        {Array.from({ length: 24 }, (_, i) => {
          const a = (i * Math.PI * 2) / 24;
          const r1 = 46;
          const r2 = i % 2 === 0 ? 41 : 43.5;
          return (
            <line
              key={i}
              x1={58 + Math.cos(a) * r1}
              y1={58 + Math.sin(a) * r1}
              x2={58 + Math.cos(a) * r2}
              y2={58 + Math.sin(a) * r2}
              stroke={stroke}
              strokeWidth="0.75"
              opacity={0.55}
            />
          );
        })}
        {!struck ? (
          <line x1="22" y1="94" x2="94" y2="22" stroke={stroke} strokeWidth="1.5" opacity={0.9} />
        ) : null}
      </svg>
      <div
        className="absolute inset-0 flex flex-col items-center justify-center text-center"
        style={{ color: stroke }}
      >
        <span className="legend" style={{ color: stroke, letterSpacing: '0.18em' }}>
          {struck ? 'struck' : 'withheld'}
        </span>
        <span
          className="display mt-1 text-[19px]"
          style={{ color: stroke, letterSpacing: '0.04em' }}
        >
          {struck ? 'ASSAY' : 'NO MARK'}
        </span>
        <span className="legend mt-1" style={{ color: stroke, letterSpacing: '0.18em' }}>
          {epoch === null ? '—' : `EP ${epoch}`}
        </span>
      </div>
    </div>
  );
}

/** Loud, unmissable banner. Used for the non-verifying adapter and for nothing trivial. */
export function Alarm({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      className="rise mb-8 border-y-2 px-5 py-4"
      style={{ borderColor: 'var(--alarm)', background: 'var(--alarm-wash)' }}
    >
      <div className="legend legend-strong" style={{ color: 'var(--alarm)' }}>
        {title}
      </div>
      <div className="note mt-2 max-w-[86ch]" style={{ color: 'var(--ink)' }}>
        {children}
      </div>
    </div>
  );
}

/** Quiet, factual notice. Used when something is simply not there yet. */
export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-y px-5 py-4" style={{ borderColor: 'var(--rule)' }}>
      <div className="legend legend-strong">{title}</div>
      <div className="note mt-2 max-w-[86ch]">{children}</div>
    </div>
  );
}

/**
 * A calibrated rule. Purely typographic furniture, but it sets the instrument register:
 * major ticks at the fifths, minor ticks between.
 */
export function CalibratedRule({ ticks = 40 }: { ticks?: number }) {
  return (
    <svg
      className="block w-full"
      height="9"
      viewBox={`0 0 ${ticks * 10} 9`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line x1="0" y1="0.5" x2={ticks * 10} y2="0.5" stroke="var(--rule)" strokeWidth="1" />
      {Array.from({ length: ticks + 1 }, (_, i) => (
        <line
          key={i}
          x1={i * 10}
          y1="0"
          x2={i * 10}
          y2={i % 5 === 0 ? 8 : 4}
          stroke="var(--rule)"
          strokeWidth="1"
        />
      ))}
    </svg>
  );
}
