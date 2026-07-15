// Clears the fetched author/finisher stats, but ONLY on maps from the
// last WINDOW_DAYS days — older maps are left completely untouched so
// fetch-authors.js's doneUids logic skips them and doesn't re-fetch the
// whole 2000+ map archive every time this runs.
//
// Why scope to recent maps: author-medal counts only move meaningfully
// in the weeks right after a TOTD's release — very old maps have long
// since plateaued, so refreshing them repeatedly wastes runtime for
// almost no data change (confirmed: a full-archive refetch fell back to
// trackmania.io's slow per-map search on nearly every map and was on
// pace for ~11+ hours, well past GitHub Actions' 6h job limit).
//
// Run with: npm run wipe-author-stats

const fs = require("fs");
const path = require("path");

const OUT_PATH = path.join(__dirname, "authors.json");
const WINDOW_DAYS = Number(process.env.WIPE_WINDOW_DAYS || 30);

if (!fs.existsSync(OUT_PATH)) {
  console.log("No authors.json found — nothing to wipe.");
  process.exit(0);
}

const results = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
results.maps = results.maps || [];

const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

function mapDate(m) {
  if (!m.monthYear || m.day == null) return null;
  const [y, mo] = m.monthYear.split("-").map(Number);
  if (!y || !mo) return null;
  return new Date(Date.UTC(y, mo - 1, m.day));
}

let wiped = 0;
let skippedOld = 0;
let skippedNoDate = 0;

results.maps.forEach((m) => {
  const d = mapDate(m);
  if (!d) { skippedNoDate++; return; }
  if (d < cutoff) { skippedOld++; return; }

  if (m.authorCount == null && m.totalFinishers == null) return;

  delete m.authorCount;
  delete m.totalFinishers;
  delete m.pct;
  delete m.authorCapped;
  delete m.verified;
  wiped++;
});

fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
console.log(`Wiped author/finisher counts on ${wiped} map(s) from the last ${WINDOW_DAYS} days.`);
console.log(`Left untouched: ${skippedOld} older map(s), ${skippedNoDate} map(s) with no usable date.`);
