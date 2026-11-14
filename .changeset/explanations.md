---
"@debugkit/ingest": minor
"@debugkit/dashboard": minor
---

Explanations: every issue gets a plain summary for support (what the user saw, where, for how many people, after which action, whether it's still happening, who to pass it to) and technical detail for developers (category, owner and impact, evidence, where in the code and what started it, a suggested fix). One template per category, no LLM. They're on the issue page, which can copy them as Markdown for a ticket, in `/api/summary` as `issues[].explanation`, and in the prefilled Linear and GitHub links. `evidenceOf()` in `@debugkit/ingest` exposes the facts behind the labels. The generic network, auth and server hints are replaced by the explanation.
