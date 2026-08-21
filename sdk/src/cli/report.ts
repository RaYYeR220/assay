/**
 * A flat claim log.
 *
 * Every line states a claim about the deployment and then whether it holds. There is no
 * colour and no symbol carrying meaning on its own: the words PASS, FAIL and SKIPPED do the
 * work, so the output survives a pipe, a CI log and a screenshot equally.
 */

export type Status = 'PASS' | 'FAIL' | 'SKIPPED' | 'WARN';

export interface Claim {
  status: Status;
  claim: string;
  evidence: string;
  section: string;
}

export class Report {
  readonly claims: Claim[] = [];
  private section = 'general';
  private readonly quiet: boolean;

  constructor(options: { quiet?: boolean } = {}) {
    this.quiet = options.quiet ?? false;
  }

  heading(title: string): void {
    this.section = title;
    if (!this.quiet) process.stdout.write(`\n${title}\n${'-'.repeat(Math.max(title.length, 8))}\n`);
  }

  pass(claim: string, evidence: string): void {
    this.record('PASS', claim, evidence);
  }

  fail(claim: string, evidence: string): void {
    this.record('FAIL', claim, evidence);
  }

  /** Something could not be checked. Never a pass, and never a made-up value. */
  skip(claim: string, why: string): void {
    this.record('SKIPPED', claim, why);
  }

  /** True, but the reader needs to know anyway. */
  warn(claim: string, evidence: string): void {
    this.record('WARN', claim, evidence);
  }

  private record(status: Status, claim: string, evidence: string): void {
    this.claims.push({ status, claim, evidence, section: this.section });
    if (this.quiet) return;
    process.stdout.write(`${`[${status}]`.padEnd(10)}${claim}\n`);
    if (evidence) process.stdout.write(`${' '.repeat(10)}${evidence}\n`);
  }

  get failures(): number {
    return this.claims.filter((c) => c.status === 'FAIL').length;
  }

  get counts() {
    return {
      pass: this.claims.filter((c) => c.status === 'PASS').length,
      fail: this.failures,
      skipped: this.claims.filter((c) => c.status === 'SKIPPED').length,
      warn: this.claims.filter((c) => c.status === 'WARN').length,
    };
  }

  summarise(): void {
    const { pass, fail, skipped, warn } = this.counts;
    if (!this.quiet) {
      process.stdout.write(
        `\n${pass} passed, ${fail} failed, ${skipped} skipped${warn ? `, ${warn} flagged` : ''}\n`,
      );
      process.stdout.write(
        fail === 0
          ? skipped === 0
            ? 'Every claim was checked and holds.\n'
            : 'Every claim that could be checked holds. The skipped ones were not checked, not passed.\n'
          : 'At least one claim does not hold. Read the FAIL lines above.\n',
      );
    }
  }

  toJSON() {
    return { counts: this.counts, claims: this.claims };
  }
}

export function shortHex(value: string, keep = 10): string {
  return value.length <= keep * 2 ? value : `${value.slice(0, keep)}...${value.slice(-6)}`;
}

export function isoTime(seconds: number): string {
  return seconds > 0 ? new Date(seconds * 1000).toISOString().replace('.000Z', 'Z') : 'never';
}
