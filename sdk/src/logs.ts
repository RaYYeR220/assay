/**
 * Chunked log scanning.
 *
 * X Layer's public RPC rejects any `eth_getLogs` spanning more than 100 blocks
 * ("block range greater than 100 max"), which makes the obvious `fromBlock: 0` scan
 * impossible: the chain is tens of millions of blocks deep. Everything that reads history
 * therefore walks backwards from the head in bounded windows and stops as soon as it has
 * what it needs.
 *
 * The consequence is visible in the results rather than hidden: a scan that finds nothing
 * reports the range it covered, so "not in the last N blocks" is never dressed up as "does
 * not exist". Put a `startBlock` in the deployment file and the scans become exact.
 */

import type { Address, Hex, Log, PublicClient } from 'viem';

/** X Layer's documented cap. Other chains may allow more; this is the safe floor. */
export const DEFAULT_MAX_SPAN = 100n;

/** How far back to walk when the deployment file carries no startBlock. */
export const DEFAULT_LOOKBACK = 20_000n;

/** Windows fetched at once. Sequential scanning of thousands of blocks is otherwise slow. */
const CONCURRENCY = 8;

export interface ScanOptions {
  fromBlock?: bigint;
  toBlock?: bigint;
  maxSpan?: bigint;
  lookback?: bigint;
}

export interface ScanResult {
  logs: Log[];
  scannedFrom: bigint;
  scannedTo: bigint;
  /** True when the walk stopped at the lookback bound rather than at fromBlock. */
  bounded: boolean;
}

/**
 * Walk backwards from the head, newest window first, handing each batch to `onBatch`.
 * Returning true from `onBatch` stops the scan; the logs collected so far are returned.
 */
export async function scanLogsBackwards(
  publicClient: PublicClient,
  address: Address,
  options: ScanOptions,
  onBatch?: (logs: Log[]) => boolean,
): Promise<ScanResult> {
  const maxSpan = options.maxSpan ?? DEFAULT_MAX_SPAN;
  const head = options.toBlock ?? (await publicClient.getBlockNumber());
  const floor =
    options.fromBlock !== undefined && options.fromBlock > 0n
      ? options.fromBlock
      : head > (options.lookback ?? DEFAULT_LOOKBACK)
        ? head - (options.lookback ?? DEFAULT_LOOKBACK)
        : 0n;

  const collected: Log[] = [];
  let cursor = head;
  let stopped = false;

  while (cursor >= floor && !stopped) {
    const windows: Array<{ from: bigint; to: bigint }> = [];
    for (let i = 0; i < CONCURRENCY && cursor >= floor; i++) {
      const to = cursor;
      const from = to > floor + maxSpan - 1n ? to - maxSpan + 1n : floor;
      windows.push({ from, to });
      if (from === 0n) {
        cursor = -1n;
        break;
      }
      cursor = from - 1n;
    }

    const batches = await Promise.all(
      windows.map((window) =>
        publicClient.getLogs({ address, fromBlock: window.from, toBlock: window.to }),
      ),
    );

    // Newest first within the batch, so an early stop returns the most recent match.
    for (const batch of batches) {
      if (batch.length === 0) continue;
      const ordered = [...batch].sort((a, b) => Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n)));
      collected.push(...ordered);
      if (onBatch?.(ordered)) {
        stopped = true;
        break;
      }
    }
  }

  return {
    logs: collected,
    scannedFrom: floor,
    scannedTo: head,
    bounded: options.fromBlock === undefined || options.fromBlock === 0n,
  };
}

/** Human sentence for the range a scan actually covered. */
export function describeRange(result: Pick<ScanResult, 'scannedFrom' | 'scannedTo' | 'bounded'>): string {
  return (
    `blocks ${result.scannedFrom}-${result.scannedTo}` +
    (result.bounded ? ' (bounded lookback; set startBlock in the deployment file to scan from the beginning)' : '')
  );
}

export function topicMatchesEpoch(log: { topics: readonly Hex[] }, epoch: number): boolean {
  const topic = log.topics[2];
  return topic !== undefined && BigInt(topic) === BigInt(epoch);
}
