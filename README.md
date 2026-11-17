# launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/swift-falcon-94/launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/swift-falcon-94/launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar ranks pre-token protocols by implied launch value, priced from live-token comparables in the same category. It reads a sealed DefiLlama snapshot, scores every launch candidate with one transparent model, and renders a static dashboard: the ranked board, a valuation breakdown and farm plan per protocol, and the method in full.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

In the grader, `main.ts` reads `/input/snapshot.json` and writes `/output`: `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json`. Node 22 or later, standard library only, no install step.

## How it works

Implied value is `TVL x peer multiple x growth x maturity x chains`. The peer multiple is the median market-cap-to-TVL ratio of the token-trading protocols in the same category (at least 3 peers, else the global median), clamped to 0.01–2. Growth is the seven-day TVL change, clamped and half-weighted; maturity rises with the log of the days since listing; each chain beyond the first adds 5%. Every input is a figure the snapshot carries, and no protocol name is special-cased.

## Layout

- `main.ts` — the entrypoint: snapshot in, ranked board and dossier out.
- `lib/model.ts` — the comparables model, the farm plans and the board checks.
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`. No network, no framework.
- `screenshots/` — the board, a detail view and a filtered view, captured from the dashboard.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied unchanged.
- `tools/validate.ts` — a local mirror of the gate's checks.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
