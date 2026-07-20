#!/usr/bin/env python3
"""validate.py — mechanical checks for the book-chapters wiki.

Usage: python3 validate.py <wiki-dir>

Walks `wiki/parts/**/*.md` + `wiki/appendix-a-seam-types.md` (the populated
content surface). Skips infrastructure files (`wiki/index.md`, `wiki/CLAUDE.md`,
`wiki/changelog.md`) — they hold structural enumeration, conventions, and
per-invocation history rather than article content.

Severity-tiered output:
  [E] ERROR — broken md-links, TBD leftovers, Cyrillic content (English-only).
  [W] WARN  — content articles below 80 lines, or chapter intros below 50 lines.
  [I] INFO  — neighborhood asymmetries (`Depends on` without reverse `Used by`
            from the target). Forward-only `Depends on` is the authored side;
            `Used by` should be computed via `compute-used-by.py`. INFO here
            tells you when running compute-used-by would change something.

Exit 0 on no [E]; exit 1 if any [E] surfaced. WARN/INFO never block.

This validator does NOT enforce roster-vs-disk symmetry against `wiki/index.md`
— that check lives separately in `structure-enum-check.py`.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Reconfigure stdout for UTF-8 (Windows cp1252 default chokes on non-ASCII).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

INFRASTRUCTURE_FILES = {"index.md", "CLAUDE.md", "changelog.md"}

# `[display](path.md)` or `[display](path.md#anchor)`. Excludes URLs.
LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+\.md)(#[^)]*)?\)")
CYR_RE = re.compile(r"[Ѐ-ӿ]")
TBD_RE = re.compile(r"\bTBD\b")
DEPENDS_HEAD_RE = re.compile(r"^\s*\*\*Depends on:\*\*\s*$")
USED_BY_HEAD_RE = re.compile(r"^\s*\*\*Used by:\*\*\s*$")
SUBSECTION_END_RE = re.compile(r"^\s*\*\*[^*]+:\*\*\s*$")
BULLET_RE = re.compile(r"^\s*-\s+")

ARTICLE_MIN_LINES = 80
INTRO_MIN_LINES = 50


def is_intro(path: Path) -> bool:
    return path.name == "_intro.md"


def collect_files(wiki: Path) -> list[Path]:
    parts = wiki / "parts"
    files = list(parts.rglob("*.md")) if parts.is_dir() else []
    appendix = wiki / "appendix-a-seam-types.md"
    if appendix.is_file():
        files.append(appendix)
    return sorted(files)


def parse_depends_on(text: str) -> set[str]:
    """Return absolute target paths cited in this file's `**Depends on:**` bullets."""
    targets: set[str] = set()
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
            if not BULLET_RE.match(line):
                in_section = False
                continue
            for m in LINK_RE.finditer(line):
                targets.add(m.group(2))
    return targets


def parse_used_by(text: str) -> set[str]:
    targets: set[str] = set()
    in_section = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if USED_BY_HEAD_RE.match(line):
            in_section = True
            continue
        if in_section:
            if not line.strip():
                in_section = False
                continue
            if SUBSECTION_END_RE.match(line):
                in_section = False
                continue
            if not BULLET_RE.match(line):
                in_section = False
                continue
            for m in LINK_RE.finditer(line):
                targets.add(m.group(2))
    return targets


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python3 validate.py <wiki-dir>", file=sys.stderr)
        return 1
    wiki = Path(sys.argv[1]).resolve()
    if not wiki.is_dir():
        print(f"ERROR: not a directory: {wiki}", file=sys.stderr)
        return 1

    files = collect_files(wiki)
    if not files:
        # Empty scaffold — no articles authored yet. Not an error; validators have
        # nothing to check. Return 0 so deploy-time smoke tests pass on a fresh install.
        print(f"[W] empty wiki — no content files under {wiki}/parts/ yet. Nothing to validate.")
        print("PASS — empty wiki (author your first article to start validating content)")
        return 0

    errors: list[str] = []
    warns: list[str] = []
    infos: list[str] = []

    # Build forward (Depends on) and reverse (Used by) graphs by absolute target path.
    depends_graph: dict[Path, set[Path]] = {}
    used_by_graph: dict[Path, set[Path]] = {}

    def resolve(rel_path: str, source: Path) -> Path | None:
        if rel_path.startswith(("http://", "https://")):
            return None
        target = (source.parent / rel_path).resolve()
        return target

    for source in files:
        text = source.read_text(encoding="utf-8")

        # 1. Cyrillic.
        for i, line in enumerate(text.splitlines(), 1):
            if CYR_RE.search(line):
                errors.append(f"[E] {source.relative_to(wiki)}:{i} — Cyrillic content")
                break  # one report per file

        # 2. TBD.
        for i, line in enumerate(text.splitlines(), 1):
            if TBD_RE.search(line):
                errors.append(f"[E] {source.relative_to(wiki)}:{i} — TBD leftover")
                break

        # 3. Link resolution.
        for m in LINK_RE.finditer(text):
            display, rel_path, _anchor = m.group(1), m.group(2), m.group(3)
            target = resolve(rel_path, source)
            if target is None:
                continue
            if not target.exists():
                errors.append(f"[E] {source.relative_to(wiki)} — broken link [{display}]({rel_path})")

        # 4. Thin warning (article vs intro thresholds differ).
        line_count = text.count("\n") + (0 if text.endswith("\n") else 1)
        threshold = INTRO_MIN_LINES if is_intro(source) else ARTICLE_MIN_LINES
        kind = "intro" if is_intro(source) else "article"
        # Appendix has its own bar — exempt.
        if source.name != "appendix-a-seam-types.md" and line_count < threshold:
            warns.append(f"[W] {source.relative_to(wiki)} — THIN {kind} ({line_count} lines, expected >={threshold})")

        # 5. Build Depends-on / Used-by graphs.
        deps = {resolve(p, source) for p in parse_depends_on(text)}
        deps = {d for d in deps if d is not None and d.exists()}
        depends_graph[source.resolve()] = deps

        usedby = {resolve(p, source) for p in parse_used_by(text)}
        usedby = {u for u in usedby if u is not None and u.exists()}
        used_by_graph[source.resolve()] = usedby

    # 6. INFO: forward-only `Depends on` should be reciprocated by computed `Used by`.
    # For each A -> B edge in depends_graph, B should list A in its used_by_graph.
    for a, deps in depends_graph.items():
        for b in deps:
            if b in used_by_graph and a not in used_by_graph[b]:
                rel_a = a.relative_to(wiki)
                rel_b = b.relative_to(wiki)
                infos.append(f"[I] {rel_a} 'Depends on' {rel_b}, but {rel_b} 'Used by' missing {rel_a} (run compute-used-by.py)")

    # Output
    print(f"=== validate.py over {len(files)} files ===\n")
    if errors:
        print(f"[E] ERROR ({len(errors)}):")
        for e in errors[:30]:
            print(f"  {e}")
        if len(errors) > 30:
            print(f"  ... and {len(errors) - 30} more")
    else:
        print("[E] ERROR: none")
    print()
    if warns:
        print(f"[W] WARN ({len(warns)}):")
        for w in warns[:30]:
            print(f"  {w}")
        if len(warns) > 30:
            print(f"  ... and {len(warns) - 30} more")
    else:
        print("[W] WARN: none")
    print()
    if infos:
        print(f"[I] INFO ({len(infos)}):")
        for i in infos[:10]:
            print(f"  {i}")
        if len(infos) > 10:
            print(f"  ... and {len(infos) - 10} more (re-run compute-used-by.py to fix all)")
    else:
        print("[I] INFO: none")
    print()

    if errors:
        print("FAIL — see [E] ERROR list above")
        return 1
    print("PASS — no [E] errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
