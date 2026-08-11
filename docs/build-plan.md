# Vindex — 48-Hour Build Plan

This build plan is optimized for a 48-hour hackathon sprint utilizing concurrent coding subagents to maximize velocity while maintaining strict code quality gates. It aligns with the `vindex-product-idea.md` and `vindex-brand-strategy.md` documents.

## Parallel Execution Strategy

We will deploy a team of autonomous subagents to work in parallel on non-overlapping domains to prevent file/state conflicts.

- **Subagent A (Backend & Data):** Database schema, Drizzle ORM setup, API routes, data validation, state persistence.
- **Subagent B (Integration & Execution):** KeeperHub MCP Execution Service, smart contract adapters, transaction simulation, on-chain execution logic, verification.
- **Subagent C (Frontend & Design):** UI Components, Visual Design System (per `DESIGN.md`), page layouts, responsive states, client-side interactions.
- **Subagent D (Threat Engine):** Threat Simulation Engine, multi-signal consensus logic, deterministic threat fixtures.

*Main Agent:* Acts as the coordinator to delegate tasks, review pull requests/commits, resolve integration conflicts, and enforce quality gates.

---

## Code Quality & Verification Gates

Before completing any phase, the following verification gates MUST be passed. Subagents must provide evidence of passing these checks.

- [ ] **Linting:** `npm run lint` (0 errors)
- [ ] **Build:** `npm run build` (Successful Next.js production build)
- [ ] **Types:** TypeScript compiler checks (0 errors)
- [ ] **Database:** Database migration steps applied (`drizzle-kit generate` & `drizzle-kit migrate`)
- [ ] **Execution:** Dry-run transaction verification (simulated exit succeeds on KeeperHub)

---

## The 48-Hour Sprint: 6 Phases (8 Hours Each)

### Phase 1: Foundation & Setup (Hours 0-8)
**Goal:** Initialize the project, set up the database, and establish the visual design tokens.

- [ ] **Subagent A:** Initialize Drizzle ORM. Define initial schema (Users, Positions, ThreatLogs, Executions). Run `drizzle-kit generate` and `migrate`.
- [ ] **Subagent B:** Initialize KeeperHub SDK/MCP server connection. Verify basic authentication and connection with KeeperHub.
- [ ] **Subagent C:** Set up Tailwind CSS/PostCSS (via Next.js 16). Implement the design tokens from `DESIGN.md` (Colors: `#F7F3EC`, `#111111`, etc.; Typography: Inter Tight & Inter).
- [ ] **Subagent D:** Scaffold the Threat Simulation Engine directory structure. Define TypeScript interfaces for Threat Signals and Protocol Adapters.
- [ ] **Gate:** Run `npm run lint` & `npm run build`.

### Phase 2: Core Engine & DB (Hours 8-16)
**Goal:** Build out the data layer and threat detection algorithms.

- [ ] **Subagent A:** Build core API routes for saving user configuration (Safe Wallet, Threat Threshold, Positions). 
- [ ] **Subagent B:** Draft the KeeperHub transaction payload structure (Withdraw -> Swap -> Transfer).
- [ ] **Subagent C:** Build base UI components: Primary CTA (with Red/Cyan glitch frame), Secondary Button, Signal feature tile, Status label.
- [ ] **Subagent D:** Implement multi-signal consensus logic (Signal Ingestion -> Processing -> Consensus Engine). Build a deterministic threat fixture (e.g., Oracle deviation + TVL drop).
- [ ] **Gate:** Database migrations applied. Type checks passed.

### Phase 3: KeeperHub Integration (Hours 16-24)
**Goal:** Connect the threat engine to KeeperHub for simulated execution.

- [ ] **Subagent A:** Create API endpoints to log threat states, consensus decisions, and execution receipts to the database.
- [ ] **Subagent B:** Implement the Pre-execution Validator and Execution Orchestrator. Send a dry-run payload to KeeperHub.
- [ ] **Subagent C:** Build the "Protected Route" squiggle SVG component and the Rescue Receipt component structure.
- [ ] **Subagent D:** Connect the Threat Simulation Engine to the KeeperHub execution service. Trigger the execution layer when the threat state reaches `RED`.
- [ ] **Gate:** Dry-run transaction verification succeeds via KeeperHub.

### Phase 4: UI/UX & Design System (Hours 24-32)
**Goal:** Assemble the frontend application and wire it to the backend.

- [ ] **Subagent A:** Finalize any missing API routes for dashboard data and audit trails.
- [ ] **Subagent B:** Build the Post-execution Verification logic (polling/webhook for KeeperHub transaction status & Safe Wallet balance check).
- [ ] **Subagent C:** Assemble the main Landing Page / Hero section and the Dashboard view. Wire up the product states (`WATCHING`, `CONFIRMING`, `EVACUATING`, `PROTECTED`).
- [ ] **Subagent D:** Ensure the Threat Engine can emit real-time state updates to the frontend (via WebSockets or polling API).
- [ ] **Gate:** `npm run lint` & `npm run build`. Visual QA against `DESIGN.md` rules (no drop shadows, correct typography, appropriate mesh usage).

### Phase 5: End-to-End Simulation & Verification (Hours 32-40)
**Goal:** Test the complete vertical slice from threat detection to safe-wallet verification.

- [ ] **Subagent A:** Verify database state transitions during the simulation lifecycle.
- [ ] **Subagent B:** Run end-to-end simulated rescue via KeeperHub. Verify safe wallet balance updates.
- [ ] **Subagent C:** Test the UI flow: User Setup -> Dry Run CTA -> Evacuation Progress -> Rescue Receipt rendered with real simulation data.
- [ ] **Subagent D:** Introduce edge cases in the threat fixture (false positives) to verify the Consensus Engine correctly rejects them.
- [ ] **Gate:** Full E2E dry-run transaction verification succeeds without manual intervention.

### Phase 6: Polish, Demo Video & Submission (Hours 40-48)
**Goal:** Finalize the codebase, prepare the demo, and submit the hackathon project.

- [ ] **Subagent A:** Clean up database seed scripts for judges to easily test the app.
- [ ] **Subagent B:** Document the KeeperHub execution paths, fallback logic, and API interactions in the `README.md`.
- [ ] **Subagent C:** Polish UI interactions, ensure responsiveness (mobile to desktop), verify accessibility (color contrast, a11y labels).
- [ ] **Subagent D:** Finalize the deterministic threat fixture to guarantee a perfect run for the demo recording.
- [ ] **Gate:** Final `npm run lint`, `npm run build`, and Type Checks.
- [ ] **Coordinator:** Record demo video. Prepare GitHub repository (open source core). Finalize Hackathon submission.
