/**
 * Live-profile smoke check: drive the plugin's routes against the REAL profile
 * (the actual `$DSH_HOME/profiles/web` directory and its patch file), with the
 * loader entry list simulated from the composed tree.
 *
 * This is the closest thing to a production read that does not require the
 * running process: it answers "does the manager see the servers this machine
 * actually has, and does it parse this profile's real file".
 *
 * Read-only: it never writes, so it is safe to run against a live profile.
 *
 * Run with:  node test/live.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocument, readPatchText } from '../lib/patch.js';

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const profileDir = join(dshHome, 'profiles', 'web');
const patchPath = join(profileDir, 'cordis.patch.yml');
const homePatchPath = join(dshHome, 'cordis.patch.yml');

const hasProfile = existsSync(join(profileDir, 'package.json'));

// The plugin's own patch reader, so this suite sees the home layer exactly as
// the panel does. A regex over `id:` lines would also pick up the override rows
// (`- id: X` + `disabled: true`), which name a row without defining it.
const yaml = hasProfile ? createRequire(join(profileDir, 'package.json'))('js-yaml') : null;
const schema =
  yaml === null
    ? null
    : yaml.JSON_SCHEMA.extend(
        new yaml.Type('tag:yaml.org,2002:js', {
          kind: 'scalar',
          resolve: (data) => typeof data === 'string',
          construct: (data) => ({ __jsExpr: data }),
          predicate: (value) => value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string',
          represent: (value) => value.__jsExpr,
        }),
      );

/** Every MCP row the shared home layer defines, as the plugin reads it. */
function sharedLayerIds() {
  if (!hasProfile || !existsSync(homePatchPath)) return [];
  const document = readDocument(readPatchText(homePatchPath), yaml, schema);
  return document.rows.map((row) => row.id).filter((id) => typeof id === 'string' && id !== '');
}

const sharedIds = sharedLayerIds();

/**
 * Boot the plugin against the real profile directory.
 * @param loaderEntries - simulated loader entry list.
 * @param extraServices - additional `ctx.get` answers (tools, providers).
 */
async function bootReal(loaderEntries, extraServices = {}) {
  const plugin = await import('../lib/index.js');
  const routes = [];
  const ctx = {
    get(name) {
      if (Object.hasOwn(extraServices, name)) return extraServices[name];
      if (name === 'loader') return { entries: () => loaderEntries };
      return undefined;
    },
    effect(factory) {
      const dispose = factory();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  const route = routes.find((entry) => entry.path === '/mcp-manager-plus');
  assert.ok(route);
  return async function request(method, path, body) {
    const req = {
      method,
      url: `/mcp-manager-plus${path}`,
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
      },
    };
    let status = 0;
    let payload = '';
    const res = {
      writeHead(code) {
        status = code;
      },
      end(text) {
        payload = text ?? '';
      },
    };
    await route.handler(req, res);
    return { status, body: payload === '' ? null : JSON.parse(payload) };
  };
}

/**
 * Boot the plugin against a temporary profile whose patch file this suite
 * writes, so a case never depends on what the machine's real profile happens to
 * contain. Only the patch content is synthetic: `js-yaml` still resolves
 * through the real profile, which is why every caller keeps `skip: !hasProfile`.
 * @param patchText - the patch file the plugin will read and report.
 * @param loaderEntries - simulated loader entries beyond the include row.
 * @param extraServices - additional `ctx.get` answers (tools, providers).
 * @returns `{ request, dir }`; the caller removes `dir`.
 */
async function bootSynthetic(patchText, loaderEntries, extraServices = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-live-'));
  writeFileSync(join(dir, 'cordis.patch.yml'), patchText);
  writeFileSync(join(dir, 'cordis.yml'), '[]\n');
  const request = await bootReal(
    [
      { options: { id: 'include', name: 'cordis:include', config: { path: join(dir, 'cordis.yml') } } },
      ...loaderEntries,
    ],
    extraServices,
  );
  return { request, dir };
}

/** A patch layer holding one managed `dbx` row, exactly as the page writes it. */
const DBX_PATCH = `- insert:
    - id: mcp-dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: stdio
        command: node
`;

/** The composed row a live loader hands back for `dbx`. */
const DBX_ENTRY = {
  options: {
    id: 'mcp-dbx',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'dbx', transport: 'stdio', command: 'node' },
  },
  fiber: { state: 2 },
  disabled: false,
};

/** A shared home layer that defines one MCP row, the way a machine writes it. */
const SHARED_HOME_PATCH = `- insert:
    - id: mcp-shared
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: shared
        transport: stdio
        command: npx
`;

test('the real profile is reachable and its patch file parses', { skip: !hasProfile }, async () => {
  const request = await bootReal([
    { options: { id: 'include', name: 'cordis:include', config: { path: join(profileDir, 'cordis.yml') } } },
  ]);
  const { status, body } = await request('GET', '/servers');
  assert.equal(status, 200);
  assert.equal(body.patchPath, patchPath, 'the plugin must find the real patch file');
  assert.equal(body.profileDir, profileDir);
  assert.equal(body.homePatchPath, homePatchPath, 'the shared layer sits one level above profiles/');
  // A complaint about an override that can never take effect is a finding, not
  // a parse failure: this machine's file is readable and every issue must be
  // something the user can act on.
  for (const issue of body.issues) assert.equal(typeof issue, 'string');
});

test('the servers this machine configured are all visible, with secrets masked', { skip: !hasProfile || sharedIds.length === 0 }, async () => {
  // The machine's MCP rows live in the shared home layer, so the composed tree
  // has to be simulated from that file — the point of this check is that the
  // manager sees what a boot would see, including where each row came from.
  const request = await bootReal([
    { options: { id: 'include', name: 'cordis:include', config: { path: join(profileDir, 'cordis.yml') } } },
    ...sharedIds.map((id) => ({
      options: { id, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: id.replace(/^mcp-/u, ''), transport: 'stdio' } },
      fiber: { state: 2 },
      disabled: false,
    })),
  ]);
  const { body } = await request('GET', '/servers');
  assert.ok(body.servers.length > 0, 'this profile has at least one MCP server configured');
  const shared = body.servers.filter((server) => server.source === 'shared');
  assert.equal(
    shared.length,
    sharedIds.length,
    'every row the shared layer defines must be listed, and labelled as shared',
  );

  for (const server of body.servers) {
    assert.equal(typeof server.serverName, 'string');
    assert.ok(server.serverName.length > 0);
    assert.ok(['user', 'shared', 'bundle', 'builtin'].includes(server.source));
    assert.ok(['stdio', 'streamable-http', 'built-in'].includes(server.transport));
    // No credential-shaped value may survive into the payload.
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (!/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue;
      assert.notEqual(value, '', `${server.serverName}.${key} must be masked`);
      assert.match(String(value), /^•+$/, `${server.serverName}.${key} must reach the page masked`);
    }
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      if (!/KEY|PASSWORD|SECRET|TOKEN|AUTH/i.test(key)) continue;
      assert.match(String(value), /^•+$/, `${server.serverName}.${key} must reach the page masked`);
    }
  }
});

test('live tool names are reported raw, and mount state follows the fiber', { skip: !hasProfile }, async () => {
  const tools = {
    schemas: () => [
      { name: 'mcp__dbx__dbx_list_connections', description: 'List connections' },
      { name: 'mcp__dbx__dbx_open_table', description: 'Open a table' },
      { name: 'mcp__other__ping', description: 'Ping' },
      { name: 'read', description: 'Not an MCP tool' },
    ],
  };
  const { request, dir } = await bootSynthetic(DBX_PATCH, [DBX_ENTRY], { tools });
  try {
    const { body } = await request('GET', '/servers');
    const dbx = body.servers.find((server) => server.serverName === 'dbx');
    assert.ok(dbx, 'the dbx server from this profile must be listed');
    assert.equal(dbx.live.mounted, true, 'the composed row must be matched by serverName, not entry id');
    assert.equal(dbx.live.phase, 'active');
    assert.deepEqual(
      dbx.live.tools.map((tool) => tool.name),
      ['dbx_list_connections', 'dbx_open_table'],
      'tools must be attributed by the mcp__<server>__ prefix and named raw',
    );
    // The prefix must not leak a same-prefix neighbour from another server.
    assert.equal(dbx.live.tools.some((tool) => tool.name === 'ping'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed fiber is reported as failed rather than silently idle', { skip: !hasProfile }, async () => {
  const { request, dir } = await bootSynthetic(DBX_PATCH, [{ ...DBX_ENTRY, fiber: { state: 3 } }]);
  try {
    const { body } = await request('GET', '/servers');
    const dbx = body.servers.find((server) => server.serverName === 'dbx');
    assert.equal(dbx.live.phase, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a patch-layer disable is reported as done only once the loader agrees', { skip: !hasProfile }, async () => {
  // Two states of the same row, because the difference between them is the
  // whole point: a written override the loader has not composed yet is a
  // pending intent, not a server that has stopped feeding the model. Reporting
  // it as off — with zero tools — is exactly how a guard turns out to be
  // decorative.
  const pending = await bootSynthetic(`${DBX_PATCH}- id: mcp-dbx\n  disabled: true\n`, [DBX_ENTRY]);
  try {
    const dbx = (await pending.request('GET', '/servers')).body.servers.find((s) => s.serverName === 'dbx');
    assert.equal(dbx.enabled, true, 'the loader has not composed the override yet');
    assert.equal(dbx.overridePending, true);
    assert.equal(dbx.live.toolCount, 0, 'no tools were simulated for this entry');
  } finally {
    rmSync(pending.dir, { recursive: true, force: true });
  }

  const composed = await bootSynthetic(`${DBX_PATCH}- id: mcp-dbx\n  disabled: true\n`, [
    { ...DBX_ENTRY, disabled: true, fiber: undefined },
  ]);
  try {
    const dbx = (await composed.request('GET', '/servers')).body.servers.find((s) => s.serverName === 'dbx');
    assert.equal(dbx.enabled, false);
    assert.equal(dbx.overridePending, false);
    assert.equal(dbx.live.phase, 'disabled');
  } finally {
    rmSync(composed.dir, { recursive: true, force: true });
  }
});

test('a row the shared layer defines is labelled shared and points at that layer', { skip: !hasProfile }, async () => {
  // The shared home layer is composed after the profile layer, so which file
  // owns a row's switch is not cosmetic: an override written into the wrong one
  // is skipped by the loader. The scratch tree mirrors a real home, so the
  // resolution under test is the one a boot does — and `js-yaml` still resolves
  // through the real profile, which is why this suite needs one.
  const scratch = mkdtempSync(join(tmpdir(), 'mcp-manager-live-home-'));
  const fakeProfile = join(scratch, 'profiles', 'web');
  mkdirSync(fakeProfile, { recursive: true });
  writeFileSync(join(scratch, 'cordis.patch.yml'), SHARED_HOME_PATCH);
  writeFileSync(join(fakeProfile, 'cordis.patch.yml'), '# empty\n[]\n');
  writeFileSync(join(fakeProfile, 'cordis.yml'), '[]\n');

  try {
    const request = await bootReal([
      { options: { id: 'include', name: 'cordis:include', config: { path: join(fakeProfile, 'cordis.yml') } } },
      {
        options: {
          id: 'mcp-shared',
          name: '@deepseek-ai/dsh-mcp-client',
          config: { serverName: 'shared', transport: 'stdio' },
        },
        fiber: { state: 2 },
        disabled: false,
      },
    ]);
    const { status, body } = await request('GET', '/servers');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(
      body.homePatchPath,
      join(scratch, 'cordis.patch.yml'),
      'the shared layer is derived from the profile location, one level above profiles/',
    );
    const shared = body.servers.find((server) => server.serverName === 'shared');
    assert.ok(shared, 'the shared-layer row must be listed');
    assert.equal(shared.source, 'shared', 'the shared layer is not a bundle and must not be labelled as one');
    assert.equal(shared.controlLayer, 'home', 'the page must know which file owns this switch');
    assert.equal(shared.enabled, true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a row the patch layer does not own is listed from the composed tree', { skip: !hasProfile }, async () => {
  const { request, dir } = await bootSynthetic('# header\n[]\n', [DBX_ENTRY]);
  try {
    const { body } = await request('GET', '/servers');
    const dbx = body.servers.find((server) => server.serverName === 'dbx');
    assert.ok(dbx, 'a deployment-provided server must still be listed');
    assert.equal(dbx.source, 'bundle');
    assert.equal(dbx.editable, false);
    assert.equal(dbx.live.mounted, true);
    assert.equal(dbx.live.phase, 'active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
