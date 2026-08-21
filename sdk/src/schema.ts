import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToString, type Hex } from 'viem';
import { toBytes, type PromptSchema } from './verify.ts';

/**
 * Load the prompt fragments exported from `script/Schema.sol`.
 *
 * This is a convenience for local tooling only. Anything that verifies a real round should
 * read the fragments back out of AssetRegistry, because the registry copy is what the
 * contract concatenates and the file could be anything.
 */
export function loadSchemaFile(path?: string): PromptSchema {
  const candidates = [
    path,
    process.env['ASSAY_SCHEMA_PATH'],
    ...schemaSearchPaths(),
  ].filter((p): p is string => typeof p === 'string');

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as PromptSchema;
    if (parsed.head && parsed.mid && parsed.tail) return parsed;
  }
  throw new Error(`no schema.appraisal.v1.json found. Looked in:\n  ${candidates.join('\n  ')}`);
}

function schemaSearchPaths(): string[] {
  const paths: string[] = [];
  const roots = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const root of roots) {
    let dir = resolve(root);
    for (let i = 0; i < 8; i++) {
      paths.push(join(dir, 'schema.appraisal.v1.json'));
      paths.push(join(dir, 'assay', 'schema.appraisal.v1.json'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...new Set(paths)];
}

/** The system prompt and user preamble, read out of the schema bytes themselves. */
export function describeSchema(schema: PromptSchema): {
  head: string;
  mid: string;
  tail: string;
  systemPrompt: string | null;
  userPreamble: string | null;
} {
  const head = decode(schema.head);
  const mid = decode(schema.mid);
  const tail = decode(schema.tail);
  return {
    head,
    mid,
    tail,
    systemPrompt: between(mid, '"role":"system","content":"', '"}'),
    userPreamble: after(mid, '"content":"'),
  };
}

function decode(value: Hex): string {
  return bytesToString(toBytes(value));
}

function between(haystack: string, open: string, close: string): string | null {
  const start = haystack.indexOf(open);
  if (start < 0) return null;
  const end = haystack.indexOf(close, start + open.length);
  if (end < 0) return null;
  return haystack.slice(start + open.length, end);
}

function after(haystack: string, marker: string): string | null {
  const at = haystack.lastIndexOf(marker);
  return at < 0 ? null : haystack.slice(at + marker.length);
}
