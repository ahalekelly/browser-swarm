# Fingerprint platform comparison — 2026-09-01 10:18:52 UTC

Source: `2026-09-01-fingerprint-platform-day-2.jsonl` (200 trials, run `2026-09-01T08:00:03.507Z-585702`).

## Interpretation

The run completed with 200 valid trials and no consistency leaks. macOS rendered 62/100 pages and Windows rendered 59/100. The configs tied on Hermes, TheRealReal, and Home Depot; macOS led Cloudflare 20–18 and Leboncoin 2–1. This small difference does not establish a platform advantage because each config ran as one block, so timing and shared reputation can affect the result. A complete macOS→Windows replacement run will test the order effect after a full-day cooldown.

## cloudflare-challenge

| Config | Renders | First challenge | Sticky | Failure mode |
|---|---:|---:|---|---|
| windows | 18/20 | 8 | no | status-403 ×2, challenge-title ×2 |
| macos | 20/20 | — | — | — |

## datadome-leboncoin

| Config | Renders | First challenge | Sticky | Failure mode |
|---|---:|---:|---|---|
| windows | 1/20 | 2 | yes | status-403 ×19 |
| macos | 2/20 | 2 | no | status-403 ×18 |

## datadome-stacked-hermes

| Config | Renders | First challenge | Sticky | Failure mode |
|---|---:|---:|---|---|
| windows | 20/20 | — | — | — |
| macos | 20/20 | — | — | — |

## perimeterx-therealreal

| Config | Renders | First challenge | Sticky | Failure mode |
|---|---:|---:|---|---|
| windows | 20/20 | — | — | — |
| macos | 20/20 | — | — | — |

## akamai-homedepot

| Config | Renders | First challenge | Sticky | Failure mode |
|---|---:|---:|---|---|
| windows | 0/20 | 1 | yes | status-403 ×20, challenge-title ×20 |
| macos | 0/20 | 1 | yes | status-403 ×20, challenge-title ×20 |

## Consistency leaks

| Config | Leaks |
|---|---|
| windows | none |
| macos | none |
