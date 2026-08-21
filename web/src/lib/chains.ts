import { defineChain, type Chain } from 'viem';

/**
 * X Layer, the two networks the dashboard can point at. Both are read over the public RPC
 * with no key, which is what lets the whole thing run from a static host.
 */

export const xLayer: Chain = defineChain({
  id: 196,
  name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.xlayer.tech'] } },
  blockExplorers: { default: { name: 'OKLink', url: 'https://www.oklink.com/xlayer' } },
});

export const xLayerTestnet: Chain = defineChain({
  id: 1952,
  name: 'X Layer Testnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: ['https://testrpc.xlayer.tech'] } },
  blockExplorers: {
    default: { name: 'OKX Explorer', url: 'https://web3.okx.com/explorer/x-layer-testnet' },
  },
  testnet: true,
});

export const CHAINS = [xLayer, xLayerTestnet] as const;

export type SupportedChainId = 196 | 1952;

export const DEFAULT_CHAIN_ID: SupportedChainId = 196;

export function chainById(id: number): Chain {
  return id === xLayerTestnet.id ? xLayerTestnet : xLayer;
}

export function isSupportedChainId(id: number): id is SupportedChainId {
  return id === 196 || id === 1952;
}

/** Explorer deep links. OKLink and the OKX explorer share the same path grammar. */
export function explorerTx(chainId: number, hash: string): string {
  return `${chainById(chainId).blockExplorers!.default.url}/tx/${hash}`;
}

export function explorerAddress(chainId: number, address: string): string {
  return `${chainById(chainId).blockExplorers!.default.url}/address/${address}`;
}
