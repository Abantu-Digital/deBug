---
"@debugkit/dashboard": minor
---

The dashboard opens on a health wall (ABA-141). Every backend service, and the app's own code, is a box filled with its level's colour: red (critical), orange (high), yellow (medium), grey (low), green (healthy). Boxes are ranked worst first, and one still failing in the last hour pulses. Each box says what's wrong in one line: the status, the backend's own code and message, and the call. A paragraph at the top answers "why is it breaking?" and can be copied for a client. A level chip shows only that level.

Clicking a service opens its page (`/services/<name>`). Its endpoints are listed worst first, each with what the server said, how often, and the issues behind it. Each issue is one click from its cause and fix. The App code box opens `/app-code`: the app's own crashes and code errors, the same way. Resolved and ignored issues are folded away at the bottom of each page. The old overview page is gone: issues are reached by drilling down, and `/issues` goes to Health. Its charts, breakdowns and release health are still in `GET /api/summary`. The main menu shows which page you're on, and issue pages have a trail back (Health › balance). The Endpoints page's service boxes use the same colours and open the same pages. Services whose names differ only by case or a trailing "s" are now one service.
