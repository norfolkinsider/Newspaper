# The Norfolk Insider — Setup

## What's built

Three content sources, fully automated:
- **Weather** — Open-Meteo API (free, no key) → Claude writes sassy blurb
- **News** — Norfolk Today + CBC Hamilton RSS feeds → Claude picks 3 best local stories
- **Events** — Your Airtable Insider Submissions table

Runs every morning at 8am automatically.

---

## Deploy

### 1. Push to GitHub
```bash
git init && git add . && git commit -m "init"
git remote add origin https://github.com/YOU/norfolk-insider.git
git push -u origin main
```

### 2. Connect Netlify
- New site → Import from GitHub
- Publish directory: `.`
- Build command: *(leave blank)*

### 3. Set environment variables in Netlify
| Variable | Value |
|---|---|
| `AIRTABLE_TOKEN` | Your Airtable personal access token (needs read access to appAtE1hE5frgdQFo) |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `TRIGGER_SECRET` | Any password you choose |

### 4. Generate first edition
Visit once to seed the content:
```
https://norfolkinsider.com/api/trigger?secret=YOUR_TRIGGER_SECRET
```

After that — fully automatic every morning.

---

## Files
```
index.html                          ← The site
netlify/functions/
  daily-engine.mts                  ← Runs 8am daily (scheduled)
  get-edition.mts                   → /api/edition
  trigger.mts                       → /api/trigger?secret=...
netlify.toml
package.json
```
