# PACT — Arc product pitch

An English, 16:9 product-promo composition for PACT. The finished narration is 181.248 seconds (about three minutes) and is voiced locally with Kokoro (`am_michael`).

## Run locally

```powershell
cd video-pitch
npm run check
npx hyperframes snapshot --at 4.8,82.7,150.5,170.5
npx hyperframes render --skill=product-launch-video --quality high --output renders/pact-arc-product-pitch.mp4
```

The generated voice clips are versioned in `assets/voice/`, so the project renders without any hosted voice-provider credentials.

## Source of truth

The copy follows the public PACT repository and its release notes:

- The public product surface is at `https://arc.pact.kant0x.xyz`.
- Arc Testnet contract deployment evidence is presented as testnet evidence, not as a production claim.
- The hosted judging surface is described as demo mode, consistent with the repository's documented deployment boundary.

`BRIEF.md`, `STORYBOARD.md`, and `SCRIPT.md` contain the product, shot, and narration specifications. The staged assets in `assets/` were taken from the local PACT project after automated website capture timed out.

## Repository hygiene

Rendered video files and visual QA snapshots are intentionally ignored: they are reproducible build artifacts. The source composition, staged media, and generated narration are committed.
