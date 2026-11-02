/**
 * Composition check: compose the web profile's real bundle layers plus its
 * user patch layer, and assert this plugin's row resolves to a loadable
 * package with a client bundle the module system can serve.
 *
 * This is the same `applyEntryPatches` call the boot include makes, so it
 * answers "will the next boot find my row" without booting anything.
 *
 * Run with:  node test/compose.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const profileDir = join(dshHome, 'profiles', 'web');
const profileRequire = createRequire(join(profileDir, 'package.json'));

/**
 * Resolve a kernel package the way a boot does.
 *
 * A hoisted install puts `@deepseek-ai/*` in the profile, but a pnpm-managed
 * one leaves them in the shared `profiles/node_modules` layer — and when that
 * layer is a set of links into a store the last upgrade replaced, they are
 * simply gone. A module-level `await import()` that throws there takes the
 * whole file down before a single test is registered, so the run reports
 * nothing instead of reporting a gap. Hence: try the anchors, and if none
 * works, skip loudly with the reason.
 * @param name - package name to resolve.
 * @returns the resolved path, or undefined.
 */
function resolveKernel(name) {
  const anchors = [
    join(profileDir, 'package.json'),
    join(dshHome, 'profiles', 'package.json'),
  ];
  for (const anchor of anchors) {
    try {
      return createRequire(anchor).resolve(name);
    } catch {
      // Try the next anchor.
    }
  }
  if (process.env.DSH_APP_ROOT) {
    try {
      return createRequire(join(process.env.DSH_APP_ROOT, 'package.json')).resolve(name);
    } catch {
      // Fall through to the reported reason below.
    }
  }
  return undefined;
}

const appBootPath = resolveKernel('@deepseek-ai/dsh-app-boot');
const includePath = resolveKernel('@deepseek-ai/cordis-plugin-include');
/** Why this suite cannot run here, or null when it can. */
const unavailable =
  appBootPath === undefined || includePath === undefined
    ? 'the kernel packages (@deepseek-ai/dsh-app-boot, @deepseek-ai/cordis-plugin-include) are not resolvable from this profile; set DSH_APP_ROOT to the dsh installation to run this suite'
    : null;

if (unavailable !== null) process.stderr.write(`compose.test.mjs: skipped — ${unavailable}\n`);
const skip = unavailable === null ? false : unavailable;

const appBootMod = unavailable === null ? await import(pathToFileURL(appBootPath).href) : {};
// `dsh-app-boot` ships CJS with a `default` object alongside named exports;
// prefer named, fall back to the default's own properties.
const appBoot = { ...(appBootMod.default ?? {}), ...appBootMod };
const includeMod = unavailable === null ? await import(pathToFileURL(includePath).href) : {};
const applyEntryPatches = includeMod.applyEntryPatches ?? includeMod.default?.applyEntryPatches;

const ROW_ID = 'mcp-manager-plus';
const PACKAGE = 'dsh-mcp-manager-plus';

/**
 * Compose every bundle layer for the profile, then the profile's own patch.
 *
 * The install anchor is where the kernel's own bundled packages live. A desktop
 * install keeps them next to the app, not next to `$DSH_HOME`, so the anchor is
 * configurable; without it the run reports the missing anchor rather than
 * pretending the profile resolved.
 */
function composeProfile() {
  assert.equal(typeof applyEntryPatches, 'function', 'the include plugin must export applyEntryPatches');
  // `resolveBundleDir` wants the path of a *file* inside the dsh app package —
  // its package.json — because in-box bundles must always come from the same
  // installation as the running dsh.
  const installAnchor =
    process.env.DSH_APP_ROOT === undefined
      ? join(dshHome, '..')
      : join(process.env.DSH_APP_ROOT, 'package.json');
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  const layers = [];
  for (const bundle of manifest.dsh.profile.bundles) {
    const dir = appBoot.resolveBundleDir('dsh', bundle, installAnchor, profileDir);
    const patch = appBoot.readProfileManifest('dsh', dir).dsh?.bundle?.patch;
    if (typeof patch !== 'string' || patch === '') continue;
    layers.push(appBoot.loadOverlayPatches('dsh', join(dir, patch)));
  }
  const userPatch = join(profileDir, 'cordis.patch.yml');
  if (existsSync(userPatch)) layers.push(appBoot.loadOverlayPatches('dsh', userPatch));
  return applyEntryPatches([], layers.flat(), () => {});
}

test('every profile bundle layer resolves, so a missing one is caught here', { skip }, () => {
  const entries = composeProfile();
  assert.ok(entries.length > 0, 'the composed tree must not be empty');
});

test('the manager row is inserted with the package name the loader will import', { skip }, () => {
  const entries = composeProfile();
  const row = entries.find((entry) => entry.id === ROW_ID);
  assert.ok(row, `row ${ROW_ID} must exist in the composed tree`);
  assert.equal(row.name, PACKAGE);
  assert.notEqual(row.disabled, true, 'the row must start enabled');
});

test('no two bundles insert the same row id (a duplicate id is a hard boot failure)', { skip }, () => {
  const entries = composeProfile();
  const ids = entries.map((entry) => entry.id).filter((id) => typeof id === 'string');
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], `duplicate loader entry ids: ${duplicates.join(', ')}`);
});

test('the package entry artifact the loader will import exists', { skip }, () => {
  const dir = join(profileDir, 'node_modules', PACKAGE);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entry = manifest.exports?.['.']?.default ?? manifest.main;
  assert.ok(entry, 'the package must declare an entry');
  assert.ok(existsSync(join(dir, entry)), `entry artifact ${entry} must exist`);
});

test('the client bundle the module system will serve exists and is non-empty', { skip }, () => {
  const dir = join(profileDir, 'node_modules', PACKAGE);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh?.client?.platform, 'web', 'the package must declare a web client');
  const clientRel = manifest.exports?.['./client'];
  assert.equal(typeof clientRel, 'string', 'the package must export ./client');
  const clientPath = join(dir, clientRel);
  assert.ok(existsSync(clientPath), `client artifact ${clientRel} must exist`);
  assert.ok(statSync(clientPath).size > 0, 'the client bundle must not be empty');
  // The bundle protocol: the shell needs a factory registered under this id.
  const source = readFileSync(clientPath, 'utf8');
  assert.match(source, /__ModuleLoader__\.load\(/);
  assert.match(source, new RegExp(`id:\\s*'${PACKAGE}'`));
});

test('the host half imports cleanly from the profile', { skip }, async () => {
  const dir = join(profileDir, 'node_modules', PACKAGE);
  const mod = await import(pathToFileURL(join(dir, 'lib', 'index.js')).href);
  assert.equal(mod.name, PACKAGE);
  assert.deepEqual(mod.inject, ['webServer']);
  assert.equal(typeof mod.apply, 'function');
});
