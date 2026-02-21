# PTTracker

A [PocketTavern](https://github.com/Starkka15/PocketTavern) extension that automatically extracts **Time**, **Location**, **Weather**, and **Heart Meter** data from AI responses and displays them in a neat status header above each AI message bubble.

---

## What It Does

PTTracker injects a system prompt that instructs the AI to append four structured tags to every reply:

```
[time: HH:MM:SS; MM/DD/YYYY (DayOfWeek)]
[location: Full Location Description]
[weather: Weather Description, Temperature]
[heart: points_value]
```

After each AI message arrives, PTTracker parses those tags and renders a compact header like:

```
Time: 08:15:00; 05/21/2001 (Monday)
Location: Mako Crystal Cave, Eastern Trail, Mount Nibel, Nibelheim
Weather: Cool and damp inside cave, sunny outside, 57°F
Heart Meter: 🖤 (0)
```

If a tag is missing from the AI response, the field shows **Unknown**.

---

## Installation

1. Locate your PocketTavern **Extensions** directory (typically `PocketTavern/extensions/`).
2. Copy (or clone) this folder into that directory so the path becomes:
   ```
   PocketTavern/extensions/PTTracker/
   ```
3. Restart PocketTavern (or reload the extension list).
4. PTTracker will activate automatically on the next chat.

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

## Quick-Reply Buttons

PTTracker registers three convenience buttons:

| Button | Sends |
|--------|-------|
| ▶ Continue | "Please continue." |
| 🔄 Refresh Tracker | Asks the AI to re-output its current tracker tags |
| 💔 Reset Heart | Resets heart points to the configured default |

During generation the buttons are replaced with a ⏹ **Stop** button and restored when generation ends.

---

## Configuration / Settings

All settings are stored in `PT.extension_settings['pt-tracker']` and persist across restarts.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Master on/off switch |
| `scanDepth` | number | `10` | Prompt injection depth (recent messages) |
| `defaultHeartPoints` | number | `0` | Value used when resetting the Heart Meter |
| `heartPoints` | number | `0` | Current persisted heart points |
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
