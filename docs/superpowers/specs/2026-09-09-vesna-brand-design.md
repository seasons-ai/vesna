# Vesna brand: palette, mark, and the empty screen

**Status:** approved design, not yet implemented.
**Scope:** the first of three pieces of visual work. This one covers colour,
the mark, and what a launched Vesna looks like before the first message.
Rendering (markdown, syntax highlighting, diffs) and motion are separate specs
and are deliberately out of scope here.

## Why this exists

Vesna is named after the Slavic goddess of spring, and the README already says
so. The visual identity should say the same thing without a caption, and it
should do a second job at the same time: the product freezes live runs into
deterministic flows, and colour can carry that distinction instead of merely
decorating it.

Hence the organising idea, **frost and blossom**: warm petal pink marks what a
model is doing live; cold ice blue marks what has been crystallised. A reader
learns the core concept from a screenshot.

## Decisions

Vesna **owns the canvas**. It paints its own background rather than sitting on
the user's terminal colours. This is what makes the palette predictable enough
to carry meaning, and it is what the rest of this document has to pay for.

## The theme model

A theme today is five foreground colours (`ok`, `held`, `dim`, `accent`,
`label`) as 256-colour codes. Owning the canvas needs surfaces, so the model
becomes:

| Group     | Tokens                  | Purpose                                       |
|-----------|-------------------------|-----------------------------------------------|
| surface   | `bg`, `panel`, `rule`   | the canvas, the input box, separators          |
| text      | `text`, `muted`, `faint`| body, secondary, non-semantic decoration       |
| brand     | `petal`, `ice`          | live work; crystallised work                   |
| state     | `ok`, `warn`, `error`   | outcomes                                       |

Every token is authored once as a hex value. The 256-colour approximation is
derived from it, so a theme author never writes a colour twice.

### Role migration

The rename touches 78 call sites across eight files:

| Old      | New     |
|----------|---------|
| `accent` | `petal` |
| `label`  | `text`  |
| `dim`    | `muted` |
| `held`   | `warn`  |
| `ok`     | `ok`    |

`bg`, `panel`, `rule`, `faint`, `ice`, and `error` are new. The old `ember` and
`dusk` themes are dropped rather than ported; nothing depends on them.

## The palettes

`vesna` is the default and the one in the README screenshot.

### vesna — frost and blossom (dark)

| Token   | Hex       | Contrast on `bg` |
|---------|-----------|------------------|
| `bg`    | `#14161F` | —                |
| `panel` | `#1C202C` | —                |
| `rule`  | `#242938` | 1.24:1           |
| `text`  | `#E3E6EF` | 14.46:1          |
| `muted` | `#7B8194` | 4.65:1           |
| `faint` | `#4E5468` | 2.40:1           |
| `petal` | `#F3AFC2` | 10.07:1          |
| `ice`   | `#9FD3E8` | 11.13:1          |
| `ok`    | `#9BD5B4` | 10.80:1          |
| `warn`  | `#F0C07A` | 10.76:1          |
| `error` | `#F090A0` | 7.90:1           |

### hanami — night under the lanterns (dark)

| Token   | Hex       | Contrast on `bg` |
|---------|-----------|------------------|
| `bg`    | `#17121C` | —                |
| `panel` | `#1F1826` | —                |
| `rule`  | `#2A2130` | 1.19:1           |
| `text`  | `#EDE4EA` | 14.82:1          |
| `muted` | `#8B7F92` | 4.87:1           |
| `faint` | `#5E5266` | 2.52:1           |
| `petal` | `#F2A9BE` | 9.82:1           |
| `ice`   | `#A9CFE0` | 11.13:1          |
| `ok`    | `#A8D8B9` | 11.57:1          |
| `warn`  | `#F0C07A` | 10.99:1          |
| `error` | `#EE94A6` | 8.27:1           |

### washi — ink on warm paper (light)

The first draft of this palette failed its own contrast rule: `muted` sat at
2.95:1 and `petal`, `ice`, and `ok` were all under 4.5:1 while carrying
meaning. Each was darkened in HLS, keeping hue and saturation, until it
cleared.

| Token   | Hex       | Contrast on `bg` | Note              |
|---------|-----------|------------------|-------------------|
| `bg`    | `#FBF7F4` | —                |                   |
| `panel` | `#F4EEE9` | —                |                   |
| `rule`  | `#EBE1DB` | 1.21:1           |                   |
| `text`  | `#3A3038` | 11.88:1          |                   |
| `muted` | `#7B6E77` | 4.54:1           | was `#9A8E96`     |
| `faint` | `#C9BDB6` | 1.72:1           |                   |
| `petal` | `#BE4674` | 4.57:1           | was `#C4577A`     |
| `ice`   | `#3C7995` | 4.52:1           | was `#3F7F9C`     |
| `ok`    | `#3D7F58` | 4.51:1           | was `#3E8159`     |
| `warn`  | `#9A6614` | 4.60:1           |                   |
| `error` | `#B03A4A` | 5.55:1           |                   |

### mono

No colour and **no background**. Owning the canvas must not become a hard
requirement.

`mono` the theme and depth 0 the capability are independent, and both paths
must work. Choosing `mono` on a truecolor terminal paints nothing, because the
theme's tokens are empty. Choosing `vesna` on a terminal that reports no colour
also paints nothing, because the depth gate strips every escape. Neither case
may change the text on the screen — only its colour.

## Colour depth

`colorSupported(env, isTTY): boolean` becomes `colorDepth(env, isTTY): 0 | 8 | 24`.

- **0** — `NO_COLOR` set, `TERM=dumb`, or not a TTY.
- **24** — `COLORTERM` is `truecolor` or `24bit`, or `TERM` ends in `-direct`.
- **8** — any other TTY. Tokens are approximated into the xterm-256 cube.

The existing precedence is preserved: `NO_COLOR` wins over `FORCE_COLOR`, which
wins over TTY detection.

## What owning the canvas costs the layout

`layout` guarantees exactly `rows` lines. It must now also guarantee that each
line is exactly `cols` columns wide, measured visibly. A short line that is not
padded lets the user's own background show through, and the frame looks torn
rather than designed.

This changes `fit` and `statusLine`, adds a pad step, and makes the screen
driver emit the background colour once per line. The existing assertion that no
line exceeds the width gains a partner: no line falls short of it either.

At depth 0 the padding is still applied but no background is set, so the
behaviour is unchanged.

## Contrast is a test, not a promise

A unit test computes the WCAG contrast ratio for every token against its own
theme's `bg` and fails when a **meaningful** token drops below 4.5:1. `faint`
and `rule` are exempt: they are decoration, never text.

This is not decoration of the test suite. It is the rule that caught `washi`
before it shipped, and it turns "contribute a theme" into a small, checkable
pull request — which is the kind of first contribution the project wants.

## The mark

A five-petal sakura blossom with faceted petals, a thin ice-blue spine along
each petal, and an ice-blue core. It reads as a blossom and as a crystal, and
one drawing survives every size from a README header to a 16-pixel favicon.

Three files:

- `assets/mark.svg` — the blossom alone, for the organisation avatar and favicon.
- `assets/logo-dark.svg` — mark and wordmark, for dark backgrounds.
- `assets/logo-light.svg` — the same, with `petal` and `ice` darkened for light.

The README uses `<picture>` with `prefers-color-scheme` so the logo does not
sink into the page for readers on light GitHub.

### The mark in the terminal

The header shows the mark as a single character, `❀` (U+2740). Most fonts have
it; some do not, and a tofu box in the header does more damage than no mark at
all. A TTY cannot be asked reliably whether a glyph exists, so the fallback is
decided from what is knowable:

- `LANG` / `LC_ALL` do not mention UTF-8 → ASCII mode.
- `ascii: true` in `.vesna/config.yaml` → ASCII mode, unconditionally.

In ASCII mode the mark is `*`.

## The empty screen

What Vesna shows before the first message is an **empty state**, not a message.
The distinction matters: a message stays in the history and clutters the rest of
the session, while an empty state exists only while the conversation is empty
and disappears the moment the user says something.

Centred in the conversation area: the mark, the wordmark spaced out, one line
of mood, and three examples that teach the whole product in two seconds — ask
for something, freeze what worked, run it forever.

The empty state must shrink. When the terminal is too narrow or too short for
the examples, they drop and only the mark, the wordmark, and the line remain.

## Testing

- Contrast: computed from the palette definitions, per theme, per token.
- Depth: `colorDepth` against the documented environment matrix, including the
  `NO_COLOR` over `FORCE_COLOR` precedence.
- Approximation: every hex maps to a 256-colour code, and no two tokens within
  one theme collapse onto the same code. Writing this test first caught two
  real defects in the palette above: `vesna`'s `bg` and `panel` both landed on
  234, which would have made the input box invisible on a 256-colour terminal,
  and `washi`'s `petal` and `error` both landed on 131, which would have made
  an error indistinguishable from the prompt marker. Both were nudged until
  they separated, `petal` while keeping its 4.5:1 floor.
- Layout: every line of every frame is exactly `cols` wide, at every size
  already covered by the layout tests.
- Empty state: present when the conversation is empty, absent after the first
  message, and reduced to mark and wordmark in a small window.
- ASCII fallback: no non-ASCII byte reaches the frame when ASCII mode is on.

## Out of scope

Markdown rendering, syntax highlighting, and diff display for `edit` are the
second piece of work. The spinner, the streaming cursor, and any motion are the
third. Neither is designed here, but the palette reserves room: syntax and diff
colours will be added as their own token group rather than by overloading
`petal` and `ice`.
