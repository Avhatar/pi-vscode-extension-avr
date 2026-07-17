#!/usr/bin/env python3
"""structure-enum-check.py — single-source-of-truth check for the wiki TOC.

`wiki/index.md` enumerates the wiki's top-level structure (8 Parts / 32 chapters)
with one-line per-chapter descriptions. Per-chapter article rosters (the leaf-level
list of `[Article](slug.md)` entries) live in each chapter's `_intro.md` § Article
roster. Other files (CLAUDE.md, skills, nested CLAUDE.md under Tools/, etc.) cite
specific articles by topic as needed but must NOT duplicate the structural list.

Heuristic: count markdown links pointing into `wiki/parts/<NN-part>/...` (or the
relative `parts/...` / `../parts/...` shapes) per file. Files (other than
`wiki/index.md`) with more than THRESHOLD such links are flagged as potential
duplicate enumerations. Per-chapter `_intro.md` rosters use sibling links
(`[Name](slug.md)`) which do not match this pattern, so intros are correctly
excluded from the duplication smell check.

Usage:
    python3 structure-enum-check.py <wiki-dir> [<extra-dir> ...]

Default extra-dirs: none. Caller passes `.claude/` to scan skills.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]*wiki/parts/[^)]+\.md|parts/[^)]+\.md|\.\./[^)]*parts/[^)]+\.md)(#[^)]*)?\)")
THRESHOLD = 5  # >5 wiki/parts links in a single non-index file == duplication smell


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python3 structure-enum-check.py <wiki-dir> [<extra-dir> ...]", file=sys.stderr)
        return 1

    wiki = Path(sys.argv[1]).resolve()
    if not wiki.is_dir():
        print(f"ERROR: not a directory: {wiki}", file=sys.stderr)
        return 1

    index_md = wiki / "index.md"

    targets: list[Path] = []
    targets.append(index_md)
    targets.append(wiki / "CLAUDE.md")
    for extra in sys.argv[2:]:
        extra_path = Path(extra).resolve()
        if not extra_path.is_dir():
            print(f"WARN: skipping non-directory {extra_path}", file=sys.stderr)
            continue
        targets.extend(extra_path.rglob("CLAUDE.md"))
        targets.extend(extra_path.rglob("SKILL.md"))

    targets = sorted({p.resolve() for p in targets if p.is_file()})

    counts: dict[Path, int] = {}
    for f in targets:
        text = f.read_text(encoding="utf-8", errors="replace")
        n = sum(1 for _ in LINK_RE.finditer(text))
        counts[f] = n

    print(f"=== structure-enum-check over {len(targets)} files ===\n")
    print(f"Threshold: >{THRESHOLD} wiki/parts/ links in a non-index file = duplicate enumeration smell.\n")

    violations: list[tuple[Path, int]] = []
    for f, n in sorted(counts.items()):
        if f == index_md:
            print(f"  index.md (source of truth): {n} wiki/parts/ links")
            continue
        if n > THRESHOLD:
            violations.append((f, n))
        if n > 0:
            print(f"  {f}: {n} wiki/parts/ links" + (" 🔴 OVER THRESHOLD" if n > THRESHOLD else ""))

    print()
    if violations:
        print(f"FAIL — {len(violations)} file(s) over threshold (likely duplicating structure enumeration):")
        for f, n in violations:
            print(f"  {f} — {n} links (>{THRESHOLD})")
        print()
        print("Hint: cite specific articles by topic, don't list whole roster. Only wiki/index.md is the structural source of truth.")
        return 1
    print("PASS — no duplicate structural enumeration outside wiki/index.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
