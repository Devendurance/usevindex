# Landing Motion and Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fixed navigation, Lenis smooth scrolling, one-time landing reveals, and a landing-only Vindex footer.

**Architecture:** A client-side landing experience component owns Lenis and IntersectionObserver lifecycle. Existing shared navigation receives fixed positioning and shell offsets. The landing page owns the reference-inspired footer markup, while global CSS supplies responsive structure and reduced-motion overrides.

**Tech Stack:** Next.js 16 App Router, React 19, Lenis 1.3.26, CSS, Playwright.

## Global Constraints

- Preserve current Vindex copy, routes, hero treatment, buttons, and product behavior.
- Footer appears only on the landing page.
- GitHub: `https://github.com/Devendurance/usevindex`.
- X: `https://x.com/devendyyy`.
- Copyright: `© 2026 Vindex. All rights reserved.`.
- Use only opacity and transform for reveal motion.
- Respect `prefers-reduced-motion`.

---

### Task 1: Acceptance Tests

**Files:**
- Modify: `tests/e2e/vindex.spec.ts`

- [ ] Add tests for fixed navigation position and unobscured content.
- [ ] Add tests for landing-only footer structure and exact links.
- [ ] Add tests for reveal activation and reduced-motion visibility.
- [ ] Run focused Playwright tests and confirm RED for missing behavior.

### Task 2: Scroll and Reveal Runtime

**Files:**
- Create: `components/shell/landing-experience.tsx`
- Modify: `components/shell/marketing-shell.tsx`
- Modify: `app/globals.css`

- [ ] Mount one Lenis instance with `autoRaf`, anchors, navigation inertia stop, and reduced-motion support.
- [ ] Observe `[data-reveal]` elements once and set their visible state.
- [ ] Add transform/opacity reveal CSS and reduced-motion overrides.
- [ ] Make navigation fixed and reserve its height in page shells.

### Task 3: Landing Footer

**Files:**
- Modify: `app/(marketing)/page.tsx`
- Modify: `app/globals.css`
- Modify: `DESIGN.md`

- [ ] Replace the compact footer with the approved multi-column Vindex structure.
- [ ] Add navigation, GitHub, X, large brand, and black copyright rail.
- [ ] Apply `data-reveal` to lower landing sections and footer.
- [ ] Add responsive layout and authoritative design-system guidance.

### Task 4: Verification

**Files:**
- Verify: all modified files

- [ ] Run focused Playwright tests to GREEN.
- [ ] Review desktop, tablet, and mobile screenshots and browser console.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm run build`, and `npx playwright test`.
