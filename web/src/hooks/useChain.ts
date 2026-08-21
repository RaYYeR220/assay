'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { publicClientFor, rpcErrorMessage } from '@/lib/rpc';
import { readOracleState, readVaultState, type OracleState, type VaultState } from '@/lib/oracle';
import { useApp } from '@/state/AppContext';
import type { Deployment } from '@/lib/deployments';

/** A clock that ticks once a second, for countdowns and ages. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface Poll<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Polls a chain read on an interval, cancelling in-flight work when the deployment or network
 * changes. Errors are surfaced rather than retried silently: a public endpoint that is not
 * answering is information a reader should have.
 */
function usePolled<T>(
  key: string,
  deployment: Deployment | null,
  read: (d: Deployment) => Promise<T>,
  intervalMs: number,
): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!deployment) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const run = async () => {
      setLoading(true);
      try {
        const next = await read(deployment);
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(rpcErrorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
        if (!cancelled) timer = setTimeout(run, intervalMs);
      }
    };

    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `read` is stable per call site; `key` distinguishes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployment, intervalMs, nonce, key]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // With no deployment there is nothing to report, so the absence is derived rather than
  // written back into state — clearing it in an effect would just cause a second render.
  return deployment
    ? { data, error, loading, refresh }
    : { data: null, error: null, loading: false, refresh };
}

export function useOracleState(intervalMs = 12_000): Poll<OracleState> {
  const { deployment } = useApp();
  return usePolled('oracle', deployment, readOracleState, intervalMs);
}

export function useVaultState(intervalMs = 12_000): Poll<VaultState> {
  const { deployment } = useApp();
  return usePolled('vault', deployment, readVaultState, intervalMs);
}

export type DeploymentPresence = 'absent' | 'checking' | 'live' | 'no-code' | 'unreachable';

/**
 * Whether the selected network actually has the contracts on it.
 *
 * Three different things get conflated by a naive dashboard: no manifest, a manifest pointing
 * at nothing, and an endpoint that will not answer. They call for different words, so they are
 * distinguished here and reported as such.
 */
export function useDeploymentPresence(): DeploymentPresence {
  const { deployment, chainId } = useApp();
  const [probed, setProbed] = useState<Record<string, DeploymentPresence>>({});
  const key = deployment ? `${chainId}:${deployment.assayOracle}` : '';

  useEffect(() => {
    if (!deployment) return;
    let cancelled = false;
    publicClientFor(chainId)
      .getCode({ address: deployment.assayOracle })
      .then((code) => {
        if (!cancelled) setProbed((p) => ({ ...p, [key]: code && code !== '0x' ? 'live' : 'no-code' }));
      })
      .catch(() => {
        if (!cancelled) setProbed((p) => ({ ...p, [key]: 'unreachable' }));
      });
    return () => {
      cancelled = true;
    };
  }, [deployment, chainId, key]);

  // "No manifest" is a fact about the build, not a probe result, so it is derived directly.
  if (!deployment) return 'absent';
  return probed[key] ?? 'checking';
}

/** Head of chain, for the header strip. Cheap enough to poll on its own cadence. */
export function useBlock(intervalMs = 6000): { number: bigint | null; timestamp: number | null; error: string | null } {
  const { chainId } = useApp();
  const [state, setState] = useState<{ number: bigint | null; timestamp: number | null; error: string | null }>({
    number: null,
    timestamp: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const block = await publicClientFor(chainId).getBlock();
        if (!cancelled) setState({ number: block.number, timestamp: Number(block.timestamp), error: null });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, error: rpcErrorMessage(e) }));
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chainId, intervalMs]);

  return state;
}
