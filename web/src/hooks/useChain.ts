'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getAddress } from 'viem';
import { publicClientFor, rpcErrorMessage } from '@/lib/rpc';
import {
  readAttestation,
  readOracleState,
  readVaultState,
  type OracleState,
  type VaultState,
} from '@/lib/oracle';
import { useApp } from '@/state/AppContext';
import { attestationFor, type AttestationSnapshot } from '@/lib/attestation';
import type { Deployment } from '@/lib/deployments';

/**
 * A clock that ticks once a second, for countdowns and ages.
 *
 * One interval for the whole page, read through `useSyncExternalStore` rather than held in
 * component state: the clock is an external source, not something React owns.
 *
 * It reads null on the server and on the first client render. The pages are prerendered into
 * static HTML, and the time at build is not the time in the reader's browser — rendering it
 * directly would make the first paint disagree with the markup and tear the page down on
 * hydration. Call sites fall back to a timestamp that is the same in both places.
 */
let clockSeconds: number | null = null;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeToClock(onChange: () => void): () => void {
  clockListeners.add(onChange);
  if (clockTimer === null) {
    clockTimer = setInterval(() => {
      clockSeconds = Math.floor(Date.now() / 1000);
      for (const listener of clockListeners) listener();
    }, 1000);
  }
  // Start the clock for whoever subscribed first, so an age is not blank for a whole second.
  if (clockSeconds === null) {
    clockSeconds = Math.floor(Date.now() / 1000);
    onChange();
  }
  return () => {
    clockListeners.delete(onChange);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

export function useNow(): number | null {
  return useSyncExternalStore(
    subscribeToClock,
    () => clockSeconds,
    () => null,
  );
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

/**
 * The trust root for the selected network, refreshed from the registry.
 *
 * The recorded snapshot is the starting point — it carries the registration transactions, which
 * the registry itself does not keep — and every field the registry does hold is read back from
 * it here. So the page opens with real data instantly and then reflects the chain: a key
 * revoked, re-attested or unbound since the snapshot shows as it stands now.
 */
export function useAttestation(intervalMs = 30_000): Poll<AttestationSnapshot> & {
  /** What is on screen, live or recorded, so a view never has to render nothing. */
  snapshot: AttestationSnapshot | null;
  /** True once the figures on screen came from the chain rather than from the record. */
  isLive: boolean;
} {
  const { deployment, chainId, rounds } = useApp();
  const recorded = attestationFor(chainId);

  // Candidate keys: whoever the record names, plus whoever signed a recorded answer. Every one
  // is confirmed against the registry before it appears, so a candidate costs nothing.
  const { candidates, modelsBySigner } = useMemo(() => {
    const models = new Map<string, string[]>();
    const add = (address: string | null | undefined, model: string) => {
      if (!address) return;
      const key = address.toLowerCase();
      const list = models.get(key) ?? [];
      if (!list.includes(model)) list.push(model);
      models.set(key, list);
    };

    for (const s of recorded?.signers ?? []) for (const m of s.models) add(s.address, m);
    for (const b of rounds) {
      for (const v of b.verdicts) {
        add(v.signer, v.model);
        add(v.attestedSigner, v.model);
      }
    }
    return {
      candidates: [...models.keys()].map((a) => getAddress(a)),
      modelsBySigner: models,
    };
  }, [recorded, rounds]);

  const key = `attestation:${chainId}:${candidates.join(',')}`;
  const read = useCallback(
    (d: Deployment) => readAttestation(d, candidates, modelsBySigner, recorded),
    [candidates, modelsBySigner, recorded],
  );

  const poll = usePolled(key, deployment, read, intervalMs);

  // A live read that finds no registered key is not an improvement on the record — it means the
  // candidates were wrong or the endpoint is answering badly — so the record stands.
  const usable = poll.data && poll.data.signers.length > 0 ? poll.data : null;
  return { ...poll, snapshot: usable ?? recorded, isLive: usable !== null };
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
