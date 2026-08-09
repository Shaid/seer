# Project status and stability

**Seer is pre-1.0. Breaking changes can and will land in minor releases.**

Every package is versioned `0.x`. Under
[semver's own rules](https://semver.org/#spec-item-4), anything below `1.0.0`
makes no compatibility promise at all, and this project uses that latitude
rather than pretending otherwise. A `0.1.x → 0.2.0` bump may rename exports,
change function signatures, or move a module to a different package.

That is not carelessness — it is the point of being pre-1.0. The API is shaped
by real reverse-engineering projects pushing on it, and those projects keep
finding that the right abstraction is not the one that shipped. Freezing the
surface now would lock in guesses.

## What this means for you

- **Pin exact versions** if you need reproducible builds. `"@seer-project/core":
  "0.1.0"` rather than `"^0.1.0"`. Note that `^0.1.0` already behaves
  restrictively for `0.x` — npm reads it as `>=0.1.0 <0.2.0` — so it will not
  silently pull a breaking minor, but it also will not pull fixes published
  under a later minor.
- **Read the [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md)
  before upgrading.** Breaking changes are called out there.
- **Expect the packages to move together.** They share a version number and are
  released as a set, because their cross-dependencies pin each other. Upgrade
  them together too.
- **Don't build a business-critical dependency on this yet** without either
  vendoring it or being prepared to follow the changes.

## Where the surface is settled, and where it isn't

This is a judgement call, not a guarantee — but it reflects how much real use
each package has taken.

| Package | Stability |
|---|---|
| `@seer-project/core` | **Steadiest.** Binary reading primitives and the asset/palette types are used by every other package and every consuming project; the shapes have survived several games |
| `@seer-project/iff` | Steady. A parser for a published 1985 standard — the format cannot move underneath it |
| `@seer-project/pipeline` | Mostly steady, but Node-only helpers get added as new extraction needs appear |
| `@seer-project/engine-2d`, `@seer-project/smus`, `@seer-project/tracker`, `@seer-project/audio-dsp` | Moving. Each was extracted from a working project and generalised; expect the generalisation to keep being refined |
| `@seer-project/audio-ui`, `@seer-project/dungeon` | Moving faster. Recently extracted, fewer independent consumers |
| `@seer-project/engine-3d` | **Newest and least settled.** Added most recently; the model-adapter boundary in particular is still being worked out |
| `create-seer-app` | Churn matters least — it generates code into your project once, so a later change to the template does not break what you already scaffolded |

## What 1.0 would need

Not a roadmap commitment, just the honest bar: enough independent projects
using the packages that the abstractions stop moving on their own, and a
deprecation policy to replace "we changed it".

See the [framework plan](https://seer.shaid.net/roadmap/framework-plan/) for
where the work is heading.
