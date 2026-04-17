# ChatGPT / Codex Provider Status

## Scope

This document tracks the current state of the `chatgpt-codex` provider in `apps/x`, what is already implemented, and what still needs to be done for a stable production-quality architecture.

Current date of this status: `2026-04-17`

## What is implemented

### 1. Provider mode and settings UX

- `ChatGPT / Codex` exists as a first-class provider choice in `Settings -> Models`.
- It is implemented as an account-backed provider mode, not as a fake BYOK `flavor`.
- `providerMode` is persisted separately from BYOK provider config.
- `ChatGPT / Codex` was removed from `Connected Accounts` and connector-style entry points to avoid duplicate UX.

### 2. Auth and token lifecycle

- Browser OAuth flow is implemented.
- Device code fallback is implemented.
- Tokens are stored in `oauth.json`.
- Token refresh logic is implemented.
- Client-facing OAuth state includes connection metadata such as `email` and `planType` when available.

### 3. Runtime provider wiring

- Runtime selection is mode-based instead of “whoever is logged in wins”.
- `rowboat`, `chatgpt-codex`, and BYOK are mutually exclusive model backends via `providerMode`.
- Direct Codex upstream transport is wired through `https://chatgpt.com/backend-api/codex`.

### 4. Model catalog and stale selection repair

- Codex model catalog no longer uses stale hardcoded `gpt-5-codex` or `codex-mini-latest`.
- Live model discovery is implemented via the Codex upstream catalog endpoint.
- Curated fallback catalog exists if live discovery fails.
- Saved invalid model IDs are normalized on config load.
- Renderer receives catalog metadata including:
  - `catalogSource`
  - `invalidSavedModels`
  - recommended defaults

### 5. Renderer synchronization

- `Settings -> Models` reads the resolved Codex catalog instead of static IDs.
- Onboarding model setup uses the same catalog source.
- Chat input model picker uses the same catalog source.
- UI surfaces fallback/discovery state and warns when stale saved model IDs were replaced.

### 6. Codex request normalization

- Codex requests now enforce backend-required request shape:
  - `instructions` is injected when absent
  - `store` is forced to `false`
- Non-stream generation paths that use the active provider were switched to a Codex-safe text helper that uses `streamText()` for `chatgpt-codex`.

### 7. Codex-specific runtime transport for tool loops

- A dedicated Codex step transport exists in `packages/core/src/models/codex-runtime.ts`.
- Agent runtime has an explicit Codex branch in `packages/core/src/agents/runtime.ts` using `streamCodexStep(...)`.
- Codex steps reconstruct context from local state and avoid persisted upstream item IDs.
- Codex error normalization is centralized in `normalizeCodexError(...)`.

### 8. Safety and defaults updates

- Corrupt or partial `models.json` handling has safe fallback behavior in the model config repo.
- `chatgpt-codex` provider is now enabled by default and can still be explicitly disabled via `ENABLE_CHATGPT_CODEX_PROVIDER`.

## What is verified now

### Code and packaging signals

- `@x/core` build passes (`pnpm --filter @x/core build`).
- Arm macOS installer build passes (`electron-forge make --platform darwin --arch arm64`), producing:
  - `apps/x/apps/main/out/make/Rowboat-darwin-arm64-0.1.0.dmg`
  - `apps/x/apps/main/out/make/zip/darwin/arm64/Rowboat-darwin-arm64-0.1.0.zip`

### Automated test signals

- `packages/core/src/models/codex-runtime.test.ts`: all tests pass.
- `packages/core/src/models/repo.test.ts`: passes, including corrupt `models.json` fallback behavior.
- `@x/core` test suite currently green (`vitest run`).

## Remaining work for production-quality architecture

### Priority 1: Complete end-to-end acceptance on a running app session

Tool-loop architecture work is done, but manual verification is still required in the real desktop flow.

Required checks:

- `Settings -> Models`: select `ChatGPT / Codex`, ensure model list resolves correctly.
- OAuth browser flow and device flow.
- One simple streamed assistant response.
- One full tool loop (`assistant -> tool-call -> tool-result -> assistant`) from the main runtime.

### Priority 2: Stabilize automated validation

- Fix failing `repo.test.ts` DI/container path in `packages/core`.
- Ensure full `@x/core` test suite runs green on the default local toolchain.
- Add/finish test coverage for:
  - OAuth browser/device paths
  - token refresh
  - model discovery fallback behavior
  - provider mode resolution and renderer model selection.

### Priority 3: Audit indirect active-provider workflows

Confirm behavior for all services that indirectly call the active provider:

- email labeling
- inline tasks
- meeting summarization
- note/tag processing

For each path, define whether Codex is:

- fully supported,
- supported with a simplified non-tool path,
- or intentionally blocked with a clear user-facing capability message.

### Priority 4: Release hardening

- Keep installer output reproducible.
- For public distribution, add Apple signing + notarization pipeline (current local installer is unsigned).

## Relevant code areas

- `apps/x/packages/core/src/auth/codex.ts`
- `apps/x/packages/core/src/config/env.ts`
- `apps/x/packages/core/src/models/codex.ts`
- `apps/x/packages/core/src/models/codex-runtime.ts`
- `apps/x/packages/core/src/models/active-provider.ts`
- `apps/x/packages/core/src/models/repo.ts`
- `apps/x/packages/core/src/models/text-generation.ts`
- `apps/x/packages/core/src/agents/runtime.ts`
- `apps/x/apps/main/src/ipc.ts`
- `apps/x/apps/main/src/oauth-handler.ts`
- `apps/x/apps/renderer/src/components/settings-dialog.tsx`
- `apps/x/apps/renderer/src/components/onboarding/use-onboarding-state.ts`
- `apps/x/apps/renderer/src/components/onboarding/steps/llm-setup-step.tsx`
- `apps/x/apps/renderer/src/components/chat-input-with-mentions.tsx`
