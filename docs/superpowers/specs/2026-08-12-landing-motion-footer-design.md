# Landing Motion and Footer Design

## Goal

Improve the landing-page experience with persistent navigation, restrained scroll motion, and a Vindex-specific footer based on the supplied structural reference.

## Navigation

The shared navigation remains visually compact but becomes fixed at the top of the viewport. It uses an opaque cream surface and a thin divider so hero imagery and route content never reduce link legibility. Page shells reserve the navigation height, and anchor destinations use matching scroll padding so headings are not hidden.

## Smooth Scrolling

Use the installed `lenis` package through one client component mounted by the shared shell layer. Lenis uses automatic RAF, anchor support with the fixed-navigation offset, and its built-in reduced-motion behavior. It must be destroyed on unmount and must not add a second scroll loop.

## Reveal Motion

Landing sections and the landing footer receive a shared reveal hook. One `IntersectionObserver` marks each element visible once at a modest threshold. CSS animates only opacity and vertical transform for approximately 600ms. The hero is immediately visible. With `prefers-reduced-motion: reduce`, reveal content is immediately visible and has no transform or transition.

## Footer

The footer appears only on `/`. It borrows the reference's spacious multi-column structure without copying newsletter or agency content:

- product statement and status-oriented copy;
- navigation links for How it works, For treasuries, View demo, and Audit trail;
- external links to GitHub and X with external-link icons and safe new-tab attributes;
- large VINDEX wordmark as the final visual anchor;
- black bottom rail with `© 2026 Vindex. All rights reserved.`.

The surface stays cream with sharp geometry, thin dividers, no nested cards, and responsive stacking below tablet widths.

## Accessibility and Performance

- Preserve the skip link, visible focus, semantic navigation landmarks, and 44px targets.
- External links have meaningful accessible names and decorative icons are hidden.
- Fixed navigation must not cover focused or anchor-linked content.
- Reveal animation uses IntersectionObserver rather than scroll handlers.
- No animated blur, layout properties, or continuous scroll-position polling.
- Reduced-motion preference disables non-essential reveal and scroll smoothing.

## Verification

Test fixed positioning, landing-only footer presence, exact external destinations, copyright copy, reveal activation, reduced-motion visibility, anchor scrolling, keyboard navigation, overflow, console health, and responsive layouts at desktop, tablet, and mobile sizes.
