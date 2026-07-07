// Builds the "division opponents" data: for every COTD one of the three
// players entered and actually played their division rounds in, who else
// was in that division — and since we know final division rank, who they
// beat and who beat them (Option A: higher division rank = the winner).
//
// Run with: npm run opponents
// Requires .env with NADEO_SERVER_LOGIN / NADEO_SERVER_PASSWORD.
//
// VERIFIED CHAIN (see probe-opponents.js for how this was confirmed):
//   1. A cup's trackmania.io `id` IS Nadeo's `competitionId` directly.
//   2. GET competitions/{id}/rounds -> one round per daily COTD.
//   3. GET rounds/{roundId}/matches?length=100&offset=0 -> up to ~29
//      matches; each match's `position` is (division - 1), e.g. "Match 8"
//      has position 7. Nadeo defaults to 10/page without the length param.
//   4. GET matches/{matchId}/results?length=100&offset=0 -> the full
//      division roster: { participant: accountId, rank: divisionRank }.
//      Same pagination default applies (confirmed: a 64-player division
//      only returned 10 rows without it). rank is null for players who
//      qualified but never played their rounds — skip those.
//
// Output: opponents.json — per player, a tally keyed by opponent account
// id: { name, faced, beaten, lostTo }. Incremental via processedCups.

const fs = require("fs");
const path = require("path");
const { nadeoFetch } = require("./nadeo-auth");

const LIVE = "NadeoLiveServices";
const CACHE_PATH = path.join(__dirname, "cache.json");
const OUT_PATH = path.join(__dirname, "opponents.json");

// Nadeo's match results only give raw account IDs, no display name. Name
// (and clan tag) resolution is handled entirely by the separate
// resolve-player-names.js script, which reads the accountIds tallied
// below out of opponents.json and writes to a standalone players.json —
// keeping one source of truth instead of two overlapping ones.

const PLAYERS = [
  { name: "XV27", accountId: "8b537233-4931-49a8-af54-b0cefc33fa72" },
  { name: "TheBreaker0", accountId: "07859bb1-b0bd-4748-b1bb-4ecb173786c6" },
  { name: "Pho3nix_.", accountId: "ede8dd52-dc02-4abc-a864-eb6e3934bc2b" },
];
// XV27's cups are cached under the merged "XV27 & Whidot" key.
const CUP_SOURCE = { "XV27": "XV27 & Whidot", "TheBreaker0": "TheBreaker0", "Pho3nix_.": "Pho3nix_." };

function loadOut() {
  if (fs.existsSync(OUT_PATH)) {
    try { return JSON.parse(fs.readFileSync(OUT_PATH, "utf8")); } catch (e) { /* rebuild */ }
  }
  return { players: {}, names: {}, processedCups: [], generatedAt: null };
}

async function getDivisionRoster(competitionId, division) {
  const rounds = await nadeoFetch(
    `https://meet.trackmania.nadeo.club/api/competitions/${competitionId}/rounds`,
    LIVE
  );
  const roundId = Array.isArray(rounds) && rounds[0] && rounds[0].id;
  if (!roundId) return null;

  const matchesResp = await nadeoFetch(
    `https://meet.trackmania.nadeo.club/api/rounds/${roundId}/matches?length=100&offset=0`,
    LIVE
  );
  const matches = Array.isArray(matchesResp) ? matchesResp : (matchesResp && matchesResp.matches) || [];
  if (!matches.length) return null;

  const wantPosition = division - 1;
  const match = matches.find((m) => m.position === wantPosition);
  if (!match) return null;

  const results = await nadeoFetch(
    `https://meet.trackmania.nadeo.club/api/matches/${match.id}/results?length=100&offset=0`,
    LIVE
  );
  const list = Array.isArray(results) ? results : (results && (results.results || results.players)) || [];
  // skip null-rank rows: qualified into the division but never played it
  return list.filter((r) => r.rank != null).map((r) => ({ accountId: r.participant, rank: r.rank }));
}

function main() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.error("cache.json not found — run `npm run update` first.");
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const out = loadOut();
  out.players = out.players || {};
  const processed = new Set(out.processedCups || []);

  // Group by competition id (== cup.id) so a cup shared by 2-3 of our
  // players only costs one rounds+matches lookup, even if their divisions
  // differ and each needs its own results call.
  const cupsById = {};
  PLAYERS.forEach((p) => {
    const cups = (cache.players[CUP_SOURCE[p.name]] && cache.players[CUP_SOURCE[p.name]].cups) || [];
    cups.forEach((c) => {
      if (c.id == null || c.div == null || c.divrank == null || c.divrank === 0) return; // must have actually played the division
      const entry = cupsById[c.id] || (cupsById[c.id] = { id: c.id, playersHere: [] });
      entry.playersHere.push({ accountId: p.accountId, name: p.name, division: c.div, divRank: c.divrank });
    });
  });

  const allIds = Object.keys(cupsById).filter((id) => !processed.has(id));
  console.log(`${Object.keys(cupsById).length} COTDs involve our players; ${allIds.length} still to process.\n`);

  const ensure = (name) => (out.players[name] = out.players[name] || {});
  const bump = (tally, oppId, field) => {
    const o = tally[oppId] || (tally[oppId] = { faced: 0, beaten: 0, lostTo: 0 });
    o[field] += 1;
  };

  (async () => {
    let done = 0;
    for (const id of allIds) {
      done++;
      const cup = cupsById[id];
      process.stdout.write(`[${done}/${allIds.length}] competition ${id} ... `);

      // group this cup's our-players by division, so we only fetch each
      // distinct division roster once even if 2 of us shared it
      const divisionsNeeded = [...new Set(cup.playersHere.map((p) => p.division))];
      const rosterByDiv = {};
      let failed = false;
      for (const div of divisionsNeeded) {
        try {
          rosterByDiv[div] = await getDivisionRoster(id, div);
        } catch (err) {
          console.log(`\n  division ${div} failed (${err.message.slice(0, 100)}) — will retry this cup on a later run`);
          failed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 900));
      }
      if (failed) { await new Promise((r) => setTimeout(r, 1500)); continue; }

      cup.playersHere.forEach((me) => {
        const roster = rosterByDiv[me.division];
        if (!roster) return;
        const tally = ensure(me.name);
        roster.forEach((opp) => {
          if (opp.accountId === me.accountId) return;
          bump(tally, opp.accountId, "faced");
          if (me.divRank < opp.rank) bump(tally, opp.accountId, "beaten");
          else if (me.divRank > opp.rank) bump(tally, opp.accountId, "lostTo");
        });
      });

      processed.add(id);
      out.processedCups = [...processed];
      out.generatedAt = new Date().toISOString();
      fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
      console.log("done");
      await new Promise((r) => setTimeout(r, 900));
    }
    console.log(`\nFinished tallying. ${processed.size} COTDs processed in total.`);
    console.log("Name/clan-tag resolution now happens separately — run `npm run names` next.");
  })().catch((err) => { console.error(err); process.exit(1); });
}

main();
