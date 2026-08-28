#!/usr/bin/env node

/**
 * Builds one wrangler-style JavaScript Durable Object project into a
 * content-addressed verglas:do-worker component.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { build as bundle } from 'esbuild';

import { readWranglerManifest } from '../src/manifest.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const witDir = resolve(packageDir, 'wit');
const shimPath = resolve(packageDir, 'src/shim.js');
const cloudflareWorkersPath = resolve(packageDir, 'src/cloudflare-workers.js');
const require = createRequire(import.meta.url);
const jcoPath = resolve(dirname(require.resolve('@bytecodealliance/jco')), 'jco.js');

/**
 * Runs one child process and preserves its stderr in the thrown error.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 * @returns {Promise<void>}
 */
function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exited with ${signal ?? `code ${code}`}`;
      reject(new Error(`${command} ${args.join(' ')} failed: ${detail}`));
    });
  });
}

/**
 * Parses the build CLI arguments.
 * @param {string[]} args
 * @returns {{projectDir: string, outputDir: string, gatewayPath: string, varsPath?: string}}
 */
function parseArguments(args) {
  if (args.length < 3) {
    throw new Error('usage: verglas-worker-build <project-dir> --out <dir> [--gateway <path>] [--vars-file <path>]');
  }
  const projectDir = resolve(args[0]);
  if (args[1] !== '--out' || !args[2]) {
    throw new Error('usage: verglas-worker-build <project-dir> --out <dir> [--gateway <path>] [--vars-file <path>]');
  }
  let gatewayPath = join(projectDir, 'gateway.json');
  let varsPath;
  for (let index = 3; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!value || (option !== '--gateway' && option !== '--vars-file')) {
      throw new Error('usage: verglas-worker-build <project-dir> --out <dir> [--gateway <path>] [--vars-file <path>]');
    }
    if (option === '--gateway') gatewayPath = value;
    else varsPath = value;
  }
  return {
    projectDir,
    outputDir: resolve(args[2]),
    gatewayPath: resolve(gatewayPath),
    ...(varsPath === undefined ? {} : { varsPath: resolve(varsPath) }),
  };
}

async function readVarsOverride(path) {
  if (path === undefined) return { vars: {}, redactedVars: {} };
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('vars override must be an object');
  const vars = value.vars;
  const redactedVars = value.redactedVars;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new Error('vars override vars must be an object');
  if (!redactedVars || typeof redactedVars !== 'object' || Array.isArray(redactedVars)) throw new Error('vars override redactedVars must be an object');
  for (const key of Object.keys(redactedVars)) {
    if (!Object.hasOwn(vars, key)) throw new Error(`redacted var ${key} has no compile-time value`);
  }
  return { vars, redactedVars };
}

/**
 * Updates selected nested artifact descriptors in a checked-in gateway manifest.
 * @param {string} gatewayPath
 * @param {string} outputDir
 * @param {string} componentDigest
 * @param {boolean} hasDurableObject
 * @returns {Promise<void>}
 */
async function updateGatewayManifest(gatewayPath, outputDir, componentDigest, hasDurableObject) {
  let source;
  try {
    source = await readFile(gatewayPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const manifest = JSON.parse(source);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`gateway manifest ${gatewayPath} must contain a JSON object`);
  }
  for (const field of ['component_digest', 'component_dir']) {
    if (Object.hasOwn(manifest, field)) {
      throw new Error(`gateway manifest ${gatewayPath} uses retired top-level ${field}; use nested artifacts`);
    }
  }
  const artifacts = manifest.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error(`gateway manifest ${gatewayPath} must contain nested artifacts`);
  }
  const products = ['worker', ...(hasDurableObject ? ['durable_object'] : [])];
  for (const product of products) {
    const descriptor = artifacts[product];
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      throw new Error(`gateway manifest ${gatewayPath} is missing artifacts.${product}`);
    }
    if (
      typeof descriptor.digest !== 'string' ||
      !descriptor.digest ||
      typeof descriptor.component_dir !== 'string' ||
      !descriptor.component_dir
    ) {
      throw new Error(`gateway manifest ${gatewayPath} artifacts.${product} must contain digest and component_dir`);
    }
    descriptor.digest = componentDigest;
    descriptor.component_dir = resolve(outputDir);
  }
  await writeFile(gatewayPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Escapes one path for use in a generated ESM import statement.
 * @param {string} path
 * @returns {string}
 */
function importPath(path) {
  return JSON.stringify(path);
}

/**
 * Bundles and componentizes one wrangler-style project.
 * @param {string} projectDir
 * @param {string} outputDir
 * @param {string} [gatewayPath]
 * @param {string} [varsPath]
 * @returns {Promise<{name: string, componentDigest: string, componentPath: string, manifestPath: string, componentBytes: Uint8Array, bindings: Array<{name: string, class_name: string}>}>}
 */
export async function buildProject(projectDir, outputDir, gatewayPath = join(projectDir, 'gateway.json'), varsPath) {
  const sourceManifest = await readWranglerManifest(projectDir);
  const override = await readVarsOverride(varsPath);
  const manifest = { ...sourceManifest, vars: { ...sourceManifest.vars, ...override.vars } };
  const emittedVars = { ...manifest.vars, ...override.redactedVars };
  const mainPath = resolve(projectDir, manifest.main);
  const workDir = await mkdtemp(join(tmpdir(), 'verglas-worker-js-'));
  const bundlePath = join(workDir, 'worker.bundle.js');
  const componentPath = join(workDir, 'worker.component.wasm');

  try {
    const entryPath = join(workDir, 'entry.js');
    const entrySource = [
      `import * as project from ${importPath(mainPath)};`,
      `import { createHandler, createWorker } from ${importPath(shimPath)};`,
      `const manifest = ${JSON.stringify(manifest)};`,
      'export const worker = createWorker(project, manifest);',
      'export const handler = createHandler(project, manifest);',
      '',
    ].join('\n');
    await writeFile(entryPath, entrySource, 'utf8');

    const bundled = await bundle({
      entryPoints: [entryPath],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      write: false,
      legalComments: 'none',
      minify: true,
      alias: { 'cloudflare:workers': cloudflareWorkersPath },
      external: ['verglas:do-worker/*@0.1.0'],
    });
    if (bundled.outputFiles.length !== 1) {
      throw new Error(`esbuild produced ${bundled.outputFiles.length} files; exactly one bundle is required`);
    }
    await writeFile(bundlePath, bundled.outputFiles[0].contents);

    await run(
      jcoPath,
      [
        'componentize',
        bundlePath,
        '--wit',
        witDir,
        '--world-name',
        'service',
        '--disable=all',
        '--out',
        componentPath,
      ],
      { cwd: packageDir },
    );

    const componentBytes = new Uint8Array(await readFile(componentPath));
    // ComponentizeJS snapshots StarlingMonkey and may emit different bytes for
    // identical input. The deployment digest always names the bytes emitted by
    // this invocation; it is never replaced with a source or manifest hash.
    const componentDigest = createHash('sha256').update(componentBytes).digest('hex');
    await mkdir(outputDir, { recursive: true });
    const outputComponentPath = join(outputDir, `${componentDigest}.wasm`);
    await writeFile(outputComponentPath, componentBytes);

    const artifacts = {
      worker: { digest: componentDigest, component_dir: resolve(outputDir) },
      ...(manifest.bindings.length === 0
        ? {}
        : { durable_object: { digest: componentDigest, component_dir: resolve(outputDir) } }),
    };
    const outputManifest = {
      name: manifest.name,
      main: manifest.main,
      ...(manifest.compatibility_date === undefined ? {} : { compatibility_date: manifest.compatibility_date }),
      compatibility_flags: manifest.compatibility_flags,
      durable_objects: { bindings: manifest.bindings },
      migrations: manifest.migrations,
      vars: emittedVars,
      ...(manifest.pipelines === undefined ? {} : { pipelines: manifest.pipelines }),
      ...(manifest.services === undefined ? {} : { services: manifest.services }),
      ...(manifest.vectorize === undefined ? {} : { vectorize: manifest.vectorize }),
      ...(manifest.graphs === undefined ? {} : { graphs: manifest.graphs }),
      ...(manifest.queries === undefined ? {} : { queries: manifest.queries }),
      ...(manifest.triggers === undefined ? {} : { triggers: manifest.triggers }),
      artifacts,
      data_root: 'state',
    };
    const manifestPath = join(outputDir, 'manifest.out.json');
    await writeFile(manifestPath, `${JSON.stringify(outputManifest, null, 2)}\n`, 'utf8');
    await updateGatewayManifest(gatewayPath, outputDir, componentDigest, manifest.bindings.length > 0);

    return {
      name: manifest.name,
      componentDigest,
      componentPath: outputComponentPath,
      manifestPath,
      componentBytes,
      bindings: manifest.bindings,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Runs the command-line entry point.
 */
async function main() {
  const { projectDir, outputDir, gatewayPath, varsPath } = parseArguments(process.argv.slice(2));
  const result = await buildProject(projectDir, outputDir, gatewayPath, varsPath);
  process.stdout.write(`${result.componentDigest}\n`);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
