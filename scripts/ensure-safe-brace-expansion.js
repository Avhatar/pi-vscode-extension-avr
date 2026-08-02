'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const semver = require('semver');

const MINIMUM_SAFE_VERSION = '5.0.8';
const shouldRepair = process.argv.includes('--repair');
const projectRoot = path.resolve(__dirname, '..');
const piPackageJson = path.join(
  projectRoot,
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'package.json',
);

function isSafe(version) {
  return semver.valid(version) !== null
    && semver.prerelease(version) === null
    && semver.gte(version, MINIMUM_SAFE_VERSION);
}

function resolveBraceExpansion() {
  const piRequire = createRequire(piPackageJson);
  const minimatchPackageJson = piRequire.resolve('minimatch/package.json');
  const minimatchRequire = createRequire(minimatchPackageJson);
  const bracePackageJson = minimatchRequire.resolve('brace-expansion/package.json');
  const manifest = JSON.parse(fs.readFileSync(bracePackageJson, 'utf8'));
  return { bracePackageJson, version: manifest.version };
}

function main() {
  if (!fs.existsSync(piPackageJson)) {
    throw new Error('Pi coding agent is not installed; run npm install before verification.');
  }

  let resolved = resolveBraceExpansion();
  if (!isSafe(resolved.version) && shouldRepair) {
    const rootPackageJson = path.join(projectRoot, 'node_modules', 'brace-expansion', 'package.json');
    const rootManifest = require(rootPackageJson);
    if (!isSafe(rootManifest.version)) {
      throw new Error(`Root brace-expansion ${rootManifest.version} is not a safe fallback.`);
    }

    fs.rmSync(path.dirname(resolved.bracePackageJson), { recursive: true, force: true });
    resolved = { bracePackageJson: rootPackageJson, version: rootManifest.version };
  }

  if (!isSafe(resolved.version)) {
    throw new Error(
      `Pi coding agent resolves brace-expansion ${resolved.version} at ${resolved.bracePackageJson}. `
      + 'Run npm run repair:runtime-dependencies before packaging.',
    );
  }

  console.log(`Runtime dependency verified: brace-expansion ${resolved.version} (${resolved.bracePackageJson})`);
}

if (require.main === module) main();

module.exports = { isSafe };
