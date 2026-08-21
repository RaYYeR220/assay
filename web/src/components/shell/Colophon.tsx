'use client';

import { useApp } from '@/state/AppContext';
import { AddressRef } from '@/components/primitives';

/** Where the numbers came from. A register states its own provenance at the foot. */
export function Colophon() {
  const { chainId, deployment, round } = useApp();

  return (
    <footer className="pb-10 pt-6" style={{ borderTop: '1px solid var(--rule)' }}>
      <div className="grid gap-x-10 gap-y-3 md:grid-cols-4">
        <Item label="Register">
          Assay · net asset value oracle for assets no price feed covers.
        </Item>
        <Item label="Source of figures">
          {deployment
            ? 'Read directly from the public X Layer endpoint in this browser.'
            : 'Recorded rounds, replayed. No network call is required to read this page.'}
        </Item>
        <Item label="Oracle">
          {deployment ? (
            <AddressRef chainId={chainId} address={deployment.assayOracle} full />
          ) : (
            'awaiting deployment'
          )}
        </Item>
        <Item label="Round">
          {round
            ? `${round.bundle.bundleId}${round.bundle.source === 'fixture' ? ' · fixture' : ''}`
            : '—'}
        </Item>
      </div>
    </footer>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="legend">{label}</div>
      <div className="hex mt-1.5" style={{ color: 'var(--ink-3)' }}>
        {children}
      </div>
    </div>
  );
}
