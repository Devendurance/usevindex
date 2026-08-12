---
version: alpha
name: Vindex
description: "The Protected Route expressed through the supplied light, grainy, fintech-cool visual direction."
colors:
  primary: "#111111"
  background: "#F7F3EC"
  meshBlue: "#3D6FE0"
  meshLavender: "#A98DE0"
  meshGold: "#F0C97C"
  threatRed: "#FF3B5C"
  routeCyan: "#34E5C7"
  textMuted: "#5C5A54"
  textFaint: "rgba(17,17,17,0.45)"
  surface: "#F7F3EC"
  white: "#FFFFFF"
  divider: "rgba(17,17,17,0.16)"
  border: "#111111"
typography:
  display1:
    fontFamily: "Inter Tight, General Sans, Inter, sans-serif"
    fontSize: "56px"
    fontWeight: 800
    lineHeight: "58px"
    letterSpacing: "-1.5px"
  display2:
    fontFamily: "Inter Tight, General Sans, Inter, sans-serif"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: "36px"
    letterSpacing: "-0.5px"
  heading3:
    fontFamily: "Inter, General Sans, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: "22px"
    letterSpacing: "0px"
  bodyLarge:
    fontFamily: "Inter, General Sans, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: "28px"
    letterSpacing: "0px"
  body:
    fontFamily: "Inter, General Sans, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "22px"
    letterSpacing: "0px"
  nav:
    fontFamily: "Inter, General Sans, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: "20px"
    letterSpacing: "0px"
  button:
    fontFamily: "Inter, General Sans, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
    letterSpacing: "0px"
  data:
    fontFamily: "Inter, General Sans, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "18px"
    letterSpacing: "0px"
rounded:
  tile: "6px"
  control: "1px"
  circle: "9999px"
spacing:
  base: "4px"
  xs: "8px"
  sm: "16px"
  md: "24px"
  lg: "32px"
  xl: "48px"
  hero: "64px–76px"
components:
  primary-cta:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "14px 32px"
    height: "48px"
  secondary-button:
    backgroundColor: "{colors.background}"
    textColor: "{colors.primary}"
    typography: "{typography.nav}"
    rounded: "{rounded.control}"
    padding: "10px 20px"
    height: "40px"
  feature-tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.tile}"
    size: "32px"
  receipt-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.control}"
    padding: "24px"
  status-label:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.data}"
    rounded: "{rounded.tile}"
    padding: "4px 8px"
---

## Overview

**Vindex** is an autonomous DeFi protection agent that detects converging threats and orchestrates a supported exit through KeeperHub to a user-configured safe wallet.

This version keeps the supplied visual direction as well as its formal design mechanics. The product category changes; the visual mood does not.

### Visual direction retained in full

- cream base with a soft, heavily blurred blue/lavender/gold mesh;
- visible but restrained grain;
- quiet, confident fintech-cool atmosphere;
- tight geometric grotesk display type;
- centred, symmetric hero composition;
- generous whitespace and calm vertical rhythm;
- no decorative line competing with the headline, supporting copy or CTA;
- thin `1–1.5px` black outlines on controls and feature tiles;
- red/cyan chromatic-aberration outline on the primary CTA only;
- small outlined square icon tiles;
- no conventional drop shadows;
- approachable, slightly Gen-Z-coded looseness around a serious financial product.

### What changes

The visual language remains deliberately close to the reference. The adaptation happens in the meaning carried by the words, states, icons and evidence:

- spending becomes supported DeFi position protection;
- budgeting features become threat monitoring and confirmation;
- the semantic Protected Route remains in explanatory product sections rather than decorating the hero;
- generic feature tiles become `WATCH`, `CONFIRM` and `VERIFY`;
- the CTA changes from generic onboarding to `RUN A DRY RUN`;
- the visual proof moment becomes the Vindex Rescue Receipt;
- the soft gradient is treated as atmosphere, not as a literal blockchain or security metaphor.

### Strategic trade-off

Keeping the original visual direction makes Vindex warmer, more approachable and less like a conventional security dashboard. That is useful for reducing intimidation around DeFi protection.

The cost is category ambiguity: a visitor may initially read the page as a personal-finance or spending product. The first headline, descriptor and feature row must therefore be unusually explicit.

### Core execution line

```text
WATCH → CONFIRM → EXIT → VERIFY
```

### Product rule

> Keep the visual world light and human, but make the product state and the destination of the funds impossible to misunderstand.

### Hero copy required to protect clarity

Recommended headline:

```text
Detect the threat.
Execute the escape.
```

Supporting copy:

```text
Vindex watches supported DeFi positions, confirms converging danger and routes a verified exit through KeeperHub.
```

Primary CTA:

```text
RUN A DRY RUN
```

Do not use a vague headline such as `Take control of your money` with this retained visual direction. The page needs to earn the visual softness with immediate category clarity.

> **Adaptation mode:** reference visual direction preserved; Vindex meaning carried by category language, state labels, route logic and Rescue Receipt evidence.

## Colors

### Primary and base

- **Ink `#111111`** — text, outlines, route strokes and primary CTA fill.
- **Cream Base `#F7F3EC`** — page field and primary surface.
- **Muted Gray `#5C5A54`** — body copy, captions and secondary explanations.
- **Faint Ink `rgba(17,17,17,0.45)`** — placeholders and low-priority metadata.
- **White `#FFFFFF`** — primary CTA text and small proof labels on Ink.

### Signal-field mesh

The reference mesh remains, but its meaning changes from lifestyle-finance atmosphere to a restrained monitoring field.

- **Signal Blue `#3D6FE0`** — ordinary monitoring and the visible onchain field.
- **Confirmation Lavender `#A98DE0`** — signals being cross-validated.
- **Safe-Route Gold `#F0C97C`** — evacuation path and verified destination warmth.

Keep all three heavily blurred, low-opacity and grain-softened. They must never become crisp blobs or neon crypto gradients.

### Action and state accents

- **Threat Red `#FF3B5C`** — the threat edge of the primary CTA and confirmed evacuation emphasis.
- **Route Cyan `#34E5C7`** — the execution edge of the primary CTA and protected-route emphasis.

The red/cyan pairing remains exclusive to the primary CTA’s chromatic-aberration frame in ordinary navigation. In product states, use the colours sparingly and always pair them with written labels. Never make colour the only indication of danger or safety.

### Semantic discipline

- `WATCHING` is mostly Ink and muted text.
- `CONFIRMING` may use Lavender as a low-opacity field, never as a glowing alert.
- `EVACUATING` may use the Red/Cyan route pairing only where action is genuinely active.
- `PROTECTED` uses plain language, a receipt and a verified destination; do not rely on green success conventions.
- `BLOCKED` uses direct error copy and an outlined state, not a saturated red screen.

## Typography

The reference font system remains unchanged.

### Inter Tight

Reserve **Inter Tight** for Display 1 and Display 2. Its dense, tight geometry gives the product urgency without requiring a dark security-dashboard aesthetic.

Use it for:

- hero headline;
- large threat state;
- large rescued amount;
- major section headings.

The shared `hero-display` treatment is reserved for the marketing headline: Inter Tight, exactly two intentional lines, approximately `38px–76px` across responsive widths, `800` weight, tight negative tracking and a `0.96` line-height. Keep section headings one step below this scale.

### Inter

Use **Inter** for:

- navigation;
- body copy;
- feature titles;
- buttons;
- labels;
- status descriptions;
- addresses, amounts and execution metadata.

### Type rules

- Keep display tracking tight-to-negative.
- Keep body and navigation tracking neutral.
- Use sentence case for navigation and action labels.
- Use uppercase only for state labels, short metadata and receipt headings.
- Never set an important destination address or failure explanation in faint text.
- Numbers and transaction identifiers must remain legible before they become stylistic.

## Layout

### Page frame

- Maximum content width: `1140px`.
- Centered container with generous side margins.
- Cream base visible around the content.
- Use the blurred mesh as a low-contrast field, not as a panel background.
- Base spacing unit: `4px`.
- Hero top padding: approximately `64px–76px` on desktop.

### Navigation

- Logo mark on the left;
- centred or balanced text links;
- secondary `Sign in` or `View demo` control on the right;
- transparent background directly over the cream/mesh field;
- compact `14px–15px` Inter, sentence case;
- hover changes opacity to `0.6` without underline animation.
- every clickable Vindex logo links to the landing page at `/`, including from product routes.

Replace the source star/asterisk mark with the Vindex symbol when available. The symbol should suggest a protected route or guarded exit—not a generic sparkle, shield or crypto node.

### Hero

Use a centred single-column hero:

1. headline;
2. short explanatory copy;
3. primary dry-run/protection CTA;
4. three-state feature row;
5. scroll indicator.

Do not place a decorative line, underline or route SVG in the hero. The reduced composition is intentional: the headline must remain exactly two visual lines on tablet and desktop, and the proof row must fit within the first viewport at the supported desktop and tablet sizes.

Recommended hero headline:

```text
Detect the threat.
Execute the escape.
```

Supporting copy:

```text
Vindex watches supported DeFi positions, confirms converging danger and routes a verified exit through KeeperHub.
```

Primary CTA:

```text
RUN A DRY RUN
```

Secondary CTA:

```text
SEE THE PROTECTED ROUTE
```

### Feature row

Retain the reference’s three-column equal-width strip, but make it the product state model:

```text
01. WATCH
Independent signals monitor the position.

02. CONFIRM
No exit on one noisy alert.

03. VERIFY
KeeperHub execution and safe-wallet proof.
```

The row should not become three generic feature cards. It is one sequence divided by spacing and alignment.

## Elevation & Depth

- No conventional drop shadows.
- No glassmorphism.
- No floating dark DeFi panels.
- No 3D coins, shield renders or glowing blockchain surfaces.
- Depth comes from the blurred mesh field, thin outlines, whitespace and the one CTA glitch frame.
- Feature tiles remain flat and outlined.
- The Rescue Receipt may use a faint doubled outline, but never a heavy shadow.

The product should feel approachable because the visual language is warm and the hierarchy is clear—not because DeFi risk information has been softened or hidden.

## Shapes

- Feature icon tiles: `6px` radius.
- Buttons and inputs: sharp `1px` radius.
- Scroll/route indicator: circular `50%` radius.
- No additional radius values.
- No pills.
- No large soft cards.
- No thick black borders.
- No circular token or coin motifs.

## Components

### Primary CTA with glitch frame

The primary CTA keeps the reference’s signature construction, but its action changes from generic onboarding to a product-specific proof action.

Recommended labels:

- `RUN A DRY RUN`;
- `PROTECT A POSITION`;
- `VIEW THE EXIT PATH`.

Rules:

- Ink fill `#111111`;
- white label;
- `14px 32px` padding;
- `48px` height;
- sharp `1px` radius;
- `1.5px` Ink border;
- red offset edge on top/left;
- cyan offset edge on bottom/right;
- hover increases the offset by approximately `1px`;
- active collapses to a clean Ink border;
- no other CTA receives this frame.

The glitch frame now has product meaning: Red is the detected threat; Cyan is the route out. The two edges meet only around the action that begins verification or protection.

### Secondary button

Use for:

- `SEE HOW IT WORKS`;
- `VIEW THE AUDIT TRAIL`;
- `OPEN THE DEMO`.

Preserve:

- Cream background;
- Ink text;
- `1.5px` Ink border;
- sharp `1px` radius;
- faint layered outline offset top-left and bottom-right;
- hover inversion to Ink fill and white text.

### Protected Route diagram

The hand-drawn route is a semantic product diagram reserved for explanatory sections below the hero. It travels through three labelled waypoints:

```text
WATCH → CONFIRM → SAFE WALLET
```

Rules:

- no route diagram in the hero;
- use the route only where the surrounding content explains the supported exit;
- use SVG, not CSS text decoration;
- keep it hand-drawn but controlled;
- no network-node clusters;
- no random looping decoration;
- its endpoint must visually terminate at the safe-wallet destination or receipt.

The route should read as a single escape path, not a generic analytics trend line.

### Signal feature tile

- transparent background;
- `1.5px` Ink border;
- `6px` radius;
- `32px × 32px` size;
- simple outlined glyph;
- use symbols for `WATCH`, `CONFIRM` and `VERIFY` only;
- no filled shields, flames, locks or coins.

### Rescue Receipt

The principal product-specific asset is a structured receipt, not an illustration:

```text
VINDEX RESCUE / 00041

POSITION    AAVE V3 ETH POOL
TRIGGER     ORACLE DEVIATION + TVL DROP
THREAT      CONFIRMED
ACTION      WITHDRAW → SWAP → TRANSFER
RESULT      19,812 USDC VERIFIED
DESTINATION 0x123…789
EXECUTION   KEEPERHUB / KH-8A12
TX HASH     0xabc…def
AUDIT       VIEW FULL RECORD
```

Use the receipt in:

- result/proof state;
- audit history;
- demo slide;
- share card;
- post-evacuation notification.

Do not show a receipt until the relevant result exists. A simulated receipt must say `SIMULATION ONLY`.

### Status card

A status card should expose the route rather than merely show a coloured badge:

```text
THREAT LEVEL / ORANGE
SIGNALS      / 3 CONVERGING
NEXT STEP    / CONFIRMING EXIT
FUNDS MOVED  / NO
```

For an active evacuation:

```text
EVACUATION ACTIVE
KEEPERHUB EXECUTION / KH-8A12
SAFE WALLET CHECK    / PENDING
```

### Navigation and iconography

- Keep square outlined icon tiles.
- Replace spending charts with signal, route and receipt glyphs.
- Use no generic star/asterisk as the primary product mark.
- Use arrows only when they describe an actual direction in the route.

## Interaction & Motion

- Mesh remains static or changes extremely slowly; no moving blobs.
- A semantic route diagram may draw once when its explanatory section enters view, then remain still.
- Primary CTA glitch offset increases by approximately `1px` on hover.
- Threat-state changes should use a short opacity or border transition, not a dramatic alarm animation.
- Rescue Receipt rows may reveal in execution order, but the full status must remain accessible.
- No confetti, token bursts, flashing red screens, sirens or panic animations.
- Respect `prefers-reduced-motion` by removing route drawing and all staged reveals.

## Responsive Behaviour

### Mobile: `375px–599px`

- Navigation collapses to a hamburger.
- Logo and primary CTA remain visible.
- The hero display remains between `38px–42px`.
- Body Large reduces to `16px`.
- Feature row stacks vertically.
- Icon tiles remain left-aligned beside their text.
- The hero remains free of route-line decoration.
- The scroll indicator is hidden.

### Tablet: `600px–1023px`

- Display 1 approximately `44px`.
- Feature row becomes a 2+1 arrangement or a readable horizontal sequence.
- Semantic route labels remain visible in explanatory sections.

### Desktop: `1024px+`

- Full 3-column feature row.
- Hero display scales up to `76px` while retaining exactly two lines.
- Maximum content width `1140px`.
- Full route and receipt composition.

### Touch targets

- Minimum `44px × 44px`.
- Recommended `48px × 48px`.
- At least `8px` between controls.

Text buttons use the same minimum touch target and a restrained underline/opacity treatment. Icon-only controls keep their square outlined treatment and must retain an accessible label.

## Accessibility

- Do not encode threat level or protection status with colour alone.
- Pair every status with a text label.
- Keep body copy readable against the cream field.
- Ensure the red/cyan CTA remains legible for colour-blind users because its label and border silhouette carry the meaning.
- Provide keyboard-visible focus states.
- Make safe-wallet addresses, execution IDs and transaction hashes selectable and copyable.
- State clearly whether funds moved.
- Explain the next safe action after a blocked or failed evacuation.
- Respect reduced motion.

## Do's and Don'ts

### Do

- Keep the cream, outlined, lightly playful substrate from the reference without apologising for its warmth.
- Make the route from signal to safe wallet the central idea.
- Use the hand-drawn squiggle once as the Protected Route.
- Keep the glitch frame exclusive to the highest-value action.
- Use the Rescue Receipt as evidence, not decoration.
- Show threat, confirmation, execution and verification in plain language.
- Preserve the centered, symmetric composition.
- Keep the mesh soft, grainy and semantically quiet.

### Don't

- Turn Vindex into a generic personal-finance landing page.
- Use spending charts, bank cards or budgeting metaphors.
- Add a shield, lock, robot, coin pile or generic blockchain network as the main visual.
- Use the mesh as a neon DeFi gradient.
- Apply the red/cyan glitch to every button.
- Add drop shadows to restore depth.
- Show an evacuation as complete before safe-wallet verification.
- Use “guaranteed safety,” “hack-proof” or “risk-free.”
- Hide the supported protocol or exit limitations.
- Add multiple illustrations when one route and one receipt communicate the product better.

## Agent Prompt Guide

When generating or implementing Vindex screens, preserve the formal substrate and replace the meaning:

1. Use `#F7F3EC` as the page background.
2. Use Inter Tight only for display headings and Inter for UI/body.
3. Keep the soft Blue/Lavender/Gold mesh, but treat it as a low-opacity signal field.
4. Keep the hero free of decorative lines; use the hand-drawn Protected Route only as a semantic diagram in explanatory sections.
5. Keep thin `1–1.5px` Ink borders and no conventional shadows.
6. Keep the Red/Cyan chromatic frame exclusive to the primary CTA.
7. Replace spending icons with signal, confirmation, route and receipt glyphs.
8. Use the Rescue Receipt for proof states.
9. Keep hero content centred and symmetric.
10. Never make an unverified evacuation look complete.
