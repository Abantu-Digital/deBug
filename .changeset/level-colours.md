---
"@debugkit/dashboard": minor
---

Issue levels have their own colours, in light and dark mode: Critical red, High orange, Medium yellow and Low grey, plus green for healthy services and journeys (never for an issue). The level is always written out too, so colour never carries it alone. Badges on the overview and issue pages use them. New components (`LevelBadge`, `LevelBox`, `LevelRow`, `HealthTile`) are ready for the health screen and the ranked list. A test checks that every level's text passes 4.5:1 contrast.
