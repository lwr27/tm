// PROBE ONLY — not the real feature. Tests one thing: does a cup's
// trackmania.io `id` (stored in cache.json) work directly as Nadeo's
// `competitionId` on the Meet API? If yes, the full opponents feature is
// straightforward. If no, we need an extra lookup step and this tells us
// exactly what's missing before we build the whole thing on a guess again.
//
// Run with: node probe-opponents.js

const fs = require("fs");
const path = require("path");
const { nadeoFetch } = require("./nadeo-auth");

const LIVE = "NadeoLiveServices";
const CACHE_PATH = path.join(__dirname, "cache.json");

async function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  // grab one recent, real, valid cup from any player
  let sample = null;
  for (const name of Object.keys(cache.players)) {
    const cups = cache.players[name].cups || [];
    const candidate = cups.slice().reverse().find((c) => c.id != null && c.div != null && c.divrank);
    if (candidate) { sample = { name, cup: candidate }; break; }
  }
  if (!sample) { console.log("No usable cup found in cache.json to test with."); return; }

  console.log(`Testing with ${sample.name}'s cup:`, JSON.stringify(sample.cup).slice(0, 300));
  console.log(`\nTrying trackmania.io cup id ${sample.cup.id} as a Nadeo competitionId...\n`);

  try {
    const rounds = await nadeoFetch(
      `https://meet.trackmania.nadeo.club/api/competitions/${sample.cup.id}/rounds`,
      LIVE
    );
    console.log("SUCCESS — rounds response:");
    console.log(JSON.stringify(rounds).slice(0, 800));

    const roundId = Array.isArray(rounds) && rounds[0] && rounds[0].id;
    if (!roundId) { console.log("\nNo round id found — stopping here."); return; }

    console.log(`\nFetching matches for round ${roundId}...\n`);
    const matches = await nadeoFetch(
      `https://meet.trackmania.nadeo.club/api/rounds/${roundId}/matches`,
      LIVE
    );
    console.log(`Matches response (${Array.isArray(matches) ? matches.length : '?'} matches):`);
    console.log(JSON.stringify(Array.isArray(matches) ? matches.slice(0, 3) : matches).slice(0, 1000));

    if (!Array.isArray(matches) || !matches.length) { console.log("\nNo matches array — stopping here."); return; }

    // our player's actual division this cup, to try to line up with a match
    console.log(`\n${sample.name} was in division ${sample.cup.div} this cup — looking for a matching match...`);

    const firstMatchId = matches[0].id;
    console.log(`\nFetching results for match ${firstMatchId} (first match in the list, just to see the shape)...\n`);
    const results = await nadeoFetch(
      `https://meet.trackmania.nadeo.club/api/matches/${firstMatchId}/results`,
      LIVE
    );
    console.log("Match results response:");
    console.log(JSON.stringify(results).slice(0, 1200));
  } catch (err) {
    console.log("FAILED:", err.message.slice(0, 300));
    console.log("\nThis likely means trackmania.io's cup id is NOT the same as Nadeo's competition id.");
    console.log("We'd need another way to resolve one from the other before this feature is viable.");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
