import type { Address, Hex } from 'viem';
import { SETTLEMENTS } from '@/generated/data';

/**
 * A transaction sent at the vault, read back off the chain.
 *
 * The register argues that a refusal is worth more than a confident guess. That argument is
 * cheap until someone tries to transact on a refused valuation and the chain stops them, which
 * is why the failed call is recorded here beside the successful one. Both are receipts: status,
 * block, amounts, and — for the failure — the error the chain itself named when the call was
 * replayed at the block before it.
 */
export interface SettlementEvent {
  address: Address;
  name: string;
  args: Record<string, string>;
}

export interface SettlementRevert {
  /** The raw revert payload, exactly as returned. */
  raw: Hex | null;
  /** Solidity error name, e.g. `OracleHalted`. */
  name: string | null;
  /** Arguments, with enum ordinals already read as their names. */
  args: string[] | null;
  /** The signature a reader would recognise on an explorer. */
  signature: string | null;
}

export interface Settlement {
  txHash: Hex;
  label: string | null;
  note: string | null;
  succeeded: boolean;
  /** 1 or 0, as the receipt reports it. */
  status: number;
  blockNumber: string;
  timestamp: number | null;
  from: Address;
  to: Address;
  gasUsed: number;
  events: SettlementEvent[];
  revert: SettlementRevert | null;
}

export interface ChainSettlement extends Settlement {
  chainId: number;
}

/**
 * Every recorded settlement, the selected network's first.
 *
 * These are not shown only for the network on screen. A transaction that was mined is a fact
 * about the chain it was mined on, not about which tab a reader has open, and the pair of them —
 * one that settled, one the chain rejected — is the point of the section. Each carries its own
 * network, so its links go to the right explorer and the reader is told which chain it was.
 */
export function allSettlements(preferredChainId?: number): ChainSettlement[] {
  const entries = Object.entries(SETTLEMENTS).flatMap(([chainId, list]) =>
    (list ?? []).map((s) => ({ ...s, chainId: Number(chainId) })),
  );
  return entries.sort((a, b) => {
    if (preferredChainId !== undefined && a.chainId !== b.chainId) {
      if (a.chainId === preferredChainId) return -1;
      if (b.chainId === preferredChainId) return 1;
    }
    // The one that settled reads first; the one the chain rejected reads against it.
    return Number(b.succeeded) - Number(a.succeeded);
  });
}

/** The `Subscribed` event a successful subscription emits, when there is one. */
export function subscriptionOf(settlement: Settlement): {
  currencyIn: bigint;
  sharesOut: bigint;
  navE6: bigint;
} | null {
  const event = settlement.events.find((e) => e.name === 'Subscribed');
  if (!event) return null;
  try {
    return {
      currencyIn: BigInt(event.args.currencyIn),
      sharesOut: BigInt(event.args.sharesOut),
      navE6: BigInt(event.args.navE6),
    };
  } catch {
    return null;
  }
}
