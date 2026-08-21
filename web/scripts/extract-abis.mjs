/**
 * Regenerates `src/abi/*.ts` from the Foundry build output in `../out`.
 *
 * The ABIs are checked in as `as const` literals so that viem can infer argument and
 * return types at compile time, and so the dashboard builds without the Solidity
 * toolchain present. Run `forge build` in the repository root, then `pnpm abi`.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'out');
const DEST = join(HERE, '..', 'src', 'abi');

/** Foundry artifact -> exported constant name. */
const TARGETS = [
  ['AssayOracle.sol/AssayOracle.json', 'assayOracleAbi', 'AssayOracle'],
  ['AssayVault.sol/AssayVault.json', 'assayVaultAbi', 'AssayVault'],
  ['AssetRegistry.sol/AssetRegistry.json', 'assetRegistryAbi', 'AssetRegistry'],
  ['AttestationRegistry.sol/AttestationRegistry.json', 'attestationRegistryAbi', 'AttestationRegistry'],
  ['UnverifiedQuoteAdapter.sol/UnverifiedQuoteAdapter.json', 'quoteAdapterAbi', 'UnverifiedQuoteAdapter'],
  ['DemoUSD.sol/DemoUSD.json', 'erc20Abi', 'DemoUSD'],
];

mkdirSync(DEST, { recursive: true });

const index = [];

for (const [artifact, name, label] of TARGETS) {
  const raw = JSON.parse(readFileSync(join(OUT, artifact), 'utf8'));
  const file = `${name.replace(/Abi$/, '')}.ts`;
  const body =
    `// Generated from out/${artifact} by scripts/extract-abis.mjs. Do not edit by hand.\n` +
    `// Source contract: ${label}\n\n` +
    `export const ${name} = ${JSON.stringify(raw.abi, null, 2)} as const;\n`;
  writeFileSync(join(DEST, file), body);
  index.push(`export { ${name} } from './${file.replace(/\.ts$/, '')}';`);
  console.log(`wrote src/abi/${file} (${raw.abi.length} entries)`);
}

writeFileSync(join(DEST, 'index.ts'), index.join('\n') + '\n');
