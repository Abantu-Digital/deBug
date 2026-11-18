---
"@debugkit/schema": minor
"@debugkit/dashboard": minor
---

Issue levels have their own colours, in light and dark mode: Critical red, High orange, Medium yellow and Low grey, plus green for healthy services and journeys (never for an issue). The level is always written out too, so colour never carries it alone. `SEVERITY_INFO` in `@debugkit/schema` gives each level's name and a one-line meaning. Badges on the overview and issue pages, and the flow chart's bars, use the new colours. The chart's tooltip names the level. New components (`LevelBadge`, `LevelBox`, `LevelRow`, `HealthTile`) are ready for the health screen and the ranked list. A test checks every level in both themes: text passes 4.5:1 and edges 3:1.
