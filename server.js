// Trackmania COTD proxy
//
// Why this exists: trackmania.io's API asks callers to send a descriptive
// User-Agent, and browsers won't let JS set that header, plus the API isn't
// set up for arbitrary cross-origin browser calls. This tiny server sits in
// between: it calls trackmania.io properly, and hands your React app clean
// JSON with CORS wide open for your own use.
//
// Run it with:  npm install && npm start
// Then point the frontend's "Proxy URL" field at http://localhost:3001

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;

// >>> EDIT THIS <<<
// trackmania.io asks that you identify your project + a contact method.
const USER_AGENT = "tm-cotd-tracker / contact: lewis (github.com/lwr27/lab)";

const BASE = "https://trackmania.io/api";

async function tmFetch(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`trackmania.io ${path} -> ${res.status}`);
  }
  return res.json();
}

// Look up players by display name -> [{ name, accountId }]
app.get("/api/search", async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: "missing ?name=" });
  try {
    const data = await tmFetch(`/players/find?search=${encodeURIComponent(name)}`);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Basic player info (display name, trophies, zone)
app.get("/api/player/:accountId", async (req, res) => {
  try {
    const data = await tmFetch(`/player/${req.params.accountId}`);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// COTD results, paginated 25 at a time (page=0 is most recent)
app.get("/api/player/:accountId/cotd/:page", async (req, res) => {
  try {
    const data = await tmFetch(
      `/player/${req.params.accountId}/cotd/${req.params.page}`
    );
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Put dashboard.html in the same folder as this file, then visit
// http://localhost:3001/dashboard.html — serving it from here (rather than
// double-clicking the file) avoids browsers blocking file:// pages from
// calling localhost.
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.redirect("/dashboard.html");
});

app.listen(PORT, () => {
  console.log(`tm-cotd-proxy listening on http://localhost:${PORT}`);
});
