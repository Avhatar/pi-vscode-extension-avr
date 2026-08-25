#!/usr/bin/env node
// Usage: node scripts/verify-release-notes.js
//
// Runs inside `npm run package`, so no VSIX can be built while RELEASES.md and
// release-state.json disagree. The notes ship inside the package as
// extension/changelog.md and cannot be corrected afterwards without repacking,
// which is why this is a build gate rather than a review checklist item.
//
// Errors are structural inconsistencies. Anything that merely looks unfinished
// is a warning, because nothing here can tell a local build from a release.

const fs = require('fs');
const core = require('./release-notes-core');
const { RELEASES_PATH, PKG_PATH, readState } = require('./release-state');

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const state = readState();
const text = fs.readFileSync(RELEASES_PATH, 'utf8');

const { errors, warnings, entries } = core.verifyReleaseNotes({
    text,
    packageVersion: pkg.version,
    lastPublishedVersion: state.lastPublishedVersion,
});

for (const warning of warnings) {
    console.warn(`WARNING: ${warning}`);
}

if (errors.length > 0) {
    for (const error of errors) {
        console.error(`ERROR: ${error}`);
    }
    console.error('\nRELEASES.md carries one entry per version handed to users, newest first, each');
    console.error('consolidating everything since the entry below it. release-state.json records');
    console.error('which of them users actually received. See AGENTS.md "Two changelogs".');
    process.exit(1);
}

const top = entries[0];
const since = top.since || 'the start';
const published = state.lastPublishedVersion || '(none recorded)';
console.log(`Release notes verified: top entry ${top.version} — ${top.date}, consolidating from ${since}; last handed to users: ${published}.`);
