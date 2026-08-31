# Fingerprint platform comparison — 2026-08-31 11:03:12 UTC

Source: `2026-08-31-fingerprint-platform-day-1.jsonl` (115 trials, run `2026-08-31T08:27:23.490Z-282081`).

Status: interrupted when its T3 exec session ended. The macOS block completed; the Windows block stopped after trial 3. The tables preserve valid results but do not support a platform comparison.

## cloudflare-challenge

| Config | Renders | First challenge | Sticky | Failure mode |
|---|---:|---:|---|---|
| macos | 17/20 | 12 | no | status-403 ×3, challenge-title ×3 |
| windows | 3/3 | — | — | — |

## datadome-leboncoin

| Config | Renders | First challenge | Sticky | Failure mode |
|---|---:|---:|---|---|
| macos | 3/20 | 4 | yes | status-403 ×17 |
| windows | 3/3 | — | — | — |

## datadome-stacked-hermes

| Config | Renders | First challenge | Sticky | Failure mode |
|---|---:|---:|---|---|
| macos | 20/20 | — | — | — |
| windows | 3/3 | — | — | — |

## perimeterx-therealreal

| Config | Renders | First challenge | Sticky | Failure mode |
|---|---:|---:|---|---|
| macos | 20/20 | — | — | — |
| windows | 3/3 | — | — | — |

## akamai-homedepot

| Config | Renders | First challenge | Sticky | Failure mode |
|---|---:|---:|---|---|
| macos | 0/20 | 1 | yes | status-403 ×20, challenge-title ×20 |
| windows | 0/3 | 1 | yes | status-403 ×3, challenge-title ×3 |

## Consistency leaks

| Config | Leaks |
|---|---|
| macos | none |
| windows | none |

## Interpretation

- macOS rendered Cloudflare 17/20, Leboncoin 3/20 with a sticky block from trial 4, Hermes 20/20, The RealReal 20/20, and Home Depot 0/20.
- Windows completed only 3/20 trials per target, so its early results are not comparable.
- One macOS validation visit to The RealReal immediately before the run rendered and exposed PerimeterX cookies. It is pre-run traffic and is not included in the 20 trials.
