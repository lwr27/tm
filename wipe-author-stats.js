// Clears the fetched author/finisher stats on every map in authors.json
// so the next `npm run authors` run treats all of them as not-yet-done
// and re-fetches fresh counts. Map identity/date fields (mapUid, name,
// day, monthYear, mapId, leaderboardUid, authorTimeMs, etc.) are left
// untouched — only the fields that make a map "done" in fetch-authors.js's
// isStale() check are removed.
//
// Run with: npm run wipe-author-stats

const fs = require("fs");
const path = require("path");

const OUT_PATH = path.join(__dirname, "authors.json");

if (!fs.existsSync(OUT_PATH)) {
  console.log("No authors.json found — nothing to wipe.");
  process.exit(0);
}

const results = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
results.maps = results.maps || [];

let wiped = 0;
results.maps.forEach((m) => {
  if (m.authorCount == null && m.totalFinishers == null) return; // already clear
  delete m.authorCount;
  delete m.totalFinishers;
  delete m.pct;
  delete m.authorCapped;
  delete m.verified;
  // playerHasAuthor / medalEvents are left alone — those are personal
  // medal-achievement facts, not counts that go stale, and wiping them
  // would just make fetch-authors.js redo work that was already correct.
  wiped++;
});

fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
console.log(`Wiped author/finisher counts on ${wiped} map(s). fetch-authors.js will re-fetch all of them on its next run.`);
