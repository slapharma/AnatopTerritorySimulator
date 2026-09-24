# AnatopTerritorySimulator

## Simulating a session without the app

`scripts/simulate-session.js` runs one whole evaluation through the app's own code —
prompts, `agents.runTurn` with its tools, `transcript.assembleText`, the evidence
check, the disagreement and question parsers, minutes, the answered-check and a
Final report — against an in-memory database, then reports how evidenced the
result is.

It never reads `DATABASE_URL`, so it cannot touch the production database the
repo's `.env` points at. It does call OpenRouter and the search provider with the
keys in that `.env`, so it costs real (small) money: about $0.03 a session on the
default model, measured.

```
node scripts/simulate-session.js --env <path-to-.env> --probe
```

`--probe` also fetches every cited URL that no agent searched or opened, to see
whether it exists. Other flags: `--model id`, `--country name`,
`--depth brief|standard|full`, `--out dir`. Output goes to `<out>/session.json`,
`transcript.md` and `metrics.json`.
