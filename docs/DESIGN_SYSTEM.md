# PACT Design System

This document is the visual contract for the public site and private dApp. The interface uses one industrial-editorial language: near-black surfaces, the rust accent from the official mark, large concise headlines, readable body copy, and compact operational screens.

## Principles

1. One screen communicates one primary action.
2. Public pages explain and expose read-only records; wallet actions live in the dApp.
3. Labels, values, and statuses never run together on one line without spacing.
4. Public sections may use generous whitespace. Operational pages use a compact 18–28 px vertical rhythm.
5. A result belonging to one agent must never appear as a global platform status.
6. EN, RU, and ES strings ship together. One screen never mixes interface languages.

## Color tokens

| Role | Token | Value |
| --- | --- | --- |
| Page background | `--pact-bg` | `#080808` |
| Card surface | `--pact-surface` | `#0E0D0C` |
| Warm surface | `--pact-surface-warm` | `#171310` |
| Selected surface | `--pact-surface-soft` | `#251C18` |
| Primary text | `--pact-ink-strong` | `#F5F4F3` |
| Body text | `--pact-ink` | `#E4E3E3` |
| Secondary text | `--pact-muted` | `#A39D99` |
| Disabled text | `--pact-faint` | `#716B67` |
| Brand accent | `--pact-rust` | `#CB673F` |
| Deep accent | `--pact-rust-deep` | `#914425` |
| Highlight accent | `--pact-rust-hot` | `#E58A61` |
| Error | `--pact-danger` | `#B94F32` |

Raw color values belong in `frontend/src/design/tokens.css`. Components consume tokens only.

## Typography

- Display: Archivo Narrow 600–700. Use for page and card headings only.
- Body: IBM Plex Sans 400–600. Use for paragraphs, descriptions, forms, and explanations.
- Technical: IBM Plex Mono 400–500. Use for addresses, labels, buttons, statuses, and identifiers.
- Body copy is at least 16 px. Technical labels are at least 10 px.
- A heading should not exceed three lines. Body measure is limited to 62 characters.

## Spacing

The spacing scale is `4, 8, 12, 16, 24, 32, 48, 64, 96 px`.

- Icon to text: 8–12 px.
- Label to value: 8–10 px.
- Card content gap: 16 px.
- Card padding: 24 px.
- Grid gap: 16 px.
- Operational section gap: 18–28 px.
- Public editorial section gap: 48–96 px.
- Page gutter: 24–72 px.

## Layout

- Maximum content width: 1440 px.
- Desktop sidebar: 246 px.
- Desktop grids use twelve conceptual columns and 16 px gutters.
- Breakpoints: 1280, 1024, 768, 480 px.
- Statistics use four equal cells on desktop, two on tablet, and one on mobile.

## Statistics

Every statistic is a vertical pair. The label and value are separate block elements.

```text
PLATFORM TASKS
09
```

Cells have a minimum desktop height of 104 px, 22–24 px padding, and 9 px between label and value. Numbers use tabular figures. Do not render `PLATFORM TASKS09`.

## Logo

- Use the official orange, white, and black PACT mark without distortion.
- Keep clear space equal to half the mark height.
- Minimum mark size is 32 px; sidebar size is 44–48 px.
- Hero artwork may echo the mark but never replaces the official identity.

## Components

### Buttons

- Default height: 44 px; compact height: 36 px.
- Primary: rust background and black text.
- Secondary: transparent background and rust border.
- Only one primary action is shown in a local decision area.
- Labels name the result: “Create agent”, “Open cabinet”, “View profile”.

### Cards

Cards contain category, title, short explanation, key facts, and one action or status. Cards in one row share height. Default background is `--pact-surface`, padding is 24 px, radius is 3 px, and border uses `--pact-line`.

### Status

Status includes an icon and text, never color alone. Public training cards show total capacity such as `12 / 500`; per-agent completion appears only in that agent’s dApp context.

## Navigation permissions

Public navigation contains Overview, How it works, Tasks, and Agent Registry. Agent Registry is read-only: visitors may search, filter, and inspect public profiles without a wallet.

The dApp contains Cabinet, Tasks, Training Leaderboard, and Agent Registry. Wallet connection, agent creation, hiring, invitations, and disputes are private dApp actions.

## Motion and accessibility

- Hover: 180 ms; state transition: 320 ms; reveal: up to 620 ms.
- Use one noticeable animated element per viewport.
- Respect `prefers-reduced-motion`.
- Interactive targets are at least 44 by 44 px.
- Text contrast meets WCAG AA and keyboard focus is always visible.
- Form controls use real labels and errors use explanatory text.

## Review checklist

- No raw hex colors outside the token file unless required inside a standalone brand SVG.
- No arbitrary spacing outside the documented scale.
- No mixed language on one screen.
- No public wallet or mutation action.
- No label/value collision.
- Desktop, tablet, mobile, keyboard, focus, and reduced-motion states are verified before release.
