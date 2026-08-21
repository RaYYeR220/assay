'use client';

import { useApp } from '@/state/AppContext';
import { toRoundView } from '@/lib/bundle';

/**
 * The recorded rounds, as entries in a register. Selecting one changes every view at once,
 * which is what lets a reader put a published round and a refused round side by side without
 * a wallet, a key, or a running service.
 */
export function RoundPicker() {
  const { rounds, roundIndex, setRoundIndex } = useApp();

  if (rounds.length <= 1) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="legend mr-1">Entry</span>
      {rounds.map((b, i) => {
        const view = toRoundView(b);
        const active = i === roundIndex;
        const halted = !view.published;
        return (
          <button
            key={b.bundleId}
            className="control"
            data-active={active}
            onClick={() => setRoundIndex(i)}
            title={`${b.assetLabel ?? b.assetId} · ${b.createdAt}`}
            style={
              !active && halted
                ? { color: 'var(--alarm)', borderColor: 'var(--alarm-rule)' }
                : undefined
            }
          >
            <span className="figure">EP {view.epoch ?? i}</span>
            <span className="mx-1.5" style={{ opacity: 0.4 }}>
              ·
            </span>
            {halted ? 'halted' : 'struck'}
          </button>
        );
      })}
    </div>
  );
}
