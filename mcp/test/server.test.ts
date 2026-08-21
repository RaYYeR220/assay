import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, loadConfig, ServerContext } from '../src/index.ts';

const EXPECTED_TOOLS = [
  'list_assets',
  'get_nav',
  'explain_round',
  'get_attestations',
  'verify_bundle',
  'check_vault',
];

async function connect(env: NodeJS.ProcessEnv = {}) {
  const server = createServer(new ServerContext(loadConfig(env)));
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

function payload(response: unknown): Record<string, unknown> {
  const content = (response as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content[0]!.type, 'text');
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

test('the server advertises exactly the six read tools', async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  await close();
});

test('every tool is annotated read-only', async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is not marked read-only`);
    assert.notEqual(tool.annotations?.destructiveHint, true, `${tool.name} claims to be destructive`);
  }
  await close();
});

test('no tool exposes a way to sign or send', async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const surface = JSON.stringify(tools).toLowerCase();
  for (const forbidden of ['privatekey', 'private_key', 'mnemonic', 'walletclient', 'sendtransaction']) {
    assert.ok(!surface.includes(forbidden), `tool surface mentions ${forbidden}`);
  }
  await close();
});

test('an unconfigured chain returns a refusal as data, not a protocol error', async () => {
  const { client, close } = await connect({ ASSAY_CHAIN_ID: '196', ASSAY_DEPLOYMENTS_DIR: '/nonexistent' });
  const response = await client.callTool({ name: 'list_assets', arguments: {} });

  assert.notEqual((response as { isError?: boolean }).isError, true);
  const body = payload(response);
  assert.equal(body['ok'], false);
  assert.equal(body['reason'], 'not-configured');
  assert.match(String(body['detail']), /AssayOracle/);
  await close();
});

test('verify_bundle re-runs the whole check locally, with no chain and no key', async () => {
  const { client, close } = await connect({ ASSAY_DEPLOYMENTS_DIR: '/nonexistent' });
  const fixture = await loadFixture();

  const response = await client.callTool({
    name: 'verify_bundle',
    arguments: {
      evidence: fixture.evidence,
      schema: { head: fixture.schema.head, mid: fixture.schema.mid, tail: fixture.schema.tail },
      policy: fixture.policy,
      now: fixture.now,
      members: fixture.members.slice(0, 5).map((m) => ({
        slot: m.slot,
        modelId: m.modelId,
        responseBody: m.responseBody,
        signature: m.signature,
      })),
    },
  });

  const body = payload(response);
  assert.equal(body['ok'], true);
  assert.equal(body['wouldPublish'], true);
  assert.equal(body['medianUsd'], '4.210000');

  const members = body['members'] as Array<Record<string, unknown>>;
  assert.equal(members.filter((m) => m['pass'] === true).length, 3);
  assert.equal(members.find((m) => m['slot'] === 3)?.['reason'], 'Malformed');
  assert.equal(members.find((m) => m['slot'] === 4)?.['reason'], 'Truncated');
  assert.equal(String(members[0]!['signedText']).length, 129);
  await close();
});

test('verify_bundle reports a disagreeing committee as a halt, not a failure', async () => {
  const { client, close } = await connect({ ASSAY_DEPLOYMENTS_DIR: '/nonexistent' });
  const fixture = await loadFixture();

  const response = await client.callTool({
    name: 'verify_bundle',
    arguments: {
      evidence: fixture.evidence,
      schema: fixture.schema,
      policy: { ...fixture.policy, bandBps: 10 }, // 0.1%: the honest answers now disagree
      now: fixture.now,
      members: fixture.members.slice(0, 3).map((m) => ({
        slot: m.slot,
        modelId: m.modelId,
        responseBody: m.responseBody,
        signature: m.signature,
      })),
    },
  });

  const body = payload(response);
  assert.equal(body['ok'], true);
  assert.equal(body['wouldPublish'], false);
  assert.equal(body['haltReason'], 'Disagreement');
  assert.ok((body['outlierSlots'] as number[]).length > 0);
  await close();
});

interface Fixture {
  schema: { head: string; mid: string; tail: string };
  evidence: string;
  now: number;
  policy: { quorum: number; minDistinctSigners: number; bandBps: number; minConfidenceBps: number; maxAgeSec: number };
  members: Array<{ slot: number; modelId: string; responseBody: string; signature: string }>;
}

/**
 * The SDK's signed fixture, reused so both packages check the same bytes rather than two
 * copies that can drift. It is a development artifact, so it lives in the sibling source
 * tree rather than in the published tarball.
 */
async function loadFixture(): Promise<Fixture> {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, '..', '..', 'sdk', 'test', 'fixtures', 'bundle.json'), 'utf8'),
  ) as Fixture;
}
