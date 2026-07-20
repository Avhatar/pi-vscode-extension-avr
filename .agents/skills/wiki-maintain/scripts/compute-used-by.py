#!/usr/bin/env python3
"""compute-used-by.py — recompute every article's `**Used by:**` section from
inverse forward-edge graph.

Forward-only authoring: each wiki article authors `## Lifecycle edges § Depends on:`
manually. The reciprocal `## Lifecycle edges § Used by:` section is COMPUTED
automatically by walking all articles, building the reverse-edge graph, and
rewriting each article's `**Used by:**` block in place.

Usage:
    python3 compute-used-by.py <wiki-dir>            # apply
    python3 compute-used-by.py <wiki-dir> --dry-run  # preview deltas

Idempotent: running twice with no source change produces no diff. Bullets are
sorted alphabetically by display name to keep diffs minimal across re-runs.

Format of each computed bullet: `- [<H1 of source article>](<rel-path>) — depends-on bullet text from source's Depends-on section`
The reason text mirrors what the source author wrote in their Depends-on bullet
(everything after the first ` — ` separator), giving readers context without
duplicating every dependency claim.

If the source's Depends-on bullet has no ` — ` reason, the Used-by bullet is
just the link with no reason.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+\.md)(#[^)]*)?\)")
DEPENDS_HEAD_RE = re.compile(r"^\s*\*\*Depends on:\*\*\s*$")
USED_BY_HEAD_RE = re.compile(r"^\s*\*\*Used by:\*\*\s*$")
SUBSECTION_END_RE = re.compile(r"^\s*\*\*[^*]+:\*\*\s*$")
LIFECYCLE_HEAD_RE = re.compile(r"^##\s+Lifecycle edges\s*$")
H2_RE = re.compile(r"^##\s+")
BULLET_RE = re.compile(r"^\s*-\s+(.*)$")
H1_RE = re.compile(r"^#\s+(.+?)\s*$")


def collect_files(wiki: Path) -> list[Path]:
    parts = wiki / "parts"
    files = list(parts.rglob("*.md")) if parts.is_dir() else []
    appendix = wiki / "appendix-a-seam-types.md"
    if appendix.is_file():
        files.append(appendix)
    return sorted(files)


def read_h1(text: str) -> str:
    for line in text.splitlines():
        m = H1_RE.match(line.rstrip())
        if m:
            return m.group(1)
    return "?"


def parse_depends_on_bullets(text: str) -> list[tuple[str, str]]:
    """Return list of (target_path, full_bullet_text) tuples from Depends-on section.

    `target_path` is the markdown link target (relative to source file).
    `full_bullet_text` is the raw bullet content after `- ` (including link + reason).
    """
    bullets: list[tuple[str, str]] = []
    in_section = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if DEPENDS_HEAD_RE.match(line):
            in_section = True
            continue
        if in_section:
            if not line.strip():
                in_section = False
                continue
            if SUBSECTION_END_RE.match(line):
                in_section = False
                continue
            mb = BULLET_RE.match(line)
            if not mb:
                in_section = False
                continue
            content = mb.group(1)
            for m in LINK_RE.finditer(line):
                bullets.append((m.group(2), content))
    return bullets


def find_lifecycle_section(lines: list[str]) -> tuple[int | None, int]:
    """Return (lifecycle_start_index, lifecycle_end_index_exclusive)."""
    start = None
    end = len(lines)
    for i, line in enumerate(lines):
        if LIFECYCLE_HEAD_RE.match(line):
            start = i
            for j in range(i + 1, len(lines)):
                if H2_RE.match(lines[j]):
                    end = j
                    break
            break
    return start, end


def find_used_by_subsection(lines: list[str], life_start: int, life_end: int) -> tuple[int | None, int]:
    """Return (start_of_**Used by:**_line, end_of_subsection_exclusive)."""
    sub_start = None
    sub_end = life_end
    for i in range(life_start + 1, life_end):
        if USED_BY_HEAD_RE.match(lines[i]):
            sub_start = i
            for j in range(i + 1, life_end):
                if SUBSECTION_END_RE.match(lines[j]) or H2_RE.match(lines[j]):
                    sub_end = j
                    break
            break
    return sub_start, sub_end


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("wiki_dir")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    wiki = Path(args.wiki_dir).resolve()
    if not wiki.is_dir():
        print(f"ERROR: not a directory: {wiki}", file=sys.stderr)
        return 1

    files = collect_files(wiki)
    h1_by_path: dict[Path, str] = {}
    deps_by_source: dict[Path, list[tuple[Path, str]]] = {}

    # Pass 1: read every file, harvest H1 + Depends-on bullets.
    for source in files:
        text = source.read_text(encoding="utf-8")
        h1_by_path[source.resolve()] = read_h1(text)
        bullets = parse_depends_on_bullets(text)
        resolved: list[tuple[Path, str]] = []
        for rel, content in bullets:
            target_abs = (source.parent / rel).resolve()
            if target_abs.exists():
                resolved.append((target_abs, content))
        deps_by_source[source.resolve()] = resolved

    # Pass 2: build inverse graph: target_abs → list of (source_abs, content)
    inverse: dict[Path, list[tuple[Path, str]]] = {}
    for source_abs, edges in deps_by_source.items():
        for target_abs, content in edges:
            inverse.setdefault(target_abs, []).append((source_abs, content))

    # Pass 3: for each file, render `**Used by:**` block from inverse[file] and rewrite.
    files_changed = 0
    bullets_total = 0
    for target in files:
        target_abs = target.resolve()
        users = inverse.get(target_abs, [])

        # Render new bullets, sorted alphabetically by source's H1 for stable diffs.
        rendered: list[str] = []
        seen: set[str] = set()
        for source_abs, content in sorted(users, key=lambda u: h1_by_path[u[0]].lower()):
            rel = os.path.relpath(source_abs, target_abs.parent).replace(os.sep, "/")
            display = h1_by_path[source_abs]
            # Extract reason from source's Depends-on bullet — text AFTER the markdown
            # link's closing `)`, separated by ` — `. Anchoring on link-end (rather than
            # splitting on the first ` — ` in the bullet) is mandatory: a display name
            # containing ` — ` (em-dash with spaces) — e.g. `[Foo — Bar](path)` —
            # would be sliced by a naive split, producing malformed output like
            # `[Source](src) — Bar](path)` in the target's Used-by.
            reason = ""
            link_match = LINK_RE.search(content)
            if link_match is not None:
                after_link = content[link_match.end():]
                sep_match = re.match(r"\s*—\s+(.*)$", after_link)
                if sep_match:
                    reason = sep_match.group(1).strip()
            # Rewrite any embedded `[X](rel.md)` markdown links inside the reason text
            # from source-directory-relative to target-directory-relative paths. Source's
            # reason text was authored to read correctly inside the source article's
            # Lifecycle edges block; when we echo it into the target's Used-by, the
            # embedded relative paths must resolve from the target's directory instead.
            if reason:
                source_dir = source_abs.parent
                target_dir = target_abs.parent

                def _rewrite_embedded(m: re.Match[str]) -> str:
                    inner_display = m.group(1)
                    url = m.group(2)
                    anchor = m.group(3) or ""
                    if url.startswith(("http://", "https://", "/")):
                        return m.group(0)
                    try:
                        absolute = (source_dir / url).resolve()
                    except (OSError, ValueError):
                        return m.group(0)
                    new_url = os.path.relpath(absolute, target_dir).replace(os.sep, "/")
                    return f"[{inner_display}]({new_url}{anchor})"

                reason = LINK_RE.sub(_rewrite_embedded, reason)
            bullet = f"- [{display}]({rel})" + (f" — {reason}" if reason else "")
            if bullet in seen:
                continue
            seen.add(bullet)
            rendered.append(bullet)

        text = target.read_text(encoding="utf-8")
        lines = text.splitlines()

        life_start, life_end = find_lifecycle_section(lines)
        if life_start is None and not rendered:
            continue  # no Lifecycle section + no users — leave alone

        if life_start is None:
            # No Lifecycle section but inverse has users — append Lifecycle + Used-by.
            insert_at = len(lines)
            new_block = ["", "## Lifecycle edges", "", "**Used by:**"]
            new_block.extend(rendered)
            new_block.append("")
            new_lines = lines + new_block
        else:
            sub_start, sub_end = find_used_by_subsection(lines, life_start, life_end)
            new_subsection = ["**Used by:**"]
            new_subsection.extend(rendered)
            if sub_start is not None:
                # Replace existing **Used by:** block.
                # Preserve trailing blank line policy: if old block ended with blank, keep it.
                trailing_blank = (sub_end < len(lines) and not lines[sub_end - 1].strip())
                replacement = new_subsection + ([""] if trailing_blank or rendered else [])
                # If rendered is empty AND no original users existed, skip the block.
                if not rendered:
                    # Strip the empty Used-by subsection entirely.
                    # Adjust to also drop preceding blank line if present.
                    drop_start = sub_start
                    if drop_start > 0 and not lines[drop_start - 1].strip():
                        drop_start -= 1
                    new_lines = lines[:drop_start] + lines[sub_end:]
                else:
                    new_lines = lines[:sub_start] + replacement + lines[sub_end:]
            else:
                if not rendered:
                    continue  # no users, no existing section — leave alone
                # No **Used by:** subsection; insert at end of Lifecycle section.
                insert_at = life_end
                # Ensure blank line separation.
                prefix = [""] if (insert_at > 0 and lines[insert_at - 1].strip()) else []
                new_lines = lines[:insert_at] + prefix + new_subsection + [""] + lines[insert_at:]

        new_text = "\n".join(new_lines)
        if text.endswith("\n") and not new_text.endswith("\n"):
            new_text += "\n"

        if new_text != text:
            files_changed += 1
            bullets_total += len(rendered)
            if not args.dry_run:
                target.write_text(new_text, encoding="utf-8")

    label = "DRY-RUN: would update" if args.dry_run else "Updated"
    print(f"{label} {files_changed} file(s) with {bullets_total} computed Used-by bullet(s) total.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
