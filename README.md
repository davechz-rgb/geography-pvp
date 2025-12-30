# Geography Trainer PvP (MVP)

This is a minimal "Pregunta2-style" PvP mode:
- Create room / Join room
- Same questions + same options for both players (server-seeded)
- Winner = most correct; tie-breaker = faster total answer time

## Run locally
1) Install Node 18+
2) `npm install`
3) `npm start`
Open http://localhost:3000

## Deploy free (Render)
1) Push this repo to GitHub
2) On Render: New > Web Service > connect repo
3) Build Command: `npm install`
4) Start Command: `npm start`
5) Done. Your Render URL hosts BOTH the site and the realtime server.
