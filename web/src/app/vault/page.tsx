'use client';

import { useState } from 'react';
import { assayVaultAbi, erc20Abi } from '@/abi';
import { useApp } from '@/state/AppContext';
import { useVaultState } from '@/hooks/useChain';
import { simulateRedeem, simulateSubscribe, type RevertInfo } from '@/lib/oracle';
import { errorCopy, HALT_COPY } from '@/lib/enums';
import { formatE6, formatUnits, parseUnits } from '@/lib/format';
import { AddressRef, Alarm, Caption, Notice, SectionHead, Spec, TxRef } from '@/components/primitives';
import { publicClientFor } from '@/lib/rpc';

/**
 * Section IV — the vault.
 *
 * Every value-moving call prices off `requireFreshNav`, which reverts whenever the committee
 * failed to agree, the valuation aged out, a challenge is open, or the sequencer is unhealthy.
 * There is no cached price to fall back on and no operator override.
 *
 * The forms are therefore not merely greyed out when the oracle refuses — they carry the
 * contract's own error, named, and a reader with a wallet is invited to send the transaction
 * anyway and watch the chain reject it. Being told is weaker than seeing it happen.
 */
export default function VaultPage() {
  const { deployment, chainId, wallet, round, connect, walletAvailable } = useApp();
  const vault = useVaultState();

  const halted = round ? !round.published : false;
  const blocked = vault.data ? !vault.data.canTransact : halted;

  // With no deployment the page still has to explain itself, so the expected revert is
  // derived from the recorded round rather than left blank.
  const expectedRevert: RevertInfo | null =
    vault.data?.blockedBy ??
    (halted && round
      ? {
          name: 'OracleHalted',
          args: [],
          signature: `OracleHalted(${round.bundle.assetIdHash ? `${round.bundle.assetIdHash.slice(0, 10)}…` : 'assetId'}, ${round.haltReason})`,
        }
      : null);

  return (
    <div data-verdict={halted ? 'halted' : 'struck'}>
      <div className="pb-6">
        <div className="legend">Tokenised claim</div>
        <h2 className="display mt-1.5 text-[26px]" style={{ fontWeight: 700 }}>
          {vault.data?.name ?? 'Assay Carbon Basket'}
        </h2>
      </div>

      <hr className="rule-heavy mb-8" />

      {blocked ? (
        <Alarm title="Subscription and redemption are refused">
          {round ? HALT_COPY[round.haltReason ?? 'Disagreement'] : 'The oracle has no usable price.'}{' '}
          Both <span className="hex">subscribe</span> and <span className="hex">redeem</span> read
          the price through <span className="hex">requireFreshNav</span>, and nothing in this vault
          catches the revert. That is the intended behaviour, not an outage: with no attested
          valuation, no shares change hands at any price.
          {expectedRevert ? (
            <>
              {' '}
              A call sent right now reverts with{' '}
              <span className="hex" style={{ fontWeight: 700 }}>
                {expectedRevert.signature}
              </span>
              .
            </>
          ) : null}
        </Alarm>
      ) : null}

      {/* ---- state ------------------------------------------------------------------------ */}
      <section className="grid grid-cols-2 gap-x-8 gap-y-6 pb-9 md:grid-cols-3 lg:grid-cols-6">
        <Spec label="Unit price" alarm={blocked}>
          {vault.data?.unitPriceE6
            ? formatE6(vault.data.unitPriceE6)
            : round?.navE6
              ? formatE6(round.navE6)
              : 'withheld'}
        </Spec>
        <Spec label="Shares outstanding">
          {vault.data ? formatUnits(vault.data.totalSupply, vault.data.decimals, 4) : '—'}
        </Spec>
        <Spec label="Supply cap">
          {vault.data ? (vault.data.supplyCap === 0n ? 'uncapped' : formatUnits(vault.data.supplyCap, vault.data.decimals, 0)) : '—'}
        </Spec>
        <Spec label="Liquidity">
          {vault.data
            ? `${formatUnits(vault.data.liquidity, vault.data.currencyDecimals, 2)} ${vault.data.currencySymbol}`
            : '—'}
        </Spec>
        <Spec label="canTransact()" alarm={blocked}>
          {vault.data ? String(vault.data.canTransact) : halted ? 'false' : '—'}
        </Spec>
        <Spec label="Subscriptions">
          {vault.data?.subscriptionsPaused ? 'paused by issuer' : 'open'}
        </Spec>
      </section>

      <hr className="rule" />

      {/* ---- forms ------------------------------------------------------------------------ */}
      <section className="py-10">
        <SectionHead
          index="I"
          title="Subscribe and redeem"
          aside={
            wallet ? (
              <>signing as <AddressRef chainId={chainId} address={wallet.address} /></>
            ) : (
              <>read-only · a wallet is optional</>
            )
          }
        />
        <Caption>
          The probe below calls <span className="hex" style={{ color: 'var(--ink)' }}>canTransact()</span>, which
          never reverts, so this page can report the vault&rsquo;s condition without pretending to be
          able to trade. The forms simulate against the live contract before anything is signed.
        </Caption>

        <div className="mt-8 grid gap-x-12 gap-y-10 lg:grid-cols-2">
          <Action
            kind="subscribe"
            blocked={blocked}
            expectedRevert={expectedRevert}
            connected={Boolean(wallet)}
            onConnect={connect}
            walletAvailable={walletAvailable}
          />
          <Action
            kind="redeem"
            blocked={blocked}
            expectedRevert={expectedRevert}
            connected={Boolean(wallet)}
            onConnect={connect}
            walletAvailable={walletAvailable}
          />
        </div>
      </section>

      <hr className="rule" />

      <section className="py-10">
        <SectionHead index="II" title="Contract" />
        {!deployment ? (
          <Notice title="Not deployed on this network yet">
            The vault has not been published to chain {chainId}. The figures above come from the
            recorded round; the forms will connect to the real contract as soon as{' '}
            <span className="hex">deployments/{chainId}.json</span> exists.
          </Notice>
        ) : (
          <div className="grid grid-cols-2 gap-x-8 gap-y-5 md:grid-cols-4">
            <Spec label="Vault">
              <AddressRef chainId={chainId} address={deployment.assayVault} />
            </Spec>
            <Spec label="Settlement currency">
              <AddressRef chainId={chainId} address={deployment.currency} />
            </Spec>
            <Spec label="Oracle">
              <AddressRef chainId={chainId} address={deployment.assayOracle} />
            </Spec>
            <Spec label="Issuer">
              <AddressRef chainId={chainId} address={vault.data?.issuer} />
            </Spec>
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------

type Outcome =
  | { kind: 'idle' }
  | { kind: 'simulating' }
  | { kind: 'ok'; text: string }
  | { kind: 'reverted'; signature: string; detail: string }
  | { kind: 'sent'; hash: string }
  | { kind: 'error'; detail: string };

function Action({
  kind,
  blocked,
  expectedRevert,
  connected,
  onConnect,
  walletAvailable,
}: {
  kind: 'subscribe' | 'redeem';
  blocked: boolean;
  expectedRevert: RevertInfo | null;
  connected: boolean;
  onConnect: () => Promise<void>;
  walletAvailable: boolean;
}) {
  const { deployment, wallet, chainId } = useApp();
  const vault = useVaultState();
  const [amount, setAmount] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  const subscribe = kind === 'subscribe';
  const decimals = subscribe ? (vault.data?.currencyDecimals ?? 6) : (vault.data?.decimals ?? 18);
  const unit = subscribe ? (vault.data?.currencySymbol ?? 'USD') : (vault.data?.symbol ?? 'shares');
  const parsed = parseUnits(amount, decimals);

  const simulate = async () => {
    if (!deployment || !wallet || parsed === null || parsed === 0n) return;
    setOutcome({ kind: 'simulating' });
    const result = subscribe
      ? await simulateSubscribe(deployment, wallet.address, parsed)
      : await simulateRedeem(deployment, wallet.address, parsed);

    if ('sharesOut' in result) {
      setOutcome({
        kind: 'ok',
        text: `${formatUnits(result.sharesOut, vault.data?.decimals ?? 18, 6)} ${vault.data?.symbol ?? 'shares'}`,
      });
    } else if ('currencyOut' in result) {
      setOutcome({
        kind: 'ok',
        text: `${formatUnits(result.currencyOut, vault.data?.currencyDecimals ?? 6, 2)} ${vault.data?.currencySymbol ?? 'USD'}`,
      });
    } else {
      setOutcome({
        kind: 'reverted',
        signature: result.revert?.signature ?? 'reverted without a named error',
        detail: result.message,
      });
    }
  };

  /** Sends the transaction whether or not it is expected to succeed. Watching it fail is the point. */
  const send = async () => {
    if (!deployment || !wallet || parsed === null || parsed === 0n) return;
    setOutcome({ kind: 'simulating' });
    try {
      if (subscribe && vault.data) {
        const client = publicClientFor(chainId);
        const allowance = (await client.readContract({
          address: vault.data.currency,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [wallet.address, deployment.assayVault],
        })) as bigint;
        if (allowance < parsed) {
          const approval = await wallet.client.writeContract({
            address: vault.data.currency,
            abi: erc20Abi,
            functionName: 'approve',
            args: [deployment.assayVault, parsed],
            chain: null,
            account: wallet.address,
          });
          await client.waitForTransactionReceipt({ hash: approval });
        }
      }

      const hash = await wallet.client.writeContract({
        address: deployment.assayVault,
        abi: assayVaultAbi,
        functionName: subscribe ? 'subscribe' : 'redeem',
        args: [parsed],
        chain: null,
        account: wallet.address,
      });
      setOutcome({ kind: 'sent', hash });
    } catch (e) {
      const message = (e as Error).message.split('\n')[0]!;
      setOutcome({ kind: 'error', detail: message });
    }
  };

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4 pb-3" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="legend legend-strong">{subscribe ? 'Subscribe' : 'Redeem'}</span>
        <span className="legend" style={{ color: blocked ? 'var(--alarm)' : 'var(--ink-3)' }}>
          {blocked ? 'refused by the oracle' : 'open'}
        </span>
      </div>

      <label className="legend mt-5 block">{subscribe ? 'Amount in' : 'Shares in'} · {unit}</label>
      <input
        className="field mt-2 figure"
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          setOutcome({ kind: 'idle' });
        }}
        disabled={!connected}
        aria-describedby={`${kind}-state`}
      />

      {blocked ? (
        <div
          id={`${kind}-state`}
          className="mt-4 border-l-2 py-1 pl-4"
          style={{ borderColor: 'var(--alarm)' }}
        >
          <div className="legend" style={{ color: 'var(--alarm)' }}>
            This call cannot succeed
          </div>
          <p className="hex mt-1.5" style={{ color: 'var(--ink-2)' }}>
            {expectedRevert?.signature ?? 'requireFreshNav reverts'}
          </p>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        {!connected ? (
          <button className="control" onClick={onConnect} disabled={!walletAvailable}>
            {walletAvailable ? 'Connect to try it' : 'No wallet detected'}
          </button>
        ) : (
          <>
            <button className="control" onClick={simulate} disabled={parsed === null || parsed === 0n}>
              Simulate
            </button>
            <button
              className="control"
              onClick={send}
              disabled={parsed === null || parsed === 0n}
              style={blocked ? { borderColor: 'var(--alarm)', color: 'var(--alarm)' } : undefined}
              title={blocked ? 'Send it anyway and watch the chain refuse it.' : undefined}
            >
              {blocked ? 'Send anyway' : subscribe ? 'Subscribe' : 'Redeem'}
            </button>
          </>
        )}
      </div>

      <div className="mt-4 min-h-[3.5rem]">
        {outcome.kind === 'simulating' ? <p className="legend">Working…</p> : null}
        {outcome.kind === 'ok' ? (
          <p className="note" style={{ color: 'var(--ink)' }}>
            Would return <span className="hex">{outcome.text}</span>.
          </p>
        ) : null}
        {outcome.kind === 'reverted' ? (
          <div>
            <div className="legend" style={{ color: 'var(--alarm)' }}>
              Reverted
            </div>
            <p className="hex mt-1" style={{ color: 'var(--alarm)', fontWeight: 600 }}>
              {outcome.signature}
            </p>
            {errorCopy(outcome.signature.split('(')[0]) ? (
              <p className="note mt-2 max-w-[46ch]">
                {errorCopy(outcome.signature.split('(')[0])}
              </p>
            ) : null}
          </div>
        ) : null}
        {outcome.kind === 'sent' ? (
          <p className="note">
            Sent — <TxRef chainId={chainId} hash={outcome.hash} />
          </p>
        ) : null}
        {outcome.kind === 'error' ? (
          <p className="hex" style={{ color: 'var(--alarm)' }}>
            {outcome.detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}
