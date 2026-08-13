---
name: ui-ux-designer
description: Design or implement polished, intentional product UI and UX from requirements, screenshots, or an existing application. Use for new screens, dashboard refinement, component systems, visual audits, and any request that must avoid generic AI-generated styling.
---

# UI/UX Designer

Create product interfaces with a deliberate visual point of view. Do not output interchangeable "AI dashboard" work.

## Non-negotiable visual authority

Every task receives three dashboard references. Inspect them before designing and treat them as the required quality benchmark, especially for controls. Adapt their professional shell, white canvas, purposeful accent, black-led type, calm cards, controlled radius, precise alignment, balanced grids, simple charts, and subtle shadows. Never copy their branding or data unless asked.

## Start with evidence

1. Inspect the target screen, existing tokens and components, and references. Inventory every component and state the screen needs; reuse suitable components instead of duplicating them.
2. Establish the shared theme tokens: semantic colors, type, spacing, control heights, radius, borders, surfaces, and elevation.
3. Before composing any page or feature layout, build or extend the complete reusable component set required by the scope: Button, Input, Search, Select, Textarea, navigation, cards, metrics, status, toolbar controls, charts, and feedback states as applicable. Do not start assembling the screen while these foundations are still being improvised.
4. Review the components together in their important variants and states. Correct their shared proportions and visual language once, at the component source.
5. Only then compose the requested screen from those verified components. Do not recreate their styling inside the page. Keep one focused system and the requested scope.

## Design direction

Make one coherent direction, not a grab bag of trends.

- Give the interface a clear hierarchy: one primary action, one page focal point, then grouped supporting information.
- Always use pure white for the page and `body` background. Do not use gray, off-white, tinted, or neutral body backgrounds unless the user explicitly asks for one. Existing references with gray canvases do not override this rule. Reserve a small accent palette for meaning, state, and primary action; do not color every card or metric.
- Use a consistent spacing scale and aligned edges.
- Use typography to distinguish page title, section title, data, labels, and helper text. Do not rely on tiny gray text for essential information.
- Use radius, borders, and shadows with restraint. Separate surfaces by one deliberate mechanism.
- Make data visualizations legible without hover-only meaning; use color as reinforcement, not the only signal.

## Buttons and inputs are the first visual priority

When the requested UI contains controls, design and verify them before cards, charts, or decoration. Inspect the attached references at full resolution and treat their buttons, search fields, compact selectors, and icon controls as direct component-level references—not merely dashboard inspiration.

- Establish control tokens first: height, horizontal padding, radius, border, type weight, icon size, gap, and focus ring. Apply them through reusable Button, Input, Search, Select, and Textarea components instead of one-off page CSS.
- Match the references' character: compact single-line controls, balanced padding, crisp text, a confident filled primary button, a fine outlined secondary button, white input surfaces, restrained borders, leading icons where useful, and clear selected states. Keep icon-only controls small and intentional. Do not fall back to generic library defaults, bulky gray fields, weak low-contrast placeholders, arbitrary pill shapes, or mismatched control heights.
- Preserve the product's brand color and component API, but restyle variants to this quality bar. Design hover, focus-visible, pressed, loading, disabled, invalid, and populated states.
- Compare a close crop of the rendered controls against the reference controls before accepting the screen. If the shell looks polished but its buttons or inputs look generic, the design is not finished.

## Reference pattern: refined editorial dashboard

Preserve these reference traits without copying their content:

- A clean white page canvas with restrained neutral surfaces inside a single rounded application shell. Use gray only within intentional components or boundaries, never as the page or `body` background unless the user asks for it.
- Near-black text, muted gray support text, and one warm or natural accent family; use one saturated color for the primary action or featured metric.
- Compact navigation, a strong page heading, and an asymmetric grid of calm cards.
- Controlled rounded cards, subtle borders, soft shadows, clean sans typography, compact labels, and prominent values.
- Simple legible charts plus realistic empty states, status, overflow, touch targets, and responsive stacking.

## Avoid AI slop

Do not default to any of the following unless the product explicitly requires them:

- purple-blue gradient hero panels, neon glows, frosted-glass cards, or excessive blur;
- a uniform grid of identical cards, every item with a colored icon circle, or a rainbow of semantic-less accent colors;
- oversized rounded pills, excessive badges, gratuitous decorative shapes, or arbitrary illustration placeholders;
- dense, center-aligned marketing copy for operational UI;
- invented design systems that ignore existing components, tokens, copy, or navigation patterns.

## Implement and review

1. After the reusable components are complete, use them to build the smallest complete flow: hierarchy, interaction, feedback states, and responsive layout.
2. Use semantic HTML and the project's component library. Preserve accessible names, focus states, contrast, and keyboard access.
3. Treat every interactive-looking element as a functional contract. Buttons must invoke a real action; links must navigate; searches and inputs must update state and submit or filter as their labels promise; menus, tabs, toggles, dialogs, pagination, and row actions must work with pointer and keyboard input. Trace each control from its rendered element through its handler to the resulting state, navigation, API call, or other observable effect. Never ship a decorative or placeholder control that looks enabled. If its behavior is outside the requested scope, omit it or render it explicitly disabled with an honest explanation.
4. Match component-library semantics to the element actually rendered. A button primitive configured as a native button must render a real `<button type="button">` (or the appropriate submit/reset type). When intentionally rendering a link or another non-button root through a polymorphic `render`/`asChild` API, use the library's documented non-native mode such as `nativeButton={false}` and preserve the correct role, accessible name, focus, and keyboard behavior. Resolve all library accessibility or semantics warnings; do not silence them without correcting the contract.
5. Exercise every affected interaction in the rendered UI and check the browser console after using it. Verify happy, loading, empty, error, disabled, and validation states that are relevant to the change. Treat console warnings from React, the component library, accessibility tooling, or invalid HTML as implementation defects.
6. Compare the rendered result directly with all three references. Correct alignment, density, color roles, type hierarchy, card geometry, and elevation before declaring it finished.
7. Reject and revise any result that reads as a generic AI-generated dashboard rather than a deliberate member of this reference family.
8. Report the theme decisions, reusable components created or reused, files changed, interactions exercised, console result, and any visual verification still needed.
