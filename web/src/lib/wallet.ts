import {
  createWalletClient,
  custom,
  numberToHex,
  type Address,
  type Chain,
  type EIP1193Provider,
  type WalletClient,
} from 'viem';
import { chainById } from './chains';

/**
 * Optional wallet support.
 *
 * The dashboard is designed to be read end to end without one: every figure, every refusal
 * and every revert reason is available with no credentials. A wallet is needed only to send
 * a subscription, a redemption or a challenge — and to watch one of them get rejected on
 * chain, which is worth doing at least once.
 */

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function hasInjectedProvider(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ethereum);
}

export interface WalletSession {
  address: Address;
  chainId: number;
  client: WalletClient;
}

export async function connectWallet(chainId: number): Promise<WalletSession> {
  const provider = window.ethereum;
  if (!provider) throw new Error('No browser wallet detected.');

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  const address = accounts[0];
  if (!address) throw new Error('The wallet returned no account.');

  await ensureChain(provider, chainById(chainId));

  const current = Number((await provider.request({ method: 'eth_chainId' })) as string);

  return {
    address,
    chainId: current,
    client: createWalletClient({ account: address, chain: chainById(current), transport: custom(provider) }),
  };
}

/** Switches the wallet to the target network, adding it first if it is unknown. */
async function ensureChain(provider: EIP1193Provider, chain: Chain): Promise<void> {
  const hexId = numberToHex(chain.id);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
  } catch (error) {
    // 4902 is the standard "unrecognised chain" code; anything else is the user's decision.
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [...chain.rpcUrls.default.http],
          blockExplorerUrls: [chain.blockExplorers!.default.url],
        },
      ],
    });
  }
}

export function onWalletChange(handler: () => void): () => void {
  const provider = window.ethereum;
  if (!provider) return () => {};
  const listener = () => handler();
  provider.on?.('accountsChanged', listener);
  provider.on?.('chainChanged', listener);
  return () => {
    provider.removeListener?.('accountsChanged', listener);
    provider.removeListener?.('chainChanged', listener);
  };
}
