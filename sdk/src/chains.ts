import { defineChain } from 'viem';

/** X Layer mainnet. */
export const xLayer = defineChain({
  id: 196,
  name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.xlayer.tech'] } },
  blockExplorers: {
    default: { name: 'OKLink', url: 'https://www.oklink.com/xlayer' },
  },
});

/** X Layer testnet. */
export const xLayerTestnet = defineChain({
  id: 1952,
  name: 'X Layer Testnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: ['https://testrpc.xlayer.tech'] } },
  blockExplorers: {
    default: { name: 'OKX Explorer', url: 'https://web3.okx.com/explorer/x-layer-testnet' },
  },
  testnet: true,
});

export const CHAINS = { 196: xLayer, 1952: xLayerTestnet } as const;

export type AssayChainId = keyof typeof CHAINS;

export function isAssayChainId(id: number): id is AssayChainId {
  return id === 196 || id === 1952;
}

export function chainById(id: number) {
  if (!isAssayChainId(id)) {
    throw new Error(`unsupported chain ${id}; Assay ships config for 196 (X Layer) and 1952 (X Layer testnet)`);
  }
  return CHAINS[id];
}

/** Explorer link for a transaction, so callers do not have to know which network they are on. */
export function txUrl(chainId: number, hash: string): string | undefined {
  const base = isAssayChainId(chainId) ? CHAINS[chainId].blockExplorers.default.url : undefined;
  return base ? `${base}/tx/${hash}` : undefined;
}

export function addressUrl(chainId: number, address: string): string | undefined {
  const base = isAssayChainId(chainId) ? CHAINS[chainId].blockExplorers.default.url : undefined;
  return base ? `${base}/address/${address}` : undefined;
}
