// Refreshes ONLY the three players' personal author-medal status across
// every map already cached in authors.json — global counts, dates, and
// everything else stay exactly as they are.
//
// Run with: npm run medals
// Requires .env with NADEO_SERVER_LOGIN / NADEO_SERVER_PASSWORD.
//
// One request per map (accountIdList batches all three players together,
// but mapId does NOT accept a comma-separated list — confirmed by the API
// itself rejecting a joined list with "is not a valid UUID", i.e. it was
// trying to parse the whole comma-joined string as a single ID). ~2200
// requests at a steady pace — a background job, not a quick refresh.

const fs = require("fs");
const path = require("path");
const { nadeoFetch } = require("./nadeo-auth");

const CORE = "NadeoServices";
const OUT_PATH = path.join(__dirname, "authors.json");

const PLAYERS = [
  { name: "XV27", accountId: "8b537233-4931-49a8-af54-b0cefc33fa72" },
  { name: "TheBreaker0", accountId: "07859bb1-b0bd-4748-b1bb-4ecb173786c6" },
  { name: "Pho3nix_.", accountId: "ede8dd52-dc02-4abc-a864-eb6e3934bc2b" },
];

async function main() {
  if (!fs.existsSync(OUT_PATH)) {
    console.error("authors.json not found — run `npm run authors` first.");
    process.exit(1);
  }
  const results = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  const maps = (results.maps || []).filter((m) => m.mapId && m.authorTimeMs != null);
  console.log(`${maps.length} cached maps with a mapId to check.`);

  const accountList = PLAYERS.map((p) => p.accountId).join(",");
  let updated = 0, checked = 0;

  for (const m of maps) {
    checked++;
    try {
      const records = await nadeoFetch(
        `https://prod.trackmania.core.nadeo.online/v2/mapRecords/?accountIdList=${accountList}&mapId=${m.mapId}`,
        CORE
      );
      const times = {};
      (Array.isArray(records) ? records : []).forEach((rec) => {
        if (rec.recordScore && rec.recordScore.time != null) times[rec.accountId] = rec.recordScore.time;
      });
      const fresh = {};
      PLAYERS.forEach((p) => {
        const t = times[p.accountId];
        fresh[p.name] = t != null ? t <= m.authorTimeMs : false;
      });
      if (JSON.stringify(fresh) !== JSON.stringify(m.playerHasAuthor || {})) {
        m.playerHasAuthor = fresh;
        updated++;
      }
    } catch (err) {
      console.error(`  ${m.name || m.mapId}: ${err.message.slice(0, 100)}`);
    }

    if (checked % 50 === 0) {
      console.log(`Checked ${checked}/${maps.length} maps (${updated} changed so far)`);
      fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2)); // save as we go
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  results.medalsRefreshedAt = new Date().toISOString();
  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
  console.log(`\nDone. ${checked} maps checked, ${updated} medal statuses changed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
