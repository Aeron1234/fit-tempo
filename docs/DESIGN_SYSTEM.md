# Fit Tempo design system

## Plan

Use ink navy and chalk as the primary surfaces, and an orange accent for actionable controls, selection ticks and time marks. A Day strip is the recurring visual device. Keep the shell and data pages flat, use headings and horizontal rules to organize information, and reserve white surfaces for forms, menus, dialogs and tables. Keep totals in a ledger with the number on the right and coverage directly beneath it.

The presentation layer reads existing authorized data. Do not add routes, change API contracts, or imply that unrecorded intervals are zero. Use the existing theme preference and operating system fallback.

## Tokens

The source is `apps/web/src/index.css`. Use Tailwind semantic utilities or `var(--token)`. Keep literal colors inside the theme.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `background` | `#EEF2F6` | `#0C223B` | Canvas |
| `card` | `#FFFFFF` | `#112C49` | Forms, tables, menus and dialogs |
| `foreground` | `#0E2A47` | `#EEF2F6` | Primary content |
| `muted` | `#DFE7F0` | `#1F3B57` | Subtle highlights |
| `muted-foreground` | `#4B6177` | `#B6C7D8` | Semantic counterpart or chart series |
| `border` | `#BCC9D7` | `#37526D` | Grouping rules |
| `control-border` | `#718398` | `#7792AB` | Essential control boundaries |
| `primary` | `#FF7A2B` | `#FF8C4B` | Filled controls |
| `primary-hover` | `#F96C1B` | `#FF9E65` | Semantic counterpart or chart series |
| `primary-foreground` | `#0E2A47` | `#0E2A47` | Semantic counterpart or chart series |
| `accent` | `#B13E08` | `#FF9E65` | Links and secondary actions |
| `mark` | `#CD4608` | `#FF8C4B` | Time marks and selection |
| `hatch` | `#6D7D8E` | `#8499AF` | Unrecorded intervals |
| `success` | `#147147` | `#77D7A6` | Semantic counterpart or chart series |
| `destructive` | `#B12230` | `#FFA7B0` | Semantic counterpart or chart series |
| `warning` | `#8C560D` | `#FFD389` | Semantic counterpart or chart series |
| `rail` | `#0E2A47` | `#07192B` | Navigation |
| `rail-foreground` | `#EEF2F6` | `#EEF2F6` | Semantic counterpart or chart series |
| `rail-rule` | `#4B6177` | `#37526D` | Semantic counterpart or chart series |
| `ring` | `#0E2A47` | `#EEF2F6` | Focus outline |
| `ring-offset` | `#EEF2F6` | `#0C223B` | Focus separation |
| `ring-halo` | `#CD4608` | `#FF8C4B` | Focus outer edge |
| `chart-1` | `#B13E08` | `#FF9E65` | Semantic counterpart or chart series |
| `chart-2` | `#205995` | `#85C2FF` | Semantic counterpart or chart series |
| `chart-3` | `#15734D` | `#77D7A6` | Semantic counterpart or chart series |
| `chart-4` | `#7454A2` | `#C6B0FF` | Semantic counterpart or chart series |
| `chart-5` | `#8C560D` | `#FFD389` | Semantic counterpart or chart series |

Tempo orange retains ink foreground in both themes. The brief’s orange-text and slate suggestions were deepened slightly for text, glyph and hatch contrast over chalk and muted surfaces. Pale grouping rules are decorative. Use `control-border` where a boundary identifies an input or another control.

## Typography and spacing

Use tabular numerals for figures and numeric table columns. Right-align numeric ledger and table values. Keep body measure below approximately 80 characters. The font stacks prefer Archivo and Atkinson Hyperlegible Next if they are installed on the device, followed by local system faces. The requested packages were absent from the workspace and npm cache, and offline npm metadata requests returned ENOTCACHED. No assets or remote requests were added. Use sentence case, a compact line-height and one heading per section.

Spacing follows a 4px rhythm. Controls use 8px corners, form panels and dialogs use 12px corners, and marks and status tags can be fully round. Tables scroll in their own container. Keep the canvas flat. Use one crisp shadow on overlays only.

## Component inventory

| Component | Role |
| --- | --- |
| `Button` | Orange fill with ink text by default. Outline and ghost variants for supporting actions. |
| `.tempo-section` | A flat content group separated by spacing and a rule. |
| `.tempo-form` and `.tempo-field` | Panel surface for forms and a shared 44px field treatment. |
| `.tempo-ledger` | One row per metric with a right-aligned amount and visible coverage. |
| `.tempo-table` and `.tempo-scroll` | Dense, readable data grids with local horizontal scrolling and sticky column headers. |
| `.tempo-nav-link` | Visible current-page state using a 3px tick. Admin navigation uses ink on chalk. |
| Day strip | Accessible local-day timeline with mark shapes, hatching and a text equivalent. |

## Day strip and data truth

Use local time boundaries in the recorded IANA timezone. A 23- or 25-hour day must contain only its actual hour ticks, including repeated time when appropriate. Meals use circles, water rings, workouts squares and activity triangles. Only show kinds backed by existing data. Scheduled marks should be hollow. Keep the current-time marker off historical days. Display unknown intervals with hatching and an explicit label, and provide the time, title and amount for every recorded mark in a screen-reader equivalent. Use neutral rest language and preserve data coverage, units, estimate labels and provenance.

Honor reduced motion. Limit passive motion to a single current-time sweep. Preserve every flow and validation message. Pair semantic status colors with text and an icon. Use labels and shapes with chart tokens to make series distinguishable without color. Draw missing values as gaps and render recorded zero explicitly.

## Accessibility

Focus uses a 2px outline with surface separation and an outer orange halo. Text aims for 4.5:1, and essential boundaries and focus use 3:1. Use the alternate focus treatment on the navigation rail. Maintain touch targets and visible focus without shrinking controls when space is tight.


### Color contrast measurements

WCAG relative luminance calculated for the semantic palette. Rows that group surfaces or states show the lowest pairing against canvas, form surface and muted fill where applicable.

| Pair | Minimum | Light | Dark |
| --- | ---: | ---: | ---: |
| Body text | 4.5:1 | 11.68:1 | 10.25:1 |
| Secondary text | 4.5:1 | 5.14:1 | 6.67:1 |
| Action label, default and hover | 4.5:1 | 4.99:1 | 6.32:1 |
| Accent text | 4.5:1 | 4.72:1 | 5.67:1 |
| Status text | 4.5:1 | 4.83:1 | 6.26:1 |
| Navigation text | 4.5:1 | 12.96:1 | 15.78:1 |
| Essential borders | 3.0:1 | 3.11:1 | 3.56:1 |
| Marks and hatching | 3.0:1 | 3.38:1 | 3.93:1 |
| Chart glyphs | 3.0:1 | 4.69:1 | 5.67:1 |
| Focus outline and halo | 3.0:1 | 3.76:1 | 5.00:1 |
| Rail focus outline and halo | 3.0:1 | 5.60:1 | 7.70:1 |

