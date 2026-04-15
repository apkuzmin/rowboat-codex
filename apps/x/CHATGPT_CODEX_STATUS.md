# ChatGPT / Codex Provider Status

## Scope

This document tracks the current state of the `chatgpt-codex` provider in `apps/x`, what is already implemented, and what still needs to be done for a stable production-quality architecture.

Current date of this status: `2026-04-15`

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

## What is working now

- Selecting `ChatGPT / Codex` in `Models`
- Connecting the provider through OAuth
- Discovering a live model catalog
- Replacing stale saved model IDs with valid ones
- Simple direct streamed inference against Codex upstream
- Non-stream helper use cases that now internally stream for Codex:
  - inline task schedule classification
  - meeting summarization
  - file-to-markdown builtin parsing

## Known blocker

The remaining major blocker is the tool-calling / multi-step loop used by the main agent runtime.

### Current failure mode

Codex upstream requires `store: false`, but the current AI SDK Responses tool loop still relies on persisted item IDs between steps.

Observed upstream error:

`Item with id 'fc_...' not found. Items are not persisted when store is set to false.`

### Why this matters

This means the current Rowboat/X agent runtime can start a Codex turn, but multi-step tool execution is not yet fully compatible with the upstream Codex backend contract.

In practice:

- simple one-shot streamed generation can work
- full tool-driven agent turns are not yet reliable

## Remaining work for production-quality architecture

### Priority 1: Fix Codex tool loop compatibility

Implement a Codex-specific step transport for tool calls instead of relying on the default AI SDK Responses persistence semantics.

Needed work:

- inspect exactly how AI SDK serializes previous tool-call items between steps
- introduce a Codex-specific request transformer or runtime path that:
  - does not send persisted upstream item IDs
  - reconstructs tool-call and tool-result context from local run state
  - preserves `call_id` / tool correlation without relying on persisted upstream storage
- verify this for:
  - single tool call
  - multiple tool calls in one turn
  - multi-step turns with tool result continuation
  - streamed assistant text after tool execution

### Priority 2: Separate Codex transport more explicitly

Right now Codex is still layered through `createOpenAI(...)` with request patching. This is acceptable for v1 exploration, but not ideal long-term.

Better architecture:

- create a dedicated Codex transport/provider adapter
- centralize all Codex-specific contracts there:
  - required headers
  - required request fields
  - streaming behavior
  - model discovery
  - error normalization
- avoid mixing Codex backend rules into generic OpenAI-compatible assumptions

### Priority 3: Normalize error handling end-to-end

Add explicit user-facing handling for Codex-specific backend errors, not only raw `AI_APICallError`.

Needed work:

- map model-not-supported errors to settings remediation
- map auth/session errors to reconnect CTA
- map tool-loop incompatibility errors to a clear “provider not fully supported for this workflow yet” message
- ensure background services do not spam logs with opaque raw transport dumps

### Priority 4: Tighten persistence and migration

Needed work:

- formalize migration behavior for old stale Codex IDs in `models.json`
- add test coverage for migration cases
- ensure partial/corrupt config files fail safely

### Priority 5: Add real test coverage

Current implementation was validated mostly by build checks and live probing. It still needs automated coverage.

Needed tests:

- OAuth browser flow
- OAuth device flow
- token refresh
- model discovery success
- model discovery fallback
- stale config normalization
- renderer model selection for Codex mode
- runtime provider resolution by `providerMode`
- Codex simple streamed generation
- Codex tool-call loop compatibility once implemented

### Priority 6: Revisit background service behavior under Codex mode

Several background services call into the active provider:

- email labeling
- inline tasks
- meeting summarization
- note/tag processing

Needed work:

- identify every place that uses the active provider indirectly
- confirm each path is Codex-compatible
- route unsupported workflows to:
  - a simpler non-tool Codex path, or
  - a different backend if configured, or
  - a clear capability error

## Recommended next implementation step

The next serious engineering step should be:

1. instrument one failing multi-step Codex turn
2. capture the exact step-to-step payload sequence
3. replace persisted upstream item references with locally reconstructed tool context
4. keep all Codex turns on `stream: true`
5. verify the main agent runtime can complete at least one tool call end-to-end

Until that is done, the provider should be considered:

- usable for login, model selection, discovery, and simple streaming
- not yet production-ready for full agent/tool architecture

## Relevant code areas

- `apps/x/packages/core/src/auth/codex.ts`
- `apps/x/packages/core/src/models/codex.ts`
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
