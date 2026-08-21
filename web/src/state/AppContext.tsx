'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { Address } from 'viem';
import { DEFAULT_CHAIN_ID, isSupportedChainId, type SupportedChainId } from '@/lib/chains';
import { deploymentFor, type Deployment } from '@/lib/deployments';
import { ROUNDS } from '@/generated/data';
import { toRoundView, type AppraisalBundle, type RoundView } from '@/lib/bundle';
import { connectWallet, hasInjectedProvider, onWalletChange, type WalletSession } from '@/lib/wallet';

/**
 * Everything the views share: which network is selected, which recorded round is open, and
 * whether a wallet happens to be attached.
 *
 * The important property is that none of this is required. With no wallet and no deployment
 * the dashboard still renders a complete round from the recorded set, because that is how a
 * reader who has never touched a chain is going to look at it.
 */

const CHAIN_STORAGE_KEY = 'assay.chain';

/**
 * The selected network survives a reload. It lives in `localStorage` rather than in the URL so
 * that a link to a section stays a link to that section.
 */
const storageListeners = new Set<() => void>();

function subscribeToStorage(onChange: () => void): () => void {
  storageListeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    storageListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function notifyStorage(): void {
  for (const listener of storageListeners) listener();
}

function readStoredChainId(): SupportedChainId | null {
  const stored = Number(window.localStorage.getItem(CHAIN_STORAGE_KEY));
  return isSupportedChainId(stored) ? stored : null;
}

interface AppState {
  chainId: SupportedChainId;
  setChainId: (id: SupportedChainId) => void;
  deployment: Deployment | null;

  rounds: AppraisalBundle[];
  roundIndex: number;
  setRoundIndex: (i: number) => void;
  round: RoundView | null;

  wallet: WalletSession | null;
  walletAvailable: boolean;
  connecting: boolean;
  walletError: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [roundIndex, setRoundIndex] = useState(0);
  const [wallet, setWallet] = useState<WalletSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  // The stored network and the presence of a wallet are only knowable in the browser, and the
  // export has to hydrate against markup that assumed neither. Reading them through
  // `useSyncExternalStore` keeps that out of an effect and out of the first paint.
  const storedChainId = useSyncExternalStore(subscribeToStorage, readStoredChainId, () => null);
  const walletAvailable = useSyncExternalStore(subscribeToStorage, hasInjectedProvider, () => false);
  const chainId = storedChainId ?? DEFAULT_CHAIN_ID;

  const setChainId = useCallback((id: SupportedChainId) => {
    window.localStorage.setItem(CHAIN_STORAGE_KEY, String(id));
    notifyStorage();
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setWalletError(null);
    try {
      setWallet(await connectWallet(chainId));
    } catch (e) {
      setWalletError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }, [chainId]);

  const disconnect = useCallback(() => setWallet(null), []);

  useEffect(() => {
    if (!wallet) return;
    return onWalletChange(() => {
      // The wallet moved out from under us; drop the session rather than act on a stale one.
      setWallet(null);
    });
  }, [wallet]);

  const round = useMemo(() => {
    const bundle = ROUNDS[roundIndex];
    return bundle ? toRoundView(bundle) : null;
  }, [roundIndex]);

  const value = useMemo<AppState>(
    () => ({
      chainId,
      setChainId,
      deployment: deploymentFor(chainId),
      rounds: ROUNDS,
      roundIndex,
      setRoundIndex,
      round,
      wallet,
      walletAvailable,
      connecting,
      walletError,
      connect,
      disconnect,
    }),
    [chainId, setChainId, roundIndex, round, wallet, walletAvailable, connecting, walletError, connect, disconnect],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

/** Convenience for the write paths, which need both an account and a deployment. */
export function useWriteTarget(): { deployment: Deployment; account: Address } | null {
  const { deployment, wallet } = useApp();
  if (!deployment || !wallet) return null;
  return { deployment, account: wallet.address };
}
