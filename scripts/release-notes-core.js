// Pure helpers behind the RELEASES.md pipeline.
//
// RELEASES.md is a chain of entries, newest first. The top entry carries the
// version of the most recent *build* and accumulates every user-facing change
// made since the last version actually handed to users. Which version that is
// cannot be derived from the repository -- bumping, packaging and installing
// all happen constantly for builds nobody else ever sees -- so it is recorded
// separately in release-state.json and moved only when the maintainer says so.
//
// Consequence: each entry's "Everything new since X" line names the entry
// directly below it, and the file reads as the list of versions users actually
// received, with everything that arrived between them in between.
//
// No filesystem access here on purpose: every function maps strings to strings,
// so the rules are unit-testable.

const ENTRY_RE = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})\s*$/;
const SINCE_RE = /^\*Everything new since (\d+\.\d+\.\d+)\.\*\s*$/;
const PLACEHOLDER_PREFIX = '<!-- TODO: consolidate the CHANGELOG.md sections since';

// ── Formatting ──

function formatHeading(version, date) {
    return `## ${version} — ${date}`;
}

function formatSince(version) {
    return `*Everything new since ${version}.*`;
}

function formatPlaceholder(sinceVersion) {
    const since = sinceVersion || 'the previous published version';
    return `${PLACEHOLDER_PREFIX} ${since} into user-facing bullets here, grouped as ### Added / ### Changed / ### Fixed. -->`;
}

// ── Parsing ──

// Git may hand this file over with CRLF on Windows, so the dominant line
// ending is detected and reused when writing: joining with a bare \n would
// leave the rewritten lines mixed with the untouched ones.
function detectEol(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

function parseEntries(text) {
    const eol = detectEol(text);
    const lines = text.split(/\r?\n/);
    const entries = [];

    lines.forEach((line, index) => {
        const match = line.match(ENTRY_RE);
        if (match) {
            entries.push({ version: match[1], date: match[2], headingIndex: index });
        }
    });

    entries.forEach((entry, i) => {
        const bodyStart = entry.headingIndex + 1;
        const bodyEnd = i + 1 < entries.length ? entries[i + 1].headingIndex : lines.length;
        const bodyLines = lines.slice(bodyStart, bodyEnd);

        entry.bodyStart = bodyStart;
        entry.bodyEnd = bodyEnd;
        entry.since = null;
        entry.sinceIndex = -1;

        for (let j = bodyStart; j < bodyEnd; j++) {
            const match = lines[j].match(SINCE_RE);
            if (match) {
                entry.since = match[1];
                entry.sinceIndex = j;
                break;
            }
        }

        entry.hasBullets = bodyLines.some(line => /^\s*-\s+\S/.test(line));
        entry.hasPlaceholder = bodyLines.some(line => line.includes(PLACEHOLDER_PREFIX));
    });

    return { lines, entries, eol };
}

// ── Mutation ──

function retitleTopEntry(text, { version, date, sinceVersion }) {
    const { lines, entries, eol } = parseEntries(text);
    if (entries.length === 0) {
        throw new Error('RELEASES.md has no version entries to retitle');
    }

    const top = entries[0];
    const out = lines.slice();
    out[top.headingIndex] = formatHeading(version, date);

    if (sinceVersion) {
        if (top.sinceIndex >= 0) {
            out[top.sinceIndex] = formatSince(sinceVersion);
        } else {
            out.splice(top.headingIndex + 1, 0, '', formatSince(sinceVersion));
        }
    }

    return out.join(eol);
}

function insertTopEntry(text, { version, date, sinceVersion }) {
    const { lines, entries, eol } = parseEntries(text);

    const block = [formatHeading(version, date), ''];
    if (sinceVersion) {
        block.push(formatSince(sinceVersion), '');
    }
    block.push(formatPlaceholder(sinceVersion), '');
    if (entries.length > 0) {
        block.push('---', '');
    }

    const insertAt = entries.length > 0 ? entries[0].headingIndex : lines.length;
    const out = lines.slice();
    out.splice(insertAt, 0, ...block);
    return out.join(eol);
}

// Decides, for a version bump, whether the top entry keeps accumulating or a
// fresh one starts. A top entry equal to the last published version is frozen:
// users already received it, so the new build opens the next entry above it.
function updateForBump(text, { newVersion, date, lastPublishedVersion }) {
    const { entries } = parseEntries(text);
    const top = entries[0];

    if (!top || top.version === lastPublishedVersion) {
        return {
            text: insertTopEntry(text, { version: newVersion, date, sinceVersion: lastPublishedVersion }),
            action: 'inserted',
            retitledFrom: null,
        };
    }

    return {
        text: retitleTopEntry(text, { version: newVersion, date, sinceVersion: lastPublishedVersion }),
        action: 'retitled',
        retitledFrom: top.version,
    };
}

// ── Verification ──

// Structural checks only; nothing here can tell a local build from a release,
// so anything that merely looks unfinished is a warning and only a genuine
// inconsistency is an error.
function verifyReleaseNotes({ text, packageVersion, lastPublishedVersion }) {
    const errors = [];
    const warnings = [];
    const { entries } = parseEntries(text);

    if (entries.length === 0) {
        errors.push('RELEASES.md contains no version entries (expected "## <version> — <YYYY-MM-DD>").');
        return { errors, warnings, entries };
    }

    const top = entries[0];

    if (packageVersion && top.version !== packageVersion) {
        errors.push(
            `RELEASES.md top entry is ${top.version} but package.json is ${packageVersion}. ` +
            'The bump retitles the top entry; if the version was changed by hand, fix the heading to match.'
        );
    }

    if (lastPublishedVersion && !entries.some(entry => entry.version === lastPublishedVersion)) {
        errors.push(
            `release-state.json names ${lastPublishedVersion} as the last published version, ` +
            'but RELEASES.md has no entry for it.'
        );
    }

    if (entries.length > 1) {
        if (!top.since) {
            errors.push(`RELEASES.md entry ${top.version} is missing its "Everything new since <version>." line.`);
        } else if (top.since !== entries[1].version) {
            errors.push(
                `RELEASES.md entry ${top.version} consolidates from ${top.since}, ` +
                `but the entry below it is ${entries[1].version}. Each entry must name the one under it.`
            );
        }

        if (lastPublishedVersion && top.version !== lastPublishedVersion && entries[1].version !== lastPublishedVersion) {
            errors.push(
                `RELEASES.md top entry ${top.version} is unpublished, so the entry below it must be the last ` +
                `published version ${lastPublishedVersion}, not ${entries[1].version}.`
            );
        }
    }

    // Older entries are frozen history: report drift without failing a build.
    for (let i = 1; i < entries.length - 1; i++) {
        if (entries[i].since && entries[i].since !== entries[i + 1].version) {
            warnings.push(
                `RELEASES.md entry ${entries[i].version} consolidates from ${entries[i].since}, ` +
                `but the entry below it is ${entries[i + 1].version}.`
            );
        }
    }

    if (top.hasPlaceholder) {
        warnings.push(`RELEASES.md entry ${top.version} still holds the unfilled placeholder comment.`);
    } else if (!top.hasBullets) {
        warnings.push(`RELEASES.md entry ${top.version} has no bullets.`);
    }

    return { errors, warnings, entries };
}

// A version may only be marked as handed to users while its notes are the top
// entry and actually say something; otherwise the record would freeze an empty
// or stale entry as what users received.
function verifyReadyToPublish({ text, version }) {
    const errors = [];
    const { entries } = parseEntries(text);
    const top = entries[0];

    if (!top) {
        errors.push('RELEASES.md contains no version entries.');
        return { errors };
    }

    if (top.version !== version) {
        errors.push(
            `RELEASES.md top entry is ${top.version}, not ${version}. ` +
            'Only the newest entry can be marked as handed to users; an older artefact needs its notes sorted out by hand.'
        );
    }

    if (top.hasPlaceholder) {
        errors.push(`RELEASES.md entry ${top.version} still holds the unfilled placeholder comment.`);
    }

    if (!top.hasBullets) {
        errors.push(`RELEASES.md entry ${top.version} has no bullets — write the notes before recording the handout.`);
    }

    return { errors };
}

module.exports = {
    ENTRY_RE,
    SINCE_RE,
    PLACEHOLDER_PREFIX,
    detectEol,
    formatHeading,
    formatSince,
    formatPlaceholder,
    parseEntries,
    retitleTopEntry,
    insertTopEntry,
    updateForBump,
    verifyReleaseNotes,
    verifyReadyToPublish,
};
