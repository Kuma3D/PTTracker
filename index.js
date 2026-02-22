/**
 * PTTracker — PocketTavern Extension
 *
 * Scans AI messages for structured metadata tags and displays
 * Time, Location, Weather, and Heart Meter data in a status header
 * above each AI message bubble.  The raw tags are stripped from the
 * displayed message text via PT.registerOutputFilter().
 *
 * Tags expected in AI responses:
 *   [time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)]
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

    /** Stores tracker state per message index: { [messageIndex]: { currentTime, currentLocation, currentWeather, heartPoints } } */
    var _perMessageTracker = {};

    /** Tracks which message headers currently have their action buttons showing. */
    var _headerButtonsVisible = {};

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
    // Time helpers
    // -------------------------------------------------------------------------

    /**
     * Converts a 24-hour time string (HH:MM or HH:MM:SS, optionally followed
     * by "; MM/DD/YYYY (DayOfWeek)") to 12-hour format with AM/PM.
     * Returns the original string unchanged if it is already in 12-hour format
     * or does not match the expected pattern.
     *
     * @param {string} timeStr
     * @returns {string}
     */
    function convertTo12Hour(timeStr) {
        if (!timeStr) return timeStr;
        // Already in 12-hour format — leave it alone.
        if (/AM|PM/i.test(timeStr)) return timeStr;
        // Match HH:MM or HH:MM:SS, optionally followed by "; date" portion.
        var match = timeStr.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(\s*;.*)?$/);
        if (!match) return timeStr;
        var hours = parseInt(match[1], 10);
        var minutes = match[2];
        var rest = match[3] || '';
        if (hours < 0 || hours > 23) return timeStr;
        var period = hours >= 12 ? 'PM' : 'AM';
        var h12 = hours % 12 || 12;
        return h12 + ':' + minutes + ' ' + period + rest;
    }

    // -------------------------------------------------------------------------
    // Heart Meter helpers
    // -------------------------------------------------------------------------

    /**
     * Reads heart-default metadata from a character object.
     * Returns the value of the first `[heart_default: N]` tag found across
     * description, personality, and scenario fields, or 0 if none is found.
     *
     * @param {object} character  Character object from PT.getContext().
     * @returns {number}
     */
    function getCharacterHeartDefault(character) {
        if (!character) return 0;
        var desc = (character.description || '') + ' ' +
                   (character.personality || '') + ' ' +
                   (character.scenario    || '');
        var heartMatch = desc.match(/\[heart_default:\s*(\d+)\]/i);
        return heartMatch ? Math.max(0, parseInt(heartMatch[1], 10)) : 0;
    }

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
            var timeVal = convertTo12Hour(tags.time || settings.currentTime || 'Unknown');
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
            '[time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)]\n' +
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
            'Update ONLY the values that have changed. Keep unchanged values exactly as they are.\n' +
            '\n' +
            'Example tags:\n' +
            '[time: 8:15 AM; 05/21/2001 (Monday)]\n' +
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
     * Edit and Regenerate are now per-message (triggered via header long-press),
     * so no global action buttons are registered by default.
     */
    var DEFAULT_BUTTONS = [];

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
     * Scans the last 2 AI messages for tracker data, updates settings, and
     * rebuilds their headers.  Called on init, chat change, and character change.
     */
    function scanRecentMessages() {
        var ctx = PT.getContext();
        if (!ctx || !ctx.recentMessages) return;
        var msgs = ctx.recentMessages;

        // Collect last 2 AI messages (oldest first).
        var aiMsgs = [];
        for (var i = msgs.length - 1; i >= 0 && aiMsgs.length < 2; i--) {
            if (!msgs[i].isUser) {
                aiMsgs.unshift(msgs[i]);
            }
        }
        if (aiMsgs.length === 0) return;

        var s = getSettings();
        for (var j = 0; j < aiMsgs.length; j++) {
            var tags = parseTags(aiMsgs[j].text);
            if (tags.time     !== null) { s.currentTime     = convertTo12Hour(tags.time); }
            if (tags.location !== null) { s.currentLocation = tags.location; }
            if (tags.weather  !== null) { s.currentWeather  = tags.weather; }
            if (tags.heart !== null) {
                var parsed = parseInt(tags.heart, 10);
                if (!isNaN(parsed)) { s.heartPoints = Math.max(0, parsed); }
            }
            _perMessageTracker[aiMsgs[j].index] = {
                currentTime:     s.currentTime,
                currentLocation: s.currentLocation,
                currentWeather:  s.currentWeather,
                heartPoints:     s.heartPoints,
            };
        }
        PT.saveSettings();

        // Rebuild headers for the scanned messages.
        for (var k = 0; k < aiMsgs.length; k++) {
            var msgTags = parseTags(aiMsgs[k].text);
            var header = buildHeader(msgTags, s);
            PT.setMessageHeader(aiMsgs[k].index, header, EXT_ID);
        }
    }

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

        // If current message is missing some tags, check the previous AI message for context.
        if (tags.time === null || tags.location === null || tags.weather === null || tags.heart === null) {
            var ctx = PT.getContext();
            if (ctx && ctx.recentMessages) {
                var msgs = ctx.recentMessages;
                for (var i = msgs.length - 1; i >= 0; i--) {
                    if (!msgs[i].isUser && msgs[i].index !== messageIndex) {
                        var prevTags = parseTags(msgs[i].text);
                        if (tags.time     === null && prevTags.time     !== null) { tags.time     = prevTags.time; }
                        if (tags.location === null && prevTags.location !== null) { tags.location = prevTags.location; }
                        if (tags.weather  === null && prevTags.weather  !== null) { tags.weather  = prevTags.weather; }
                        if (tags.heart    === null && prevTags.heart    !== null) { tags.heart    = prevTags.heart; }
                        break;
                    }
                }
            }
        }

        // Update persisted tracker fields from parsed tags.
        if (tags.time !== null)     { s.currentTime     = convertTo12Hour(tags.time); }
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

        _perMessageTracker[messageIndex] = {
            currentTime:     s.currentTime,
            currentLocation: s.currentLocation,
            currentWeather:  s.currentWeather,
            heartPoints:     s.heartPoints,
        };

        var header = buildHeader(tags, s);
        PT.setMessageHeader(messageIndex, header, EXT_ID);
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
        scanRecentMessages();
        injectPrompt();
    }

    /** Fired when the active character changes. */
    function onCharacterChanged() {
        PT.log('[PTTracker] CHARACTER_CHANGED — re-registering buttons.');
        var s = getSettings();
        // Reset heart points to 0, then check character metadata for an override.
        var ctx = PT.getContext();
        s.heartPoints = getCharacterHeartDefault(ctx && ctx.character);
        PT.saveSettings();
        registerDefaultButtons();
        scanRecentMessages();
        injectPrompt();
    }

    /**
     * Fired when a quick-reply button with an `action` field is clicked.
     * data = { action: string }
     */
    function onButtonClicked(data) {
        PT.log('[PTTracker] BUTTON_CLICKED action=' + data.action);
        var s = getSettings();
        var action = data.action;

        if (action.indexOf('edit_message_') === 0) {
            var editIdx = parseInt(action.substring('edit_message_'.length), 10);
            var editData = _perMessageTracker[editIdx] || {};
            PT.showEditDialog('Edit Tracker', [
                { key: 'time',     label: 'Time',         value: editData.currentTime     || s.currentTime     || '' },
                { key: 'location', label: 'Location',     value: editData.currentLocation || s.currentLocation || '' },
                { key: 'weather',  label: 'Weather',      value: editData.currentWeather  || s.currentWeather  || '' },
                { key: 'heart',    label: 'Heart Points', value: String(editData.heartPoints !== undefined ? editData.heartPoints : s.heartPoints) },
            ]).then(function (result) {
                if (!result) return;
                var newTime     = result.time     !== undefined ? result.time     : (editData.currentTime     || s.currentTime     || '');
                var newLocation = result.location !== undefined ? result.location : (editData.currentLocation || s.currentLocation || '');
                var newWeather  = result.weather  !== undefined ? result.weather  : (editData.currentWeather  || s.currentWeather  || '');
                // Start from the stored value; override with the user's edited value if provided.
                var newHeart    = editData.heartPoints !== undefined ? editData.heartPoints : s.heartPoints;
                if (result.heart !== undefined) {
                    var pts = parseInt(result.heart, 10);
                    if (!isNaN(pts)) { newHeart = Math.max(0, pts); }
                }
                _perMessageTracker[editIdx] = {
                    currentTime: newTime, currentLocation: newLocation,
                    currentWeather: newWeather, heartPoints: newHeart,
                };
                var tempSettings = {
                    showTime: s.showTime, showLocation: s.showLocation,
                    showWeather: s.showWeather, showHeartMeter: s.showHeartMeter,
                    currentTime: newTime, currentLocation: newLocation,
                    currentWeather: newWeather, heartPoints: newHeart,
                };
                // Pass null tags so buildHeader falls back entirely to tempSettings values.
                PT.setMessageHeader(editIdx, buildHeader({ time: null, location: null, weather: null, heart: null }, tempSettings), EXT_ID);
                // Update global settings if this is the most recent AI message.
                var ctx = PT.getContext();
                if (ctx && ctx.recentMessages) {
                    var msgs = ctx.recentMessages;
                    for (var i = msgs.length - 1; i >= 0; i--) {
                        if (!msgs[i].isUser) {
                            if (msgs[i].index === editIdx) {
                                s.currentTime = newTime; s.currentLocation = newLocation;
                                s.currentWeather = newWeather; s.heartPoints = newHeart;
                                PT.saveSettings();
                                injectPrompt();
                            }
                            break;
                        }
                    }
                }
                PT.log('[PTTracker] Tracker updated via Edit dialog for message #' + editIdx + '.');
            });

        } else if (action.indexOf('regenerate_message_') === 0) {
            var regenIdx = parseInt(action.substring('regenerate_message_'.length), 10);
            var regenData = _perMessageTracker[regenIdx] || {};
            var curTime     = regenData.currentTime     !== undefined ? regenData.currentTime     : (s.currentTime     || 'unknown');
            var curLocation = regenData.currentLocation !== undefined ? regenData.currentLocation : (s.currentLocation || 'unknown');
            var curWeather  = regenData.currentWeather  !== undefined ? regenData.currentWeather  : (s.currentWeather  || 'unknown');
            var curHeart    = regenData.heartPoints      !== undefined ? regenData.heartPoints      : s.heartPoints;
            var prompt =
                '[OOC: The current tracker values are:\n' +
                '[time: ' + curTime + ']\n' +
                '[location: ' + curLocation + ']\n' +
                '[weather: ' + curWeather + ']\n' +
                '[heart: ' + curHeart + ']\n\n' +
                'Based on the most recent message, update ONLY the values that have changed. ' +
                'Keep unchanged values exactly as they are. ' +
                'Output ONLY the four tracker tags and nothing else:\n' +
                '[time: ...]\n[location: ...]\n[weather: ...]\n[heart: ...]]';
            PT.generateHidden(prompt).then(function (response) {
                if (!response) return;
                var tags = parseTags(response);
                var updated = false;
                var newTime     = curTime;
                var newLocation = curLocation;
                var newWeather  = curWeather;
                var newHeart    = curHeart;
                if (tags.time     !== null) { newTime     = convertTo12Hour(tags.time); updated = true; }
                if (tags.location !== null) { newLocation = tags.location;              updated = true; }
                if (tags.weather  !== null) { newWeather  = tags.weather;               updated = true; }
                if (tags.heart !== null) {
                    var pts = parseInt(tags.heart, 10);
                    if (!isNaN(pts)) { newHeart = Math.max(0, pts); updated = true; }
                }
                if (!updated) return;
                _perMessageTracker[regenIdx] = {
                    currentTime: newTime, currentLocation: newLocation,
                    currentWeather: newWeather, heartPoints: newHeart,
                };
                var tempSettings = {
                    showTime: s.showTime, showLocation: s.showLocation,
                    showWeather: s.showWeather, showHeartMeter: s.showHeartMeter,
                    currentTime: newTime, currentLocation: newLocation,
                    currentWeather: newWeather, heartPoints: newHeart,
                };
                // Pass null tags so buildHeader falls back entirely to tempSettings values.
                PT.setMessageHeader(regenIdx, buildHeader({ time: null, location: null, weather: null, heart: null }, tempSettings), EXT_ID);
                // Update global settings if this is the most recent AI message.
                var ctx = PT.getContext();
                if (ctx && ctx.recentMessages) {
                    var msgs = ctx.recentMessages;
                    for (var i = msgs.length - 1; i >= 0; i--) {
                        if (!msgs[i].isUser) {
                            if (msgs[i].index === regenIdx) {
                                s.currentTime = newTime; s.currentLocation = newLocation;
                                s.currentWeather = newWeather; s.heartPoints = newHeart;
                                PT.saveSettings();
                                injectPrompt();
                            }
                            break;
                        }
                    }
                }
                PT.log('[PTTracker] Tracker regenerated for message #' + regenIdx + '.');
            });

        } else if (action === 'hide_buttons') {
            _headerButtonsVisible = {};
            PT.registerButtons(EXT_ID, DEFAULT_BUTTONS);
            PT.log('[PTTracker] Per-message buttons hidden.');
        }
    }

    /**
     * Fired when the user long-presses a message header that this extension owns.
     * data = { messageIndex: number, extensionId: string }
     * Replaces the global quick-reply buttons with per-message Edit/Regenerate actions.
     */
    function onHeaderLongPressed(data) {
        var msgIndex = data.messageIndex;
        PT.log('[PTTracker] HEADER_LONG_PRESSED messageIndex=' + msgIndex);
        if (_headerButtonsVisible[msgIndex]) return; // buttons already showing for this message
        _headerButtonsVisible[msgIndex] = true;
        PT.registerButtons(EXT_ID, [
            { label: '\u270F\uFE0F Edit Tracker (msg #' + msgIndex + ')',       action: 'edit_message_' + msgIndex },
            { label: '\uD83D\uDD04 Regenerate Tracker (msg #' + msgIndex + ')', action: 'regenerate_message_' + msgIndex },
            { label: '\u274C Hide', action: 'hide_buttons' },
        ]);
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
        var s = getSettings();
        // Reset heart points to 0, then check character metadata for an override.
        var ctx = PT.getContext();
        s.heartPoints = getCharacterHeartDefault(ctx && ctx.character);
        PT.saveSettings();

        // Register the output filter so PocketTavern's Kotlin side strips tracker
        // tags from displayed message bubbles AFTER this extension has parsed them.
        PT.registerOutputFilter(EXT_ID, OUTPUT_FILTER_PATTERN);
        PT.log('[PTTracker] Output filter registered.');

        // Scan recent messages for existing tracker data.
        scanRecentMessages();

        // Inject the tracker system prompt.
        injectPrompt();

        // Register quick-reply buttons.
        registerDefaultButtons();

        // Subscribe to PT events.
        PT.eventSource.on(PT.events.MESSAGE_RECEIVED,     onMessageReceived);
        PT.eventSource.on(PT.events.MESSAGE_EDITED,       onMessageEdited);
        PT.eventSource.on(PT.events.MESSAGE_DELETED,      onMessageDeleted);
        PT.eventSource.on(PT.events.GENERATION_STARTED,   onGenerationStarted);
        PT.eventSource.on(PT.events.GENERATION_STOPPED,   onGenerationStopped);
        PT.eventSource.on(PT.events.CHAT_CHANGED,         onChatChanged);
        PT.eventSource.on(PT.events.CHARACTER_CHANGED,    onCharacterChanged);
        PT.eventSource.on(PT.events.BUTTON_CLICKED,       onButtonClicked);
        PT.eventSource.on(PT.events.HEADER_LONG_PRESSED,  onHeaderLongPressed);

        PT.log('[PTTracker] Ready.');
    }

    // Kick things off.
    init();

})();
