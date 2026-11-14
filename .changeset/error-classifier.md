---
"@debugkit/schema": minor
"@debugkit/ingest": minor
"@debugkit/dashboard": minor
---

Errors are labelled at ingest with a category, a likely owner, a user impact and causes (docs/taxonomy.md). The labels are stored with each error event and rolled up as new `category`, `owner` and `impact` dimensions. `/api/summary` adds `issues[].labels` and `breakdowns.category|owner|impact`, and the issue page has `issue.labels`. Issues stored before this release get their labels worked out when read. Also on the issue page: severity now ranks one level higher in critical flows, as it already did in the list.
