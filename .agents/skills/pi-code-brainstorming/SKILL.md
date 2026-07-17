---
name: pi-code-brainstorming
description: Use when a Pi Code feature or technical problem has unclear requirements, meaningful design choices, or unresolved architectural trade-offs.
---

# Brainstorming Pi Code Designs

Turn an uncertain idea into an agreed, implementable design through focused collaboration. Scale the process to the decision: inspect the repository, clarify only material unknowns, compare real alternatives, recommend a direction, and obtain approval before implementation.

## Scope Gate

Use this skill when at least one is true:

- requirements or success criteria are incomplete;
- ownership, data flow, protocol shape, persistence, or API boundaries are undecided;
- multiple materially different approaches are plausible;
- the change crosses extension-host, webview, SDK, persistence, or packaging boundaries;
- the user explicitly asks to brainstorm or design.

Do **not** start a design ceremony when:

- the user requested a small, exact, already-agreed change;
- the approach is approved and the user asks for a plan or implementation;
- the task is read-only investigation;
- repository inspection can resolve the only uncertainty.

## Design Gate

Do not implement an unresolved design before approval. Read-only exploration and explicitly requested disposable prototypes are allowed, but do not present them as the final implementation. After approval, proceed to the requested next phase without asking for the same decision again.

## Process

### 1. Explore Existing Context

Before asking design questions:

- read the applicable `AGENTS.md`, relevant source, tests, documentation, and recent changes;
- find similar working features and established patterns;
- classify each affected surface as extension host, shared protocol, chat/settings/launcher webview, Pi SDK/resource loading, persistence/subagents, or packaging;
- distinguish repository facts from assumptions;
- identify only decisions that require user input.

Prefer an established project pattern unless evidence supports a new one.

### 2. Clarify High-Impact Unknowns

Ask the smallest number of questions needed to make the design sound. Prefer one direction-changing question at a time, or a short related group when separate turns add no value. Do not ask for facts available in the repository or re-ask constraints already supplied.

Focus on user-visible behavior, supported VS Code/workspace/provider environments, compatibility, failure behavior, migration, security, and measurable success criteria.

### 3. Explore Real Alternatives

Present two or three approaches only when materially different. For each, explain the core idea, benefits, costs, risks, and fit with Pi Code patterns. Lead with the recommendation. Do not invent fake alternatives when one approach clearly dominates.

### 4. Present the Design

Scale the design to complexity. Cover only relevant areas:

- goals, non-goals, and observable behavior;
- ownership between extension host and browser-only webviews;
- typed `ClientMessage` / `ServerMessage` protocol changes and handlers;
- per-tab state, session, diff, checkpoint, queue, and steering behavior;
- Pi SDK lifecycle, resource loading, providers, models, and cancellation;
- persistence, restoration, migration, and rollback;
- SecretStorage, workspace trust, permissions, and failure handling;
- webview DOM rendering, accessibility, and VS Code theme variables;
- package/runtime dependency and installed-VSIX implications;
- unit, integration, manual, and rollout verification.

Request one approval for a compact design. Use section-by-section approval only for large, high-risk designs with dependent decisions.

### 5. Resolve and Record

Revise disputed parts until approved. Record the design only when requested or required by project conventions. Include the chosen approach, rejected alternatives when useful, remaining risks, acceptance criteria, and next step.

## Pi Code Design Lens

Check only what applies:

- extension-host Node/CJS versus webview browser/IIFE boundary;
- protocol-first changes before host or webview handlers;
- tab isolation and restored panel/session state;
- queued prompts versus mid-stream steering;
- cancellation, disposal, event subscriptions, and window reload;
- SecretStorage and runtime API-key bridging;
- project/user skills, tools, MCP, LSP, and subagent trust boundaries;
- vanilla DOM and CSS variable requirements;
- bundled Pi extensions and production dependency packaging;
- F5 behavior versus installed-VSIX behavior.

## Recommended Response Shape

```markdown
## Recommendation
[Preferred approach and why]

## Alternatives
[Only meaningful alternatives and trade-offs]

## Proposed Design
[Scope-scaled design]

## Risks and Open Questions
[Only unresolved or material items]

## Acceptance Criteria
[Observable outcomes]

Does this direction look right, or should any part change before we proceed?
```

## Red Flags

- Designing before inspecting project patterns
- Asking questions answerable from the repository
- Applying brainstorming to an exact or approved task
- Ignoring the extension-host/webview or protocol boundary
- Expanding scope with unrelated cleanup
- Repeating approval already given
- Turning a small decision into a long document

## Core Principles

- Scale ceremony to uncertainty and risk.
- Resolve important decisions, not every imaginable detail.
- Prefer established project patterns.
- Keep unsupported scope out.
- Require approval once for unresolved design, not repeatedly.
