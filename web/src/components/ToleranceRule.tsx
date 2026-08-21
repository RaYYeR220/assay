'use client';

import { useMemo } from 'react';
import type { RoundReading } from '@/lib/bundle';
import { bpsToPercent, formatE6, groupDigits } from '@/lib/format';

/**
 * The agreement band, drawn as a measuring rule with a tolerance gate.
 *
 * Deviation from the median runs along the rule in basis points. Two hard posts stand at the
 * band edge. Every verified answer drops a needle onto the rule. If all the needles land
 * between the posts the gate closes and the valuation is struck; if even one lands beyond a
 * post the gate cannot close, and that is the whole of the refusal, visible in one glance.
 *
 * When a reading is far outside the band the rule takes a scale break rather than compressing
 * the cluster into a single smudge — the point is to see both that the four agreed and that
 * the fifth was nowhere near them.
 */

const W = 1000;
const H = 214;
const AXIS_Y = 132;
const NEEDLE_TOP = 60;

/** Fraction of the rule given to the in-band region when a break is needed. */
const INNER_SHARE = 0.74;

interface Scale {
  /** Maps a deviation in basis points to an x coordinate. */
  x: (bps: number) => number;
  /** Half-width of the linear region, in basis points. */
  domain: number;
  breakAt: { left: number | null; right: number | null };
}

function buildScale(bandBps: number, deviations: number[]): Scale {
  const domain = Math.max(bandBps * 1.65, 10);
  const maxRight = Math.max(0, ...deviations);
  const maxLeft = Math.min(0, ...deviations);

  const overRight = maxRight > domain;
  const overLeft = -maxLeft > domain;
  const breaks = (overLeft ? 1 : 0) + (overRight ? 1 : 0);

  const pad = 26;
  const usable = W - pad * 2;
  const innerWidth = breaks === 0 ? usable : usable * INNER_SHARE;
  const outerWidth = breaks === 0 ? 0 : (usable - innerWidth) / breaks;

  const innerStart = pad + (overLeft ? outerWidth : 0);
  const innerEnd = innerStart + innerWidth;

  const rightTail = Math.max(maxRight, domain * 1.02);
  const leftTail = Math.min(maxLeft, -domain * 1.02);

  return {
    domain,
    breakAt: {
      left: overLeft ? innerStart - outerWidth * 0.32 : null,
      right: overRight ? innerEnd + outerWidth * 0.32 : null,
    },
    x(bps: number) {
      if (bps > domain) {
        const t = (bps - domain) / Math.max(1, rightTail - domain);
        return innerEnd + outerWidth * (0.55 + 0.42 * t);
      }
      if (bps < -domain) {
        const t = (-bps - domain) / Math.max(1, -leftTail - domain);
        return innerStart - outerWidth * (0.55 + 0.42 * t);
      }
      return innerStart + ((bps + domain) / (2 * domain)) * innerWidth;
    },
  };
}

export function ToleranceRule({
  readings,
  bandBps,
  medianE6,
  published,
}: {
  readings: RoundReading[];
  bandBps: number;
  medianE6: bigint | null;
  published: boolean;
}) {
  const valued = readings.filter((r) => r.navE6 !== null && r.deviationBps !== null);
  const missing = readings.filter((r) => r.navE6 === null || r.deviationBps === null);

  const scale = useMemo(
    () => buildScale(bandBps, valued.map((r) => r.deviationBps!)),
    [bandBps, valued],
  );

  // Needles that land close together are stepped onto alternating tiers, so a tight cluster
  // reads as a comb of pins rather than as one smudged mark with its labels on top of itself.
  const placed = useMemo(() => {
    const MIN_GAP = 40;
    // Greedy: take the lowest tier whose last needle is far enough to the left.
    const lastX: number[] = [];
    return [...valued]
      .map((reading) => ({ reading, x: scale.x(reading.deviationBps!) }))
      .sort((a, b) => a.x - b.x)
      .map((entry) => {
        let tier = 0;
        while (lastX[tier] !== undefined && entry.x - lastX[tier]! < MIN_GAP) tier += 1;
        lastX[tier] = entry.x;
        return { ...entry, tier };
      });
  }, [valued, scale]);

  if (medianE6 === null) {
    return (
      <div className="py-10">
        <p className="note">
          No answer survived verification, so there is no median to measure against and nothing to
          plot. The rule is blank because the round produced nothing, not because it failed to load.
        </p>
      </div>
    );
  }

  const postL = scale.x(-bandBps);
  const postR = scale.x(bandBps);
  const gateClosed = published;
  const alarm = 'var(--alarm)';

  // Minor ticks every tenth of the band, major every half band, across the linear region.
  const minorStep = bandBps / 5;
  const ticks: { bps: number; major: boolean }[] = [];
  for (let v = 0; v <= scale.domain; v += minorStep) {
    const major = Math.abs(v % (bandBps / 2)) < 1e-6;
    ticks.push({ bps: v, major });
    if (v > 0) ticks.push({ bps: -v, major });
  }

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        style={{ height: 'auto' }}
        role="img"
        aria-label={
          gateClosed
            ? `All ${valued.length} verified answers fall inside the ${bandBps} basis point agreement band.`
            : `One or more answers fall outside the ${bandBps} basis point agreement band, so the gate cannot close.`
        }
      >
        <defs>
          <pattern id="band-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--ink)" strokeWidth="0.5" opacity="0.09" />
          </pattern>
        </defs>

        {/* In-band region: the space the committee is allowed to occupy. */}
        <rect x={postL} y={NEEDLE_TOP - 18} width={postR - postL} height={AXIS_Y - NEEDLE_TOP + 18} fill="url(#band-hatch)" />

        {/* The rule itself. */}
        <line x1={16} y1={AXIS_Y} x2={W - 16} y2={AXIS_Y} stroke="var(--ink)" strokeWidth="1.25" />

        {/* Calibration. */}
        {ticks.map(({ bps, major }) => {
          const x = scale.x(bps);
          return (
            <g key={`t${bps}`}>
              <line
                x1={x}
                y1={AXIS_Y}
                x2={x}
                y2={AXIS_Y + (major ? 9 : 4.5)}
                stroke="var(--ink-3)"
                strokeWidth={major ? 1 : 0.75}
              />
              {major && bps !== 0 ? (
                <text
                  x={x}
                  y={AXIS_Y + 24}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--ink-4)"
                  letterSpacing="0.08em"
                >
                  {bps > 0 ? `+${bps}` : bps}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* Scale break: two struck slashes where the rule stops being continuous. */}
        {scale.breakAt.right !== null ? <ScaleBreak x={scale.breakAt.right} /> : null}
        {scale.breakAt.left !== null ? <ScaleBreak x={scale.breakAt.left} /> : null}

        {/* The gate posts. Heavy when they hold, struck in alarm when they cannot close. */}
        <GatePost x={postL} closed={gateClosed} side="left" bandBps={bandBps} />
        <GatePost x={postR} closed={gateClosed} side="right" bandBps={bandBps} />

        {/* Median datum. */}
        <line
          x1={scale.x(0)}
          y1={NEEDLE_TOP - 38}
          x2={scale.x(0)}
          y2={AXIS_Y}
          stroke="var(--ink)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        {/* Set to the left of the datum so a needle sitting on the median cannot cover it. */}
        <text
          x={scale.x(0) - 10}
          y={NEEDLE_TOP - 44}
          textAnchor="end"
          fontSize="10.5"
          fill="var(--ink)"
          letterSpacing="0.12em"
          fontWeight="600"
        >
          MEDIAN {formatE6(medianE6)}
        </text>

        {/* One needle per verified answer, stepped so a tight cluster stays readable. */}
        {placed.map(({ reading: r, x, tier }, i) => {
          const out = r.outsideBand;
          const colour = out ? alarm : 'var(--ink)';
          const top = NEEDLE_TOP - Math.min(tier, 3) * 15;
          return (
            <g key={r.slot} className="sweep" style={{ animationDelay: `${140 + i * 70}ms` }}>
              <line x1={x} y1={top} x2={x} y2={AXIS_Y} stroke={colour} strokeWidth={out ? 1.75 : 1.1} />
              <circle cx={x} cy={top} r={out ? 5 : 3.6} fill={colour} />
              {out ? <circle cx={x} cy={top} r={9} fill="none" stroke={alarm} strokeWidth="1" opacity="0.5" /> : null}
              <text
                x={x}
                y={top - 10}
                textAnchor="middle"
                fontSize="10"
                fill={colour}
                fontWeight={out ? 700 : 500}
                letterSpacing="0.06em"
              >
                {r.slot}
              </text>
              <text
                x={x}
                y={AXIS_Y + 38 + Math.min(tier, 3) * 12}
                textAnchor="middle"
                fontSize="9.5"
                fill={out ? alarm : 'var(--ink-3)'}
                fontWeight={out ? 700 : 400}
              >
                {r.deviationBps! > 0 ? `+${groupDigits(String(r.deviationBps))}` : groupDigits(String(r.deviationBps))}
              </text>
            </g>
          );
        })}

        {/* Answers that never produced a value sit in a gutter, present but unmeasurable. */}
        {missing.map((r, i) => {
          const x = 34 + i * 22;
          return (
            <g key={`m${r.slot}`} opacity="0.8">
              <line x1={x} y1={AXIS_Y - 22} x2={x} y2={AXIS_Y} stroke={alarm} strokeWidth="1" strokeDasharray="2 3" />
              <line x1={x - 4} y1={AXIS_Y - 26} x2={x + 4} y2={AXIS_Y - 18} stroke={alarm} strokeWidth="1.25" />
              <line x1={x - 4} y1={AXIS_Y - 18} x2={x + 4} y2={AXIS_Y - 26} stroke={alarm} strokeWidth="1.25" />
              <text x={x} y={AXIS_Y - 32} textAnchor="middle" fontSize="9.5" fill={alarm} fontWeight="600">
                {r.slot}
              </text>
            </g>
          );
        })}

        {missing.length > 0 ? (
          <text x={34 + missing.length * 22 + 6} y={AXIS_Y - 6} fontSize="9.5" fill={alarm} letterSpacing="0.1em">
            NO READING
          </text>
        ) : null}
      </svg>

      <figcaption className="note mt-3">
        {gateClosed ? (
          <>
            All {valued.length} verified answers land inside the tolerance posts. The widest is{' '}
            {groupDigits(String(Math.max(...valued.map((r) => Math.abs(r.deviationBps!)))))} basis
            points from the median against a {groupDigits(String(bandBps))} basis point band, so the
            gate closes and the mark is struck.
          </>
        ) : (
          <>
            The gate cannot close. {valued.filter((r) => r.outsideBand).length === 0
              ? `Only ${valued.length} answer${valued.length === 1 ? '' : 's'} survived verification, short of the quorum this asset requires.`
              : `${valued.filter((r) => r.outsideBand).length} reading${valued.filter((r) => r.outsideBand).length === 1 ? ' sits' : 's sit'} beyond the post at ${bpsToPercent(bandBps)} from the median.`}{' '}
            The contract published nothing.
          </>
        )}
      </figcaption>
    </figure>
  );
}

function GatePost({
  x,
  closed,
  side,
  bandBps,
}: {
  x: number;
  closed: boolean;
  side: 'left' | 'right';
  bandBps: number;
}) {
  const colour = closed ? 'var(--ink)' : 'var(--alarm)';
  const dir = side === 'left' ? 1 : -1;
  return (
    <g>
      <line x1={x} y1={NEEDLE_TOP - 22} x2={x} y2={AXIS_Y + 14} stroke={colour} strokeWidth="2.5" />
      {/* The arm that swings shut. When it cannot, it stops short and is struck. */}
      <line
        x1={x}
        y1={NEEDLE_TOP - 22}
        x2={x + dir * 16}
        y2={NEEDLE_TOP - 22}
        stroke={colour}
        strokeWidth="2.5"
      />
      <text
        x={x + dir * 6}
        y={NEEDLE_TOP - 30}
        textAnchor={side === 'left' ? 'start' : 'end'}
        fontSize="9.5"
        fill={colour}
        letterSpacing="0.14em"
        fontWeight="600"
      >
        {side === 'left' ? `-${bandBps}` : `+${bandBps}`} BPS
      </text>
      {/* An arm that cannot close is struck at its tip. */}
      {!closed ? (
        <>
          <line
            x1={x + dir * 16 - 5}
            y1={NEEDLE_TOP - 27}
            x2={x + dir * 16 + 5}
            y2={NEEDLE_TOP - 17}
            stroke="var(--alarm)"
            strokeWidth="1.75"
          />
          <line
            x1={x + dir * 16 - 5}
            y1={NEEDLE_TOP - 17}
            x2={x + dir * 16 + 5}
            y2={NEEDLE_TOP - 27}
            stroke="var(--alarm)"
            strokeWidth="1.75"
          />
        </>
      ) : null}
    </g>
  );
}

/** The conventional draughting mark for a rule that is not continuous. */
function ScaleBreak({ x }: { x: number }) {
  return (
    <g>
      <rect x={x - 7} y={AXIS_Y - 9} width="14" height="18" fill="var(--paper)" />
      <line x1={x - 6} y1={AXIS_Y + 8} x2={x - 1} y2={AXIS_Y - 8} stroke="var(--ink-3)" strokeWidth="1" />
      <line x1={x + 1} y1={AXIS_Y + 8} x2={x + 6} y2={AXIS_Y - 8} stroke="var(--ink-3)" strokeWidth="1" />
    </g>
  );
}
