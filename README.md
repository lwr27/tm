# tm-cotd-tracker (dockerized)

One container, one port: serves the API (talking to trackmania.io on the
server side) and the static frontend from the same origin, so there's no
CORS setup to think about.

## Run locally

```bash
docker compose up --build
```

Visit `http://localhost:3001`.

## Put it on a real website

1. Build and push the image somewhere your host can pull it from:

   ```bash
   docker build -t ghcr.io/YOUR_USER/tm-cotd-tracker:latest .
   docker push ghcr.io/YOUR_USER/tm-cotd-tracker:latest
   ```

2. On the server (your lab, a VPS, whatever), run it behind a reverse
   proxy that handles HTTPS — e.g. Caddy, Traefik, or nginx with certbot.
   Caddy is the least fuss if you've not got one already:

   ```
   yourdomain.com {
     reverse_proxy tm-cotd-tracker:3001
   }
   ```

3. Point DNS at the host, done. No further config changes needed — the
   frontend calls the API with relative paths, so it works under any
   domain automatically.

## Notes

- Friend lists are stored in each visitor's browser (`localStorage`), not
  on the server. If you want everyone in the group to see one shared
  list instead of each person adding friends themselves, that's a small
  change — swap `localStorage` for a couple of extra API endpoints
  backed by a JSON file or SQLite in the container. Say the word if you
  want that.
- `TM_USER_AGENT` is set via environment variable now (see
  `docker-compose.yml`) rather than hardcoded, so you can change it
  without rebuilding the image.
- trackmania.io's API is unofficial and undocumented — if a field ever
  goes missing or renames, the fix is almost always in the `results[...] =`
  line in `public/index.html`, mapping the actual response shape.
