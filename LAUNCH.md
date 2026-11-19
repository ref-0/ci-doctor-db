# CI score: the X launch (noted 18 Nov 2026)

The site gets an X launch, inspired by React Doctor's launch post. Bring this up again when the site is close to ready.

## The reference

[aidenybai, 17 Feb 2026](https://x.com/aidenybai/status/2023806825062449424), read through the public fxtwitter API on 18 Nov 2026: 1.08M views, 10.4k likes, 750 reposts and 346 replies.

> Introducing React Doctor
>
> Scan your React codebase for anti-patterns:
>
> - Unnecessary useEffects
> - Fix accessibility issues
> - Prop drilling instead of context / composition
>
> Run as a CLI or agent skill. Repeat until passing. Fully open source

It's attached to a 1080p demo video.

How the post is built:
1. **"Introducing <name>",** on a line of its own.
2. **One line on what it does,** in the reader's terms ("your React codebase").
3. **Three concrete findings, each a pain the reader recognizes,** not features.
4. **How to use it, in agent terms:** "CLI or agent skill. Repeat until passing."
5. **"Fully open source."**
6. **A video carries the rest.**

## A first draft for ours

> Introducing ci-doctor
>
> Paste your GitHub repo, get your CI's score:
>
> - How long a PR waits for checks, against repos your size
> - Tests that only pass on a rerun
> - CI minutes burned per merged PR
>
> Copy the prompt into your agent. Repeat until fast. Fully open source

**The video, about 20–30 s, captured from the real site:**
1. Paste a well-known repo.
2. The progress steps tick off.
3. The score counts up and the bars fill.
4. "Where you stand" slides in.
5. The PR run replays: shards finish, then everything waits on the slowest.
6. Copy the prompt.
7. An agent opens ci-doctor and starts on the first fix.

## Before launch

- **The leaderboard is seeded from the calibration runs,** so the first visitors see real repos and real comparisons.
- **Every number in the post and the video is measured and dated.**
- **The site is fast and cached,** and quota holds up under a spike. See [SITE.md](SITE.md#architecture-on-cloudflare).
- **The repo is public,** with `ref-0/ci-doctor` tagged v0.1.0 and the README lockup in place.
- **`npx @ref0/ci-doctor` works,** since home offers it for private and local repos. See [SITE.md](SITE.md#private-repos).
- **One real before and after.** Run ci-doctor on one or two slow open-source repos with their maintainers a couple of weeks ahead, and use their numbers on the history card, the home card and in the post. See [SITE.md](SITE.md#before-and-after).
- **The X card design is picked.** [SITE.md](SITE.md#the-x-card-open) has the concepts. A2, the score card, is picked (19 Nov).
- **Follow the `brand` skill** for the post's copy and the video, and check both with `design-review`.
