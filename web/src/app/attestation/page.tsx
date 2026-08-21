'use client';

import { useMemo } from 'react';
import { useApp } from '@/state/AppContext';
import { useAttestation, useDeploymentPresence, useNow } from '@/hooks/useChain';
import {
  attestationLife,
  enclaveIndependence,
  tcbIsClean,
  type AttestedSigner,
} from '@/lib/attestation';
import { AddressRef, Alarm, Caption, Notice, SectionHead, Spec, TxRef } from '@/components/primitives';
import { relativeAge, splitModelId, truncateHex } from '@/lib/format';

/**
 * Section II — the trust root.
 *
 * Nothing above this page means anything if the keys are not what they claim to be. Each key
 * is here because an Intel TDX quote was verified on chain and the address was read out of the
 * verified report data — nobody, including the contract's owner, can name a signer directly.
 *
 * The one thing that can undo all of that is a deployment still wired to the non-verifying
 * stand-in, so that is stated first, in the alarm colour, before anything else on the page.
 */
export default function AttestationPage() {
  const { chainId, round } = useApp();
  const tick = useNow();
  const presence = useDeploymentPresence();
  const attestation = useAttestation();
  const snapshot = attestation.snapshot;
  // Before the clock starts, ages are measured from the moment the snapshot itself was taken —
  // a figure baked into the page, so the markup and the first paint agree.
  const now = tick ?? snapshot?.capturedAt ?? 0;

  // Which models each key actually answered for in the round on screen.
  const servedInRound = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of round?.readings ?? []) {
      if (!r.signer) continue;
      const key = r.signer.toLowerCase();
      map.set(key, [...(map.get(key) ?? []), r.model]);
    }
    return map;
  }, [round]);

  if (!snapshot) {
    return (
      <Notice title="No attestation record">
        Nothing has been captured from the attestation registry on chain {chainId}, and no enclave
        key has been recorded for it. Once the contracts are deployed there and a quote is
        verified, this page fills in with the registry&rsquo;s own answers.
      </Notice>
    );
  }

  const untrusted = !snapshot.adapter.isTrusted;
  // A worked example is never allowed to read as the live trust root of the selected network.
  // A snapshot read out of the registry on this very chain is not an example, so a slow or
  // unreachable endpoint does not demote it — only a record from somewhere else does.
  const isFixture =
    snapshot.source === 'fixture' ||
    snapshot.chainId !== chainId ||
    presence === 'absent' ||
    presence === 'no-code';

  const independence = enclaveIndependence(snapshot);

  return (
    <div>
      <div className="pb-6">
        <div className="legend">Trust root</div>
        <h2 className="display mt-1.5 text-[26px]" style={{ fontWeight: 700 }}>
          Registered enclave keys
        </h2>
      </div>

      <hr className="rule-heavy mb-8" />

      {isFixture ? (
        <div
          className="mb-8 border-y-2 px-5 py-4"
          style={{ borderColor: 'var(--ink)', background: 'var(--paper-sunk)' }}
        >
          <div className="legend legend-strong">Worked example — not live chain data</div>
          <div className="note mt-2 max-w-[86ch]" style={{ color: 'var(--ink)' }}>
            These keys, measurements and transactions are a recorded illustration of the trust
            root, kept so the mechanism can be read without a deployment. They are not registered
            on {chainId === 196 ? 'X Layer mainnet' : 'this network'}, and nothing here should be
            taken as an attestation that exists on chain. The page switches to live registry reads
            automatically once the contracts are deployed on the selected network.
          </div>
        </div>
      ) : null}

      {untrusted ? (
        <Alarm title="This deployment is not verifying attestations">
          The attestation registry is wired to{' '}
          <span className="hex" style={{ fontWeight: 600 }}>
            {snapshot.adapter.label}
          </span>{' '}
          at <AddressRef chainId={chainId} address={snapshot.adapter.address} />, a stand-in that
          performs no cryptographic verification whatsoever. It reports{' '}
          <span className="hex">isTrusted() = false</span> precisely so that an interface can say
          this out loud. Every key listed below was accepted on an operator&rsquo;s say-so, not on
          Intel&rsquo;s. Treat the valuations on this deployment as a demonstration of the mechanism,
          not as an attested price.
        </Alarm>
      ) : (
        <div
          className="mb-8 border-y px-5 py-4"
          style={{ borderColor: 'var(--ink)', background: 'var(--seal-wash)' }}
        >
          <div className="legend legend-strong" style={{ color: 'var(--seal)' }}>
            Quotes verified on chain
          </div>
          <div className="note mt-2 max-w-[86ch]" style={{ color: 'var(--ink)' }}>
            The registry is wired to <span className="hex">{snapshot.adapter.label}</span> at{' '}
            <AddressRef chainId={chainId} address={snapshot.adapter.address} />, which reports{' '}
            <span className="hex">isTrusted() = true</span>. Every key below was admitted only after
            its Intel TDX quote was walked back to the pinned Intel root inside a transaction on
            this chain — each one linked in the record beneath.
          </div>
        </div>
      )}

      <section className="grid grid-cols-2 gap-x-8 gap-y-6 pb-8 md:grid-cols-3 lg:grid-cols-6">
        <Spec label="Adapter">
          <span className="hex">{snapshot.adapter.label}</span>
        </Spec>
        <Spec label="isTrusted()" alarm={untrusted}>
          {String(snapshot.adapter.isTrusted)}
        </Spec>
        <Spec label="Attestation lifetime">{relativeAge(snapshot.attestationTtlSec)}</Spec>
        <Spec label="Attested keys">{snapshot.signers.length}</Spec>
        <Spec label="Committee seats" alarm={independence.shared}>
          {independence.seats}
        </Spec>
        <Spec label="Read at">
          {attestation.isLive ? (
            <span style={{ color: 'var(--seal)' }}>
              live · block {snapshot.capturedAtBlock ?? '—'}
            </span>
          ) : attestation.error ? (
            <span style={{ color: 'var(--alarm)' }}>endpoint down</span>
          ) : (
            `recorded ${relativeAge(Math.max(0, now - snapshot.capturedAt))} ago`
          )}
        </Spec>
      </section>

      {/* The count of keys and the count of seats are not the same number, and that difference
          is a limit on what any of this proves. It is stated before the keys, not after them. */}
      {independence.shared ? (
        <div
          className="mb-2 border-y-2 px-5 py-4"
          style={{ borderColor: 'var(--alarm)', background: 'var(--alarm-wash)' }}
        >
          <div className="legend legend-strong" style={{ color: 'var(--alarm)' }}>
            Stated limitation · {independence.keys} attested{' '}
            {independence.keys === 1 ? 'enclave' : 'enclaves'} behind {independence.seats} committee
            seats
          </div>
          <div className="note mt-2 max-w-[86ch]" style={{ color: 'var(--ink)' }}>
            {independence.keys === 1 ? 'A single attested gateway enclave fronts' : 'Fewer attested enclaves than seats front'}{' '}
            all {independence.seats} models
            {independence.sharedMeasurement ? (
              <>
                , and every registration reports the same measurement{' '}
                <span className="hex" title={independence.sharedMeasurement}>
                  {truncateHex(independence.sharedMeasurement, 12, 8)}
                </span>
              </>
            ) : null}
            . The quotes are real and the verification is real, but what they attest is one machine
            running one image, not {independence.seats} independent ones. A committee is only as
            independent as the enclaves behind it, so the correlated-failure argument for a
            multi-model committee does not hold on this deployment: the models differ, the hardware
            does not. The registry counts distinct signing keys, which is why{' '}
            <span className="hex">minDistinctSigners</span> is the figure that actually binds here.
          </div>
        </div>
      ) : null}

      <hr className="rule" />

      <section className="py-10">
        <SectionHead
          index="I"
          title="Keys"
          aside={<>signer address · measurement · tcb · expiry</>}
        />
        <Caption>
          A confidential-inference enclave derives a secp256k1 key and binds that address into the
          report data of its own quote. Verifying the quote is therefore what pins the address: the
          registry does not accept a signer, it derives one.
        </Caption>

        <div className="mt-8 ruled">
          {snapshot.signers.map((s, i) => (
            <SignerRecord
              key={s.address}
              signer={s}
              chainId={chainId}
              ttl={snapshot.attestationTtlSec}
              now={now}
              index={i}
              usedFor={servedInRound.get(s.address.toLowerCase()) ?? []}
              untrusted={untrusted}
            />
          ))}
        </div>
      </section>

      {snapshot.allowedImages && snapshot.allowedImages.length > 0 ? (
        <>
          <hr className="rule" />
          <section className="py-10">
            <SectionHead
              index="II"
              title="Allowlisted images"
              aside={<>measurement · admitted in</>}
            />
            <Caption>
              A verified quote is not enough on its own. The registry admits a key only if the
              measurement in its quote is an image the operator allowlisted first, in its own
              transaction — so which software may answer is a decision on the record, made before
              any key was bound to it.
            </Caption>
            <div className="mt-6 ruled">
              {snapshot.allowedImages.map((image) => (
                <div
                  key={image.txHash}
                  className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 py-4"
                >
                  <span className="hex" title={image.measurement} style={{ fontWeight: 600 }}>
                    {truncateHex(image.measurement, 16, 10)}
                  </span>
                  <span className="legend" style={{ color: 'var(--ink-4)' }}>
                    {image.allowed ? 'allowed' : 'withdrawn'} in{' '}
                    <TxRef chainId={chainId} hash={image.txHash} /> · block {image.blockNumber}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}

      <hr className="rule" />

      <section className="py-10">
        <SectionHead index="III" title="Report data layout" />
        <Caption>
          The 64 bytes an enclave binds into its quote. The first twenty are the signing address the
          registry reads back out at offset {snapshot.signerOffset}; the tail carries the nonce that
          ties the accelerator evidence to the same quote.
        </Caption>
        <div className="mt-6 ruled">
          {snapshot.signers.map((s) =>
            s.reportData ? (
              <div key={s.address} className="py-4">
                <div className="legend pb-2">{truncateHex(s.address, 10, 8)}</div>
                <p className="hex leading-relaxed">
                  <span style={{ background: 'var(--seal-wash)', color: 'var(--seal)', fontWeight: 600 }}>
                    {s.reportData.slice(0, 40)}
                  </span>
                  <span style={{ color: 'var(--ink-4)' }}>{s.reportData.slice(40, 64)}</span>
                  <span style={{ color: 'var(--ink-2)' }}>{s.reportData.slice(64)}</span>
                </p>
                <div className="legend mt-2" style={{ color: 'var(--ink-4)' }}>
                  <span style={{ color: 'var(--seal)' }}>signer address</span> · padding ·{' '}
                  <span style={{ color: 'var(--ink-2)' }}>accelerator nonce</span>
                </div>
              </div>
            ) : null,
          )}
        </div>
      </section>
    </div>
  );
}

function SignerRecord({
  signer,
  chainId,
  ttl,
  now,
  index,
  usedFor,
  untrusted,
}: {
  signer: AttestedSigner;
  chainId: number;
  ttl: number;
  now: number;
  index: number;
  usedFor: string[];
  untrusted: boolean;
}) {
  const life = attestationLife(signer, ttl, now);
  const clean = tcbIsClean(signer.tcbStatus);
  const bad = life.expired || signer.revoked;

  return (
    <div className="rise py-7" style={{ animationDelay: `${100 + index * 80}ms` }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <div className="flex items-baseline gap-3">
          <span className="legend" style={{ color: 'var(--ink-4)' }}>
            Key {String(index + 1).padStart(2, '0')}
          </span>
          <span className="figure text-[17px]" style={{ fontWeight: 600 }}>
            <AddressRef chainId={chainId} address={signer.address} full />
          </span>
        </div>
        <div
          className="legend"
          style={{ color: bad ? 'var(--alarm)' : untrusted ? 'var(--alarm)' : 'var(--seal)' }}
        >
          {signer.revoked ? 'revoked' : life.expired ? 'attestation expired' : untrusted ? 'unverified stand-in' : 'live'}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-8 gap-y-5 md:grid-cols-4 lg:grid-cols-5">
        <Spec label="mrTd measurement">
          <span className="hex" title={signer.mrTd}>
            {truncateHex(signer.mrTd, 12, 8)}
          </span>
        </Spec>
        <Spec label="TCB status" alarm={!clean}>
          {signer.tcbStatusLabel}
        </Spec>
        <Spec label="Attested">{relativeAge(now - signer.attestedAt)} ago</Spec>
        <Spec label="Expires in" alarm={life.remainingSec < 86_400}>
          {life.expired ? 'expired' : relativeAge(life.remainingSec)}
        </Spec>
        <Spec label="Image allowlisted" alarm={signer.imageAllowed === false}>
          {signer.imageAllowed === undefined ? '—' : String(signer.imageAllowed)}
        </Spec>
      </div>

      {/* Attestation lifetime as a measured bar, ticked at the quarters. */}
      <div className="mt-5">
        <div className="relative h-[7px]" style={{ background: 'var(--paper-sunk)' }}>
          <div
            className="absolute left-0 top-0 h-full"
            style={{
              width: `${life.elapsed * 100}%`,
              background: life.remainingSec < 86_400 ? 'var(--alarm)' : 'var(--ink)',
            }}
          />
          {[0.25, 0.5, 0.75].map((f) => (
            <span
              key={f}
              className="absolute top-0 h-full"
              style={{ left: `${f * 100}%`, width: 1, background: 'var(--paper)' }}
            />
          ))}
        </div>
        <div className="legend mt-1.5 flex justify-between">
          <span>attested</span>
          <span style={{ color: life.remainingSec < 86_400 ? 'var(--alarm)' : undefined }}>
            must re-attest within {relativeAge(ttl)}
          </span>
        </div>
      </div>

      <div className="mt-5">
        <div className="legend">
          Serves · {signer.models.length}{' '}
          {signer.models.length === 1 ? 'model' : 'models'}, each bound in its own transaction
        </div>
        <div className="mt-2 ruled">
          {signer.models.map((m) => {
            const { vendor, name } = splitModelId(m);
            const used = usedFor.includes(m);
            const registration = signer.registrations?.find((r) => r.model === m);
            return (
              <div
                key={m}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2"
              >
                <span
                  className="text-[12.5px]"
                  style={{ color: used ? 'var(--ink)' : 'var(--ink-3)' }}
                >
                  <span style={{ color: 'var(--ink-4)' }}>{vendor}/</span>
                  {name}
                  {used ? (
                    <span className="legend ml-2" style={{ color: 'var(--seal)' }}>
                      in this round
                    </span>
                  ) : null}
                </span>
                {registration ? (
                  <span className="legend" style={{ color: 'var(--ink-4)' }}>
                    quote verified in{' '}
                    <TxRef chainId={chainId} hash={registration.txHash} /> · block{' '}
                    {registration.blockNumber}
                    {registration.quoteBytes ? ` · ${registration.quoteBytes} quote bytes` : ''}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
