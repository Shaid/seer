# @seer-project/retro-display

Post-display simulation — CRT shadow mask, aperture grille, slot mask, LCD
subpixel — for any canvas or image source. Not mesh- or sprite-specific: a
CRT-simulated PSX battle model is exactly as period-accurate as a
CRT-simulated sprite, so this is scoped the same way as
`@seer-project/canvas-export` — one package, any canvas-based viewer.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds. Details:
> <https://seer.shaid.net/start-here/project-status/>.

> **Phases 5-6 of `2d-export-proposal.md`.** All five `DisplayProfile`
> values have a real shader implementation, including
> curvature/glow/chromatic-aberration.

## Installation

```bash
npm install @seer-project/retro-display
```

Zero runtime dependencies.

## Usage

```ts
import { createRetroDisplayRenderer } from '@seer-project/retro-display';

const retro = createRetroDisplayRenderer({ profile: 'crt-shadow-mask' });
retro.render(mySourceCanvas); // draws mySourceCanvas through the shader into retro.canvas
document.body.appendChild(retro.canvas);

retro.setOptions({ profile: 'crt-shadow-mask', scanlineIntensity: 0.5 });
// ...
retro.dispose(); // frees the GL context and its resources
```

`retro.canvas` is a **persistent** output canvas owned by the renderer for
its whole lifetime — mount it once and call `render()` again on every
redraw; don't wipe/replace it, the same persistent-canvas constraint Phase 2
of `2d-export-proposal.md` established for the 2D draw path itself. It's
also what a `CaptureSource.canvas` getter should point at when a profile is
active, so a screenshot/recording captures the shaded output rather than
the unshaded source.

## `DISPLAY_PROFILE_PRESETS` / `resolveRetroDisplayOptions`

```ts
import { DISPLAY_PROFILE_PRESETS, resolveRetroDisplayOptions } from '@seer-project/retro-display';

DISPLAY_PROFILE_PRESETS['crt-shadow-mask'];
// -> { scanlineIntensity: 0.3, maskIntensity: 0.25, vignette: 0.15, glow: 0.2, brightness: 1.1 }

resolveRetroDisplayOptions({ profile: 'crt-shadow-mask', scanlineIntensity: 0.9 });
// -> preset values for every field EXCEPT scanlineIntensity, which the explicit option overrides
```

Each profile's preset gives the profile selector alone a complete,
good-looking result; the individual `RetroDisplayOptions` fields are for
fine-tuning afterwards, not required inputs. Precedence: an explicit option
> that profile's preset > the package-wide bare default.

## Testing

```bash
npm test
npm run lint
```

`DISPLAY_PROFILE_PRESETS`/`resolveRetroDisplayOptions` are pure and tested
directly. The shader itself needs a real WebGL2 context and is verified only
in the browser (per-project Playwright: switch profiles, assert the canvas
image changes and differs from `'none'`, export a screenshot under an
active profile and confirm the *exported* image reflects the shader) — see
`2d-export-proposal.md`'s Testing section.

## Licensing & Commercial Use

Seer exists to reverse-engineer other people's work, and that is only possible
because the preservation and romhacking communities published what they found
instead of keeping it. The licence is chosen so that keeps happening: build on
Seer and your work stays open too, so the next person gets the same head start.

- **[AGPL-3.0-or-later](https://github.com/Shaid/seer/blob/main/LICENSE)** —
  free for personal, educational and open-source use. Note that the AGPL extends
  copyleft to **network use**: run a public web app or hosted service on this
  and you must publish your application's source under the AGPL.
- **Commercial licence** — waives that requirement so a proprietary or
  closed-source product can keep its codebase private. Flat-fee and subscription
  terms are available, and custom terms are negotiable.

If the copyleft doesn't fit what you're building, we would much rather have the
conversation than have you walk away — email
[dr.shaid@gmail.com](mailto:dr.shaid@gmail.com) with the subject
`[Commercial License Request - Project Name]`.

Full details: <https://seer.shaid.net/start-here/licensing/>.
