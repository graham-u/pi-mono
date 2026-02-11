# Upstream Package Modifications

Changes we have made to upstream pi-mono framework packages. These packages
may receive updates from upstream, so our modifications need to be tracked
and re-applied after merges.

All changes are in `packages/web-ui/`.

---

## 1. Case-insensitive model search

**Commit:** `3f962a98` — Fix case-sensitive model search (breaks on mobile auto-capitalization)

**File:** `src/dialogs/ModelSelector.ts`

**Problem:** The model search dialog lowercased the search target but not the
user's input. On mobile keyboards (which auto-capitalise the first letter),
typing "Claude" matched nothing because "Claude" !== "claude".

**Change:** Added `.toLowerCase()` to each search token before comparison
(one-line fix).

---

## 2. Collapsible tool output

**Commit:** `f127c345` — Collapse tool output by default in chat UI

**Files:**
- `src/tools/types.ts` — added optional `toolName` parameter to `render()`
- `src/tools/index.ts` — pass `toolName` through to renderers
- `src/tools/renderers/DefaultRenderer.ts` — wrap completed/in-progress output
  in `renderCollapsibleHeader` (collapsed by default); show tool name in header
- `src/tools/renderers/BashRenderer.ts` — wrap completed output in
  `renderCollapsibleHeader` (collapsed by default); show truncated command in
  header; leave in-progress output expanded so the user can see what's running

**Rationale:** Tool results produce a lot of visual noise in the chat. Collapsing
them by default keeps the conversation readable while still allowing expansion
on demand. Uses the existing `renderCollapsibleHeader` utility already present
in the codebase.

---

## 3. Public `focusInput()` and `getInput()` APIs

**Commit:** `0a16dacd` — Focus prompt input on session switch and preserve draft text

**Files:**
- `src/components/AgentInterface.ts` — added `focusInput()` and `getInput()`
  public methods
- `src/components/MessageEditor.ts` — extracted `focusInput()` as a public
  method (refactored out of `firstUpdated()`)

**Rationale:** The assistant frontend needs to programmatically focus the
textarea and read its current value (for draft preservation across session
switches). Rather than traversing shadow DOM from outside — which is fragile —
these methods provide a clean public API on the existing components.
