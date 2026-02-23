# PTTracker

A [PocketTavern](https://github.com/Starkka15/PocketTavern) extension that automatically extracts **Time**, **Location**, **Weather**, **Heart Meter**, and **Characters Present** data from AI responses and displays them in a structured header above each AI message bubble. Raw tracker tags are automatically stripped from the visible message text so the chat bubble always shows clean narrative.

---

## Features

- **Always-visible status bar** — ⏰ Time, 🗺️ Location, 🌤️ Weather, and 💘 Heart Meter displayed above every AI message
- **Collapsible Characters section** — tap the chevron to expand a full character breakdown showing each character's Outfit, State, and Position on separate labeled lines
- **Heart Meter** — tracks romantic interest (0–69,999) across 7 color-coded emoji levels
- **Per-message Edit** — long-press any header to manually correct tracker values for that message
- **Per-message Regenerate** — long-press any header to re-ask the AI to infer fresh tracker values from scene context
- **Persistent state** — all tracker values save with the chat and survive app restarts
- **Clean output** — tracker tags are stripped from the visible message bubble via `PT.registerOutputFilter()`
- **`[heart_default: N]`** — set a starting heart value in a character's definition that auto-applies on first load

---

## Installation

1. In PocketTavern, open **Extensions → Install from URL**
2. Paste the raw URL for this extension:
   ```
   https://raw.githubusercontent.com/Kuma3D/PTTracker/main/index.js
   ```
3. PTTracker downloads and activates automatically

---

## How It Works

PTTracker injects a system prompt instructing the AI to append structured tags at the end of every response:

```
[time: 8:15 AM; 05/21/2001 (Monday)]
[location: Mako Crystal Cave, Eastern Trail, Mount Nibel]
[weather: Cool and damp, sunny outside, 57°F]
[heart: 5000]
[char: Alice | outfit: Blue dress | state: Happy | position: Near the fountain]
[char: Bob | outfit: Casual jeans | state: Nervous | position: On the bench]
```

PTTracker parses these tags, stores the data, and renders a header. The raw tags are stripped from the displayed message so the chat bubble shows only narrative text.

If a tag is missing from a response, PTTracker falls back to the value from the previous message, then to the persisted settings value, then to **Unknown**.

---

## Header Layout

**Always visible:**
```
⏰ Time: 8:15 AM; 05/21/2001 (Monday)
🗺️ Location: Mako Crystal Cave, Eastern Trail, Mount Nibel
🌤️ Weather: Cool and damp, sunny outside, 57°F
💘 Heart Meter: 🖤 0
```

**Tap chevron to expand (Characters Present):**
```
Characters Present:

Alice
  Outfit: Blue dress
  State: Happy
  Position: Near the fountain

Bob
  Outfit: Casual jeans
  State: Nervous
  Position: On the bench
```

---

## Heart Meter

Tracks the AI character's romantic interest in `{{user}}`. The AI adjusts the value based on each interaction, with a maximum shift of ±10,000 points per message.

| Points | Emoji |
|--------|-------|
| 0 – 4,999 | 🖤 |
| 5,000 – 19,999 | 💜 |
| 20,000 – 29,999 | 💙 |
| 30,000 – 39,999 | 💚 |
| 40,000 – 49,999 | 💛 |
| 50,000 – 59,999 | 🧡 |
| 60,000 – 69,999 | ❤️ |

To set a starting value for a specific character, add a `[heart_default: N]` tag anywhere in their description, personality, or scenario fields. PTTracker reads this on first load and uses it as the initial heart points (only if the current value is 0).

---

## Long-Press Actions

Long-press any message header to reveal two action buttons:

| Button | Action |
|--------|--------|
| ✏️ Edit | Opens a dialog to manually edit Time, Location, Weather, Heart Points, and Characters for that message |
| 🔄 Regenerate | Sends a hidden prompt asking the AI to re-infer all tracker values from surrounding story context |

When editing Characters, enter each character on a separate entry separated by `;`:
```
Alice | outfit: Blue dress | state: Happy | position: Near the fountain; Bob | outfit: Jeans | state: Nervous | position: On the bench
```

---

## Settings

All settings are stored in `PT.extension_settings['pt-tracker']` and persist across restarts.

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Master on/off switch |
| `scanDepth` | `10` | How many recent messages the injected prompt is anchored to |
| `defaultHeartPoints` | `0` | Initial heart points (overridden by `[heart_default: N]` if present) |
| `heartPoints` | `0` | Current persisted heart points |
| `currentTime` | `''` | Last known time value |
| `currentLocation` | `''` | Last known location value |
| `currentWeather` | `''` | Last known weather value |
| `currentCharacters` | `[]` | Last known characters array |
| `showTime` | `true` | Show ⏰ Time in the header |
| `showLocation` | `true` | Show 🗺️ Location in the header |
| `showWeather` | `true` | Show 🌤️ Weather in the header |
| `showHeartMeter` | `true` | Show 💘 Heart Meter in the header |
| `showCharacters` | `true` | Show the collapsible Characters section |

---

## File Structure

```
PTTracker/
├── index.js       — Extension logic
├── manifest.json  — Extension metadata
└── README.md      — This file
```

---

## Author

Made by [Kuma3D](https://github.com/Kuma3D)
Built for [PocketTavern](https://github.com/Starkka15/PocketTavern) by [Starkka15](https://github.com/Starkka15)
