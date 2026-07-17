#!/usr/bin/env python3
"""reciprocal.py — DEMOTED. Bidirectional Lifecycle-edges symmetry check.

**Demoted to one-shot audit.**
Forward-only `Depends on` is the authored side; `Used by` is COMPUTED by
`compute-used-by.py`. Use this script for first-pass migration validation,
rare manual asymmetry checks, or post-`compute-used-by` verification. The
`--fix` mode survives unchanged for legacy use; for the steady-state
workflow, prefer `compute-used-by.py` (which authors `Used by` from the
inverse Depends-on graph deterministically).

Original purpose follows.

reciprocal.py — check that Lifecycle-edges graph is symmetric.

For each wiki node (Lx-*.md), parse the sections:
  **Depends on:** — edges OUT of this node
  **Used by:**    — edges IN to this node

For every edge A -> B recorded on A's "Depends on:" list, B's "Used by:" list must
contain A. Vice versa for "Used by:" on A implying "Depends on:" on B.

Usage:
  python3 reciprocal.py <wiki-dir>                    # check only, exit 1 on asymmetry
  python3 reciprocal.py <wiki-dir> --fix              # auto-insert missing reverse bullets
  python3 reciprocal.py <wiki-dir> --fix --dry-run    # print planned edits, no writes

Fix mode appends minimal bullets (`- [Display](file.md)`) at the end of the target
section's bullet list. Display name is the target file's H1 stripped of "# ". If
a `## Lifecycle edges` section or `**Depends on:**` / `**Used by:**` sub-heading is
missing, it is created.
"""

import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+\.md)\)")
HEADING_RE = re.compile(r"^\s*\*\*(Depends on|Used by):\*\*\s*$")
# Any bold-colon pseudo-heading, e.g. `**Used by (consumed via events):**` —
# these act as section terminators even if not reciprocity-relevant.
SUBSECTION_END_RE = re.compile(r"^\s*\*\*[^*]+:\*\*\s*$")
BULLET_RE = re.compile(r"^\s*-\s+")
LIFECYCLE_HEADING_RE = re.compile(r"^##\s+Lifecycle edges\s*$")
H1_RE = re.compile(r"^#\s+(.+?)\s*$")


def parse_node(path: Path) -> Tuple[Set[str], Set[str]]:
    """Return (depends_on, used_by) as sets of target .md filenames (basenames)."""
    depends_on: Set[str] = set()
    used_by: Set[str] = set()
    current: Optional[Set[str]] = None

    text = path.read_text(encoding="utf-8", errors="replace")
    for raw in text.splitlines():
        line = raw.rstrip()
        m = HEADING_RE.match(line)
        if m:
            current = depends_on if m.group(1) == "Depends on" else used_by
            continue
        if current is not None:
            if not line.strip():
                current = None
                continue
            if not BULLET_RE.match(line):
                current = None
                continue
            for link in LINK_RE.findall(line):
                target = os.path.basename(link)
                if target.startswith("L") and target.endswith(".md"):
                    current.add(target)
    return depends_on, used_by


def read_h1(path: Path) -> str:
    """Return the file's H1 heading text (without '# '). Fallback to stem."""
    try:
        with path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                m = H1_RE.match(line.rstrip())
                if m:
                    return m.group(1)
    except OSError:
        pass
    return path.stem


def check(wiki_dir: Path) -> Tuple[List[str], Dict[str, Path]]:
    """Run the reciprocity check. Return (errors, node_paths_by_filename)."""
    nodes = sorted(
        p for p in wiki_dir.iterdir()
        if p.is_file() and p.suffix == ".md" and p.name.startswith("L")
    )
    paths_by_name: Dict[str, Path] = {p.name: p for p in nodes}

    depends: Dict[str, Set[str]] = {}
    used: Dict[str, Set[str]] = {}
    for p in nodes:
        d, u = parse_node(p)
        depends[p.name] = d
        used[p.name] = u

    errors: List[str] = []

    for a, a_deps in depends.items():
        for b in a_deps:
            if b not in used:
                errors.append(f"  {a} 'Depends on' {b}, but {b} is not a known node.")
                continue
            if a not in used[b]:
                errors.append(f"  {a} 'Depends on' {b}, but {b} does not list {a} in 'Used by'.")

    for a, a_used in used.items():
        for b in a_used:
            if b not in depends:
                errors.append(f"  {a} 'Used by' {b}, but {b} is not a known node.")
                continue
            if a not in depends[b]:
                errors.append(f"  {a} 'Used by' {b}, but {b} does not list {a} in 'Depends on'.")

    return errors, paths_by_name


# ---------- fix mode ----------

# Each edit:
#   target_file   — filename to edit (e.g. 'event-bus.md')
#   target_section — 'Depends on' or 'Used by'
#   source_file   — filename of the node to insert as a bullet
#   source_display — display name for the bullet
Edit = Tuple[str, str, str, str]


def errors_to_edits(errors: List[str], paths: Dict[str, Path]) -> List[Edit]:
    """Translate reciprocal errors into concrete edits."""
    # Error formats:
    #   A 'Depends on' B, but B does not list A in 'Used by'.
    #     -> edit B's 'Used by' section, insert A.
    #   A 'Used by' B, but B does not list A in 'Depends on'.
    #     -> edit B's 'Depends on' section, insert A.
    # Skip unknown-node errors (those need human intervention).
    pattern = re.compile(
        r"^\s+(?P<a>\S+\.md) '(?P<kind>Depends on|Used by)' (?P<b>\S+\.md), "
        r"but \S+\.md does not list \S+\.md in '(?P<missing>Used by|Depends on)'\.$"
    )
    edits: List[Edit] = []
    for line in errors:
        if "is not a known node" in line:
            continue
        m = pattern.match(line)
        if not m:
            continue
        a = m.group("a")
        b = m.group("b")
        missing = m.group("missing")
        if a not in paths or b not in paths:
            continue
        display = read_h1(paths[a])
        edits.append((b, missing, a, display))
    return edits


def apply_edits_to_file(path: Path, edits_for_file: List[Edit]) -> Tuple[str, List[str]]:
    """Return (new_text, diff_lines) after applying the edits to the file."""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines(keepends=False)

    # Split planned bullets by section
    to_add: Dict[str, List[str]] = {"Depends on": [], "Used by": []}
    for _, section, src_file, src_display in edits_for_file:
        bullet = f"- [{src_display}]({src_file})"
        if bullet not in to_add[section]:
            to_add[section].append(bullet)

    # Locate ## Lifecycle edges
    lifecycle_start = None
    lifecycle_end = len(lines)
    for i, line in enumerate(lines):
        if LIFECYCLE_HEADING_RE.match(line):
            lifecycle_start = i
            # find next top-level heading
            for j in range(i + 1, len(lines)):
                if lines[j].startswith("## "):
                    lifecycle_end = j
                    break
            break

    diff_lines: List[str] = []

    if lifecycle_start is None:
        # No Lifecycle edges section — append one before any trailing content.
        # Default: append right before the next top-level heading after H1, or at EOF.
        insert_at = len(lines)
        new_block = ["", "## Lifecycle edges", ""]
        for section in ("Depends on", "Used by"):
            if to_add[section]:
                new_block.append(f"**{section}:**")
                for b in to_add[section]:
                    new_block.append(b)
                    diff_lines.append(f"  {path.name} [NEW {section}] {b}")
                new_block.append("")
        lines = lines[:insert_at] + new_block + lines[insert_at:]
    else:
        # Find existing sub-sections within [lifecycle_start+1, lifecycle_end).
        # A reciprocity-relevant sub-section is started by `**Depends on:**` / `**Used by:**`
        # (HEADING_RE) and ends at the next ANY bold-colon pseudo-heading (SUBSECTION_END_RE)
        # or at lifecycle_end. Non-standard pseudo-headings (e.g. "**Used by (consumed ...):**")
        # are treated as terminators only — not as the start of a tracked section.
        section_bounds: Dict[str, Tuple[int, int]] = {}
        i = lifecycle_start + 1
        cur_section: Optional[str] = None
        cur_start: Optional[int] = None
        while i < lifecycle_end:
            if SUBSECTION_END_RE.match(lines[i]):
                # Close previous tracked section, if any
                if cur_section is not None and cur_start is not None:
                    section_bounds[cur_section] = (cur_start, i)
                    cur_section = None
                    cur_start = None
                # Open a new tracked section only if it's a reciprocity-relevant heading
                mh = HEADING_RE.match(lines[i])
                if mh:
                    cur_section = mh.group(1)
                    cur_start = i
            i += 1
        if cur_section is not None and cur_start is not None:
            section_bounds[cur_section] = (cur_start, lifecycle_end)

        # Apply per-section inserts from bottom of file upward to keep earlier indices valid.
        # Collect planned inserts with their absolute insertion positions.
        insert_plan: List[Tuple[int, List[str]]] = []  # (insert_index, bullets)
        for section in ("Depends on", "Used by"):
            if not to_add[section]:
                continue
            if section in section_bounds:
                sec_start, sec_end = section_bounds[section]
                # Find last bullet line within the section
                last_bullet = sec_start  # fallback: right after heading
                j = sec_start + 1
                while j < sec_end:
                    if BULLET_RE.match(lines[j]):
                        last_bullet = j
                    j += 1
                insert_idx = last_bullet + 1
                insert_plan.append((insert_idx, list(to_add[section])))
                for b in to_add[section]:
                    diff_lines.append(f"  {path.name} [APPEND {section}] {b}")
            else:
                # Sub-section missing — create it right after the `## Lifecycle edges` heading
                # (or after the existing sibling section). Insert as: blank, `**{section}:**`, bullets.
                insert_idx = lifecycle_end
                new_block = [""] if (insert_idx > 0 and lines[insert_idx - 1].strip()) else []
                new_block.append(f"**{section}:**")
                for b in to_add[section]:
                    new_block.append(b)
                    diff_lines.append(f"  {path.name} [NEW SUB-SECTION {section}] {b}")
                insert_plan.append((insert_idx, new_block))

        # Apply inserts bottom-up
        for insert_idx, block in sorted(insert_plan, key=lambda x: -x[0]):
            lines = lines[:insert_idx] + block + lines[insert_idx:]

    # Preserve trailing newline
    out = "\n".join(lines)
    if text.endswith("\n") and not out.endswith("\n"):
        out += "\n"
    return out, diff_lines


def run_fix(wiki_dir: Path, dry_run: bool) -> int:
    errors, paths = check(wiki_dir)
    if not errors:
        print(f"PASS — reciprocal edges consistent across {len(paths)} nodes; nothing to fix")
        return 0

    edits = errors_to_edits(errors, paths)
    unfixable = len(errors) - len(edits)

    # Group by target file
    by_file: Dict[str, List[Edit]] = {}
    for e in edits:
        by_file.setdefault(e[0], []).append(e)

    label = "DRY-RUN" if dry_run else "FIX"
    print(f"{label} — {len(errors)} errors, {len(edits)} fixable, {unfixable} unfixable (unknown-node), {len(by_file)} files to edit")
    total_diff_lines = 0
    for target_file in sorted(by_file.keys()):
        path = paths[target_file]
        new_text, diff = apply_edits_to_file(path, by_file[target_file])
        for dl in diff:
            print(dl)
        total_diff_lines += len(diff)
        if not dry_run:
            path.write_text(new_text, encoding="utf-8")

    print(f"{label} — applied {total_diff_lines} bullet insertions across {len(by_file)} files")
    if unfixable:
        print(f"WARNING — {unfixable} errors not auto-fixable (unknown node names); fix those by hand")
    if dry_run:
        return 0
    # Re-check
    errors_after, _ = check(wiki_dir)
    if errors_after:
        print(f"POST-FIX CHECK — still {len(errors_after)} errors remaining (may be unknown-node or same-file unresolvable)")
        return 1
    print("POST-FIX CHECK — PASS")
    return 0


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if args else 1

    wiki_dir = Path(args[0]).resolve()
    if not wiki_dir.is_dir():
        print(f"ERROR: not a directory: {wiki_dir}", file=sys.stderr)
        return 1

    fix = "--fix" in args[1:]
    dry_run = "--dry-run" in args[1:]
    unknown = [a for a in args[1:] if a not in ("--fix", "--dry-run")]
    if unknown:
        print(f"ERROR: unknown argument(s): {' '.join(unknown)}", file=sys.stderr)
        return 1

    if fix:
        return run_fix(wiki_dir, dry_run)

    errors, paths = check(wiki_dir)
    if errors:
        print(f"FAIL — {len(errors)} asymmetric edge(s):")
        for e in errors:
            print(e)
        return 1
    print(f"PASS — reciprocal edges consistent across {len(paths)} nodes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
