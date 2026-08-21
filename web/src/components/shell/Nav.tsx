'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const SECTIONS = [
  { href: '/', index: 'I', label: 'Oracle' },
  { href: '/attestation/', index: 'II', label: 'Attestation' },
  { href: '/evidence/', index: 'III', label: 'Evidence' },
  { href: '/vault/', index: 'IV', label: 'Vault' },
  { href: '/dispute/', index: 'V', label: 'Dispute' },
] as const;

/** Numbered sections, as a register's contents page would list them. */
export function Nav() {
  const pathname = usePathname();
  const normalised = pathname.endsWith('/') ? pathname : `${pathname}/`;

  return (
    <nav className="flex flex-wrap items-stretch">
      {SECTIONS.map((s) => {
        const active = normalised === s.href;
        return (
          <Link
            key={s.href}
            href={s.href}
            aria-current={active ? 'page' : undefined}
            className="group relative flex items-baseline gap-2 py-3 pr-9 transition-colors"
            style={{ color: active ? 'var(--ink)' : 'var(--ink-3)' }}
          >
            <span className="legend" style={{ color: active ? 'var(--ink-4)' : 'var(--ink-4)' }}>
              {s.index}
            </span>
            <span
              className="text-[13px] tracking-[0.04em]"
              style={{ fontWeight: active ? 600 : 400 }}
            >
              {s.label}
            </span>
            <span
              aria-hidden
              className="absolute bottom-0 left-0 h-[2px] transition-[width] duration-200 ease-out"
              style={{
                width: active ? 'calc(100% - 2.25rem)' : 0,
                background: 'var(--ink)',
              }}
            />
          </Link>
        );
      })}
    </nav>
  );
}
