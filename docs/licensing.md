# Licensing

Seer is dual-licensed: **AGPL-3.0-or-later**, with a paid commercial licence
available for anyone who needs an exemption from the AGPL's source-sharing
requirement.

## Why copyleft, specifically

This is not about limiting who gets to use the framework. It is about what kind
of ecosystem a tool like this one should produce.

Seer exists to reverse-engineer other people's work — to take a shipped game's
data files apart, understand formats their authors never documented, and rebuild
them as something you can read and run. That work is only possible because
decades of people in the preservation and romhacking communities published what
they found instead of keeping it. Every solved format this framework builds on
was somebody's unpaid, shared effort.

A framework built on that foundation ought to keep feeding it. So the licence is
chosen to make the give-back the default: if you build on Seer, your work stays
open too, and the next person gets the same head start you did.

That is a principle, not a trap. If the copyleft genuinely doesn't fit what
you're doing, there is a commercial option below and we would rather have that
conversation than have you quietly walk away.

## Option 1 — AGPL-3.0-or-later (free)

Use, modify and distribute Seer freely for personal, educational or open-source
work.

The AGPL's distinguishing term matters here: it extends copyleft to **network
use**. If you build a web application or hosted service on Seer, you must make
your application's complete source available under the AGPL to its users — not
only if you ship them a binary. For a browser-based framework, that is the case
that actually comes up.

The full text is in [`LICENSE`](https://github.com/Shaid/seer/blob/main/LICENSE)
at the repository root, and ships inside every published package.

## Option 2 — Commercial licence (paid)

If you want to build a proprietary, closed-source product or SaaS platform on
Seer, a commercial licence waives the AGPL's source-sharing requirement and lets
your codebase stay private.

What we are really after is one of two outcomes: your improvements and format
work come back upstream where everyone benefits, or the exemption is paid for.
Either is fine. Simple flat-fee and subscription terms are available, and custom
terms are negotiable.

**To enquire:** email
[dr.shaid@gmail.com](mailto:dr.shaid@gmail.com) with the subject line
`[Commercial License Request - Project Name]`.

## Which one applies to you

| What you're doing | Licence |
|---|---|
| Personal project, research, learning | AGPL — nothing to do |
| Open-source project, released under AGPL-compatible terms | AGPL — nothing to do |
| Internal tool, never exposed over a network | AGPL — nothing to do |
| Public web app or hosted service, source published | AGPL — nothing to do |
| Public web app or hosted service, source kept private | Commercial |
| Proprietary product distributed to customers | Commercial |

If you're unsure, ask. Getting this wrong by accident helps nobody.

## Third-party code

`@seer-project/tracker` contains a TypeScript port of the Micromod JavaScript
ProTracker replay engine by Martin Cameron, used under the **BSD 3-Clause**
licence. That licence is permissive, so the port can be redistributed under
Seer's own terms — but its copyright notice must be retained in any
redistribution, **including under a commercial licence**. The full notice ships
with that package as `THIRD-PARTY-LICENSES.md`.

## What this licence does not cover

Seer ships no game data, and neither should anything built with it. The
framework is tooling: it reads files you already legally own. Original game
assets, disk images and executables are the copyright of their respective
owners, are not distributable under any licence offered here, and are excluded
from every published package by design.
