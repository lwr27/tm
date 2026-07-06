# TM COTD Dashboard

Trackmania Cup of the Day analytics for XV27, TheBreaker0 and Pho3nix_. —
cup history, divisions, Glicko-2 qualifier ratings, map-style breakdowns,
and a TOTD author-medal table.

Live dashboard: **https://lwr27.github.io/tm/**

## How it works

- Static single-file dashboard (`dashboard.html`) that reads four JSON
  caches sitting next to it: `cache.json` (COTD cup history),
  `map-tags.json` (TMX style tags / environments / TMX ids),
  `authors.json` (TOTD author-medal stats), `totd-months.json`
  (TOTD listing cache).
- A daily GitHub Actions workflow (`.github/workflows/update-data.yml`)
  runs the fetch scripts incrementally and commits any changed data back
  to the repo, which redeploys GitHub Pages automatically.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Local server at http://localhost:3001/dashboard.html |
| `npm run update` | Incremental COTD cup history -> cache.json |
| `npm run tags` | TMX style tags / environment / TMX id per map -> map-tags.json |
| `npm run authors` | TOTD author-medal stats (new maps only) -> authors.json |
| `npm run medals` | Refresh only the three players' personal medal ticks |

`authors` and `medals` need Nadeo dedicated-server credentials — locally
via a `.env` file (`NADEO_SERVER_LOGIN` / `NADEO_SERVER_PASSWORD`), in CI
via repo Actions secrets of the same names. `.env` is gitignored; never
commit it.

## Local use

```
npm install
npm start
```

Then open http://localhost:3001/dashboard.html.
