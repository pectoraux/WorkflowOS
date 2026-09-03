# V2-017 Universal Product UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the default WorkflowOS human-facing experience around MAKE / DO / LEARN / SHARE / IMPROVE while preserving every frozen V2 authority and the existing developer workspace.

**Architecture:** This is a frontend composition layer over existing backend authorities. No new workflow semantics, execution authority, or evidence authority is introduced; the UI maps canonical backend facts into a compact human mental model and progressively discloses advanced technical detail.

**Tech Stack:** React 18, TypeScript, Vite, React Router, Tailwind CSS 4, Radix UI, Vitest, Testing Library, Playwright/browser E2E.

**Spec:** `docs/superpowers/specs/2026-09-03-workflowos-universal-ux-design.md`

## Global Constraints

- WorkflowIR remains the sole semantic source of workflow meaning.
- WorkflowVersion remains immutable.
- Run, Deployment, Node, Capability, authorization, placement, evidence, attestation and proof authorities are unchanged.
- Conversation is input, not the durable workflow format.
- Failed reads must remain distinct from successful empty results.
- Marketplace entitlement never becomes execution authority.
- Cryptographic authenticity never becomes automatic proof of physical side effects.
- Existing developer/engineering control surfaces remain accessible.
- No second workflow engine/protocol/evidence/verification authority.
- No platform-specific workflow semantics.

---

### Task 1: Establish the V2 human-facing application shell

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify/Create: `frontend/src/components/shell/AppShell.tsx`
- Create/Modify: `frontend/src/pages/HomePage.tsx`
- Create/Modify: `frontend/src/pages/WorkflowsPage.tsx`
- Create/Modify: `frontend/src/pages/ExplorePage.tsx`
- Create/Modify: `frontend/src/pages/ActivityPage.tsx`
- Test: `frontend/src/App.test.tsx`

- [ ] Write failing route/navigation tests for Home, Workflows, Explore, Activity, Create, and expert workspace access.
- [ ] Run the focused frontend test suite and confirm the new navigation contract fails.
- [ ] Implement the smallest shell/navigation change that preserves all existing protected routes.
- [ ] Add progressive-disclosure entry points for advanced/developer surfaces without exposing them as primary navigation.
- [ ] Run focused tests and verify the expected routes and labels.
- [ ] Run frontend typecheck and lint.
- [ ] Commit the shell increment.

### Task 2: Replace the project-first landing experience with workflow-first Home

**Files:**
- Modify/Create: `frontend/src/pages/HomePage.tsx`
- Create: `frontend/src/components/home/creation-entry.tsx`
- Create: `frontend/src/components/home/recent-workflows.tsx`
- Create: `frontend/src/components/home/attention-feed.tsx`
- Test: `frontend/src/pages/HomePage.test.tsx`

- [ ] Write tests for the creation entry and successful/empty/error read-state distinctions.
- [ ] Implement Home around “What do you want to get done?” and recent workflows/attention.
- [ ] Ensure failed reads render unavailable states instead of empty conclusions.
- [ ] Verify the page uses existing APIs only.
- [ ] Commit.

### Task 3: Build the workflow library

**Files:**
- Create/Modify: `frontend/src/pages/WorkflowsPage.tsx`
- Create: `frontend/src/components/workflows/workflow-card.tsx`
- Create: `frontend/src/components/workflows/workflow-filters.tsx`
- Test: `frontend/src/pages/WorkflowsPage.test.tsx`

- [ ] Write tests for My Workflows, Installed, Shared with me, Drafts, Archived, and attention filters.
- [ ] Implement human-readable workflow cards emphasizing purpose, state, last run, schedule, and environment.
- [ ] Keep internal IDs/digests secondary.
- [ ] Verify empty and error states are distinct.
- [ ] Commit.

### Task 4: Build the workflow detail experience

**Files:**
- Create/Modify: workflow detail page/component currently responsible for project/workflow content
- Create: `frontend/src/components/workflows/workflow-header.tsx`
- Create: `frontend/src/components/workflows/workflow-overview.tsx`
- Create: `frontend/src/components/workflows/workflow-activity.tsx`
- Create: `frontend/src/components/workflows/workflow-access.tsx`
- Test: corresponding workflow detail test file

- [ ] Write tests for Run, Teach Me, Edit, Schedule, status, what-it-does, when/where-it-runs, version, access/safety and recent activity.
- [ ] Implement the human-facing workflow detail hierarchy.
- [ ] Expose advanced inspection as an intentional secondary path.
- [ ] Verify version/pin facts are rendered from authoritative responses.
- [ ] Commit.

### Task 5: Build Tell / Show / Tell + Show creation UX

**Files:**
- Create: `frontend/src/pages/CreateWorkflowPage.tsx`
- Create: `frontend/src/components/create/tell-workflow.tsx`
- Create: `frontend/src/components/create/show-workflow.tsx`
- Create: `frontend/src/components/create/workflow-understanding-preview.tsx`
- Test: `frontend/src/pages/CreateWorkflowPage.test.tsx`

- [ ] Write tests for Tell, Show and hybrid entry states.
- [ ] Reuse existing authoring/backend contracts; do not create another workflow representation.
- [ ] Implement semantic preview before commitment.
- [ ] Add correction/change interaction before workflow creation.
- [ ] Verify no UI state is treated as durable workflow truth.
- [ ] Commit.

### Task 6: Build Run / approval / where-it-runs UX

**Files:**
- Create/Modify: workflow run components used by the detail page
- Create: `frontend/src/components/workflows/run-preview.tsx`
- Create: `frontend/src/components/workflows/run-location-picker.tsx`
- Create: `frontend/src/components/workflows/run-status.tsx`
- Test: focused run UX tests

- [ ] Write tests for consequential-action previews, location availability, explicit unavailable reasons, and authorization language.
- [ ] Implement Run preview and human-readable environment selection.
- [ ] Preserve authoritative Run command semantics; UI must not invent completion.
- [ ] Add Waiting for you / Paused / Needs attention / Couldn't complete states.
- [ ] Commit.

### Task 7: Build failure, recovery and human takeover UX

**Files:**
- Create: `frontend/src/components/workflows/failure-recovery.tsx`
- Create: `frontend/src/components/workflows/human-takeover.tsx`
- Test: focused recovery tests

- [ ] Write failure-state tests proving known/unknown/unavailable facts remain distinct.
- [ ] Implement Take over, Try again, Edit workflow and Stop actions.
- [ ] Preserve the existing Run identity/state authority during takeover/resume.
- [ ] Verify no failed operation is rendered as success.
- [ ] Commit.

### Task 8: Build scheduling and event presentation

**Files:**
- Create/Modify: scheduling UI components
- Create: `frontend/src/components/workflows/when-editor.tsx`
- Test: focused trigger/schedule tests

- [ ] Write tests for manual, scheduled, event-based and workflow-completion triggers.
- [ ] Implement plain-language “When” presentation.
- [ ] Preserve canonical event IDs and backend trigger semantics.
- [ ] Expose advanced deduplication/timezone/missed-window details only on demand.
- [ ] Commit.

### Task 9: Build Teach Me / reverse teaching experience

**Files:**
- Create/Modify: teaching pages/components
- Create: `frontend/src/components/teaching/lesson-header.tsx`
- Create: `frontend/src/components/teaching/practice-step.tsx`
- Create: `frontend/src/components/teaching/uncertainty-notice.tsx`
- Test: teaching and reverse-teaching component tests

- [ ] Write tests for version binding, progress/resume, learner confirmation, evidence separation and missing-information disclosure.
- [ ] Implement Teach Me beside Run.
- [ ] Make the distinction between workflow execution and human learning visible.
- [ ] Verify uncertain procedural details are disclosed, not invented.
- [ ] Commit.

### Task 10: Build Activity and “How do you know?” trust UX

**Files:**
- Modify/Create: `frontend/src/pages/ActivityPage.tsx`
- Create: `frontend/src/components/activity/activity-item.tsx`
- Create: `frontend/src/components/evidence/how-do-you-know.tsx`
- Create: `frontend/src/components/evidence/advanced-verification.tsx`
- Test: Activity/evidence tests

- [ ] Write tests for completed, failed, approval, update and device events.
- [ ] Implement concise evidence explanations before advanced verification.
- [ ] Ensure signatures/digests/attestations are never described as automatic side-effect proof.
- [ ] Preserve exact Run/attestation bindings from authoritative data.
- [ ] Commit.

### Task 11: Build versions, updates and optimization presentation

**Files:**
- Create/Modify: workflow version/update components
- Create: `frontend/src/components/workflows/update-available.tsx`
- Create: `frontend/src/components/workflows/optimization-proposals.tsx`
- Test: version/optimization tests

- [ ] Write tests for immutable installed version presentation and explicit adoption.
- [ ] Implement update comparison and adoption affordance.
- [ ] Implement optimization proposals as candidate versions with explicit trade-offs.
- [ ] Verify no silent activation/mutation occurs in UI.
- [ ] Commit.

### Task 12: Build sharing / marketplace / install presentation

**Files:**
- Modify/Create: `frontend/src/pages/ExplorePage.tsx`
- Create: `frontend/src/components/marketplace/workflow-listing.tsx`
- Create: `frontend/src/components/marketplace/install-flow.tsx`
- Create: `frontend/src/components/workflows/share-flow.tsx`
- Test: marketplace/share tests

- [ ] Write tests for entitlement vs installation vs execution presentation.
- [ ] Implement listing metadata, install flow, sharing and Make my own/fork flow.
- [ ] Preserve provenance and keep publisher secrets/data out of the customer-facing model.
- [ ] Verify purchase does not render as execution authorization.
- [ ] Commit.

### Task 13: Re-contextualize the existing developer workspace

**Files:**
- Modify: developer/workbench navigation components only where required for entry/context
- Test: existing developer workspace tests

- [ ] Write a regression proving existing developer routes remain reachable.
- [ ] Add an intentional Expert / Developer entry path.
- [ ] Remove implementation-centric language from default surfaces without deleting expert functionality.
- [ ] Verify no developer authority moves into the consumer shell.
- [ ] Commit.

### Task 14: Responsive/mobile polish

**Files:**
- Modify: shared shell and responsive components
- Create/Modify: mobile-specific workflow action surfaces where needed
- Test: responsive component tests and browser E2E

- [ ] Add tests for mobile navigation and primary action accessibility.
- [ ] Adapt information hierarchy to mobile rather than shrinking desktop layouts.
- [ ] Verify platform-semantic equivalence remains intact.
- [ ] Commit.

### Task 15: Full verification and dogfooding

**Files:**
- Modify/Create: browser E2E specs and dogfooding evidence

- [ ] Run frontend typecheck.
- [ ] Run frontend lint.
- [ ] Run full frontend unit/component suite.
- [ ] Run relevant browser E2E suites.
- [ ] Run architecture/static checks.
- [ ] Run a real browser journey: create → review → run → inspect outcome → recover/take over or complete → Teach Me → review version/update.
- [ ] Persist the dogfooding evidence with explicit limitations.
- [ ] Re-read V2-017 acceptance criteria line-by-line and record evidence for all 16 criteria.
- [ ] Verify the final diff contains only approved UX/product-layer surfaces.
- [ ] Commit final verification artifacts.

### Task 16: PR preparation and architect review

- [ ] Verify exact base SHA is the governance-approved main after V2-ACR-003/V2-017 activation.
- [ ] Open the implementation PR with requirement → implementation → test → dogfooding mapping.
- [ ] Do not merge until architect review is complete.
- [ ] Re-run exact-head CI and repository-first review before merge.
