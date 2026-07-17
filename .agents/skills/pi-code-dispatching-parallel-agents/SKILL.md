---
name: pi-code-dispatching-parallel-agents
description: Use when a Pi Code task contains two or more independent investigation, review, or implementation slices that may be delegated concurrently.
---

# Dispatching Parallel Agents for Pi Code

The harness provides the launch mechanism. This skill decides when parallel work is safe and how the parent integrates it. The root `AGENTS.md` subagent policy remains authoritative.

## Independence Gate

Parallelize only when every slice can answer yes:

- Can it be understood without another slice's result?
- Does it have a narrow, explicit scope and expected output?
- Can it avoid editing the same files or shared contracts?
- Can it avoid shared mutable runtime, ports, credentials, and build output?
- Can its result be verified independently?
- Can the parent integrate results deterministically?

Otherwise keep work sequential or combine coupled slices.

## Pi Code Safety

### Usually safe

- read-only research in unrelated subsystems;
- independent searches or test/spec lookup;
- review of separate requirement groups or diffs;
- implementation in isolated worktrees with non-overlapping ownership;
- documentation work that does not duplicate the same canonical section.

### Usually unsafe

- siblings editing `src/shared/protocol.ts`, `package.json`, `package-lock.json`, `CHANGELOG.md`, `AGENTS.md`, or the same session/controller files;
- one slice defining a contract another slice consumes before the contract is settled;
- concurrent shared-workspace writers without the harness writer lease;
- several agents running package/deploy/install flows or mutating `out/` and dependencies;
- live provider tests sharing credentials, quotas, model state, ports, or worktrees;
- failures likely caused by one common activation, session, queue, persistence, or resource-loader defect.

Read-only agents can share the checkout more safely. Background writers require worktree isolation. Shared-workspace writing remains foreground and leased. Children never receive the `subagent` tool.

## Decompose by Responsibility

Good slices:

- inspect host-side session lifecycle;
- inspect the independent webview rendering path;
- audit package/runtime dependency rules;
- review a separate test surface.

Bad slices:

- two agents editing halves of `ChatController`;
- one agent adds a protocol variant while another guesses its shape;
- several failures that likely share one initialization cause;
- overlapping reviewers with no distinct stage or scope.

## Agent Brief

Every delegated slice receives:

```text
Goal:
Owned paths and scope:
Read-only or allowed writes:
Known evidence/reproduction:
Project invariants:
Shared resources it must not use:
Acceptance criteria:
Expected report or artifact:
Allowed verification:
```

Use a matching named agent when available; otherwise create a focused ad-hoc role. Keep prompts self-contained and tools narrow.

## Parent Responsibilities

The parent owns independence validation, isolation choice, lifecycle operations, actual diff review, conflict detection, controlled apply order, integrated compile/tests/package verification, and cleanup. Review isolated patches before applying them. Agent summaries are not evidence that changes integrate or pass.

## Conflicting Results

Stop integration and determine whether the slices shared a hidden contract, used stale assumptions, overlapped ownership, or observed changing workspace state. Resolve the shared decision centrally, then resume sequentially or re-dispatch with corrected boundaries.

## Red Flags

- Parallelizing because there are many files
- Manufacturing work to justify delegation
- Two writers touching one contract
- Applying a child patch without review
- Trusting child test claims instead of parent-run checks
- Skipping integrated verification after merging results
