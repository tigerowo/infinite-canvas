# Optional ComfyUI Media Slots Implementation Plan

> **Required sub-skill:** Use `superpowers:test-driven-development` for every implementation task and `superpowers:verification-before-completion` before reporting completion.

**Goal:** Let a local ComfyUI workflow run with zero, some, or all configured image/video/audio references by exposing safe optional media slots on Infinite Canvas.

**Architecture:** Extend the existing workflow field mapping instead of adding a second workflow system. The Bridge owns graph analysis and pruning because it has the executable API graph and ComfyUI `/object_info`; the Go service owns request validation and media resolution; the canvas stores only per-slot run modes and derives sparse reference arrays from existing upstream assets.

**Tech Stack:** Go 1.25, React 19, Next.js 16, TypeScript, Ant Design, Bun tests.

**Spec:** `docs/superpowers/specs/2026-10-01-optional-media-slots-design.md`

**Global Constraints:** Local ComfyUI Bridge only; no RunningHub behavior change; no database migration; no new dependency; old workflow JSON must keep its current behavior; reject unsafe or stale prune plans before submitting to ComfyUI.

**Review Focus:** Sparse slots must keep their real indices; stale/tampered prune plans must fail closed; shared/output/unknown branches must never be pruned; retry and reload must preserve slot modes; fields without `optionalMedia` must remain unchanged.

## Task 1: Add the backward-compatible data contract

**Files:**

- Modify: `model/setting.go`
- Modify: `service/workflow_mapping.go`
- Modify: `web/src/lib/workflow-channel.ts`
- Modify: `web/src/services/api/workflow-generation.ts`
- Test: `service/workflow_mapping_test.go`
- Create: `web/src/lib/workflow-channel.test.ts`

- [ ] Add one failing Go round-trip/behavior test proving omitted optional-media fields retain the current required-media behavior and provided `mediaSlotModes` deserialize by `nodeId::fieldName`.
- [ ] Run `go test ./service -run 'TestResolveWorkflowFieldsLegacyMedia|TestWorkflowRunInputMediaSlotModes'` and confirm the new test fails.
- [ ] Add the minimum shared structs/types: `MediaPrunePlan`, `MediaDetachInput`, `OptionalMedia`, `MediaDefaultMode`, and `MediaSlotModes`.
- [ ] Extend `WorkflowFieldMapping` and `WorkflowRunInput` with the approved JSON keys, leaving every new field optional/zero-value compatible.
- [ ] Add the equivalent TypeScript union/types and preserve the new fields in `normalizeWorkflowFieldMappings` and `mergeWorkflowFieldMappings`.
- [ ] Add a focused Bun test for normalization/merge preservation, then run `cd web; bun test src/lib/workflow-channel.test.ts`.
- [ ] Re-run the focused Go tests and commit: `feat: add optional workflow media contract`.

## Task 2: Discover safe prune plans in the Bridge

**Files:**

- Modify: `canvas-agent/native/comfy-bridge/main.go`
- Modify: `canvas-agent/native/comfy-bridge/workflow.go`
- Modify: `canvas-agent/native/comfy-bridge/workflow_test.go`

- [ ] Add table-driven failing tests for: direct optional input, multi-node required chain, safe fan-out, shared required branch rejection, output-node rejection, unknown input rejection, cycle rejection, and `COMFY_AUTOGROW_V3` dynamic image/audio keys.
- [ ] Run `go test ./canvas-agent/native/comfy-bridge -run TestDiscoverMediaPrunePlan` and confirm the new cases fail.
- [ ] Reuse the existing normalized workflow and fetch `/object_info` once during inspect; pass both into field discovery rather than adding a parallel inspection endpoint.
- [ ] Implement one graph walk that starts at the media loader, removes only nodes whose traversed input is required, stops by recording a detach at optional inputs, and fails closed on every unsafe path.
- [ ] Include the loader in `removeNodeIds`; deduplicate and sort node IDs and detach pairs before returning the plan.
- [ ] Mark an inspected media field `optionalMedia: true` and attach `mediaPrunePlan` only when every downstream path is safe; otherwise leave its legacy mapping untouched.
- [ ] Run the focused Bridge test and commit: `feat: discover safe ComfyUI media branches`.

## Task 3: Resolve slot modes and sparse media on the server

**Files:**

- Modify: `service/workflow_mapping.go`
- Modify: `service/workflow_task.go`
- Modify: `service/workflow_mapping_test.go`

- [ ] Add failing tests for `off` skipping required validation, `default` preserving workflow input, `canvas` requiring its exact indexed asset, a disabled earlier slot not shifting a later image/audio, invalid mode rejection, and non-optional fields ignoring slot modes.
- [ ] Run `go test ./service -run 'TestResolveWorkflowFieldsOptionalMedia|TestComfyWorkflowPayloadSparseMedia'` and confirm failure.
- [ ] Resolve each optional field mode from `mediaSlotModes[field identity]`, falling back to `mediaDefaultMode`; validate only `off|canvas|default`.
- [ ] For `off`, produce no override and skip `required`; for `default`, produce no override and keep the original API value; for `canvas`, require and validate the media at the field's real index.
- [ ] Change `comfyWorkflowPayload` so blank sparse entries are omitted from upload items without renumbering their `image:n`, `video:n`, or `audio:n` IDs, and include `mediaSlotModes` for Bridge pruning.
- [ ] Keep the existing unmapped-media capacity check for nonblank entries only.
- [ ] Run the focused service tests and commit: `feat: resolve optional media slot modes`.

## Task 4: Execute prune plans safely before ComfyUI submission

**Files:**

- Modify: `canvas-agent/native/comfy-bridge/workflow.go`
- Modify: `canvas-agent/native/comfy-bridge/workflow_test.go`

- [ ] Add failing tests for all-off, partial-off, all-canvas/default, stale node ID, stale detach input, and a remaining link to a removed node.
- [ ] Run `go test ./canvas-agent/native/comfy-bridge -run TestApplyOptionalMediaPrunePlans` and confirm failure.
- [ ] In `applyWorkflowFields`, retain legacy behavior for non-optional media fields; for optional fields use the resolved mode and never infer a prune plan at run time.
- [ ] Re-run the same safety analysis against the current workflow/object info and require an exact match with the saved plan; then apply overrides, delete planned nodes, and detach planned inputs. This validates rather than silently replacing stale or tampered plans.
- [ ] Scan the final graph for links to deleted nodes and return an actionable “重新拉取工作流参数” error before `/prompt` if any plan is stale or incomplete.
- [ ] Run `go test ./canvas-agent/native/comfy-bridge -run 'TestApplyOptionalMediaPrunePlans|TestApplyWorkflowFields'` and commit: `feat: prune disabled ComfyUI media slots`.

## Task 5: Add canvas slot derivation and persistence

**Files:**

- Create: `web/src/lib/workflow-media-slots.ts`
- Create: `web/src/lib/workflow-media-slots.test.ts`
- Modify: `web/src/app/(user)/canvas/types.ts`

- [ ] Add failing Bun tests that resolve a `WorkflowRef` to its saved entry, derive only safe optional fields, normalize stored modes, preserve slot indices, build sparse image/audio arrays, allow all-off, and report the exact enabled slot missing a canvas asset.
- [ ] Run `cd web; bun test src/lib/workflow-media-slots.test.ts` and confirm failure.
- [ ] Add `mediaSlotModes` to `CanvasNodeMetadata` so existing canvas project persistence carries the state without a new store.
- [ ] Implement the smallest pure helpers for workflow lookup, slot derivation, mode fallback, sparse reference assignment, and validation; callers pass the result of existing `listWorkflowChannels` instead of creating a second cache.
- [ ] Run the focused Bun test and commit: `feat: derive canvas workflow media slots`.

## Task 6: Expose optional slots and submit their modes

**Files:**

- Create: `web/src/app/(user)/canvas/components/workflow-media-slot-control.tsx`
- Modify: `web/src/app/(user)/canvas/components/canvas-node-prompt-panel.tsx`
- Modify: `web/src/app/(user)/canvas/components/canvas-config-node-panel.tsx`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`

- [ ] Render the shared compact control only when the selected workflow has safe optional slots; show per-slot `off/canvas/default`, plus all-on/all-off actions limited to optional slots.
- [ ] Save changes through the existing `onConfigChange` path into `CanvasNodeMetadata.mediaSlotModes`; do not introduce a new canvas state store.
- [ ] Before generate and retry, load the selected workflow entry, derive sparse references from existing upstream media, stop with the helper's slot-specific error only for missing `canvas` slots, and pass `mediaSlotModes` to `submitWorkflowTask`.
- [ ] Copy the same modes into generated result-node metadata so retry uses the original binding.
- [ ] Run `cd web; bun test src/lib/workflow-media-slots.test.ts` and commit: `feat: control optional media slots on canvas`.

## Task 7: Configure the H3 workflow and document manual verification

**Files:**

- Modify: `web/src/components/workflow/workflow-field-mapping-editor.tsx`
- Modify: `docs/progress/pending-test.md`

- [ ] Show the optional-media toggle/default-mode selector only when inspect returned a safe plan; show the read-only remove/detach summary and keep unsafe fields non-optional.
- [ ] Use the existing field save/merge path so re-inspection refreshes plans while preserving user mode choices for unchanged field identities.
- [ ] Re-inspect `【MINIMAX-H3】八月最强文戏-高配版.json`, mark its six image and three audio fields optional with default `off`, and set both exposed `task_type` fields to `auto`.
- [ ] Record the exact desktop verification matrix in `docs/progress/pending-test.md`: all-off queues without `217::image`, one later image with earlier slots off keeps its index, partial image/audio, all-enabled, retry after reload, stale-plan rejection, and one legacy workflow regression.
- [ ] Run the targeted suite: `go test ./service ./canvas-agent/native/comfy-bridge`; then `cd web; bun test src/lib/workflow-channel.test.ts src/lib/workflow-media-slots.test.ts`.
- [ ] Do not run the full desktop build unless requested; commit: `docs: add optional media slot verification matrix`.

## Final Review

- [ ] Compare the diff against the approved spec and remove any abstraction, state store, endpoint, dependency, or unrelated refactor not required by the acceptance criteria.
- [ ] Confirm every optional slot has a Bridge-issued plan and every `off` request fails closed if that plan no longer matches the graph.
- [ ] Confirm legacy ComfyUI and all RunningHub code paths are byte-for-byte behavior compatible at the request boundary.
- [ ] Use `superpowers:requesting-code-review` for one final review, then `superpowers:verification-before-completion` before claiming the implementation works.
