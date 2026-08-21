'use client';

import { useApp } from '@/state/AppContext';
import { useBlock, useDeploymentPresence } from '@/hooks/useChain';
import { CHAINS, type SupportedChainId } from '@/lib/chains';
import { truncateHex } from '@/lib/format';
import { ATTESTATION_SNAPSHOT } from '@/generated/data';

/**
 * Masthead and health strip.
 *
 * The strip is the running condition of the register: which network, how far the chain has
 * got, whether the verdict currently stands, and whether the trust root is the real verifier
 * or the labelled stand-in. Anything wrong here is stated in the alarm colour and nowhere
 * else on the line.
 */
export function Header() {
  const { chainId, setChainId, deployment, round, wallet, walletAvailable, connecting, connect, disconnect } =
    useApp();
  const block = useBlock();
  const presence = useDeploymentPresence();

  const halted = round ? !round.published : false;
  const adapterUntrusted = ATTESTATION_SNAPSHOT ? !ATTESTATION_SNAPSHOT.adapter.isTrusted : false;

  return (
    <header className="pt-7">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1
            className="display text-[30px] leading-none"
            style={{ letterSpacing: '0.06em', fontWeight: 800 }}
          >
            ASSAY
          </h1>
          <p className="legend mt-2" style={{ letterSpacing: '0.2em' }}>
            Net asset value register · Office of appraisal
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="legend mr-1 hidden sm:block">Network</div>
          {CHAINS.map((c) => (
            <button
              key={c.id}
              className="control"
              data-active={chainId === c.id}
              onClick={() => setChainId(c.id as SupportedChainId)}
            >
              {c.id === 196 ? 'X Layer' : 'Testnet'}
            </button>
          ))}
          {wallet ? (
            <button className="control" onClick={disconnect} title={wallet.address}>
              {truncateHex(wallet.address, 6, 4)}
            </button>
          ) : (
            <button
              className="control"
              onClick={connect}
              disabled={!walletAvailable || connecting}
              title={walletAvailable ? 'Optional. Only the write actions need it.' : 'No browser wallet detected.'}
            >
              {connecting ? 'Connecting' : 'Connect'}
            </button>
          )}
        </div>
      </div>

      <hr className="rule-heavy mt-5" />

      {/* Health strip. One line, six readings, no chrome. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 py-2.5">
        <Reading label="Chain">{chainId === 196 ? '196 · mainnet' : '1952 · testnet'}</Reading>
        <Reading label="Block" alarm={Boolean(block.error)}>
          {block.error ? 'unreachable' : block.number !== null ? `#${block.number.toString()}` : '····'}
        </Reading>
        <Reading label="Contracts" alarm={presence !== 'live'}>
          {presence === 'live' && deployment
            ? truncateHex(deployment.assayOracle, 8, 4)
            : presence === 'no-code'
              ? 'manifest without code'
              : presence === 'checking'
                ? '····'
                : presence === 'unreachable'
                  ? 'unreachable'
                  : 'not deployed'}
        </Reading>
        <Reading label="Verdict" alarm={halted}>
          {round ? (round.published ? 'published' : 'halted') : 'no round'}
        </Reading>
        <Reading label="Trust root" alarm={adapterUntrusted}>
          {adapterUntrusted ? 'stand-in, unverified' : 'on-chain verifier'}
        </Reading>
        <Reading label="Mode">{presence === 'live' ? 'live reads' : 'recorded replay'}</Reading>
      </div>

      <hr className="rule" />
    </header>
  );
}

function Reading({
  label,
  children,
  alarm,
}: {
  label: string;
  children: React.ReactNode;
  alarm?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="legend">{label}</span>
      <span
        className="figure text-[12px]"
        style={alarm ? { color: 'var(--alarm)', fontWeight: 600 } : { color: 'var(--ink)' }}
      >
        {children}
      </span>
    </div>
  );
}
