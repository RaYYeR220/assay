'use client';

import { useEffect, useState } from 'react';
import { formatEther, parseEther } from 'viem';
import { assayOracleAbi } from '@/abi';
import { useApp } from '@/state/AppContext';
import { useNow, useOracleState } from '@/hooks/useChain';
import { AddressRef, Alarm, Caption, Notice, SectionHead, Spec, TxRef } from '@/components/primitives';
import { formatE6, relativeAge } from '@/lib/format';
import { describeRevert, readPendingWithdrawal } from '@/lib/oracle';

/**
 * Section V — disputes.
 *
 * A price nobody can argue with is just a different kind of trusted feed. Opening a challenge
 * is permissionless and it bites immediately, before anyone adjudicates: the valuation moves to
 * Disputed and consumers stop reading it. The cost of being wrong therefore falls on the
 * challenger, never on holders who would otherwise transact against a value under question.
 */
export default function DisputePage() {
  const { deployment, chainId, wallet, round, connect, walletAvailable } = useApp();
  const live = useOracleState();
  const now = useNow();
  const [bond, setBond] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dispute = live.data?.dispute;
  const policy = live.data?.policy;
  const nav = live.data?.nav;
  const open = dispute?.open ?? false;

  const requiredBond = policy?.disputeBond ?? 10_000_000_000_000_000n;
  const challengeable = nav?.state === 'Live';

  // Bonds are credited on settlement and claimed separately, so the balance is its own read.
  // Keyed by account so a disconnect derives an empty balance instead of writing one back.
  const [credited, setCredited] = useState<Record<string, bigint>>({});
  const account = wallet?.address ?? '';
  const pending = credited[account] ?? 0n;

  useEffect(() => {
    if (!deployment || !wallet) return;
    let cancelled = false;
    readPendingWithdrawal(deployment, wallet.address)
      .then((v) => !cancelled && setCredited((c) => ({ ...c, [wallet.address]: v })))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [deployment, wallet, status]);

  const withdraw = async () => {
    if (!deployment || !wallet) return;
    setError(null);
    try {
      const hash = await wallet.client.writeContract({
        address: deployment.assayOracle,
        abi: assayOracleAbi,
        functionName: 'withdraw',
        chain: null,
        account: wallet.address,
      });
      setStatus(hash);
    } catch (e) {
      const info = describeRevert(e);
      setError(info?.signature ?? (e as Error).message.split('\n')[0]!);
    }
  };

  const challenge = async () => {
    if (!deployment || !wallet) return;
    setError(null);
    setStatus(null);
    try {
      const hash = await wallet.client.writeContract({
        address: deployment.assayOracle,
        abi: assayOracleAbi,
        functionName: 'challenge',
        args: [deployment.assetId],
        value: bond ? parseEther(bond) : requiredBond,
        chain: null,
        account: wallet.address,
      });
      setStatus(hash);
    } catch (e) {
      const info = describeRevert(e);
      setError(info?.signature ?? (e as Error).message.split('\n')[0]!);
    }
  };

  return (
    <div data-verdict={open ? 'halted' : 'struck'}>
      <div className="pb-6">
        <div className="legend">Contested valuations</div>
        <h2 className="display mt-1.5 text-[26px]" style={{ fontWeight: 700 }}>
          Dispute
        </h2>
      </div>

      <hr className="rule-heavy mb-8" />

      {open ? (
        <Alarm title="A challenge is open">
          The valuation for this asset is marked Disputed. Consumers stopped reading it the moment
          the bond was posted, so the vault refuses to move value while this stands — before anyone
          has adjudicated anything. It is settled by re-appraising with a fresh committee round.
        </Alarm>
      ) : null}

      <section className="grid grid-cols-2 gap-x-8 gap-y-6 pb-9 md:grid-cols-3 lg:grid-cols-6">
        <Spec label="State" alarm={open || nav?.state === 'Voided'}>
          {nav?.state ?? (round?.published ? 'Live' : 'Halted')}
        </Spec>
        <Spec label="Contested value">
          {nav && nav.valueE6 > 0n ? formatE6(nav.valueE6) : round?.navE6 ? formatE6(round.navE6) : '—'}
        </Spec>
        <Spec label="Bond required">{formatEther(requiredBond)} OKB</Spec>
        <Spec label="Dispute band">
          ±{policy?.disputeBandBps ?? round?.policy.disputeBandBps ?? 500} bps
        </Spec>
        <Spec label="Challenger">
          {open && dispute ? <AddressRef chainId={chainId} address={dispute.challenger} /> : '—'}
        </Spec>
        <Spec label="Open for">
          {open && dispute ? relativeAge(now - dispute.openedAt) : '—'}
        </Spec>
      </section>

      <hr className="rule" />

      {/* ---- how it settles ---------------------------------------------------------------- */}
      <section className="py-10">
        <SectionHead index="I" title="How a challenge settles" />
        <div className="mt-4 grid gap-x-12 gap-y-8 lg:grid-cols-3">
          <Outcome
            index="01"
            title="Challenger wins"
            body="The fresh valuation lands further from the contested one than the dispute band allows. The contested value is voided, a halt is recorded, and the bond is returned to the challenger."
            alarm
          />
          <Outcome
            index="02"
            title="Challenger wins by silence"
            body="The fresh round cannot reach consensus at all. Refusing to price counts as evidence for the challenger, not against them — the same value is voided and the bond comes back."
            alarm
          />
          <Outcome
            index="03"
            title="Challenge fails"
            body="The fresh valuation lands inside the dispute band. The new value is published, the asset goes back to Live, and the bond is forfeited to the issuer."
          />
        </div>
      </section>

      <hr className="rule" />

      {/* ---- claim -------------------------------------------------------------------------- */}
      <section className="py-10">
        <SectionHead
          index="II"
          title="Claim a bond"
          aside={<>credited on settlement · withdrawn separately</>}
        />
        <Caption>
          Settlement credits the winner rather than paying them. A transfer that fails — a
          recipient contract that reverts on receipt, or one that runs out of gas — would otherwise
          be able to hold the whole settlement hostage, so the value is recorded against the
          address and claimed in its own transaction.
        </Caption>

        <div className="mt-7 flex flex-wrap items-end gap-x-10 gap-y-5">
          <Spec label="Credited to you">
            {wallet ? `${formatEther(pending)} OKB` : 'connect to check'}
          </Spec>
          <button
            className="control"
            onClick={withdraw}
            disabled={!wallet || !deployment || pending === 0n}
            title={pending === 0n ? 'Nothing is credited to this address.' : undefined}
          >
            Withdraw
          </button>
        </div>
      </section>

      <hr className="rule" />

      {/* ---- act ---------------------------------------------------------------------------- */}
      <section className="py-10">
        <SectionHead
          index="III"
          title="Open a challenge"
          aside={<>permissionless · anyone may post a bond</>}
        />
        <Caption>
          Only a Live valuation can be contested; a round that already refused to publish has
          nothing to argue with. The bond is at risk: if the re-appraisal agrees with the contested
          value, it goes to the issuer.
        </Caption>

        {!deployment ? (
          <div className="mt-6">
            <Notice title="Not deployed on this network yet">
              Challenges are sent to the oracle at{' '}
              <span className="hex">deployments/{chainId}.json</span>, which does not exist yet. The
              mechanism above is what the contract already implements.
            </Notice>
          </div>
        ) : (
          <div className="mt-7 max-w-[30rem]">
            <label className="legend block">Bond · OKB</label>
            <input
              className="field mt-2 figure"
              inputMode="decimal"
              placeholder={formatEther(requiredBond)}
              value={bond}
              onChange={(e) => setBond(e.target.value)}
              disabled={!wallet || !challengeable}
            />

            {!challengeable ? (
              <div className="mt-4 border-l-2 py-1 pl-4" style={{ borderColor: 'var(--alarm)' }}>
                <div className="legend" style={{ color: 'var(--alarm)' }}>
                  Nothing to challenge
                </div>
                <p className="hex mt-1.5" style={{ color: 'var(--ink-2)' }}>
                  {open ? 'DisputeAlreadyOpen()' : 'NothingToChallenge()'}
                </p>
              </div>
            ) : null}

            <div className="mt-5 flex gap-2">
              {!wallet ? (
                <button className="control" onClick={connect} disabled={!walletAvailable}>
                  {walletAvailable ? 'Connect to challenge' : 'No wallet detected'}
                </button>
              ) : (
                <button
                  className="control"
                  onClick={challenge}
                  style={!challengeable ? { borderColor: 'var(--alarm)', color: 'var(--alarm)' } : undefined}
                >
                  {challengeable ? 'Post bond and challenge' : 'Send anyway'}
                </button>
              )}
            </div>

            <div className="mt-4 min-h-[2.5rem]">
              {status ? (
                <p className="note">
                  Sent — <TxRef chainId={chainId} hash={status} />
                </p>
              ) : null}
              {error ? (
                <p className="hex" style={{ color: 'var(--alarm)', fontWeight: 600 }}>
                  {error}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Outcome({
  index,
  title,
  body,
  alarm,
}: {
  index: string;
  title: string;
  body: string;
  alarm?: boolean;
}) {
  return (
    <div style={{ borderTop: `2px solid ${alarm ? 'var(--alarm)' : 'var(--ink)'}`, paddingTop: 14 }}>
      <div className="legend" style={{ color: 'var(--ink-4)' }}>
        {index}
      </div>
      <h3
        className="mt-1.5 text-[15px]"
        style={{ fontWeight: 600, color: alarm ? 'var(--alarm)' : 'var(--ink)' }}
      >
        {title}
      </h3>
      <p className="note mt-2">{body}</p>
    </div>
  );
}
