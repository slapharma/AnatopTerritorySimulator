# Design System: Launch Working Group

Generated with ui-ux-pro-max (query: pharma healthcare SaaS dashboard meeting record) and then adjusted. The generator proposed Neumorphism and a horizontal-scroll landing pattern; both were rejected because this is a dense, text-heavy meeting record with accessibility needs (badges must be readable, contrast 4.5:1). Kept: the calm cyan / health-green palette direction. Typography is fixed by the brief: Montserrat throughout.

## Pattern
Three-column workspace: saved sessions (left, 268px), transcript (centre, fluid), evidence panel with Sources / Disagreements / Cost tabs (right, 340px). Setup form is a single centred column, two fields per row.

## Style
Flat, light, low-chrome. Cards with 1px borders and a 4px left rule in the speaker colour. No gradients, no neumorphic shadows, no emoji icons (one SVG in the brand mark; search chips use a text glyph only).

## Colours
| Role | Hex |
|---|---|
| Background | #F8FAFC |
| Surface | #FFFFFF |
| Text | #0F172A |
| Muted text | #64748B (minimum #475569 for body) |
| Primary (actions, citations) | #0891B2, hover #0E7490 |
| Accent (decision output) | #059669 |
| Regulatory | #1D4ED8 |
| Clinical | #0F766E |
| Commercial | #6D28D9 |
| Moderator assistant | #334155 |
| Moderator (human) | #B45309 on #FFFBEB |
| VERIFIED badge | #166534 on #DCFCE7 |
| ESTIMATE badge | #92400E on #FEF3C7 |
| UNKNOWN badge | #374151 on #E5E7EB |
| Disagreement block | #FFF7ED with #FED7AA border |
| Questions block | #ECFEFF with #A5F3FC border |

The same hex values are used in the Word and PDF exports.

## Typography
Montserrat (self-hosted TTF in `fonts/`): 400 body, 600 labels/buttons, 700 headings. Body 13.5–14px, line-height 1.55–1.6. Code in Consolas.

## Interaction
- Buttons ≥ 32px tall, focus ring 2px primary, disabled at 50% while a turn runs.
- Transitions 150ms colour/border only; no transform hover.
- Streaming text repaints at most every 250ms; the transcript stays pinned to the bottom only if the user is already there.
- `prefers-reduced-motion` disables the spinner animation and smooth scroll.

## Anti-patterns avoided
Neon colours, AI purple/pink gradients, motion-heavy reveals, emoji-as-icon, transparent glass cards on a light ground.
