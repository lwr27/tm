// Refreshes ONLY the three players' personal author-medal status across
// every map already cached in authors.json — global counts, dates, and
// everything else stay exactly as they are.
//
// Run with: npm run medals
// Requires .env with NADEO_SERVER_LOGIN / NADEO_SERVER_PASSWORD.
//
// Fast: the mapRecords endpoint accepts a list of map IDs per request, so
// this batches ~25 maps per call — the whole TOTD history refreshes in a
// couple of minutes, safe to run as often as you like after playing.

const fs = require("fs");
const path = require("path");
const { nadeoFetch } = require("./nadeo-auth");

const CORE = "NadeoServices";
const OUT_PATH = path.join(__dirname, "authors.json");
const CHUNK = 25;

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

  for (let i = 0; i < maps.length; i += CHUNK) {
    const chunk = maps.slice(i, i + CHUNK);
    const mapIdList = chunk.map((m) => m.mapId).join(",");
    let records;
    try {
      // NB: the parameter is named mapId (singular) — the API rejects
      // "mapIdList" with a "Missing mapId parameter" error, but accepts a
      // comma-separated list under mapId.
      records = await nadeoFetch(
        `https://prod.trackmania.core.nadeo.online/v2/mapRecords/?accountIdList=${accountList}&mapId=${mapIdList}`,
        CORE
      );
    } catch (err) {
      console.warn(`Chunk ${Math.floor(i / CHUNK) + 1} failed as a batch (${err.message.slice(0, 120)}...) — retrying these ${chunk.length} maps one at a time`);
      records = [];
      for (const m of chunk) {
        try {
          const single = await nadeoFetch(
            `https://prod.trackmania.core.nadeo.online/v2/mapRecords/?accountIdList=${accountList}&mapId=${m.mapId}`,
            CORE
          );
          records = records.concat(Array.isArray(single) ? single : []);
        } catch (err2) {
          console.error(`  ${m.name || m.mapId}: ${err2.message.slice(0, 100)}`);
        }
        await new Promise((r) => setTimeout(r, 700));
      }
    }

    // index records by mapId -> accountId -> time
    const byMap = {};
    (Array.isArray(records) ? records : []).forEach((rec) => {
      if (!rec.mapId || !rec.recordScore || rec.recordScore.time == null) return;
      byMap[rec.mapId] = byMap[rec.mapId] || {};
      byMap[rec.mapId][rec.accountId] = rec.recordScore.time;
    });

    chunk.forEach((m) => {
      checked++;
      const times = byMap[m.mapId] || {};
      const fresh = {};
      PLAYERS.forEach((p) => {
        const t = times[p.accountId];
        fresh[p.name] = t != null ? t <= m.authorTimeMs : false;
      });
      const old = JSON.stringify(m.playerHasAuthor || {});
      if (JSON.stringify(fresh) !== old) {
        m.playerHasAuthor = fresh;
        updated++;
      }
    });

    console.log(`Checked ${Math.min(i + CHUNK, maps.length)}/${maps.length} maps (${updated} changed so far)`);
    // save as we go so an interrupt loses nothing
    fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
    await new Promise((r) => setTimeout(r, 800));
  }

  results.medalsRefreshedAt = new Date().toISOString();
  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
  console.log(`\nDone. ${checked} maps checked, ${updated} medal statuses changed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
