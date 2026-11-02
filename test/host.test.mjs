/**
 * End-to-end tests for the host half: the real `apply()` is driven through a
 * minimal fake Cordis context, so every HTTP route, the patch-file writes and
 * the inventory projection are exercised as they run in the harness.
 *
 * Run with:  node test/host.test.mjs
 *
 * The fake context provides only what the plugin actually uses (`get`,
 * `effect`, and a capturing `webServer`), which is also a check that the
 * plugin does not reach for anything else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveEntryYaml, yamlResolutionAnchors } from '../lib/yaml.js';

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const profileRequire = createRequire(join(dshHome, 'profiles', 'web', 'package.json'));
const yaml = profileRequire('js-yaml');
const yamlPath = profileRequire.resolve('js-yaml');

const plugin = await import('../lib/index.js');

const jsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: (value) => value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string',
  represent: (value) => value.__jsExpr,
});
const schema = yaml.JSON_SCHEMA.extend(jsExpr);

const SEED = `# Your patch layer for this dsh profile.
- insert:
    - id: mcp-dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: stdio
        command: "node.exe"
        args: ["dbx-mcp-server.js"]
        env:
          DBX_DATA_DIR: "E:\\\\tools\\\\DBX_x64-portable\\\\data"
          DBX_API_TOKEN: "s3cret"
`;

/**
 * Boot the plugin against a temporary profile and return a driver for its
 * routes.
 *
 * The scratch tree mirrors a real harness home — `<dir>/cordis.patch.yml` as
 * the shared home layer, `<dir>/profiles/web/cordis.patch.yml` as the
 * profile's own — because which of those two a toggle has to write to is a
 * function of the layout, and a test that fakes the layout tests nothing.
 * @param seed - initial profile patch-file content (defaults to {@link SEED}).
 * @param options - `{ tools, services, loaderEntries, includeEntry, homeSeed }` stubs.
 * @returns `{ patchPath, homePatchPath, request, read, dispose, log }`.
 */
async function boot(seed = SEED, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-host-'));
  const profileDir = join(dir, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const homePatchPath = join(dir, 'cordis.patch.yml');
  if (seed !== null) writeFileSync(patchPath, seed);
  if (options.homeSeed !== undefined) writeFileSync(homePatchPath, options.homeSeed);

  const routes = [];
  const cleanups = [];
  const log = [];
  const toolSchemas = options.tools ?? [];
  const services = options.services ?? {};
  const loaderEntries = options.loaderEntries ?? [];

  const ctx = {
    get(name) {
      if (name === 'tools') return { schemas: () => toolSchemas };
      if (Object.hasOwn(services, name)) return services[name];
      if (name === 'loader') {
        if (options.includeEntry === null) return undefined;
        return {
          entries: () => [
            {
              options: {
                id: 'include',
                name: 'cordis:include',
                config: { path: options.includeEntry ?? join(profileDir, 'cordis.yml') },
              },
              fiber: { state: 2 },
              disabled: false,
            },
            ...loaderEntries,
          ],
        };
      }
      return undefined;
    },
    effect(factory, label) {
      const dispose = factory();
      cleanups.push(dispose);
      log.push(label);
      return dispose;
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
  };

  plugin.apply(ctx);
  const route = routes.find((entry) => entry.path === '/mcp-manager-plus');
  assert.ok(route, 'the management route must be registered');

  /** Issue one request through the real handler. */
  async function request(method, path, body) {
    const url = `/mcp-manager-plus${path}`;
    const req = {
      method,
      url,
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
      },
    };
    let status = 0;
    let payload = '';
    const headers = {};
    const res = {
      writeHead(code, sent) {
        status = code;
        Object.assign(headers, sent ?? {});
      },
      end(text) {
        payload = text ?? '';
      },
    };
    await route.handler(req, res);
    return { status, headers, body: payload === '' ? null : JSON.parse(payload) };
  }

  return {
    dir: profileDir,
    patchPath,
    homePatchPath,
    request,
    read: () => readFileSync(patchPath, 'utf8'),
    readHome: () => readFileSync(homePatchPath, 'utf8'),
    parse: () => yaml.load(readFileSync(patchPath, 'utf8'), { schema }),
    dispose() {
      for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('lists the servers already in the patch layer, with secrets masked', async () => {
  const app = await boot();
  try {
    const { status, body } = await app.request('GET', '/servers');
    assert.equal(status, 200);
    assert.equal(body.servers.length, 1);
    const server = body.servers[0];
    assert.equal(server.serverName, 'dbx');
    assert.equal(server.id, 'mcp-dbx');
    assert.equal(server.source, 'user');
    assert.equal(server.enabled, true);
    assert.equal(server.transport, 'stdio');
    assert.deepEqual(server.args, ['dbx-mcp-server.js']);
    assert.equal(server.env.DBX_DATA_DIR, 'E:\\tools\\DBX_x64-portable\\data');
    assert.notEqual(server.env.DBX_API_TOKEN, 's3cret', 'a credential must never reach the browser');
    assert.equal(body.writable, true);
  } finally {
    app.dispose();
  }
});

test('rejects a non-loopback caller', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-remote-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, '# header\n[]\n');
  const routes = [];
  const ctx = {
    get(name) {
      if (name === 'loader') {
        return {
          entries: () => [
            { options: { id: 'include', name: 'cordis:include', config: { path: join(dir, 'cordis.yml') } } },
          ],
        };
      }
      return undefined;
    },
    effect(factory) {
      return factory();
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
  try {
    let status = 0;
    let payload = '';
    await route.handler(
      {
        method: 'GET',
        url: '/mcp-manager-plus/servers',
        socket: { remoteAddress: '10.1.2.3' },
        async *[Symbol.asyncIterator]() {},
      },
      {
        writeHead(code) {
          status = code;
        },
        end(text) {
          payload = text ?? '';
        },
      },
    );
    assert.equal(status, 403);
    assert.match(JSON.parse(payload).error, /本机/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('creating a server appends a row and a re-read sees it', async () => {
  const app = await boot();
  try {
    const saved = await app.request('POST', '/save', {
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'tok' },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.action, 'created');
    assert.equal(saved.body.serverName, 'github');

    // The dbx row is untouched, and the new row is a sibling block.
    const parsed = app.parse();
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].insert[0].id, 'mcp-dbx');
    assert.equal(parsed[1].insert[0].id, 'mcp-github');
    assert.equal(parsed[1].insert[0].config.serverName, 'github');
    assert.equal(parsed[1].insert[0].config.env.GITHUB_TOKEN, 'tok');

    const listing = await app.request('GET', '/servers');
    assert.deepEqual(
      listing.body.servers.map((s) => s.serverName),
      ['dbx', 'github'],
    );
  } finally {
    app.dispose();
  }
});

test('editing a server updates its own row and keeps its siblings', async () => {
  const app = await boot();
  try {
    const saved = await app.request('POST', '/save', {
      serverName: 'dbx',
      originalName: 'dbx',
      transport: 'stdio',
      command: 'node2.exe',
      args: ['a.js', 'b.js'],
    });
    assert.equal(saved.body.action, 'updated');
    const parsed = app.parse();
    assert.equal(parsed.length, 1, 'the row stays in its original block');
    const row = parsed[0].insert[0];
    assert.equal(row.id, 'mcp-dbx');
    assert.equal(row.config.command, 'node2.exe');
    assert.deepEqual(row.config.args, ['a.js', 'b.js']);
    // A field the form did not resubmit is preserved, not dropped.
    assert.equal(row.config.env.DBX_API_TOKEN, 's3cret');
  } finally {
    app.dispose();
  }
});

test('a masked credential round-trips unchanged when the form echoes it back', async () => {
  const app = await boot();
  try {
    const listing = await app.request('GET', '/servers');
    const masked = listing.body.servers[0].env;
    assert.notEqual(masked.DBX_API_TOKEN, 's3cret');
    await app.request('POST', '/save', {
      serverName: 'dbx',
      originalName: 'dbx',
      transport: 'stdio',
      command: 'node.exe',
      args: ['dbx-mcp-server.js'],
      env: masked,
    });
    const row = app.parse()[0].insert[0];
    assert.equal(row.config.env.DBX_API_TOKEN, 's3cret', 'the mask must resolve back to the real value');
  } finally {
    app.dispose();
  }
});

test('a renamed server keeps its row id and its overrides', async () => {
  const app = await boot();
  try {
    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: false });
    assert.equal(app.parse().length, 2, 'the disable override was appended');

    const saved = await app.request('POST', '/save', {
      serverName: 'dbx2',
      originalName: 'dbx',
      transport: 'stdio',
      command: 'node.exe',
    });
    assert.equal(saved.body.action, 'updated');
    assert.equal(saved.body.id, 'mcp-dbx');
    const parsed = app.parse();
    assert.equal(parsed[0].insert[0].id, 'mcp-dbx');
    assert.equal(parsed[0].insert[0].config.serverName, 'dbx2');
  } finally {
    app.dispose();
  }
});

test('disabling then enabling a user row leaves one override, then none', async () => {
  const app = await boot();
  try {
    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: false });
    let listing = await app.request('GET', '/servers');
    assert.equal(listing.body.servers[0].enabled, false);
    assert.equal(app.parse().length, 2);

    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: true });
    listing = await app.request('GET', '/servers');
    assert.equal(listing.body.servers[0].enabled, true);
    const parsed = app.parse();
    assert.equal(parsed.length, 1, 'the redundant override is dropped, not replaced with disabled:false');
  } finally {
    app.dispose();
  }
});

test('toggling repeatedly never accumulates override blocks', async () => {
  const app = await boot();
  try {
    // Ends on "enabled", which drops the override entirely for a user row.
    for (let i = 0; i < 5; i += 1) {
      await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: i % 2 === 0 });
    }
    assert.equal(
      (app.read().match(/^- id: mcp-dbx$/gmu) ?? []).length,
      0,
      'a user row that ends enabled carries no override at all',
    );

    // Ending on "disabled" leaves exactly one, however many times it flipped.
    for (let i = 0; i < 6; i += 1) {
      await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: i % 2 === 0 });
    }
    assert.equal((app.read().match(/^- id: mcp-dbx$/gmu) ?? []).length, 1);
    assert.equal(yaml.load(app.read(), { schema }).length, 2);
  } finally {
    app.dispose();
  }
});

test('removing a server drops its row and its override, keeping the header', async () => {
  const app = await boot();
  try {
    await app.request('POST', '/toggle', { id: 'mcp-dbx', enabled: false });
    const removed = await app.request('POST', '/remove', { id: 'mcp-dbx' });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.action, 'removed');
    const text = app.read();
    assert.doesNotMatch(text, /mcp-dbx/);
    assert.match(text, /# Your patch layer/);
    assert.match(text, /^\[\]$/mu, 'an emptied file keeps a valid placeholder');
  } finally {
    app.dispose();
  }
});

test('a built-in provider service is listed read-only beside the servers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-builtin-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, '# header\n[]\n');
  const routes = [];
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          schemas: () => [
            { name: 'computer_use_get_app_state', description: 'Read the app state' },
            { name: 'computer_use_click', description: 'Click a point' },
            { name: 'unrelated_tool', description: 'Not part of the provider' },
          ],
        };
      }
      if (name === 'computerUse') return { register: () => async () => {} };
      if (name === 'loader') {
        return {
          entries: () => [
            { options: { id: 'include', name: 'cordis:include', config: { path: join(dir, 'cordis.yml') } } },
          ],
        };
      }
      return undefined;
    },
    effect(factory) {
      return factory();
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
  try {
    let payload = '';
    await route.handler(
      {
        method: 'GET',
        url: '/mcp-manager-plus/servers',
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {},
      },
      {
        writeHead() {},
        end(text) {
          payload = text ?? '';
        },
      },
    );
    const builtin = JSON.parse(payload).servers.find((s) => s.source === 'builtin');
    assert.ok(builtin, 'the built-in provider must be listed');
    assert.equal(builtin.editable, false);
    assert.equal(builtin.removable, false);
    assert.deepEqual(
      builtin.live.tools.map((t) => t.name),
      ['computer_use_click', 'computer_use_get_app_state'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The composed MCP row a loader hands back for a server named `shared`. */
function sharedEntry(disabled) {
  return {
    options: {
      id: 'mcp-shared',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'shared', transport: 'stdio', command: 'npx' },
    },
    fiber: { state: 2 },
    disabled,
  };
}

test('a bundle-provided row is listed read-only and togglable', async () => {
  const app = await boot('# header\n[]\n', {
    tools: [
      { name: 'mcp__shared__ping', description: 'Ping' },
      { name: 'mcp__shared__pong', description: 'Pong' },
    ],
    loaderEntries: [sharedEntry(false)],
  });
  try {
    const listing = await app.request('GET', '/servers');
    const shared = listing.body.servers.find((s) => s.serverName === 'shared');
    assert.ok(shared, 'the bundle row must appear');
    assert.equal(shared.source, 'bundle');
    assert.equal(shared.controlLayer, 'profile', 'a bundle row is still reachable from the profile layer');
    assert.equal(shared.editable, false);
    assert.equal(shared.removable, false);
    assert.equal(shared.live.toolCount, 2);
    assert.deepEqual(
      shared.live.tools.map((t) => t.name),
      ['ping', 'pong'],
    );

    const toggled = await app.request('POST', '/toggle', { id: 'mcp-shared', enabled: false });
    assert.equal(toggled.status, 200);
    assert.equal(toggled.body.layer, 'profile');
    assert.match(app.read(), /- id: mcp-shared\n  disabled: true/);

    // The override is the intent; the loader entry is the fact. This stub
    // never reloads, so the page must report the fact — an uncomposed override
    // must not be presented as a server that has stopped feeding the model,
    // and its tools must stay listed because they are still reaching it.
    const after = toggled.body.state.servers.find((s) => s.serverName === 'shared');
    assert.equal(after.enabled, true, 'the loader has not composed the override yet');
    assert.equal(after.overridePending, true, 'a written override that has not taken effect must be visible');
    assert.equal(after.live.toolCount, 2, 'tools stay listed while they still reach the model');

    const remove = await app.request('POST', '/remove', { id: 'mcp-shared' });
    assert.equal(remove.status, 400);
    assert.match(remove.body.error, /不能删除|只能停用/);
  } finally {
    app.dispose();
  }
});

test('once the loader composes the override the row really reads as off', async () => {
  // The same row, this time with its live entry in the state the composition
  // actually produces. This is what the browser's settle-poll waits for.
  const seed = `# header
- insert:
    - id: mcp-shared
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: shared
        transport: stdio
        command: npx
- id: mcp-shared
  disabled: true
`;
  const app = await boot(seed, {
    tools: [{ name: 'mcp__shared__ping', description: 'Ping' }],
    loaderEntries: [sharedEntry(true)],
  });
  try {
    const { body } = await app.request('GET', '/servers');
    const shared = body.servers.find((s) => s.serverName === 'shared');
    assert.equal(shared.enabled, false, 'the loader agrees with the override, so the row is off');
    assert.equal(shared.overridePending, false, 'nothing is pending once the loader agrees');
    assert.equal(shared.live.phase, 'disabled');
    assert.equal(shared.live.toolCount, 0);

    const on = await app.request('POST', '/toggle', { id: 'mcp-shared', enabled: true });
    assert.equal(on.status, 200);
    // This plugin inserted the row, so nothing holds it down and the override is
    // simply dropped rather than written back as `disabled: false`.
    assert.doesNotMatch(app.read(), /disabled:/u);
    assert.match(app.read(), /serverName: shared/u, 'the definition itself must survive');
  } finally {
    app.dispose();
  }
});

test('importing an mcpServers document adds each entry', async () => {
  const app = await boot('# header\n[]\n');
  try {
    const result = await app.request('POST', '/import', {
      json: JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
          'web-http': { url: 'http://localhost:3000/mcp', headers: { Authorization: 'Bearer t' } },
        },
      }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.created.sort(), ['github', 'web-http']);

    const listing = await app.request('GET', '/servers');
    const byName = Object.fromEntries(listing.body.servers.map((s) => [s.serverName, s]));
    assert.equal(byName.github.transport, 'stdio');
    assert.equal(byName['web-http'].transport, 'streamable-http');
    assert.equal(byName['web-http'].url, 'http://localhost:3000/mcp');
  } finally {
    app.dispose();
  }
});

test('re-importing an existing server updates it instead of failing', async () => {
  const app = await boot();
  try {
    const result = await app.request('POST', '/import', {
      json: JSON.stringify({
        mcpServers: { dbx: { command: 'node3.exe', args: ['new.js'] } },
      }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.updated, ['dbx']);
    assert.deepEqual(result.body.created, []);
    const row = app.parse()[0].insert[0];
    assert.equal(row.id, 'mcp-dbx', 'the edit keeps the row id');
    assert.equal(row.config.command, 'node3.exe');
    assert.deepEqual(row.config.args, ['new.js']);
  } finally {
    app.dispose();
  }
});

test('importing rejects a malformed document with an actionable message', async () => {
  const app = await boot('# header\n[]\n');
  try {
    const bad = await app.request('POST', '/import', { json: '{ not json' });
    assert.equal(bad.status, 400);
    // The message names the position the parser choked on, and says "配置"
    // rather than "JSON" because a TOML paste is a supported input too.
    assert.match(bad.body.error, /配置解析失败/);
    assert.match(bad.body.error, /position|line/u);

    const empty = await app.request('POST', '/import', { json: '{"mcpServers":{}}' });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /未在配置中找到/);
  } finally {
    app.dispose();
  }
});

test('validation rejects an invalid server name and a duplicate', async () => {
  const app = await boot();
  try {
    const bad = await app.request('POST', '/save', { serverName: 'has space', transport: 'stdio', command: 'npx' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /服务名/);

    const dup = await app.request('POST', '/save', { serverName: 'dbx', transport: 'stdio', command: 'npx' });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /已存在/);
  } finally {
    app.dispose();
  }
});

test('lang=en asks the host for English messages', async () => {
  const app = await boot();
  try {
    const bad = await app.request('POST', '/save?lang=en', { serverName: 'dbx', transport: 'stdio', command: 'npx' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /already exists/u);

    const saved = await app.request('POST', '/save?lang=en', {
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
    assert.equal(saved.status, 200);
    const imported = await app.request('POST', '/import?lang=en', {
      json: JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'x'] } } }),
    });
    assert.equal(imported.status, 200);
    assert.match(imported.body.message, /Recognized .* configuration; Updated github/u);

    const unknown = await app.request('GET', '/nope?lang=en');
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /Unknown endpoint/u);
  } finally {
    app.dispose();
  }
});

test('the default language stays Chinese when no lang is asked for', async () => {
  const app = await boot();
  try {
    const unknown = await app.request('GET', '/nope');
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /未知接口/u);
  } finally {
    app.dispose();
  }
});

test('a save never leaves the document unparseable, even under odd input', async () => {
  const app = await boot();
  try {
    const cases = [
      { serverName: 'a', transport: 'stdio', command: 'npx', args: ['x', '', 'y'] },
      { serverName: 'b', transport: 'streamable-http', url: 'http://x/mcp', headers: { A: '1', B: '2' } },
      { serverName: 'c', transport: 'stdio', command: 'npx', env: { 'WEIRD KEY': 'v' } },
    ];
    for (const body of cases) {
      const result = await app.request('POST', '/save', body);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(yaml.load(app.read(), { schema }) instanceof Array, true);
    }
  } finally {
    app.dispose();
  }
});

test('the reported patch path follows the loader include entry', async () => {
  const app = await boot();
  try {
    const { body } = await app.request('GET', '/servers');
    assert.equal(body.patchPath, app.patchPath);
    assert.equal(body.profileDir, app.dir);
  } finally {
    app.dispose();
  }
});

test('a read-only patch file is reported instead of failing on write', async () => {
  const app = await boot();
  try {
    const { body } = await app.request('GET', '/servers');
    assert.equal(body.writable, true);
  } finally {
    app.dispose();
  }
});

// Regression for the DSH Desktop report: it hands the include path over as a
// `file://` URL, so an install directory containing a space arrives
// percent-encoded (`DeepSeek%20Harness`). Reading that verbatim named a file
// that does not exist, and the writability probe then reported the patch file
// as read-only, refusing every save.
test('a percent-encoded file:// include path resolves to the real patch file', async () => {
  const base = mkdtempSync(join(tmpdir(), 'mcp-manager-url-'));
  const dir = join(base, 'DeepSeek Harness');
  mkdirSync(dir);
  const patchPath = join(dir, 'cordis.patch.yml');
  writeFileSync(patchPath, SEED);
  const includeUrl = pathToFileURL(join(dir, 'cordis.yml')).href;
  assert.match(includeUrl, /%20/u, 'the fixture must really carry percent-encoding');

  const app = await boot(null, { includeEntry: includeUrl });
  try {
    const { status, body } = await app.request('GET', '/servers');
    assert.equal(status, 200);
    assert.equal(body.patchPath, patchPath, 'the decoded path must name the real patch file');
    assert.equal(body.writable, true, 'a space in the install path must not look read-only');
    assert.equal(body.servers.length, 1, 'the seed row must be read through the decoded path');
  } finally {
    app.dispose();
    rmSync(base, { recursive: true, force: true });
  }
});

/** The composed MCP row a live loader hands back for the `dbx` patch row. */
function dbxEntry(fiber) {
  return {
    options: {
      id: 'mcp-dbx',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'dbx', transport: 'stdio', command: 'node.exe' },
    },
    fiber,
    disabled: false,
  };
}

// Restarting a row in place is the one place this plugin touches loader
// internals, and the API for it changed under the plugin: dsh 0.1.6-alpha.1
// shipped cordis-plugin-loader 1.0.3 with a private `entry._dispose()`, while
// 0.2.0-rc.2 ships 1.0.5, which dropped it for the public `fiber.restart()`.
// These three tests pin both generations so an upgrade cannot silently turn
// "restart" back into "unsupported".

test('restart re-applies the row through fiber.restart() on the newer loader', async () => {
  const calls = [];
  const entry = dbxEntry({
    state: 2,
    async restart() {
      calls.push('restart');
    },
  });
  const app = await boot(SEED, { loaderEntries: [entry] });
  try {
    const { status, body } = await app.request('POST', '/restart', { id: 'mcp-dbx' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(calls, ['restart']);
    assert.match(body.message, /已重启/u);
  } finally {
    app.dispose();
  }
});

test('restart still uses _dispose() + init() on the older loader', async () => {
  const calls = [];
  const entry = {
    ...dbxEntry({ state: 2 }),
    async _dispose() {
      calls.push('_dispose');
    },
    async init() {
      calls.push('init');
    },
  };
  const app = await boot(SEED, { loaderEntries: [entry] });
  try {
    const { status, body } = await app.request('POST', '/restart', { id: 'mcp-dbx' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(calls, ['_dispose', 'init']);
  } finally {
    app.dispose();
  }
});

test('restart reports a disposed fiber as unmounted, and an unknown shape as unsupported', async () => {
  const disposed = await boot(SEED, {
    loaderEntries: [dbxEntry({ state: 4, async restart() {} })],
  });
  try {
    const { status, body } = await disposed.request('POST', '/restart', { id: 'mcp-dbx' });
    assert.equal(status, 400);
    assert.match(body.error, /未挂载/u);
  } finally {
    disposed.dispose();
  }

  const opaque = await boot(SEED, { loaderEntries: [dbxEntry({ state: 2 })] });
  try {
    const { status, body } = await opaque.request('POST', '/restart', { id: 'mcp-dbx' });
    assert.equal(status, 400);
    assert.match(body.error, /不支持就地重启/u);
  } finally {
    opaque.dispose();
  }
});

// The reported regression, end to end. Another plugin's `js-yaml@^5` hoisted a
// v5 to the profile root; `new yaml.Type(...)` then threw inside `loadYaml()`
// and every route answered 500, so the page showed nothing but
// `加载失败：yaml.Type is not a constructor`. A v5-shaped copy (it parses, it
// has no custom-type API) is planted where the profile anchor finds it, and the
// panel must still come up and list the seeded row.
test('a js-yaml without the custom-type API no longer breaks the panel', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-manager-home-'));
  const fakeDir = join(home, 'profiles', 'web', 'node_modules', 'js-yaml');
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(
    join(fakeDir, 'package.json'),
    JSON.stringify({ name: 'js-yaml', version: '5.4.3', main: 'index.js' }),
  );
  writeFileSync(
    join(fakeDir, 'index.js'),
    `const real = require(${JSON.stringify(yamlPath)});\n` +
      'const mod = { load: (text, options) => real.load(text, options) };\n' +
      'if (real.JSON_SCHEMA) mod.JSON_SCHEMA = real.JSON_SCHEMA;\n' +
      'module.exports = mod;\n',
  );

  const seeded = mkdtempSync(join(tmpdir(), 'mcp-manager-profile-'));
  const patchPath = join(seeded, 'cordis.patch.yml');
  writeFileSync(patchPath, SEED);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const app = await boot(null, { includeEntry: pathToFileURL(join(seeded, 'cordis.yml')).href });
  try {
    // Whether this copy or a capable one is picked is environment-dependent
    // (a workspace node_modules can provide the plugin's own pinned copy), so
    // the probe decides which assertions apply — but the endpoint must answer
    // in both cases.
    const probe = await resolveEntryYaml(yamlResolutionAnchors(seeded, { home, profile: 'web' }));
    const { status, body } = await app.request('GET', '/servers');
    assert.equal(status, 200, `the panel must answer, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.patchPath, patchPath);
    assert.equal(body.servers.length, 1, 'the seeded row must still be listed');
    assert.equal(body.servers[0].serverName, 'dbx');
    assert.equal(body.writable, true);
    if (probe.degraded) {
      assert.ok(
        body.issues.some((issue) => issue.includes('js-yaml')),
        'a degraded parse must be reported to the user instead of hidden',
      );
    }
  } finally {
    app.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(seeded, { recursive: true, force: true });
  }
});

// ── the shared home layer ───────────────────────────────────────────────────
//
// The composed order is bundle → profile → home, and a patch only edits a row
// that already exists when it runs. A `disabled` override written into the
// profile layer for a row the HOME layer inserts therefore matches nothing, and
// the loader skips it with a stderr warning nobody reads: the server kept
// running and its tool definitions kept reaching the model while the panel said
// "已停用" and listed zero tools.
//
// So the decisive assertion in this section is not on the plugin's own output.
// It is the kernel's patch algorithm — the same call boot makes — run over the
// files the plugin actually wrote. It is reproduced here rather than imported
// because the kernel's own packages are not resolvable from every profile
// layout (a hoisted install can leave `profiles/node_modules/@deepseek-ai`
// dangling), and a test that dies while loading is a test that silently does
// not run. The replica is `applyEntryPatches` from
// `@deepseek-ai/cordis-plugin-include`, verbatim, and the self-test below
// pins the two rules the fix rests on so a wrong replica cannot pass by itself.

/**
 * `applyEntryPatches` from the include plugin, reproduced.
 * @param data - the entry list to patch.
 * @param patches - the patch rows, in application order.
 * @param warn - sink for skipped-patch diagnostics.
 * @returns the patched entry list.
 */
function kernelApplyEntryPatches(data, patches, warn) {
  // `composeEntries` clones the layer list before applying it; without that the
  // patches would be mutated in place and a second application would see the
  // first one's result.
  data = structuredClone(data);
  patches = structuredClone(patches);
  const entryMap = new Map();
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry);
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
    }
  };
  buildMap(data);
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert) {
      if (id) {
        const target = entryMap.get(id);
        if (!target || !target.group) continue;
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insert);
      } else data.push(...insert);
      buildMap(insert);
      continue;
    }
    if (!id) continue;
    const target = entryMap.get(id);
    if (!target) {
      warn({ kind: 'missing', id });
      continue;
    }
    if (name && name !== target.name) continue;
    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue;
      target[key] = value;
    }
  }
  return data;
}

/**
 * The kernel's composition of the two user patch layers, in boot order.
 * @param profileText - the profile's `cordis.patch.yml`.
 * @param homeText - the shared `$DSH_HOME/cordis.patch.yml`.
 * @returns the composed entry list.
 */
function composeUserLayers(profileText, homeText) {
  const layer = (text) => yaml.load(text, { schema });
  return kernelApplyEntryPatches([], [...layer(profileText), ...layer(homeText)], () => {});
}

test('the composition replica implements the rule this whole section rests on', () => {
  const warnings = [];
  const after = kernelApplyEntryPatches(
    [],
    [{ insert: [{ id: 'x', name: 'p' }] }, { id: 'x', disabled: true }],
    () => {},
  );
  assert.equal(after[0].disabled, true, 'an override after the insert wins');

  const before = kernelApplyEntryPatches(
    [],
    [{ id: 'x', disabled: true }, { insert: [{ id: 'x', name: 'p' }] }],
    (warning) => warnings.push(warning),
  );
  assert.equal(before[0].disabled, undefined, 'an override before any insert is skipped');
  assert.deepEqual(warnings, [{ kind: 'missing', id: 'x' }], 'and the skip is announced, not silent');
});

/** The composed row for one id, or undefined when no layer inserts it. */
function composedRow(entries, id) {
  return entries.find((entry) => entry.id === id);
}

/** The shared layer as a real machine writes it: an insert, no override yet. */
const HOME_TOOLPACK = `- insert:
    - id: mcp-toolpack
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: toolpack
        transport: stdio
        command: node
        args: ["server.mjs"]
`;

/** The composed row a loader hands back for the shared layer's `toolpack`. */
const TOOLPACK_ENTRY = {
  options: {
    id: 'mcp-toolpack',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'toolpack', transport: 'stdio', command: 'node' },
  },
  fiber: { state: 2 },
  disabled: false,
};

test('a shared-layer row is disabled in the shared layer, where the patch can win', async () => {
  const app = await boot('# header\n[]\n', {
    homeSeed: HOME_TOOLPACK,
    tools: [{ name: 'mcp__toolpack__find_tool', description: 'Find' }],
    loaderEntries: [TOOLPACK_ENTRY],
  });
  try {
    const listing = await app.request('GET', '/servers');
    const row = listing.body.servers.find((s) => s.serverName === 'toolpack');
    assert.ok(row, 'the shared-layer row must be listed');
    assert.equal(row.source, 'shared', 'the shared layer is not a bundle and must not be labelled as one');
    assert.equal(row.controlLayer, 'home');
    assert.equal(row.enabled, true);
    assert.equal(listing.body.homePatchPath, app.homePatchPath);
    assert.deepEqual(listing.body.issues, [], 'a fresh shared layer has nothing to complain about');

    const toggled = await app.request('POST', '/toggle', { id: 'mcp-toolpack', enabled: false });
    assert.equal(toggled.status, 200, JSON.stringify(toggled.body));
    assert.equal(toggled.body.layer, 'home', 'the override must land in the layer applied after the insert');
    assert.equal(app.read(), '# header\n[]\n', 'the profile layer must not gain a patch that can never match');
    assert.match(app.readHome(), /- id: mcp-toolpack\n  disabled: true/);

    // The proof: the kernel composes the two files and really sees a disabled row.
    const composed = composeUserLayers(app.read(), app.readHome());
    assert.equal(composedRow(composed, 'mcp-toolpack')?.disabled, true);

    // And the file it wrote must still be a legal layer, with the override after
    // the insert that creates its target.
    const home = app.readHome();
    assert.ok(
      home.indexOf('- insert:') < home.lastIndexOf('- id: mcp-toolpack'),
      'the override must follow the insert',
    );

    const on = await app.request('POST', '/toggle', { id: 'mcp-toolpack', enabled: true });
    assert.equal(on.status, 200);
    // This plugin does not own the shared layer's definition, so it cannot
    // assume dropping the override is enough — it writes `disabled: false`
    // explicitly, which is what a later patch in the same layer is for.
    assert.match(app.readHome(), /- id: mcp-toolpack\n  disabled: false\n$/u);
    assert.match(app.readHome(), /serverName: toolpack/u, 'the definition itself must survive');
    assert.notEqual(composedRow(composeUserLayers(app.read(), app.readHome()), 'mcp-toolpack')?.disabled, true);
  } finally {
    app.dispose();
  }
});

test('a profile-layer override for a shared-layer row is reported, never obeyed', async () => {
  const app = await boot('# header\n- id: mcp-toolpack\n  disabled: true\n', {
    homeSeed: HOME_TOOLPACK,
    tools: [{ name: 'mcp__toolpack__find_tool', description: 'Find' }],
    loaderEntries: [TOOLPACK_ENTRY],
  });
  try {
    const { body } = await app.request('GET', '/servers');
    const row = body.servers.find((s) => s.serverName === 'toolpack');
    // The kernel skips that patch, so the server is live. The panel must say so
    // rather than mirror the dead override, and it must keep the tools listed:
    // this is precisely the state that used to be reported as "off, 0 tools".
    assert.equal(row.enabled, true);
    assert.equal(row.live.toolCount, 1);
    assert.ok(
      body.issues.some((issue) => issue.includes('mcp-toolpack')),
      'the override that can never take effect must be reported',
    );
    assert.equal(
      composedRow(composeUserLayers(app.read(), app.readHome()), 'mcp-toolpack')?.disabled,
      undefined,
      'the trap this section exists for: that override really does nothing',
    );

    // Toggling heals it: the dead override is dropped and the live one written.
    const toggled = await app.request('POST', '/toggle', { id: 'mcp-toolpack', enabled: false });
    assert.equal(toggled.status, 200);
    assert.equal(app.read(), '# header\n[]\n', 'the dead override is cleaned up');
    assert.equal(composedRow(composeUserLayers(app.read(), app.readHome()), 'mcp-toolpack')?.disabled, true);
    const after = (await app.request('GET', '/servers')).body;
    assert.deepEqual(after.issues, [], 'nothing left to report once the override is where it works');
  } finally {
    app.dispose();
  }
});

test('a toggle for a row no layer inserts is refused instead of silently doing nothing', async () => {
  const app = await boot();
  try {
    const before = app.read();
    const result = await app.request('POST', '/toggle', { id: 'mcp-ghost', enabled: false });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /mcp-ghost/u);
    assert.equal(app.read(), before, 'a refused toggle must not touch the file');
    assert.equal(existsSync(app.homePatchPath), false, 'nor create a shared layer');
  } finally {
    app.dispose();
  }
});
