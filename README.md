# PTTracker

A [PocketTavern](https://github.com/Starkka15/PocketTavern) extension that automatically extracts **Time**, **Location**, **Weather**, and **Heart Meter** data from AI responses and displays them in a neat status header above each AI message bubble.  Tracker tags are automatically stripped from the visible message text so they never appear in the chat bubble itself.

---

## What It Does

PTTracker injects a system prompt that instructs the AI to append four structured tags to every reply:

```
[time: HH:MM:SS; MM/DD/YYYY (DayOfWeek)]
[location: Full Location Description]
[weather: Weather Description, Temperature]
[heart: points_value]
```

After each AI message arrives, PTTracker parses those tags, stores the values in settings, and renders a compact header like:

```
Time: 08:15:00; 05/21/2001 (Monday)
Location: Mako Crystal Cave, Eastern Trail, Mount Nibel, Nibelheim
Weather: Cool and damp inside cave, sunny outside, 57°F
Heart Meter: 🖤 (0)
```

The raw tags are **stripped from the displayed message** via `PT.registerOutputFilter()` so the chat bubble stays clean.  If a tag is missing from the AI response, PTTracker falls back to the value stored in settings, or shows **Unknown**.

---

## Installation

1. In PocketTavern, open **Extensions → Install from URL**.
2. Enter the raw GitHub URL for this extension:
   ```
   https://raw.githubusercontent.com/Kuma3D/PTTracker/main/index.js
   ```
3. PTTracker will download and activate automatically.

---

## Tracker Fields

| Field | Description |
|-------|-------------|
| **Time** | In-world date and time in `HH:MM:SS; MM/DD/YYYY (DayOfWeek)` format |
| **Location** | Full in-world location description |
| **Weather** | Current weather conditions and temperature |
| **Heart Meter** | Romantic interest score with emoji indicator |

---

## Heart Meter

The Heart Meter tracks the AI character's romantic interest in the user. Points range from 0 upward and map to coloured heart emojis:

| Points | Emoji | Level |
|--------|-------|-------|
| 0 – 4,999 | 🖤 | Black Heart |
| 5,000 – 19,999 | 💜 | Purple Heart |
| 20,000 – 29,999 | 💙 | Blue Heart |
| 30,000 – 39,999 | 💚 | Green Heart |
| 40,000 – 49,999 | 💛 | Yellow Heart |
| 50,000 – 59,999 | 🧡 | Orange Heart |
| 60,000 – 69,999 | ❤️ | Red Heart |

The current heart value is saved in extension settings and persists across sessions. The maximum change per message is ±10,000 points.

---

## Editing Tracker Values

You can manually set or correct any tracker field directly in the extension settings (`PT.extension_settings['pt-tracker']`).  After saving, the updated values are immediately used as the fallback in the header and are also re-injected into the system prompt so the AI continues from the correct state.

---

## Output Filter

At initialisation PTTracker calls:

```javascript
PT.registerOutputFilter('pt-tracker', '\\[(?:time|location|weather|heart):\\s*[^\\]]*\\]');
```

PocketTavern's Kotlin layer (`JsExtensionHost.applyOutputFilters`) uses this regex to strip matching tags from the displayed message **after** the extension has already parsed them.  This means the header is populated correctly while the chat bubble shows clean narrative text.

---

## Quick-Reply Buttons

PTTracker registers two inline buttons inside each message header, shown when you long-press the header:

| Button | Action |
|--------|--------|
| ✏️ Edit | Opens a dialog to manually edit the tracker values for that message |
| 🔄 Regenerate | Sends a hidden OOC prompt asking the AI to reassess and re-output tracker tags for that message |

The buttons are toggled visible/hidden automatically by PocketTavern on long-press — no separate Hide button is needed.

---

## Configuration / Settings

All settings are stored in `PT.extension_settings['pt-tracker']` and persist across restarts.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Master on/off switch |
| `scanDepth` | number | `10` | Prompt injection depth (recent messages) |
| `defaultHeartPoints` | number | `0` | Initial heart points value |
| `heartPoints` | number | `0` | Current persisted heart points |
| `currentTime` | string | `''` | Editable current time (e.g. `"08:30:00; 06/20/2011 (Sunday)"`) |
| `currentLocation` | string | `''` | Editable current location (e.g. `"Town Square, Alexandria"`) |
| `currentWeather` | string | `''` | Editable current weather (e.g. `"Sunny, no overcast, 80°F"`) |
| `showTime` | boolean | `true` | Show the Time field in the header |
| `showLocation` | boolean | `true` | Show the Location field in the header |
| `showWeather` | boolean | `true` | Show the Weather field in the header |
| `showHeartMeter` | boolean | `true` | Show the Heart Meter field in the header |

---

## Example Tracker Output

**Example 1 — early relationship:**
```
Time: 08:15:00; 05/21/2001 (Monday)
Location: Mako Crystal Cave, Eastern Trail, Mount Nibel, Nibelheim
Weather: Cool and damp inside cave, sunny outside, 57°F
Heart Meter: 🖤 (0)
```

**Example 2 — growing affection:**
```
Time: 08:30:00; 06/20/2011 (Sunday)
Location: Town Square, Alexandria
Weather: Sunny, no overcast, 80°F
Heart Meter: 💜 (14000)
```

---

## File Structure

```
PTTracker/
├── index.js       — Extension logic
├── manifest.json  — Extension metadata
└── README.md      — This file
```

