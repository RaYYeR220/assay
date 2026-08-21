/**
 * Formatting helpers. Every figure on screen is derived from an integer, never from a float,
 * so the value a reader sees is the value the contract stores.
 */

/** Splits a 1e6-scaled USD integer into whole and fractional parts for typographic layering. */
export function splitE6(valueE6: bigint): { whole: string; fraction: string } {
  const negative = valueE6 < 0n;
  const abs = negative ? -valueE6 : valueE6;
  const whole = (abs / 1_000_000n).toString();
  const fraction = (abs % 1_000_000n).toString().padStart(6, '0');
  return { whole: `${negative ? '-' : ''}${groupDigits(whole)}`, fraction };
}

export function formatE6(valueE6: bigint): string {
  const { whole, fraction } = splitE6(valueE6);
  return `${whole}.${fraction}`;
}

/** Rounds a 1e6 figure to a plain two-decimal display, for dense tables. */
export function formatE6Short(valueE6: bigint): string {
  const cents = (valueE6 + 5000n) / 10_000n;
  return `${groupDigits((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export function groupDigits(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatUnits(value: bigint, decimals: number, dp = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, '0').slice(0, dp);
  return dp > 0 ? `${groupDigits(whole.toString())}.${frac}` : groupDigits(whole.toString());
}

export function parseUnits(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') return null;
  const [whole = '0', frac = ''] = trimmed.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

export function truncateHex(hex: string, lead = 6, tail = 4): string {
  if (hex.length <= lead + tail + 2) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

/** Relative age, phrased tersely. Instrument readouts, not prose. */
export function relativeAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—';
  return `${groupDigits(Math.round(bps).toString())} bps`;
}

/** Basis points rendered as a percentage, for copy aimed at a first-time reader. */
export function bpsToPercent(bps: number): string {
  const pct = bps / 100;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`;
}

export function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** Model ids read `vendor/model`; the vendor is set apart in the readouts. */
export function splitModelId(id: string): { vendor: string; name: string } {
  const i = id.indexOf('/');
  return i < 0 ? { vendor: '', name: id } : { vendor: id.slice(0, i), name: id.slice(i + 1) };
}
