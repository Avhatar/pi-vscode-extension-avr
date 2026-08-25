#!/usr/bin/env node
// Usage: npm run mark-released -- <version> [YYYY-MM-DD]
//
// Records that <version> was handed to users, which is the one fact about this
// repository that cannot be derived from it. Run this only when the maintainer
// says so -- bumping, packaging, `npm run deploy` and installing locally all
// happen constantly for versions nobody else ever sees.
//
// After this, the next bump stops extending the top RELEASES.md entry and opens
// a fresh one above it, so the file keeps reading as the list of versions users
// actually received.

const fs = require('fs');
const core = require('./release-notes-core');
const { RELEASES_PATH, readState, writeState } = require('./release-state');

const args = process.argv.slice(2);
const version = args.find(arg => /^\d+\.\d+\.\d+$/.test(arg));
const date = args.find(arg => /^\d{4}-\d{2}-\d{2}$/.test(arg)) || new Date().toISOString().slice(0, 10);

if (!version) {
    console.error('Usage: npm run mark-released -- <version> [YYYY-MM-DD]');
    process.exit(1);
}

const state = readState();

if (state.lastPublishedVersion === version) {
    console.log(`${version} is already recorded as the last version handed to users.`);
    process.exit(0);
}

const text = fs.readFileSync(RELEASES_PATH, 'utf8');
const { errors } = core.verifyReadyToPublish({ text, version });

if (errors.length > 0) {
    for (const error of errors) {
        console.error(`ERROR: ${error}`);
    }
    console.error('\nThe entry a user reads is the one being frozen here; write it before recording the handout.');
    process.exit(1);
}

const previous = state.lastPublishedVersion;
writeState({ ...state, lastPublishedVersion: version, publishedAt: date });

console.log(`release-state.json: last handed to users ${previous || '(none)'} → ${version} (${date})`);
console.log(`RELEASES.md entry ${version} is now frozen; the next bump opens a new entry above it.`);
