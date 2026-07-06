// Looks up trackmania.exchange style tags (Tech, Dirt, Ice, etc.) for every
// map that shows up in cache.json, and writes map-tags.json.
//
// Run with: npm run tags
// (run npm run update first so cache.json has cups to pull map UIDs from)
//
// Map tags never change once a map's uploaded, so this only fetches maps
// it hasn't already got a tag entry for — safe and fast to re-run.

const fs = require("fs");
const path = require("path");

const USER_AGENT = process.env.TM_USER_AGENT || "tm-cotd-tracker / contact: lewis (github.com/lwr27/lab)";
const TMX_BASE = "https://trackmania.exchange/api";
const CACHE_PATH = path.join(__dirname, "cache.json");
const TAGS_PATH = path.join(__dirname, "map-tags.json");

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    clearTimeout(timeout);
    if (res.status === 404) return null; // map not on TMX
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetry(url, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchJson(url);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const waitMs = Math.min(30000, 2000 * 2 ** attempt);
      console.warn(`  retrying in ${Math.round(waitMs / 1000)}s (${err.message})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function main() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.error("cache.json not found — run `npm run update` first.");
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const mapTags = fs.existsSync(TAGS_PATH) ? JSON.parse(fs.readFileSync(TAGS_PATH, "utf8")) : { tagNames: {}, maps: {} };

  // 1. tag ID -> name lookup, fetch once if we don't already have it
  if (!Object.keys(mapTags.tagNames).length) {
    console.log("Fetching tag name list from TMX...");
    const tags = await fetchWithRetry(`${TMX_BASE}/tags/gettags`);
    (tags || []).forEach((t) => { mapTags.tagNames[t.ID] = t.Name; });
  }

  // 2. collect every unique map UID across all players' cups, plus every
  //    TOTD map in authors.json (so the author-medal table can link to TMX)
  const uids = new Set();
  Object.values(cache.players).forEach((p) => {
    (p.cups || []).forEach((c) => { if (c.mapuid) uids.add(c.mapuid); });
  });
  const AUTHORS_PATH = path.join(__dirname, "authors.json");
  if (fs.existsSync(AUTHORS_PATH)) {
    try {
      const authors = JSON.parse(fs.readFileSync(AUTHORS_PATH, "utf8"));
      (authors.maps || []).forEach((m) => { if (m.mapUid) uids.add(m.mapUid); });
    } catch (e) { /* optional */ }
  }
  console.log(`${uids.size} unique maps found across cached cups + TOTD listing.`);

  let fetched = 0, skipped = 0, notFound = 0;
  for (const uid of uids) {
    const existing = mapTags.maps[uid];
    const needsBackfill = existing && existing.found && (existing.env === undefined || existing.mxid === undefined);
    if (existing && !needsBackfill) { skipped++; continue; }
    try {
      const info = await fetchWithRetry(`${TMX_BASE}/maps/get_map_info/uid/${uid}`);
      if (!info) {
        mapTags.maps[uid] = { found: false };
        notFound++;
      } else {
        const tagIds = (info.Tags || "").split(",").map((s) => s.trim()).filter(Boolean);
        const tagNames = tagIds.map((id) => mapTags.tagNames[id]).filter(Boolean);
        mapTags.maps[uid] = { found: true, name: info.Name, tags: tagNames, env: info.EnvironmentName || null, mxid: info.MapID ?? info.TrackID ?? null };
        fetched++;
      }
    } catch (err) {
      console.warn(`  ${uid}: failed (${err.message}), will retry next run`);
    }
    if ((fetched + notFound) % 25 === 0 && (fetched + notFound) > 0) {
      fs.writeFileSync(TAGS_PATH, JSON.stringify(mapTags, null, 2));
      console.log(`  progress: ${fetched} fetched, ${notFound} not on TMX, ${skipped} already cached`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  fs.writeFileSync(TAGS_PATH, JSON.stringify(mapTags, null, 2));
  console.log(`\nDone. ${fetched} fetched, ${notFound} not found on TMX, ${skipped} already cached.`);
  console.log(`Wrote ${TAGS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
