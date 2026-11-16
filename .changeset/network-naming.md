---
"@debugkit/sdk": minor
---

Named API calls and backend error details. Set `network.baseUrls` and each request's breadcrumb is named by service (the first path segment after the base, so services behind one gateway each get a name) with its path, method, status, duration and outcome. When a call fails, what the backend said in its problem-details body (`title`, `code`, `traceId`, `errors`) is added to the breadcrumb, with phone numbers and emails masked, for fetch and XHR (axios on React Native, including `arraybuffer` responses). A fetch failure is reported once its body is read, at most 3 seconds later. Error messages, and so issue grouping, are unchanged. An `isFailure` that throws now counts the call as not failed, instead of throwing inside the request's listener.
