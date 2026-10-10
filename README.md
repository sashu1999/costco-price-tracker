# Costco price tracker

A small personal tool: list item numbers from Costco receipts and see today's
in-store price at your warehouse. It flags when you're due a price adjustment
(the price dropped within 30 days of buying).

- **App:** https://sashu1999.github.io/costco-price-tracker/
- **Prices** come from costco.com's public product API, which returns per-warehouse
  in-store prices by item number (no login). This month's warehouse coupons are
  read from costco.com's Warehouse Savings page and taken off.
- **Scheduled check:** `.github/workflows/check.yml` runs every morning, saves
  prices to `data/history.json`, and opens a GitHub issue when a price drops or an
  adjustment is due (GitHub emails you about new issues).

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The whole app (GitHub Pages). |
| `data/items.json` | Your items: item number, price paid, date bought, note. |
| `data/config.json` | Warehouse number (233 = Pentagon City). |
| `data/coupons.json`, `data/history.json`, `data/latest.json` | Written by the scheduled check. |
| `tracker/` | Python used by the scheduled check (`python tracker/run.py`). |

Items you add are kept in your browser. To also get email alerts, paste a fine-grained GitHub token
(this repo only, Contents: read and write) under Settings, so items are saved to the repo. It is kept in
your browser only.

## Accounts and email alerts (Supabase)

With `config.js` filled in, people create an account (password, then an emailed sign-in link or code).
Each account keeps its own items and store (picked by ZIP code under **Store & alerts**).

Every morning `tracker/alerts.py` checks each account's items at that account's store, saves prices to
`price_history`, and emails each person the drops they can claim (once per drop). It needs these
repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API keys → secret key (never put it in the page) |
| `GMAIL_USER` | The Gmail address alerts are sent from |
| `GMAIL_APP_PASSWORD` | A Google app password for that address |

Run `supabase/schema.sql` again in the SQL Editor after updating; it is safe to re-run.
