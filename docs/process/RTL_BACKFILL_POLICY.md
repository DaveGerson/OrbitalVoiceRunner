# React Testing Library (RTL) Component Backfill Policy

This document defines the policy, standards, and limits for component-level RTL testing in the Vitest jsdom lane (`vitest.config.ts`).

## 1. Per-PR Policy

Any pull request (PR) that creates or modifies a voice-facing render component — including `KitchenRadio`, `CaptionBar`, status/gate chips, or related voice control components — **must add or extend a corresponding RTL component test** (`*.test.tsx`) in `src/`.

### Requirements
- Tests must execute in the Vitest jsdom lane (`npx vitest run <path-to-test>`).
- Tests must be characterization tests: assert actual visible text, DOM attributes, aria roles/live regions, and canonical callback dispatches.
- Empty/idle affordances as well as populated states must be explicitly tested.
- Smoke-only ("renders without crashing") assertions are prohibited as the sole check for populated states.

## 2. Reference Idiom

The standard testing pattern and reference idiom for RTL component tests in this codebase is established in:
- **`src/orbital/FleetExchangeView.test.tsx`** (Primary reference file)
- **`src/orbital/KitchenRadio.test.tsx`**
- **`src/orbital/CaptionBar.test.tsx`**

### Standard Structure & Patterns
1. **Clean Teardown**: Explicit `afterEach(() => { cleanup(); });`.
2. **Props Builder Pattern**: Define a `baseProps(overrides = {})` helper function to construct clean default props with `vi.fn()` callbacks.
3. **User Interaction**: Use `@testing-library/user-event` (`userEvent.setup()`) for testing button clicks and keyboard navigation.
4. **Scoped Queries**: Use `within(container)` and `data-testid` attributes to target specific sub-regions without brittle selector coupling.

## 3. Known Limitations

Vitest runs under `jsdom`, which provides a mock DOM environment without full browser rendering engines or canvas support.

- **jsdom Limits**: Canvas elements, real terminal emulators (`xterm.js`), and low-level WebGL/AudioContext layout engines cannot be accurately rendered or asserted in jsdom.
- **Boundary Partitioning**: Components wrapping real-DOM classes like `xterm` stay guarded by Playwright end-to-end smoke tests in `e2e/`. RTL tests should test cleanly unit-renderable component surfaces and mock seam boundaries.

## 4. Effort Expectation

- **Sizing**: **S** (Small) effort expectation per component (~30–60 minutes).
- Backfilling or extending component tests should remain focused, testing the component's public props contract and UI states without refactoring underlying product code during test creation.
