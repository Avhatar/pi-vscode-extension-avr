#!/usr/bin/env node
// Usage: node scripts/bump-version.js <patch|minor|major> [--hierarchical-npm-install]
//
// 1. Reads [Unreleased] section from CHANGELOG.md
// 2. Validates it has content (fails if empty)
// 3. Bumps version in package.json
// 4. Stamps [Unreleased] → [x.y.z] - YYYY-MM-DD in CHANGELOG.md
// 5. Adds a fresh empty [Unreleased] section
// 6. Optionally runs npm install to sync package-lock.json

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');

// ── Parse args ──

const args = process.argv.slice(2);
const bumpType = args.find(a => !a.startsWith('-'));
const syncLock = args.includes('--sync-lock');

if (!['patch', 'minor', 'major'].includes(bumpType)) {
    console.error('Usage: node scripts/bump-version.js <patch|minor|major> [--sync-lock]');
    process.exit(1);
}

// ── Read current version ──

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

let newVersion;
switch (bumpType) {
    case 'major': newVersion = `${major + 1}.0.0`; break;
    case 'minor': newVersion = `${major}.${minor + 1}.0`; break;
    case 'patch': newVersion = `${major}.${minor}.${patch + 1}`; break;
}

// ── Validate CHANGELOG has unreleased content ──

let changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');

const unreleasedRe = /^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## \[|\Z)/m;
const match = changelog.match(unreleasedRe);

if (!match) {
    console.error('ERROR: No [Unreleased] section found in CHANGELOG.md');
    console.error('Add your changes under "## [Unreleased]" before bumping.');
    process.exit(1);
}

const unreleasedBody = match[1].trim();
if (!unreleasedBody) {
    console.error('ERROR: [Unreleased] section in CHANGELOG.md is empty.');
    console.error('Document your changes before bumping the version.');
    process.exit(1);
}

// ── Bump package.json ──

pkg.version = newVersion;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
console.log(`package.json: ${major}.${minor}.${patch} → ${newVersion}`);

// ── Stamp CHANGELOG ──

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const freshUnreleased = '## [Unreleased]\n';
const stampedHeading = `## [${newVersion}] - ${today}`;

changelog = changelog.replace(
    '## [Unreleased]',
    `${freshUnreleased}\n${stampedHeading}`
);

fs.writeFileSync(CHANGELOG_PATH, changelog);
console.log(`CHANGELOG.md: [Unreleased] → [${newVersion}] - ${today}`);

// ── Sync package-lock.json ──

if (syncLock) {
    console.log('Syncing package-lock.json...');
    execSync('npm install --package-lock-only', { cwd: ROOT, stdio: 'inherit' });
}

console.log(`\nVersion bumped to ${newVersion}. Ready to deploy.`);
