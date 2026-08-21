'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/state/AppContext';
import { RoundPicker } from '@/components/RoundPicker';
import {
  AddressRef,
  Caption,
  Notice,
  SectionHead,
  Spec,
  SpecRow,
  TxRef,
} from '@/components/primitives';
import { reconstructRequests, type ReconstructedRequest } from '@/lib/oracle';
import { rpcErrorMessage } from '@/lib/rpc';
import { formatTimestamp, relativeAge, truncateHex } from '@/lib/format';
import type { RoundReading } from '@/lib/bundle';

/**
 * Section III — the evidence, and the question.
 *
 * The prompt is not a configuration file somewhere; it is stored in the asset registry as byte
 * fragments, and the oracle concatenates them itself on every round. So the question the
 * models were asked is on chain, immutable, and shown here split into the parts that came
 * from the registry and the one part that varied.
 */
export default function EvidencePage() {
  const { round, deployment, chainId } = useApp();
  const [onChain, setOnChain] = useState<ReconstructedRequest[] | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [slot, setSlot] = useState(0);

  const evidence = round?.bundle.evidence;

  useEffect(() => {
    if (!deployment || !round || !evidence) return;
    let cancelled = false;
    reconstructRequests(deployment, evidence.line, round.readings.map((r) => r.model))
      .then((r) => !cancelled && setOnChain(r))
      .catch((e) => !cancelled && setChainError(rpcErrorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [deployment, round, evidence]);

  const reading = round?.readings.find((r) => r.slot === slot) ?? round?.readings[0];
  const parts = useMemo(
    () => (reading && evidence ? splitRequest(reading, evidence.line) : null),
    [reading, evidence],
  );

  if (!round || !evidence || !reading || !parts) {
    return <Notice title="No round selected">There is no recorded evidence to display.</Notice>;
  }

  const matchesChain = onChain
    ? onChain.find((r) => r.slot === reading.slot)?.request === reading.requestBody
    : null;

  const commitment = round.bundle.onChain?.evidenceCommitment ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 pb-6">
        <div>
          <div className="legend">The record the committee was shown</div>
          <h2 className="display mt-1.5 text-[26px]" style={{ fontWeight: 700 }}>
            Evidence &amp; reconstructed request
          </h2>
        </div>
        <RoundPicker />
      </div>

      <hr className="rule-heavy" />

      {/* ---- the evidence bytes ----------------------------------------------------------- */}
      <section className="py-10">
        <SectionHead
          index="I"
          title="Evidence document"
          aside={<>{evidence.byteLength} bytes · one line · printable ascii only</>}
        />
        <Caption>
          One line of ordered key-value pairs, restricted to characters that need no escaping
          inside a JSON string. That constraint is what makes the bytes on chain, the bytes on the
          wire and the bytes inside the request literally identical rather than merely equivalent.
        </Caption>

        <div
          className="mt-6 border-y px-5 py-5"
          style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }}
        >
          <EvidenceFields line={evidence.line} />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-3">
          <Spec label="sha256 of the record">
            <span className="hex">0x{evidence.evidenceSha256}</span>
          </Spec>
          <Spec label="sha256 stored by the contract">
            <span className="hex">0x{evidence.lineSha256}</span>
          </Spec>
          <Spec label="Echoed back by">
            {round.accepted.length} of {round.readings.length} members
          </Spec>
        </div>
      </section>

      <hr className="rule" />

      {/* ---- the prior commitment ---------------------------------------------------------- */}
      <section className="py-10">
        <SectionHead
          index="II"
          title="Prior commitment"
          aside={
            commitment === null
              ? 'no record in this bundle'
              : commitment.committed
                ? 'committed before the round ran'
                : 'never committed'
          }
        />
        <hr className="rule mb-7" />

        <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div>
            <p className="note max-w-[56ch]" style={{ color: 'var(--ink)' }}>
              The issuer commits to <em>what the evidence is</em>. The committee decides{' '}
              <em>what it is worth</em>. The chain checks both, and refuses a round whose evidence
              digest was not published in advance.
            </p>
            <p className="note mt-3 max-w-[56ch]">
              Without that split, whoever posts a round could choose the evidence after seeing which
              answers it produced — running the appraisal repeatedly and keeping the document that
              gave the number they wanted. Commitment is mandatory: an uncommitted digest reverts
              with <span className="hex" style={{ color: 'var(--alarm)' }}>EvidenceNotCommitted</span>{' '}
              before a single signature is checked.
            </p>
          </div>

          <div>
            <div
              className="border-y px-5 py-5"
              style={{
                borderColor: commitment?.committed === false ? 'var(--alarm)' : 'var(--rule)',
                background:
                  commitment?.committed === false ? 'var(--alarm-wash)' : 'var(--paper-raised)',
              }}
            >
              <div className="legend legend-strong" style={{ color: 'var(--seal)' }}>
                Committed digest
              </div>
              <p className="hex mt-2 leading-relaxed" style={{ color: 'var(--ink)', fontWeight: 600 }}>
                0x{evidence.evidenceSha256}
              </p>

              <div className="mt-5 ruled">
                <SpecRow label="Status" alarm={commitment?.committed === false}>
                  {commitment === null
                    ? 'not recorded'
                    : commitment.committed
                      ? 'committed'
                      : 'never committed'}
                </SpecRow>
                <SpecRow label="Committed by">
                  {commitment ? (
                    <AddressRef chainId={chainId} address={commitment.issuer} />
                  ) : (
                    '—'
                  )}
                </SpecRow>
                <SpecRow label="In transaction">
                  {commitment ? <TxRef chainId={chainId} hash={commitment.txHash} /> : '—'}
                </SpecRow>
                <SpecRow label="Committed at">
                  {commitment?.timestamp ? formatTimestamp(commitment.timestamp) : '—'}
                </SpecRow>
                <SpecRow label="Ahead of the round by">
                  {commitment?.timestamp && round.bundle.onChain?.timestamp
                    ? relativeAge(round.bundle.onChain.timestamp - commitment.timestamp)
                    : '—'}
                </SpecRow>
                <SpecRow label="Document">
                  <span className="hex">{commitment?.uri ?? '—'}</span>
                </SpecRow>
              </div>
            </div>
          </div>
        </div>
      </section>

      <hr className="rule" />

      {/* ---- the reconstructed request ----------------------------------------------------- */}
      <section className="py-10">
        <SectionHead
          index="III"
          title="Reconstructed request"
          aside={
            <div className="flex items-center gap-2">
              <span className="legend">Slot</span>
              {round.readings.map((r) => (
                <button
                  key={r.slot}
                  className="control"
                  data-active={r.slot === reading.slot}
                  onClick={() => setSlot(r.slot)}
                >
                  {r.slot}
                </button>
              ))}
            </div>
          }
        />
        <Caption>
          The exact bytes the contract hashes for slot {reading.slot}. The registry holds{' '}
          <span className="hex" style={{ color: 'var(--ink)' }}>
            head
          </span>
          ,{' '}
          <span className="hex" style={{ color: 'var(--ink)' }}>
            mid
          </span>{' '}
          and{' '}
          <span className="hex" style={{ color: 'var(--ink)' }}>
            tail
          </span>{' '}
          immutably; the model id is fixed by the committee seat; only the evidence varies. A relayer
          cannot reword the question, because the question is never handed to the contract.
        </Caption>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <Swatch colour="var(--ink-3)" label="head · registry" />
          <Swatch colour="var(--seal)" label="model id · committee seat" />
          <Swatch colour="var(--ink-2)" label="mid · system and user prompt, on chain" />
          <Swatch colour="var(--alarm)" label="evidence · the only variable payload" />
          <Swatch colour="var(--ink-3)" label="tail · registry" />
        </div>

        <pre
          className="hex mt-5 max-h-[26rem] overflow-auto whitespace-pre-wrap border-y px-5 py-5 leading-relaxed"
          style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }}
        >
          <span style={{ color: 'var(--ink-3)' }}>{parts.head}</span>
          <span style={{ color: 'var(--seal)', fontWeight: 700, background: 'var(--seal-wash)' }}>
            {parts.model}
          </span>
          <span style={{ color: 'var(--ink-2)' }}>{parts.mid}</span>
          <span style={{ color: 'var(--alarm)', fontWeight: 600, background: 'var(--alarm-wash)' }}>
            {parts.evidence}
          </span>
          <span style={{ color: 'var(--ink-3)' }}>{parts.tail}</span>
        </pre>

        <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-3">
          <Spec label="Rebuilt on chain">
            {!deployment
              ? 'not deployed — shown from record'
              : chainError
                ? chainError
                : matchesChain === null
                  ? 'reading…'
                  : matchesChain
                    ? 'byte-for-byte identical'
                    : 'differs from record'}
          </Spec>
          <Spec label="sha256 of request">
            <span className="hex">{truncateHex(`0x${reading.requestSha256}`, 14, 10)}</span>
          </Spec>
          <Spec label="sha256 of response">
            <span className="hex">{truncateHex(`0x${reading.responseSha256}`, 14, 10)}</span>
          </Spec>
        </div>
      </section>

      <hr className="rule" />

      {/* ---- what was signed --------------------------------------------------------------- */}
      <section className="py-10">
        <SectionHead index="IV" title="What the enclave signed" aside={<>129 characters, exactly</>} />
        <Caption>
          Not the answer, and not the question — the two digests joined by a colon. The contract
          recomputes both halves from bytes it holds and recovers a signer from the result, so a
          signature only ever attests to this precise pairing of question and answer.
        </Caption>
        <div
          className="mt-6 border-y px-5 py-5"
          style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }}
        >
          <p className="hex leading-relaxed">
            <span style={{ color: 'var(--ink-4)' }}>{'\\x19Ethereum Signed Message:\\n129'}</span>
            <br />
            <span style={{ color: 'var(--ink)' }}>{reading.signedText?.slice(0, 64)}</span>
            <span style={{ color: 'var(--alarm)', fontWeight: 700 }}>:</span>
            <span style={{ color: 'var(--ink-2)' }}>{reading.signedText?.slice(65)}</span>
          </p>
        </div>
        <div className="mt-6">
          <Spec label="Signature">
            <span className="hex">{reading.signature ?? 'none produced'}</span>
          </Spec>
        </div>
      </section>

      <hr className="rule" />

      {/* ---- the raw answer ---------------------------------------------------------------- */}
      <section className="py-10">
        <SectionHead
          index="V"
          title="Raw response"
          aside={<>slot {reading.slot} · {reading.responseBody.length} bytes</>}
        />
        <Caption>
          The response exactly as the gateway returned it. The contract parses this strictly: the
          marker line must begin immediately after{' '}
          <span className="hex" style={{ color: 'var(--ink)' }}>
            &quot;content&quot;:&quot;
          </span>{' '}
          and the closing quote must follow the last digit. A sentence of preamble is enough to have
          the whole answer refused.
        </Caption>
        <pre
          className="hex mt-6 max-h-[20rem] overflow-auto whitespace-pre-wrap border-y px-5 py-5 leading-relaxed"
          style={{
            borderColor: reading.accepted ? 'var(--rule)' : 'var(--alarm-rule)',
            background: reading.accepted ? 'var(--paper-raised)' : 'var(--alarm-wash)',
          }}
        >
          {reading.responseBody}
        </pre>
      </section>
    </div>
  );
}

function Swatch({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="inline-block h-[3px] w-6" style={{ background: colour }} />
      <span className="legend">{label}</span>
    </span>
  );
}

/**
 * Splits the request back into the fragments it was assembled from. The evidence line is
 * unique inside the document, so locating it is enough to recover every boundary.
 */
function splitRequest(reading: RoundReading, evidenceLine: string) {
  const body = reading.requestBody;
  const iEv = body.indexOf(evidenceLine);
  if (iEv < 0) return { head: '', model: '', mid: body, evidence: '', tail: '' };

  const prefix = body.slice(0, iEv);
  const iModel = prefix.indexOf(reading.model);

  return {
    head: iModel < 0 ? prefix : prefix.slice(0, iModel),
    model: iModel < 0 ? '' : reading.model,
    mid: iModel < 0 ? '' : prefix.slice(iModel + reading.model.length),
    evidence: evidenceLine,
    tail: body.slice(iEv + evidenceLine.length),
  };
}

/** The evidence line as a ruled table, without altering a byte of it. */
function EvidenceFields({ line }: { line: string }) {
  const fields = line.split(';').map((pair) => {
    const i = pair.indexOf('=');
    return i < 0 ? { key: pair, value: '' } : { key: pair.slice(0, i), value: pair.slice(i + 1) };
  });

  return (
    <div className="grid gap-x-10 md:grid-cols-2">
      {fields.map((f, i) => (
        <div
          key={`${f.key}-${i}`}
          className="flex items-baseline justify-between gap-6 py-[5px]"
          style={{ borderTop: i > 1 ? '1px solid var(--rule-fine)' : undefined }}
        >
          <span className="legend shrink-0">{f.key.replace(/_/g, ' ')}</span>
          <span
            className="hex text-right"
            style={f.key === 'evidence_sha256' ? { color: 'var(--seal)', fontWeight: 600 } : undefined}
          >
            {f.value}
          </span>
        </div>
      ))}
    </div>
  );
}
