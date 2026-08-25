// Access to release-state.json -- the record of which version was last handed
// to users. Nothing else in the repository knows it: git tags are incomplete,
// the root .vsix files include local-only builds, and CHANGELOG.md stamps every
// bump, so this file is the only source for "what do users actually have".

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'release-state.json');
const RELEASES_PATH = path.join(ROOT, 'RELEASES.md');
const PKG_PATH = path.join(ROOT, 'package.json');

function readState() {
    if (!fs.existsSync(STATE_PATH)) {
        return { lastPublishedVersion: null, publishedAt: null };
    }
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

// Spread over the existing object so the self-documenting fields survive.
function writeState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

module.exports = { ROOT, STATE_PATH, RELEASES_PATH, PKG_PATH, readState, writeState };
