'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoundReading, RoundView } from '@/lib/bundle';
import type { RejectReason } from '@/lib/enums';
import { formatE6, groupDigits, truncateHex } from '@/lib/format';
import { ToleranceRule } from '@/components/ToleranceRule';

/**
 * A round, replayed at reading speed.
 *
 * Driven entirely from a recorded bundle, so it runs the same way every time — no network, no
 * timing luck, nothing to go wrong in front of an audience. The sequence follows the order the
 * contract actually works in: seal the evidence, confirm the issuer committed to its digest,
 * rebuild each request from the on-chain prompt schema, take in the answers, then walk each seat
 * through signature, attestation, timestamp, freshness, answer and confidence — stopping where
 * the contract stops — before measuring the spread and either striking the mark or refusing.
 */

type Phase = 'evidence' | 'commitment' | 'request' | 'answer' | 'checks' | 'band' | 'verdict';

/**
 * The per-member checks, in the order the contract actually performs them. Freshness is settled
 * before the answer is read, so a stale response is dropped without its content ever being
 * parsed — and the timeline has to say so, or it teaches the wrong mental model.
 */
const CHECKS: {
  label: string;
  fails: RejectReason[];
  passed: (r: RoundReading) => string;
  failed: (r: RoundReading) => string;
}[] = [
  {
    label: 'Signature recovered',
    fails: ['BadSignature', 'DuplicateSlot'],
    passed: (r) => `${truncateHex(r.signer ?? '0x', 10, 6)} from ${r.signedText?.length ?? 129} signed characters`,
    failed: (r) => (r.rejectReason === 'DuplicateSlot' ? 'two answers claimed this seat' : 'recovers to nothing'),
  },
  {
    label: 'Key attested',
    fails: ['UnknownSigner', 'SignerExpired', 'SignerRevoked', 'WrongModel'],
    passed: (r) => `registered for ${r.model}`,
    failed: (r) => (r.rejectReason ?? 'UnknownSigner'),
  },
  {
    label: 'Timestamp read',
    fails: ['NoTimestamp'],
    passed: () => 'created field present in the signed bytes',
    failed: () => 'no readable timestamp — age cannot be established',
  },
  {
    label: 'Within freshness window',
    fails: ['Stale'],
    passed: () => 'inside the window this asset allows',
    failed: () => 'older than the freshness window',
  },
  {
    label: 'Answer parsed',
    fails: ['Truncated', 'Malformed', 'OutOfRange'],
    passed: (r) => (r.navE6 !== null ? `nav ${formatE6(r.navE6)}` : 'parsed'),
    failed: (r) => (r.rejectReason ?? 'Malformed'),
  },
  {
    label: 'Confidence at floor',
    fails: ['LowConfidence'],
    passed: (r) => `${r.confidenceBps} bps`,
    failed: (r) => `${r.confidenceBps ?? 0} bps, below the floor`,
  },
];

interface Step {
  phase: Phase;
  slot: number | null;
  label: string;
  detail: string;
  failed: boolean;
}

const PHASES: { key: Phase; label: string }[] = [
  { key: 'evidence', label: 'Evidence' },
  { key: 'commitment', label: 'Commitment' },
  { key: 'request', label: 'Request' },
  { key: 'answer', label: 'Answers' },
  { key: 'checks', label: 'Checks' },
  { key: 'band', label: 'Band' },
  { key: 'verdict', label: 'Verdict' },
];

const TEMPO_MS = 460;

function buildSteps(round: RoundView): Step[] {
  const steps: Step[] = [];
  const ev = round.bundle.evidence;

  steps.push({
    phase: 'evidence',
    slot: null,
    label: 'Evidence sealed',
    detail: `${ev.byteLength} bytes · sha256 ${truncateHex(`0x${ev.evidenceSha256}`, 12, 8)}`,
    failed: false,
  });

  const commitment = round.bundle.onChain?.evidenceCommitment;
  steps.push({
    phase: 'commitment',
    slot: null,
    label: commitment?.committed
      ? 'Prior commitment confirmed'
      : commitment
        ? 'Evidence was never committed'
        : 'Prior commitment assumed',
    detail: commitment?.committed
      ? commitment.txHash
        ? `committed by the issuer in ${truncateHex(commitment.txHash, 10, 6)}`
        : 'committed by the issuer before the round ran'
      : commitment
        ? 'the round reverts with EvidenceNotCommitted'
        : 'no commitment record in this bundle',
    failed: commitment !== undefined && !commitment.committed,
  });

  for (const r of round.readings) {
    steps.push({
      phase: 'request',
      slot: r.slot,
      label: `Request rebuilt · slot ${r.slot}`,
      detail: `${r.model} · sha256 ${truncateHex(`0x${r.requestSha256}`, 10, 6)}`,
      failed: false,
    });
  }

  // Answers arrive in the order the enclaves actually returned them.
  const byLatency = [...round.readings].sort((a, b) => a.latencyMs - b.latencyMs);
  for (const r of byLatency) {
    steps.push({
      phase: 'answer',
      slot: r.slot,
      label: `Answer received · slot ${r.slot}`,
      detail: `${(r.latencyMs / 1000).toFixed(2)} s · ${r.responseBody.length} bytes`,
      failed: false,
    });
  }

  // Each seat is walked through the checks in contract order and stops at the first failure,
  // because that is exactly where the contract stops.
  for (const r of round.readings) {
    for (const check of CHECKS) {
      const fails = r.rejectReason !== null && check.fails.includes(r.rejectReason);
      steps.push({
        phase: 'checks',
        slot: r.slot,
        label: `Slot ${r.slot} · ${check.label}${fails ? ' — refused' : ''}`,
        detail: fails ? check.failed(r) : check.passed(r),
        failed: fails,
      });
      if (fails) break;
    }
  }

  steps.push({
    phase: 'band',
    slot: null,
    label: 'Spread measured',
    detail:
      round.medianE6 !== null
        ? `median ${formatE6(round.medianE6)} · widest ${groupDigits(String(round.maxDeviationBps ?? 0))} bps of ${groupDigits(String(round.policy.bandBps))}`
        : 'no median — nothing survived verification',
    failed: (round.maxDeviationBps ?? 0) > round.policy.bandBps,
  });

  steps.push({
    phase: 'verdict',
    slot: null,
    label: round.published ? 'Mark struck' : round.ignored ? 'Round ignored' : 'Publication refused',
    detail: round.published
      ? `nav ${formatE6(round.navE6!)} written at epoch ${round.epoch ?? '—'}`
      : round.ignored
        ? 'too little of the round was authentic to act on · no state written'
        : `${round.haltReason} recorded · no price written`,
    failed: !round.published,
  });

  return steps;
}

export function RoundTimeline({ round }: { round: RoundView }) {
  const steps = useMemo(() => buildSteps(round), [round]);
  const [cursor, setCursor] = useState(steps.length);
  const [playing, setPlaying] = useState(false);
  const [shownRound, setShownRound] = useState(round.bundle.bundleId);
  const logRef = useRef<HTMLDivElement>(null);

  // Selecting a different round resets the replay. Adjusting during render rather than in an
  // effect avoids a frame where the new round is on screen at the old round's cursor.
  if (shownRound !== round.bundle.bundleId) {
    setShownRound(round.bundle.bundleId);
    setCursor(steps.length);
    setPlaying(false);
  }

  const finished = cursor >= steps.length;

  useEffect(() => {
    if (!playing || finished) return;
    const id = setTimeout(() => setCursor((c) => c + 1), TEMPO_MS);
    return () => clearTimeout(id);
  }, [playing, finished, cursor]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [cursor]);

  const visible = steps.slice(0, cursor);
  const currentPhase = visible.length ? visible[visible.length - 1]!.phase : null;
  const phaseIndex = currentPhase ? PHASES.findIndex((p) => p.key === currentPhase) : -1;

  // Needles only appear once their answer has been parsed, so the rule fills in as it goes.
  const settledSlots = new Set(
    visible.filter((s) => s.phase === 'checks' || s.phase === 'band' || s.phase === 'verdict').map((s) => s.slot),
  );
  const bandReached = visible.some((s) => s.phase === 'band');
  const verdictReached = visible.some((s) => s.phase === 'verdict');

  const shown: RoundReading[] = bandReached
    ? round.readings
    : round.readings.filter((r) => settledSlots.has(r.slot));

  const replay = () => {
    setCursor(0);
    setPlaying(true);
  };

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4 pb-3">
        <h2 className="legend legend-strong">
          <span style={{ color: 'var(--ink-4)' }}>V</span>
          <span className="mx-2" style={{ color: 'var(--ink-4)' }}>
            —
          </span>
          Round replay
        </h2>
        <div className="flex items-center gap-2">
          <button className="control" onClick={replay}>
            Replay round
          </button>
          <button
            className="control"
            onClick={() => (finished ? replay() : setPlaying((p) => !p))}
            disabled={finished}
          >
            {playing ? 'Pause' : 'Resume'}
          </button>
          <button className="control" onClick={() => { setPlaying(false); setCursor(steps.length); }}>
            Show all
          </button>
        </div>
      </div>

      {/* Phase rail: a calibrated track with the head travelling along it. */}
      <div className="relative pb-1 pt-2">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${PHASES.length}, 1fr)` }}>
          {PHASES.map((p, i) => {
            const reached = i <= phaseIndex;
            const isVerdict = p.key === 'verdict';
            const alarm = isVerdict && verdictReached && !round.published;
            return (
              <div key={p.key} className="relative pb-2">
                <div
                  className="legend"
                  style={{
                    color: alarm ? 'var(--alarm)' : reached ? 'var(--ink)' : 'var(--ink-4)',
                    fontWeight: reached ? 600 : 400,
                  }}
                >
                  {String(i + 1).padStart(2, '0')} {p.label}
                </div>
              </div>
            );
          })}
        </div>
        <div className="relative h-[3px]" style={{ background: 'var(--rule)' }}>
          <div
            className="absolute left-0 top-0 h-full transition-[width] duration-300 ease-out"
            style={{
              width: `${(Math.max(0, phaseIndex + 1) / PHASES.length) * 100}%`,
              background: verdictReached && !round.published ? 'var(--alarm)' : 'var(--ink)',
            }}
          />
        </div>
        <div className="grid" style={{ gridTemplateColumns: `repeat(${PHASES.length}, 1fr)` }}>
          {PHASES.map((p, i) => (
            <div key={p.key} className="h-2" style={{ borderLeft: `1px solid ${i <= phaseIndex ? 'var(--ink)' : 'var(--rule)'}` }} />
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div>
          {shown.length > 0 && round.medianE6 !== null ? (
            <ToleranceRule
              readings={shown}
              bandBps={round.policy.bandBps}
              medianE6={round.medianE6}
              published={verdictReached ? round.published : true}
            />
          ) : (
            <div className="flex h-[220px] items-center">
              <p className="note">
                The rule is empty until answers have been verified and parsed. Nothing is plotted on
                trust.
              </p>
            </div>
          )}
        </div>

        <div>
          <div className="legend pb-2" style={{ borderBottom: '1px solid var(--rule)' }}>
            Record of proceedings
          </div>
          <div ref={logRef} className="max-h-[300px] overflow-y-auto">
            <div className="ruled">
              {visible.map((s, i) => (
                <div key={i} className="rise flex items-baseline gap-3 py-2">
                  <span className="figure shrink-0 text-[11px]" style={{ color: 'var(--ink-4)' }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block text-[12.5px] leading-tight"
                      style={{ color: s.failed ? 'var(--alarm)' : 'var(--ink)', fontWeight: s.failed ? 600 : 500 }}
                    >
                      {s.label}
                    </span>
                    <span className="hex mt-0.5 block" style={{ color: 'var(--ink-3)' }}>
                      {s.detail}
                    </span>
                  </span>
                </div>
              ))}
              {visible.length === 0 ? (
                <p className="note py-3">Press replay to run the round from the beginning.</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
