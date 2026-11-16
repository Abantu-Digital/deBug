---
"@debugkit/sdk": minor
---

Named API calls and backend error details. Set `network.baseUrls` and each request's breadcrumb is named by service (the first path segment after the base, so services behind one gateway each get a name) with its path, method, status, duration and outcome. When a call fails, what the backend said in its problem-details body (`title`, `code`, `traceId`, `errors`) is added to the breadcrumb, for fetch and XHR (axios on React Native). Error messages, and so issue grouping, are unchanged.
