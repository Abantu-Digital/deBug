---
"@debugkit/adapters": minor
"@debugkit/ingest": minor
"@debugkit/dashboard": minor
"@debugkit/cli": minor
---

You choose how long raw events are kept, and every view takes a date range.

- **Retention:**
  - `npx debugkit init` asks how long to keep raw events: 30, 60 (default), 90, 180, 365 days, or any number. It shows a rough storage cost.
  - The dashboard's new Settings page shows the current period, changes it per app, and can apply it to events already stored.
  - The setting is stored in your own database (a settings record per app). Ingest reads it, cached for a minute, and falls back to `DEBUG_RETENTION_DAYS`.
  - Counts, issues and release health are still kept forever.
- **Admin routes on ingest:** `GET/PUT /admin/settings` and `POST /admin/restamp`, protected by `DEBUG_ADMIN_TOKEN`. The dashboard calls them, so its database credentials stay read-only.
- **Date ranges:**
  - The overview and issue pages take 24h, 7, 14, 30 or 90 days, or a custom range, with a comparison against the previous period.
  - Charts are hourly for 24h, daily up to 90 days and weekly beyond.
  - The range is in the URL and in `/api/summary` and `/api/issues/:fp` (`range`, `from`, `to`).
  - Summary fields now say "Range" instead of "14d": `errorsRange`, `eventsRange`, `sessionsRange`, `failuresRange`.
- **Adapters:**
  - `getSettings`, `putSettings`, `restampExpiry`, and `writeEvents(events, { retentionDays })`.
  - Hourly counters expire after 7 days. Firestore needs the TTL rule on `rollups.expireAt` from the updated `firestore.indexes.json`.
