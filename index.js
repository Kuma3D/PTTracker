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
     */
    var OUTPUT_FILTER_PATTERN = '\\[(?:time|location|weather|heart):\\s*[^\\]]*\\]';

    /** Stores tracker state per message index: { [messageIndex]: { currentTime, currentLocation, currentWeather, heartPoints } } */
    var _perMessageTracker = {};

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

    /**
     * Returns true if at least one tracker tag was found.
     * @param {{ time: string|null, location: string|null, weather: string|null, heart: string|null }} tags
     * @returns {boolean}
     */
    function hasTags(tags) {
        return tags.time !== null || tags.location !== null ||
               tags.weather !== null || tags.heart !== null;
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
     * so the AI knows the starting point.
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
            '  0 – 4,999     \u2192 \uD83D\uDDA4 Black Heart\n' +
            '  5,000 – 19,999  \u2192 \uD83D\uDC9C Purple Heart\n' +
            '  20,000 – 29,999 \u2192 \uD83D\uDC99 Blue Heart\n' +
            '  30,000 – 39,999 \u2192 \uD83D\uDC9A Green Heart\n' +
            '  40,000 – 49,999 \u2192 \uD83D\uDC9B Yellow Heart\n' +
            '  50,000 – 59,999 \u2192 \uD83E\uDDE1 Orange Heart\n' +
            '  60,000 – 69,999 \u2192 \u2764\uFE0F Red Heart\n' +
            '\n' +
            'Current tracker state (continue from here):\n' +
            currentState + '\n' +
            '\n' +
            'Update ONLY the values that have changed. Keep unchanged values exactly as they are.\n' +
            '\n' +
            'Example tags:\n' +
            '[time: 8:15 AM; 05/21/2001 (Monday)]\n' +
            '[location: Mako Crystal Cave, Eastern Trail, Mount Nibel, Nibelheim]\n' +
            '[weather: Cool and damp inside cave, sunny outside, 57\u00B0F]\n' +
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
    // Message processing
    // -------------------------------------------------------------------------

    /**
     * Scans the last 2 AI messages for tracker data, updates settings, and
     * rebuilds their headers.  Called on init, chat change, and character change.
     *
     * FIX: Only sets headers on messages that actually contain tracker tags.
     * Messages without tags (e.g. the greeting) are skipped entirely.
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
        var anyUpdated = false;

        for (var j = 0; j < aiMsgs.length; j++) {
            var tags = parseTags(aiMsgs[j].text);

            // Skip messages that have NO tracker tags at all (e.g. greeting)
            if (!hasTags(tags)) continue;

            anyUpdated = true;
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

            // Rebuild header for this message
            var header = buildHeader(tags, s);
            PT.setMessageHeader(aiMsgs[j].index, header, EXT_ID);
        }

        if (anyUpdated) {
            PT.saveSettings();
        }
    }

    /**
     * Parses tags from an AI message, updates persisted tracker fields,
     * rebuilds the header, and re-injects the prompt with the updated state.
     *
     * FIX: Only sets a header if the message actually contains at least one tag.
     *
     * @param {string} text         Raw message text from the AI.
     * @param {number} messageIndex Index of the message in the chat.
     */
    function processAiMessage(text, messageIndex) {
        var s = getSettings();
        if (!s.enabled) return;

        var tags = parseTags(text);

        // If the message has NO tracker tags at all, don't set a header.
        // This prevents phantom headers on greetings and other tag-free messages.
        if (!hasTags(tags)) return;

        // If current message is missing SOME tags, check the previous AI message for context.
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

    /**
     * Finds the previous AI message's tracker header text using
     * PT.getMessageHeaders(). Returns the header text or null.
     *
     * @param {number} beforeIndex  Only consider messages before this index.
     * @returns {string|null}
     */
    function getPreviousTrackerHeader(beforeIndex) {
        var ctx = PT.getContext();
        if (!ctx || !ctx.recentMessages) return null;
        var msgs = ctx.recentMessages;
        for (var i = msgs.length - 1; i >= 0; i--) {
            if (!msgs[i].isUser && msgs[i].index < beforeIndex) {
                var headers = PT.getMessageHeaders(msgs[i].index);
                for (var h = 0; h < headers.length; h++) {
                    if (headers[h].extensionId === EXT_ID) {
                        return headers[h].text;
                    }
                }
                // No persisted header — try parsing raw text instead
                var rawTags = parseTags(msgs[i].text);
                if (hasTags(rawTags)) {
                    var s = getSettings();
                    return buildHeader(rawTags, s);
                }
                return null;
            }
        }
        return null;
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
            processAiMessage(data.text, data.index);
        } else {
            PT.clearMessageHeader(data.index);
        }
    }

    /** Fired when a message is deleted. */
    function onMessageDeleted() {
        PT.log('[PTTracker] MESSAGE_DELETED — clearing in-memory tracker cache.');
        _perMessageTracker = {};
    }

    /** Fired when text generation begins. */
    function onGenerationStarted() {
        PT.log('[PTTracker] GENERATION_STARTED');
    }

    /** Fired when text generation ends or is cancelled. */
    function onGenerationStopped() {
        PT.log('[PTTracker] GENERATION_STOPPED');
    }

    /** Fired when the active chat changes. */
    function onChatChanged() {
        PT.log('[PTTracker] CHAT_CHANGED — clearing all headers.');
        PT.clearAllHeaders();
        _perMessageTracker = {};
        scanRecentMessages();
        injectPrompt();
    }

    /** Fired when the active character changes. */
    function onCharacterChanged() {
        PT.log('[PTTracker] CHARACTER_CHANGED.');
        var s = getSettings();
        // Only reset heart points if this is the first time seeing this character
        // (settings still at default 0 and character has a heart_default tag).
        // Otherwise preserve the earned heart points from gameplay.
        var ctx = PT.getContext();
        var charDefault = getCharacterHeartDefault(ctx && ctx.character);
        if (s.heartPoints === 0 && charDefault > 0) {
            s.heartPoints = charDefault;
            PT.saveSettings();
        }
        _perMessageTracker = {};
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

            // Get the PREVIOUS message's tracker header as reference context.
            // Completely ignores the current message's tracker values.
            var prevHeaderText = getPreviousTrackerHeader(regenIdx);

            var prompt =
                '[OOC: Based ONLY on the conversation history and what has happened in the story, ' +
                'determine what the tracker values should be for this point in the narrative. ' +
                'Do NOT copy values — derive everything fresh from the scene context.\n\n';

            if (prevHeaderText) {
                prompt +=
                    'The PREVIOUS message\'s tracker state was:\n' +
                    prevHeaderText + '\n\n' +
                    'Use this only as a reference point for continuity. ' +
                    'Values should reflect what has changed since then based on the story.\n\n';
            }

            prompt +=
                'Consider:\n' +
                '- What time of day and date it should be based on story progression\n' +
                '- Where the characters are currently located in the scene\n' +
                '- What the weather and environment are like\n' +
                '- How the character feels about {{user}} based on their interactions (heart points 0-69999)\n\n' +
                'Output ONLY the four tracker tags and nothing else:\n' +
                '[time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)]\n' +
                '[location: Full Location Description]\n' +
                '[weather: Weather Description, Temperature]\n' +
                '[heart: points_value]]';

            PT.generateHidden(prompt).then(function (response) {
                if (!response) return;
                var tags = parseTags(response);
                if (!hasTags(tags)) return;

                var newTime     = tags.time     !== null ? convertTo12Hour(tags.time) : (s.currentTime     || 'Unknown');
                var newLocation = tags.location !== null ? tags.location              : (s.currentLocation || 'Unknown');
                var newWeather  = tags.weather  !== null ? tags.weather               : (s.currentWeather  || 'Unknown');
                var newHeart    = s.heartPoints;
                if (tags.heart !== null) {
                    var pts = parseInt(tags.heart, 10);
                    if (!isNaN(pts)) { newHeart = Math.max(0, pts); }
                }

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
        }
    }

    /**
     * Fired when the user long-presses a message header that this extension owns.
     * data = { messageIndex: number, extensionId: string }
     * Registers inline per-message Edit/Regenerate buttons inside the header.
     */
    function onHeaderLongPressed(data) {
        var msgIndex = data.messageIndex;
        PT.log('[PTTracker] HEADER_LONG_PRESSED messageIndex=' + msgIndex);
        PT.registerHeaderButtons(EXT_ID, [
            { label: '\u270F\uFE0F Edit',       action: 'edit_message_' + msgIndex },
            { label: '\uD83D\uDD04 Regenerate', action: 'regenerate_message_' + msgIndex },
        ]);
    }

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    /**
     * Entry point — called once when PocketTavern loads the extension.
     */
    function init() {
        PT.log('[PTTracker] Initialising\u2026');

        // Ensure settings exist with sensible defaults.
        var s = getSettings();

        // Only set heart default on first-ever load (when heartPoints is still
        // at 0 and the character has a heart_default tag). This preserves
        // earned heart progress across reloads.
        var ctx = PT.getContext();
        var charDefault = getCharacterHeartDefault(ctx && ctx.character);
        if (s.heartPoints === 0 && charDefault > 0) {
            s.heartPoints = charDefault;
        }
        PT.saveSettings();

        // Register the output filter so tracker tags are stripped from display.
        PT.registerOutputFilter(EXT_ID, OUTPUT_FILTER_PATTERN);
        PT.log('[PTTracker] Output filter registered.');

        // Scan recent messages for existing tracker data.
        scanRecentMessages();

        // Inject the tracker system prompt.
        injectPrompt();

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
