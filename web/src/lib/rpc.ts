import { createPublicClient, http, type PublicClient } from 'viem';
import { chainById } from './chains';

/**
 * Read-only clients, one per network, created lazily and reused.
 *
 * Calls are batched into multicall where viem can do so, which keeps a page load down to a
 * couple of requests against the public endpoint. Nothing here needs a key.
 */
const clients = new Map<number, PublicClient>();

export function publicClientFor(chainId: number): PublicClient {
  const existing = clients.get(chainId);
  if (existing) return existing;

  const chain = chainById(chainId);
  const client = createPublicClient({
    chain,
    transport: http(chain.rpcUrls.default.http[0], {
      batch: { wait: 16 },
      retryCount: 2,
      timeout: 12_000,
    }),
    batch: { multicall: { wait: 16 } },
  }) as PublicClient;

  clients.set(chainId, client);
  return client;
}

/** Normalises the noise a public endpoint returns into something worth printing. */
export function rpcErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: string }).shortMessage;
    return short ?? error.message.split('\n')[0]!;
  }
  return String(error);
}
