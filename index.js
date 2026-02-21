/**
 * PTTracker — PocketTavern Extension
 *
 * Scans recent AI messages for structured metadata tags and displays
 * Time, Location, Weather, and Heart Meter data in a status header
 * above each AI message bubble.
 *
 * Tags expected in AI responses:
 *   [time: HH:MM:SS; MM/DD/YYYY (DayOfWeek)]
 *   [location: Full Location Description]
 *   [weather: Weather Description, Temperature]
 *   [heart: points_value]
 */
(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /** Extension identifier — must match manifest.json "id". */
    const EXT_ID = 'pt-tracker';

    /**
     * Default settings applied the first time the extension loads
     * (or when a key is missing from persisted settings).
     */
    const DEFAULT_SETTINGS = {
        /** Master on/off switch. */
        enabled: true,
        /** Number of recent messages the prompt injection is anchored to. */
        scanDepth: 10,
        /** Starting heart points (used when resetting). */
        defaultHeartPoints: 0,
        /** Current persisted heart points value. */
        heartPoints: 0,
        /** Toggle individual display fields. */
        showTime: true,
        showLocation: true,
        showWeather: true,
        showHeartMeter: true,
    };

    // -------------------------------------------------------------------------
    // System Prompt
    // -------------------------------------------------------------------------

    /**
     * Instructs the AI to append structured tracker tags to every reply.
     * Uses {{user}} which PocketTavern substitutes with the persona name.
     */
    const TRACKER_PROMPT = `
[PTTracker Instructions]
At the end of EVERY response, you must include all four of the following tracker tags on separate lines. Keep them at the very end of your message, after any narrative content.

[time: HH:MM:SS; MM/DD/YYYY (DayOfWeek)]
[location: Full Location Description]
[weather: Weather Description, Temperature]
[heart: points_value]

Heart Meter Rules:
After each message, assess the character and {{user}}'s relationship and assign a heart points value showing the romantic interest the character has for {{user}}. The Heart Meter can increase or decrease depending on the interactions with {{user}}. The level it increases or decreases can range dramatically and can even go up and down entire heart levels in one post. The maximum amount of points it can increase or decrease is 10000.

Heart point ranges:
  0 – 4,999     → 🖤 Black Heart
  5,000 – 19,999  → 💜 Purple Heart
  20,000 – 29,999 → 💙 Blue Heart
  30,000 – 39,999 → 💚 Green Heart
  40,000 – 49,999 → 💛 Yellow Heart
  50,000 – 59,999 → 🧡 Orange Heart
  60,000 – 69,999 → ❤️ Red Heart

Example tags:
[time: 08:15:00; 05/21/2001 (Monday)]
[location: Mako Crystal Cave, Eastern Trail, Mount Nibel, Nibelheim]
[weather: Cool and damp inside cave, sunny outside, 57°F]
[heart: 0]
`.trim();

    // -------------------------------------------------------------------------
    // Heart Meter helpers
    // -------------------------------------------------------------------------

    /**
     * Maps a numeric heart-points value to the corresponding emoji.
     * Values below 0 are treated as 0; values above 69,999 map to ❤️.
     *
     * @param {number} points
     * @returns {string} emoji character
     */
    function getHeartEmoji(points) {
        if (points < 5000)  return '🖤';
        if (points < 20000) return '💜';
        if (points < 30000) return '💙';
        if (points < 40000) return '💚';
        if (points < 50000) return '💛';
        if (points < 60000) return '🧡';
        return '❤️';
    }

    // -------------------------------------------------------------------------
    // Tag parsing
    // -------------------------------------------------------------------------

    /**
     * Extracts the four tracker tags from an AI message string.
     *
     * @param {string} text  Raw AI message text.
     * @returns {{ time: string, location: string, weather: string, heart: string|null }}
     */
    function parseTags(text) {
        const extract = (pattern) => {
            const match = text.match(pattern);
            return match ? match[1].trim() : null;
        };

        return {
            time:     extract(/\[time:\s*([^\]]+)\]/i),
            location: extract(/\[location:\s*([^\]]+)\]/i),
            weather:  extract(/\[weather:\s*([^\]]+)\]/i),
            heart:    extract(/\[heart:\s*([^\]]+)\]/i),
        };
    }

    // -------------------------------------------------------------------------
    // Header builder
    // -------------------------------------------------------------------------

    /**
     * Builds the plain-text header string shown above an AI message bubble.
     *
     * @param {{ time: string|null, location: string|null, weather: string|null, heart: string|null }} tags
     * @param {object} settings  Current extension settings.
     * @returns {string}
     */
    function buildHeader(tags, settings) {
        const lines = [];

        if (settings.showTime) {
            lines.push(`Time: ${tags.time || 'Unknown'}`);
        }
        if (settings.showLocation) {
            lines.push(`Location: ${tags.location || 'Unknown'}`);
        }
        if (settings.showWeather) {
            lines.push(`Weather: ${tags.weather || 'Unknown'}`);
        }
        if (settings.showHeartMeter) {
            const pts = settings.heartPoints;
            const emoji = getHeartEmoji(pts);
            lines.push(`Heart Meter: ${emoji} (${pts})`);
        }

        return lines.join('\n');
    }

    // -------------------------------------------------------------------------
    // Settings helpers
    // -------------------------------------------------------------------------

    /**
     * Returns the current settings object, creating defaults for any missing keys.
     *
     * @returns {object}
     */
    function getSettings() {
        if (!PT.extension_settings[EXT_ID]) {
            PT.extension_settings[EXT_ID] = {};
        }
        const s = PT.extension_settings[EXT_ID];
        // Fill in any missing keys from defaults (non-destructive).
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (s[key] === undefined) {
                s[key] = value;
            }
        }
        return s;
    }

    // -------------------------------------------------------------------------
    // Prompt injection
    // -------------------------------------------------------------------------

    /**
     * (Re-)injects the tracker system prompt at the configured depth.
     */
    function injectPrompt() {
        const s = getSettings();
        if (!s.enabled) {
            // Remove the prompt when the extension is disabled.
            PT.setExtensionPrompt(EXT_ID, '', PT.INJECTION_POSITION.AFTER_CHAR_DEFS, s.scanDepth);
            return;
        }
        PT.setExtensionPrompt(
            EXT_ID,
            TRACKER_PROMPT,
            PT.INJECTION_POSITION.AFTER_CHAR_DEFS,
            s.scanDepth
        );
        PT.log(`[PTTracker] Prompt injected (scanDepth=${s.scanDepth}).`);
    }

    // -------------------------------------------------------------------------
    // Quick-reply buttons
    // -------------------------------------------------------------------------

    /** Default buttons shown when the AI is idle. */
    const DEFAULT_BUTTONS = [
        { label: '▶ Continue',        message: 'Please continue.' },
        { label: '🔄 Refresh Tracker', message: 'Please re-output your current tracker tags: [time:...] [location:...] [weather:...] [heart:...]' },
        { label: '💔 Reset Heart',     message: '__RESET_HEART__' },
    ];

    /** Buttons shown while a generation is in progress. */
    const STOP_BUTTONS = [
        { label: '⏹ Stop', message: '__STOP__' },
    ];

    /**
     * Registers the default quick-reply buttons.
     */
    function registerDefaultButtons() {
        PT.registerButtons(EXT_ID, DEFAULT_BUTTONS);
    }

    /**
     * Swaps to the Stop button during generation.
     */
    function registerStopButton() {
        PT.registerButtons(EXT_ID, STOP_BUTTONS);
    }

    // -------------------------------------------------------------------------
    // Message processing
    // -------------------------------------------------------------------------

    /**
     * Parses tags from an AI message, updates heart points, and sets the header.
     *
     * @param {string} text         Raw message text from the AI.
     * @param {number} messageIndex Index of the message in the chat.
     */
    function processAiMessage(text, messageIndex) {
        const s = getSettings();
        if (!s.enabled) return;

        const tags = parseTags(text);

        // Update persisted heart points if a valid number was found.
        if (tags.heart !== null) {
            const parsed = parseInt(tags.heart, 10);
            if (!isNaN(parsed)) {
                s.heartPoints = Math.max(0, parsed);
                PT.saveSettings();
                PT.log(`[PTTracker] Heart points updated to ${s.heartPoints}.`);
            }
        }

        const header = buildHeader(tags, s);
        PT.setMessageHeader(messageIndex, header);
        PT.log(`[PTTracker] Header set for message #${messageIndex}.`);
    }

    // -------------------------------------------------------------------------
    // Event handlers
    // -------------------------------------------------------------------------

    /** Fired when the AI sends a new message. */
    function onMessageReceived(event) {
        PT.log('[PTTracker] MESSAGE_RECEIVED');
        processAiMessage(event.text, event.index);
    }

    /** Fired when any message is edited. */
    function onMessageEdited(event) {
        PT.log('[PTTracker] MESSAGE_EDITED');
        if (!event.isUser) {
            // Only AI messages carry tracker tags.
            processAiMessage(event.text, event.index);
        } else {
            // If a user message is edited, clear any stale header.
            PT.clearMessageHeader(event.index);
        }
    }

    /** Fired when a message is deleted. */
    function onMessageDeleted() {
        PT.log('[PTTracker] MESSAGE_DELETED — a message was removed from the chat.');
    }

    /** Fired when text generation begins. */
    function onGenerationStarted() {
        PT.log('[PTTracker] GENERATION_STARTED');
        registerStopButton();
    }

    /** Fired when text generation ends or is cancelled. */
    function onGenerationStopped() {
        PT.log('[PTTracker] GENERATION_STOPPED');
        registerDefaultButtons();
    }

    /** Fired when the active chat changes. */
    function onChatChanged() {
        PT.log('[PTTracker] CHAT_CHANGED — clearing all headers.');
        PT.clearAllHeaders();
        injectPrompt();
    }

    /** Fired when the active character changes. */
    function onCharacterChanged() {
        PT.log('[PTTracker] CHARACTER_CHANGED — re-registering buttons.');
        registerDefaultButtons();
        injectPrompt();
    }

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    /**
     * Entry point — called once when PocketTavern loads the extension.
     */
    function init() {
        PT.log('[PTTracker] Initialising…');

        // Ensure settings exist with sensible defaults.
        getSettings();
        PT.saveSettings();

        // Inject the tracker system prompt.
        injectPrompt();

        // Register quick-reply buttons.
        registerDefaultButtons();

        // Subscribe to PT events.
        PT.eventSource.on(PT.events.MESSAGE_RECEIVED,    onMessageReceived);
        PT.eventSource.on(PT.events.MESSAGE_EDITED,      onMessageEdited);
        PT.eventSource.on(PT.events.MESSAGE_DELETED,     onMessageDeleted);
        PT.eventSource.on(PT.events.GENERATION_STARTED,  onGenerationStarted);
        PT.eventSource.on(PT.events.GENERATION_STOPPED,  onGenerationStopped);
        PT.eventSource.on(PT.events.CHAT_CHANGED,        onChatChanged);
        PT.eventSource.on(PT.events.CHARACTER_CHANGED,   onCharacterChanged);

        PT.log('[PTTracker] Ready.');
    }

    // Kick things off.
    init();

})();
