/**
 * PTTracker — PocketTavern Extension
 *
 * Scans AI messages for structured metadata tags and displays
 * Time, Location, Weather, and Heart Meter data in a status header
 * above each AI message bubble.  The raw tags are stripped from the
 * displayed message text via PT.registerOutputFilter().
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
    var EXT_ID = 'pt-tracker';

    /**
     * Regex pattern registered with PT.registerOutputFilter() so PocketTavern's
     * Kotlin side (JsExtensionHost.applyOutputFilters) strips the tracker tags
     * from the displayed message bubble AFTER the extension has parsed them.
     * The doubled backslashes are JavaScript string escaping — the Kotlin side
     * receives the single-backslash regex: \[(?:time|location|weather|heart):\s*[^\]]*\]
     */
    var OUTPUT_FILTER_PATTERN = '\\[(?:time|location|weather|heart):\\s*[^\\]]*\\]';

    /**
     * Default settings applied the first time the extension loads
     * (or when a key is missing from persisted settings).
     */
    var DEFAULT_SETTINGS = {
        /** Master on/off switch. */
        enabled: true,
        /** Number of recent messages the prompt injection is anchored to. */
        scanDepth: 10,
        /** Starting heart points (used as the initial value). */
        defaultHeartPoints: 0,
        /** Current persisted heart points value. */
        heartPoints: 0,
        /** Editable tracker fields — user can set these manually in settings. */
        currentTime: '',
        currentLocation: '',
        currentWeather: '',
        /** Toggle individual display fields. */
        showTime: true,
        showLocation: true,
        showWeather: true,
        showHeartMeter: true,
    };

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
     * @returns {{ time: string|null, location: string|null, weather: string|null, heart: string|null }}
     */
    function parseTags(text) {
        function extract(pattern) {
            var match = text.match(pattern);
            return match ? match[1].trim() : null;
        }

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
     * Falls back to the stored settings values when a tag is missing from
     * the AI response, and to "Unknown" when settings are also empty.
     *
     * @param {{ time: string|null, location: string|null, weather: string|null, heart: string|null }} tags
     * @param {object} settings  Current extension settings.
     * @returns {string}
     */
    function buildHeader(tags, settings) {
        var lines = [];

        if (settings.showTime) {
            var timeVal = tags.time || settings.currentTime || 'Unknown';
            lines.push('Time: ' + timeVal);
        }
        if (settings.showLocation) {
            var locVal = tags.location || settings.currentLocation || 'Unknown';
            lines.push('Location: ' + locVal);
        }
        if (settings.showWeather) {
            var weatherVal = tags.weather || settings.currentWeather || 'Unknown';
            lines.push('Weather: ' + weatherVal);
        }
        if (settings.showHeartMeter) {
            var pts = settings.heartPoints;
            var emoji = getHeartEmoji(pts);
            lines.push('Heart Meter: ' + emoji + ' (' + pts + ')');
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
        var s = PT.extension_settings[EXT_ID];
        // Fill in any missing keys from defaults (non-destructive).
        var keys = Object.keys(DEFAULT_SETTINGS);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (s[key] === undefined) {
                s[key] = DEFAULT_SETTINGS[key];
            }
        }
        return s;
    }

    // -------------------------------------------------------------------------
    // Prompt injection
    // -------------------------------------------------------------------------

    /**
     * Builds the tracker system prompt including the current tracker state
     * so the AI knows the starting point.  Uses {{user}} which PocketTavern
     * substitutes with the persona name.
     *
     * @param {object} settings  Current extension settings.
     * @returns {string}
     */
    function buildPrompt(settings) {
        var currentState = [
            '[time: ' + (settings.currentTime || 'unknown') + ']',
            '[location: ' + (settings.currentLocation || 'unknown') + ']',
            '[weather: ' + (settings.currentWeather || 'unknown') + ']',
            '[heart: ' + settings.heartPoints + ']',
        ].join('\n');

        return (
            '[PTTracker Instructions]\n' +
            'At the end of EVERY response, you must include all four of the following tracker tags on separate lines. Keep them at the very end of your message, after any narrative content.\n' +
            '\n' +
            '[time: HH:MM:SS; MM/DD/YYYY (DayOfWeek)]\n' +
            '[location: Full Location Description]\n' +
            '[weather: Weather Description, Temperature]\n' +
            '[heart: points_value]\n' +
            '\n' +
            'Heart Meter Rules:\n' +
            'After each message, assess the character and {{user}}\'s relationship and assign a heart points value showing the romantic interest the character has for {{user}}. The Heart Meter can increase or decrease depending on the interactions with {{user}}. The level it increases or decreases can range dramatically and can even go up and down entire heart levels in one post. The maximum amount of points it can increase or decrease is 10000.\n' +
            '\n' +
            'Heart point ranges:\n' +
            '  0 – 4,999     → 🖤 Black Heart\n' +
            '  5,000 – 19,999  → 💜 Purple Heart\n' +
            '  20,000 – 29,999 → 💙 Blue Heart\n' +
            '  30,000 – 39,999 → 💚 Green Heart\n' +
            '  40,000 – 49,999 → 💛 Yellow Heart\n' +
            '  50,000 – 59,999 → 🧡 Orange Heart\n' +
            '  60,000 – 69,999 → ❤️ Red Heart\n' +
            '\n' +
            'Current tracker state (continue from here):\n' +
            currentState + '\n' +
            '\n' +
            'Example tags:\n' +
            '[time: 08:15:00; 05/21/2001 (Monday)]\n' +
            '[location: Mako Crystal Cave, Eastern Trail, Mount Nibel, Nibelheim]\n' +
            '[weather: Cool and damp inside cave, sunny outside, 57°F]\n' +
            '[heart: 0]'
        );
    }

    /**
     * (Re-)injects the tracker system prompt at the configured depth.
     * Called at init and whenever settings change so the AI always sees
     * the latest tracker state.
     */
    function injectPrompt() {
        var s = getSettings();
        if (!s.enabled) {
            // Remove the prompt when the extension is disabled.
            PT.setExtensionPrompt(EXT_ID, '', PT.INJECTION_POSITION.AFTER_CHAR_DEFS, s.scanDepth);
            return;
        }
        PT.setExtensionPrompt(
            EXT_ID,
            buildPrompt(s),
            PT.INJECTION_POSITION.AFTER_CHAR_DEFS,
            s.scanDepth
        );
        PT.log('[PTTracker] Prompt injected (scanDepth=' + s.scanDepth + ').');
    }

    // -------------------------------------------------------------------------
    // Quick-reply buttons
    // -------------------------------------------------------------------------

    /**
     * Default buttons shown when the AI is idle.
     * - Edit Tracker: sends empty string (hint to user to edit via settings)
     * - Regenerate Tracker: asks the AI to re-output its tracker tags
     */
    var DEFAULT_BUTTONS = [
        { label: '\u270F\uFE0F Edit Tracker',       message: '' },
        { label: '\uD83D\uDD04 Regenerate Tracker', message: '[OOC: Please reassess and re-output your tracker tags for the current scene: [time:...] [location:...] [weather:...] [heart:...]]' },
    ];

    /** Buttons shown while a generation is in progress. */
    var STOP_BUTTONS = [
        { label: '\u23F9 Stop', message: '' },
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
     * Parses tags from an AI message, updates persisted tracker fields,
     * rebuilds the header, and re-injects the prompt with the updated state.
     *
     * @param {string} text         Raw message text from the AI.
     * @param {number} messageIndex Index of the message in the chat.
     */
    function processAiMessage(text, messageIndex) {
        var s = getSettings();
        if (!s.enabled) return;

        var tags = parseTags(text);

        // Update persisted tracker fields from parsed tags.
        if (tags.time !== null)     { s.currentTime     = tags.time; }
        if (tags.location !== null) { s.currentLocation = tags.location; }
        if (tags.weather !== null)  { s.currentWeather  = tags.weather; }

        // Update persisted heart points if a valid number was found.
        if (tags.heart !== null) {
            var parsed = parseInt(tags.heart, 10);
            if (!isNaN(parsed)) {
                s.heartPoints = Math.max(0, parsed);
                PT.log('[PTTracker] Heart points updated to ' + s.heartPoints + '.');
            }
        }

        PT.saveSettings();

        var header = buildHeader(tags, s);
        PT.setMessageHeader(messageIndex, header);
        PT.log('[PTTracker] Header set for message #' + messageIndex + '.');

        // Re-inject prompt so the AI always sees the latest tracker state.
        injectPrompt();
    }

    // -------------------------------------------------------------------------
    // Event handlers
    // -------------------------------------------------------------------------

    /**
     * Fired when the AI sends a new message.
     * data = { text: string, index: number, isUser: boolean }
     */
    function onMessageReceived(data) {
        PT.log('[PTTracker] MESSAGE_RECEIVED');
        processAiMessage(data.text, data.index);
    }

    /**
     * Fired when any message is edited.
     * data = { text: string, index: number, isUser: boolean }
     */
    function onMessageEdited(data) {
        PT.log('[PTTracker] MESSAGE_EDITED');
        if (!data.isUser) {
            // Only AI messages carry tracker tags.
            processAiMessage(data.text, data.index);
        } else {
            // If a user message is edited, clear any stale header.
            PT.clearMessageHeader(data.index);
        }
    }

    /** Fired when a message is deleted. */
    function onMessageDeleted() {
        PT.log('[PTTracker] MESSAGE_DELETED — message removed; no header action needed.');
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

        // Register the output filter so PocketTavern's Kotlin side strips tracker
        // tags from displayed message bubbles AFTER this extension has parsed them.
        PT.registerOutputFilter(EXT_ID, OUTPUT_FILTER_PATTERN);
        PT.log('[PTTracker] Output filter registered.');

        // Inject the tracker system prompt.
        injectPrompt();

        // Register quick-reply buttons.
        registerDefaultButtons();

        // Subscribe to PT events.
        PT.eventSource.on(PT.events.MESSAGE_RECEIVED,   onMessageReceived);
        PT.eventSource.on(PT.events.MESSAGE_EDITED,     onMessageEdited);
        PT.eventSource.on(PT.events.MESSAGE_DELETED,    onMessageDeleted);
        PT.eventSource.on(PT.events.GENERATION_STARTED, onGenerationStarted);
        PT.eventSource.on(PT.events.GENERATION_STOPPED, onGenerationStopped);
        PT.eventSource.on(PT.events.CHAT_CHANGED,       onChatChanged);
        PT.eventSource.on(PT.events.CHARACTER_CHANGED,  onCharacterChanged);

        PT.log('[PTTracker] Ready.');
    }

    // Kick things off.
    init();

})();
