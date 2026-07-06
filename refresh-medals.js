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

// Same dedup logic as fetch-authors.js — shared log, one entry per
// player+map, ever.
function logMedalEvent(results, playerName, m, recordTimestamp){
  results.medalEvents = results.medalEvents || [];
  const key = `${playerName}|${m.mapUid}`;
  if (results.medalEvents.some((e) => e.key === key)) return;
  results.medalEvents.push({
    key,
    player: playerName,
    mapUid: m.mapUid,
    mapName: m.name,
    achievedAt: recordTimestamp || null,
    detectedAt: new Date().toISOString(),
  });
}

async function main() {
  if (!fs.existsSync(OUT_PATH)) {
    console.error("authors.json not found — run `npm run authors` first.");
    process.exit(1);
  }
  const results = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  const maps = (results.maps || []).filter((m) => m.mapId && m.authorTimeMs != null);
  console.log(`${maps.length} cached maps with a mapId to check.`);

  const accountList = PLAYERS.map((p) => p.accountId).join(",");
  let updated = 0, checked = 0, newMedals = 0, loggedShape = false;

  for (const m of maps) {
    checked++;
    try {
      const records = await nadeoFetch(
        `https://prod.trackmania.core.nadeo.online/v2/mapRecords/?accountIdList=${accountList}&mapId=${m.mapId}`,
        CORE
      );
      if (!loggedShape && Array.isArray(records) && records.length) {
        loggedShape = true;
        console.log("Raw mapRecords entry (checking for a timestamp field):", JSON.stringify(records[0]));
      }
      const recByAccount = {};
      (Array.isArray(records) ? records : []).forEach((rec) => {
        if (rec.recordScore && rec.recordScore.time != null) {
          recByAccount[rec.accountId] = { time: rec.recordScore.time, timestamp: rec.timestamp || null };
        }
      });
      const fresh = {};
      const previouslyHad = m.playerHasAuthor || {};
      PLAYERS.forEach((p) => {
        const rec = recByAccount[p.accountId];
        const has = rec != null && rec.time <= m.authorTimeMs;
        fresh[p.name] = has;
        // log only the false -> true transition, i.e. a genuinely new medal
        if (has && !previouslyHad[p.name]) {
          logMedalEvent(results, p.name, m, rec.timestamp);
          newMedals++;
        }
      });
      if (JSON.stringify(fresh) !== JSON.stringify(previouslyHad)) {
        m.playerHasAuthor = fresh;
        updated++;
      }
    } catch (err) {
      console.error(`  ${m.name || m.mapId}: ${err.message.slice(0, 100)}`);
    }

    if (checked % 50 === 0) {
      console.log(`Checked ${checked}/${maps.length} maps (${updated} changed, ${newMedals} new medals so far)`);
      fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2)); // save as we go
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  results.medalsRefreshedAt = new Date().toISOString();
  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
  console.log(`\nDone. ${checked} maps checked, ${updated} medal statuses changed, ${newMedals} new medal(s) logged.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
