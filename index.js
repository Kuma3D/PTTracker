/**
 * PTTracker — PocketTavern Extension
 *
 * Scans AI messages for structured metadata tags and displays
 * Time, Location, Weather, Heart Meter, and Characters data in a
 * status header above each AI message bubble. The raw tags are
 * stripped from the displayed message text via PT.registerOutputFilter().
 *
 * Tags expected in AI responses:
 *   [time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)]
 *   [location: Full Location Description]
 *   [weather: Weather Description, Temperature]
 *   [heart: points_value]
 *   [char: Name | outfit: What they wear | state: Their state | position: Where they are]
 */
(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    var EXT_ID = 'pt-tracker';

    var OUTPUT_FILTER_PATTERN = '\\[(?:time|location|weather|heart|char):\\s*[^\\]]*\\]';

    var _perMessageTracker = {};

    var DEFAULT_SETTINGS = {
        enabled: true,
        scanDepth: 10,
        defaultHeartPoints: 0,
        heartPoints: 0,
        currentTime: '',
        currentLocation: '',
        currentWeather: '',
        currentCharacters: [],
        showTime: true,
        showLocation: true,
        showWeather: true,
        showHeartMeter: true,
        showCharacters: true,
    };

    // -------------------------------------------------------------------------
    // Time helpers
    // -------------------------------------------------------------------------

    function convertTo12Hour(timeStr) {
        if (!timeStr) return timeStr;
        if (/AM|PM/i.test(timeStr)) return timeStr;
        var match = timeStr.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(\s*;.*)?$/);
        if (!match) return timeStr;
        var hours   = parseInt(match[1], 10);
        var minutes = match[2];
        var rest    = match[3] || '';
        if (hours < 0 || hours > 23) return timeStr;
        var period = hours >= 12 ? 'PM' : 'AM';
        var h12    = hours % 12 || 12;
        return h12 + ':' + minutes + ' ' + period + rest;
    }

    // -------------------------------------------------------------------------
    // Heart Meter helpers
    // -------------------------------------------------------------------------

    function getCharacterHeartDefault(character) {
        if (!character) return 0;
        var desc = (character.description || '') + ' ' +
                   (character.personality || '') + ' ' +
                   (character.scenario    || '');
        var heartMatch = desc.match(/\[heart_default:\s*(\d+)\]/i);
        return heartMatch ? Math.max(0, parseInt(heartMatch[1], 10)) : 0;
    }

    function getHeartEmoji(points) {
        if (points < 5000)  return '\uD83D\uDDA4';  // 🖤
        if (points < 20000) return '\uD83D\uDC9C';  // 💜
        if (points < 30000) return '\uD83D\uDC99';  // 💙
        if (points < 40000) return '\uD83D\uDC9A';  // 💚
        if (points < 50000) return '\uD83D\uDC9B';  // 💛
        if (points < 60000) return '\uD83E\uDDE1';  // 🧡
        return '\u2764\uFE0F';                       // ❤️
    }

    // -------------------------------------------------------------------------
    // Tag parsing
    // -------------------------------------------------------------------------

    /**
     * Extracts all tracker tags from an AI message string.
     * Returns time/location/weather/heart as strings (or null if absent)
     * and characters as an array of { name, outfit, state, position } objects.
     *
     * @param {string} text
     * @returns {{ time, location, weather, heart, characters }}
     */
    function parseTags(text) {
        function extract(pattern) {
            var match = text.match(pattern);
            return match ? match[1].trim() : null;
        }

        // Extract all [char: ...] tags — one per character in the scene.
        var characters = [];
        var charRegex  = /\[char:\s*([^\]]+)\]/gi;
        var charMatch;
        while ((charMatch = charRegex.exec(text)) !== null) {
            var charLine = charMatch[1].trim();
            var parts    = charLine.split('|').map(function (p) { return p.trim(); });
            var charObj  = { name: '', outfit: '', state: '', position: '' };
            for (var i = 0; i < parts.length; i++) {
                var part = parts[i];
                var sep  = part.indexOf(':');
                if (sep === -1) {
                    // No colon — treat the first bare token as the character name.
                    if (i === 0 && !charObj.name) charObj.name = part;
                } else {
                    var k = part.slice(0, sep).trim().toLowerCase();
                    var v = part.slice(sep + 1).trim();
                    if      (k === 'name')     charObj.name     = v;
                    else if (k === 'outfit')   charObj.outfit   = v;
                    else if (k === 'state')    charObj.state    = v;
                    else if (k === 'position') charObj.position = v;
                    else if (i === 0 && !charObj.name) charObj.name = part;
                }
            }
            if (charObj.name) characters.push(charObj);
        }

        return {
            time:       extract(/\[time:\s*([^\]]+)\]/i),
            location:   extract(/\[location:\s*([^\]]+)\]/i),
            weather:    extract(/\[weather:\s*([^\]]+)\]/i),
            heart:      extract(/\[heart:\s*([^\]]+)\]/i),
            characters: characters,
        };
    }

    function hasTags(tags) {
        return tags.time !== null || tags.location !== null ||
               tags.weather !== null || tags.heart !== null ||
               (tags.characters && tags.characters.length > 0);
    }

    // -------------------------------------------------------------------------
    // Characters helpers
    // -------------------------------------------------------------------------

    /**
     * Converts a characters array to a semicolon-separated editable string.
     * Format per entry: "Name | outfit: X | state: Y | position: Z"
     */
    function charsToString(chars) {
        if (!chars || chars.length === 0) return '';
        return chars.map(function (c) {
            var parts = [c.name];
            if (c.outfit)   parts.push('outfit: '   + c.outfit);
            if (c.state)    parts.push('state: '    + c.state);
            if (c.position) parts.push('position: ' + c.position);
            return parts.join(' | ');
        }).join('; ');
    }

    /**
     * Parses a semicolon-separated characters string back to an array.
     */
    function stringToChars(str) {
        if (!str || !str.trim()) return [];
        return str.split(';').map(function (entry) {
            entry = entry.trim();
            if (!entry) return null;
            var parts   = entry.split('|').map(function (p) { return p.trim(); });
            var charObj = { name: '', outfit: '', state: '', position: '' };
            for (var i = 0; i < parts.length; i++) {
                var part = parts[i];
                var sep  = part.indexOf(':');
                if (sep === -1) {
                    if (i === 0) charObj.name = part;
                } else {
                    var k = part.slice(0, sep).trim().toLowerCase();
                    var v = part.slice(sep + 1).trim();
                    if      (k === 'name')     charObj.name     = v;
                    else if (k === 'outfit')   charObj.outfit   = v;
                    else if (k === 'state')    charObj.state    = v;
                    else if (k === 'position') charObj.position = v;
                    else if (i === 0 && !charObj.name) charObj.name = part;
                }
            }
            return charObj.name ? charObj : null;
        }).filter(Boolean);
    }

    // -------------------------------------------------------------------------
    // Header builder
    // -------------------------------------------------------------------------

    /**
     * Builds the header string shown above an AI message bubble.
     *
     * Always-visible fields: ⏰ Time, 🗺️ Location, 🌤️ Weather, 💘 Heart Meter.
     * Below a blank separator: 👥 Characters (name list on one line), then one
     * detail line per character showing outfit, state, and position.
     *
     * @param {{ time, location, weather, heart, characters }} tags
     * @param {object} settings
     * @returns {string}
     */
    function buildHeader(tags, settings) {
        var lines = [];

        if (settings.showTime) {
            var timeVal = convertTo12Hour(tags.time || settings.currentTime || 'Unknown');
            lines.push('\u23F0 Time: ' + timeVal);
        }
        if (settings.showLocation) {
            var locVal = tags.location || settings.currentLocation || 'Unknown';
            lines.push('\uD83D\uDDFA\uFE0F Location: ' + locVal);
        }
        if (settings.showWeather) {
            var weatherVal = tags.weather || settings.currentWeather || 'Unknown';
            lines.push('\uD83C\uDF24\uFE0F Weather: ' + weatherVal);
        }
        if (settings.showHeartMeter) {
            var pts   = settings.heartPoints;
            var emoji = getHeartEmoji(pts);
            lines.push('\uD83D\uDC98 Heart Meter: ' + emoji + ' ' + pts.toLocaleString());
        }

        if (settings.showCharacters) {
            var chars = (tags.characters && tags.characters.length > 0)
                ? tags.characters
                : (settings.currentCharacters || []);

            if (chars.length > 0) {
                lines.push('');
                // Single line listing all names
                var names = chars.map(function (c) { return c.name; }).join(', ');
                lines.push('\uD83D\uDC65 Characters: ' + names);
                // One detail line per character
                for (var i = 0; i < chars.length; i++) {
                    var c       = chars[i];
                    var details = [];
                    if (c.outfit)   details.push(c.outfit);
                    if (c.state)    details.push(c.state);
                    if (c.position) details.push(c.position);
                    lines.push(c.name + (details.length > 0 ? ' \u2014 ' + details.join(' | ') : ''));
                }
            }
        }

        return lines.join('\n');
    }

    // -------------------------------------------------------------------------
    // Settings helpers
    // -------------------------------------------------------------------------

    function getSettings() {
        if (!PT.extension_settings[EXT_ID]) {
            PT.extension_settings[EXT_ID] = {};
        }
        var s    = PT.extension_settings[EXT_ID];
        var keys = Object.keys(DEFAULT_SETTINGS);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (s[key] === undefined) s[key] = DEFAULT_SETTINGS[key];
        }
        return s;
    }

    // -------------------------------------------------------------------------
    // Prompt injection
    // -------------------------------------------------------------------------

    function buildPrompt(settings) {
        var chars     = settings.currentCharacters || [];
        var charLines = chars.map(function (c) {
            var parts = [c.name];
            if (c.outfit)   parts.push('outfit: '   + c.outfit);
            if (c.state)    parts.push('state: '    + c.state);
            if (c.position) parts.push('position: ' + c.position);
            return '[char: ' + parts.join(' | ') + ']';
        }).join('\n');

        var currentState = [
            '[time: '     + (settings.currentTime     || 'unknown') + ']',
            '[location: ' + (settings.currentLocation || 'unknown') + ']',
            '[weather: '  + (settings.currentWeather  || 'unknown') + ']',
            '[heart: '    + settings.heartPoints + ']',
        ].join('\n');
        if (charLines) currentState += '\n' + charLines;

        return (
            '[PTTracker Instructions]\n' +
            'At the end of EVERY response, after all narrative content, include the following tracker tags:\n' +
            '\n' +
            '[time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)]\n' +
            '[location: Full Location Description]\n' +
            '[weather: Weather Description, Temperature]\n' +
            '[heart: points_value]\n' +
            '[char: CharacterName | outfit: What they wear | state: Emotional/physical state | position: Where in the scene]\n' +
            '\n' +
            'Add one [char: ...] line for EACH character currently present in the scene.\n' +
            '\n' +
            'Heart Meter Rules:\n' +
            'Assess the relationship and assign heart points showing the romantic interest the character has for {{user}}. ' +
            'The maximum change per message is \u00B110,000 points. Range: 0\u201369,999.\n' +
            '\n' +
            'Heart point ranges:\n' +
            '  0\u20134,999     \u2192 \uD83D\uDDA4 Black Heart\n' +
            '  5,000\u201319,999  \u2192 \uD83D\uDC9C Purple Heart\n' +
            '  20,000\u201329,999 \u2192 \uD83D\uDC99 Blue Heart\n' +
            '  30,000\u201339,999 \u2192 \uD83D\uDC9A Green Heart\n' +
            '  40,000\u201349,999 \u2192 \uD83D\uDC9B Yellow Heart\n' +
            '  50,000\u201359,999 \u2192 \uD83E\uDDE1 Orange Heart\n' +
            '  60,000\u201369,999 \u2192 \u2764\uFE0F Red Heart\n' +
            '\n' +
            'Current tracker state (continue from here):\n' +
            currentState + '\n' +
            '\n' +
            'Update ONLY values that have changed. Never omit any tag.\n' +
            '\n' +
            'Example:\n' +
            '[time: 8:15 AM; 05/21/2001 (Monday)]\n' +
            '[location: Mako Crystal Cave, Eastern Trail, Mount Nibel]\n' +
            '[weather: Cool and damp, sunny outside, 57\u00B0F]\n' +
            '[heart: 5000]\n' +
            '[char: Alice | outfit: Blue dress | state: Happy | position: Near the fountain]\n' +
            '[char: Bob | outfit: Casual jeans | state: Nervous | position: On the bench]'
        );
    }

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

    function scanRecentMessages() {
        var ctx = PT.getContext();
        if (!ctx || !ctx.recentMessages) return;
        var msgs = ctx.recentMessages;

        var aiMsgs = [];
        for (var i = msgs.length - 1; i >= 0 && aiMsgs.length < 2; i--) {
            if (!msgs[i].isUser) aiMsgs.unshift(msgs[i]);
        }
        if (aiMsgs.length === 0) return;

        var s          = getSettings();
        var anyUpdated = false;

        for (var j = 0; j < aiMsgs.length; j++) {
            var tags = parseTags(aiMsgs[j].text);
            if (!hasTags(tags)) continue;

            anyUpdated = true;
            if (tags.time       !== null)   { s.currentTime       = convertTo12Hour(tags.time); }
            if (tags.location   !== null)   { s.currentLocation   = tags.location; }
            if (tags.weather    !== null)   { s.currentWeather    = tags.weather; }
            if (tags.characters.length > 0) { s.currentCharacters = tags.characters; }
            if (tags.heart !== null) {
                var parsed = parseInt(tags.heart, 10);
                if (!isNaN(parsed)) s.heartPoints = Math.max(0, parsed);
            }

            _perMessageTracker[aiMsgs[j].index] = {
                currentTime:       s.currentTime,
                currentLocation:   s.currentLocation,
                currentWeather:    s.currentWeather,
                heartPoints:       s.heartPoints,
                currentCharacters: s.currentCharacters,
            };

            PT.setMessageHeader(aiMsgs[j].index, buildHeader(tags, s), EXT_ID);
        }

        if (anyUpdated) PT.saveSettings();
    }

    function processAiMessage(text, messageIndex) {
        var s = getSettings();
        if (!s.enabled) return;

        var tags = parseTags(text);
        if (!hasTags(tags)) return;

        // Fill any missing tags from the previous AI message for continuity.
        var needsFill = tags.time === null || tags.location === null ||
                        tags.weather === null || tags.heart === null ||
                        tags.characters.length === 0;
        if (needsFill) {
            var ctx = PT.getContext();
            if (ctx && ctx.recentMessages) {
                var msgs = ctx.recentMessages;
                for (var i = msgs.length - 1; i >= 0; i--) {
                    if (!msgs[i].isUser && msgs[i].index !== messageIndex) {
                        var prevTags = parseTags(msgs[i].text);
                        if (tags.time       === null && prevTags.time       !== null) { tags.time       = prevTags.time; }
                        if (tags.location   === null && prevTags.location   !== null) { tags.location   = prevTags.location; }
                        if (tags.weather    === null && prevTags.weather    !== null) { tags.weather    = prevTags.weather; }
                        if (tags.heart      === null && prevTags.heart      !== null) { tags.heart      = prevTags.heart; }
                        if (tags.characters.length === 0 && prevTags.characters.length > 0) {
                            tags.characters = prevTags.characters;
                        }
                        break;
                    }
                }
            }
        }

        if (tags.time       !== null)   { s.currentTime       = convertTo12Hour(tags.time); }
        if (tags.location   !== null)   { s.currentLocation   = tags.location; }
        if (tags.weather    !== null)   { s.currentWeather    = tags.weather; }
        if (tags.characters.length > 0) { s.currentCharacters = tags.characters; }

        if (tags.heart !== null) {
            var parsed = parseInt(tags.heart, 10);
            if (!isNaN(parsed)) {
                s.heartPoints = Math.max(0, parsed);
                PT.log('[PTTracker] Heart points updated to ' + s.heartPoints + '.');
            }
        }

        PT.saveSettings();

        _perMessageTracker[messageIndex] = {
            currentTime:       s.currentTime,
            currentLocation:   s.currentLocation,
            currentWeather:    s.currentWeather,
            heartPoints:       s.heartPoints,
            currentCharacters: s.currentCharacters,
        };

        PT.setMessageHeader(messageIndex, buildHeader(tags, s), EXT_ID);
        PT.log('[PTTracker] Header set for message #' + messageIndex + '.');

        injectPrompt();
    }

    function getPreviousTrackerHeader(beforeIndex) {
        var ctx = PT.getContext();
        if (!ctx || !ctx.recentMessages) return null;
        var msgs = ctx.recentMessages;
        for (var i = msgs.length - 1; i >= 0; i--) {
            if (!msgs[i].isUser && msgs[i].index < beforeIndex) {
                var headers = PT.getMessageHeaders(msgs[i].index);
                for (var h = 0; h < headers.length; h++) {
                    if (headers[h].extensionId === EXT_ID) return headers[h].text;
                }
                var rawTags = parseTags(msgs[i].text);
                if (hasTags(rawTags)) return buildHeader(rawTags, getSettings());
                return null;
            }
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // Event handlers
    // -------------------------------------------------------------------------

    function onMessageReceived(data) {
        PT.log('[PTTracker] MESSAGE_RECEIVED');
        processAiMessage(data.text, data.index);
    }

    function onMessageEdited(data) {
        PT.log('[PTTracker] MESSAGE_EDITED');
        if (!data.isUser) {
            processAiMessage(data.text, data.index);
        } else {
            PT.clearMessageHeader(data.index);
        }
    }

    function onMessageDeleted() {
        PT.log('[PTTracker] MESSAGE_DELETED — clearing in-memory tracker cache.');
        _perMessageTracker = {};
    }

    function onGenerationStarted() {
        PT.log('[PTTracker] GENERATION_STARTED');
    }

    function onGenerationStopped() {
        PT.log('[PTTracker] GENERATION_STOPPED');
    }

    function onChatChanged() {
        PT.log('[PTTracker] CHAT_CHANGED — clearing all headers.');
        PT.clearAllHeaders();
        _perMessageTracker = {};
        scanRecentMessages();
        injectPrompt();
    }

    function onCharacterChanged() {
        PT.log('[PTTracker] CHARACTER_CHANGED.');
        var s   = getSettings();
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

    function onButtonClicked(data) {
        PT.log('[PTTracker] BUTTON_CLICKED action=' + data.action);
        var s      = getSettings();
        var action = data.action;

        // ── Edit ──────────────────────────────────────────────────────────────
        if (action.indexOf('edit_message_') === 0) {
            var editIdx  = parseInt(action.substring('edit_message_'.length), 10);
            var editData = _perMessageTracker[editIdx] || {};
            var chars    = editData.currentCharacters || s.currentCharacters || [];

            PT.showEditDialog('Edit Tracker', [
                { key: 'time',       label: 'Time',         value: editData.currentTime     || s.currentTime     || '' },
                { key: 'location',   label: 'Location',     value: editData.currentLocation || s.currentLocation || '' },
                { key: 'weather',    label: 'Weather',      value: editData.currentWeather  || s.currentWeather  || '' },
                { key: 'heart',      label: 'Heart Points', value: String(editData.heartPoints !== undefined ? editData.heartPoints : s.heartPoints) },
                { key: 'characters', label: 'Characters (Name | outfit: X | state: Y | position: Z  — separate multiple with ;)',
                  value: charsToString(chars) },
            ]).then(function (result) {
                if (!result) return;

                var newTime     = result.time       !== undefined ? result.time       : (editData.currentTime     || s.currentTime     || '');
                var newLocation = result.location   !== undefined ? result.location   : (editData.currentLocation || s.currentLocation || '');
                var newWeather  = result.weather    !== undefined ? result.weather    : (editData.currentWeather  || s.currentWeather  || '');
                var newHeart    = editData.heartPoints !== undefined ? editData.heartPoints : s.heartPoints;
                var newChars    = editData.currentCharacters || s.currentCharacters || [];

                if (result.heart !== undefined) {
                    var pts = parseInt(result.heart, 10);
                    if (!isNaN(pts)) newHeart = Math.max(0, pts);
                }
                if (result.characters !== undefined) {
                    newChars = stringToChars(result.characters);
                }

                _perMessageTracker[editIdx] = {
                    currentTime:       newTime,
                    currentLocation:   newLocation,
                    currentWeather:    newWeather,
                    heartPoints:       newHeart,
                    currentCharacters: newChars,
                };

                var tempSettings = {
                    showTime: s.showTime, showLocation: s.showLocation,
                    showWeather: s.showWeather, showHeartMeter: s.showHeartMeter,
                    showCharacters: s.showCharacters,
                    currentTime: newTime, currentLocation: newLocation,
                    currentWeather: newWeather, heartPoints: newHeart,
                    currentCharacters: newChars,
                };
                PT.setMessageHeader(
                    editIdx,
                    buildHeader({ time: null, location: null, weather: null, heart: null, characters: [] }, tempSettings),
                    EXT_ID
                );

                // Update global settings if this is the most recent AI message.
                var ctx = PT.getContext();
                if (ctx && ctx.recentMessages) {
                    var msgs = ctx.recentMessages;
                    for (var i = msgs.length - 1; i >= 0; i--) {
                        if (!msgs[i].isUser) {
                            if (msgs[i].index === editIdx) {
                                s.currentTime       = newTime;
                                s.currentLocation   = newLocation;
                                s.currentWeather    = newWeather;
                                s.heartPoints       = newHeart;
                                s.currentCharacters = newChars;
                                PT.saveSettings();
                                injectPrompt();
                            }
                            break;
                        }
                    }
                }
                PT.log('[PTTracker] Tracker updated via Edit dialog for message #' + editIdx + '.');
            });

        // ── Regenerate ────────────────────────────────────────────────────────
        } else if (action.indexOf('regenerate_message_') === 0) {
            var regenIdx       = parseInt(action.substring('regenerate_message_'.length), 10);
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
                '- How the character feels about {{user}} based on their interactions (heart points 0-69999)\n' +
                '- Which characters are present and their current outfit, state, and position\n\n' +
                'Output ONLY the tracker tags and nothing else:\n' +
                '[time: h:MM AM/PM; MM/DD/YYYY (DayOfWeek)]\n' +
                '[location: Full Location Description]\n' +
                '[weather: Weather Description, Temperature]\n' +
                '[heart: points_value]\n' +
                '[char: Name | outfit: What they wear | state: State | position: Position]';

            PT.generateHidden(prompt).then(function (response) {
                if (!response) return;
                var tags = parseTags(response);
                if (!hasTags(tags)) return;

                var newTime     = tags.time     !== null ? convertTo12Hour(tags.time) : (s.currentTime     || 'Unknown');
                var newLocation = tags.location !== null ? tags.location              : (s.currentLocation || 'Unknown');
                var newWeather  = tags.weather  !== null ? tags.weather               : (s.currentWeather  || 'Unknown');
                var newHeart    = s.heartPoints;
                var newChars    = tags.characters.length > 0 ? tags.characters : (s.currentCharacters || []);

                if (tags.heart !== null) {
                    var pts = parseInt(tags.heart, 10);
                    if (!isNaN(pts)) newHeart = Math.max(0, pts);
                }

                _perMessageTracker[regenIdx] = {
                    currentTime:       newTime,
                    currentLocation:   newLocation,
                    currentWeather:    newWeather,
                    heartPoints:       newHeart,
                    currentCharacters: newChars,
                };

                var tempSettings = {
                    showTime: s.showTime, showLocation: s.showLocation,
                    showWeather: s.showWeather, showHeartMeter: s.showHeartMeter,
                    showCharacters: s.showCharacters,
                    currentTime: newTime, currentLocation: newLocation,
                    currentWeather: newWeather, heartPoints: newHeart,
                    currentCharacters: newChars,
                };
                PT.setMessageHeader(
                    regenIdx,
                    buildHeader({ time: null, location: null, weather: null, heart: null, characters: [] }, tempSettings),
                    EXT_ID
                );

                // Update global settings if this is the most recent AI message.
                var ctx = PT.getContext();
                if (ctx && ctx.recentMessages) {
                    var msgs = ctx.recentMessages;
                    for (var i = msgs.length - 1; i >= 0; i--) {
                        if (!msgs[i].isUser) {
                            if (msgs[i].index === regenIdx) {
                                s.currentTime       = newTime;
                                s.currentLocation   = newLocation;
                                s.currentWeather    = newWeather;
                                s.heartPoints       = newHeart;
                                s.currentCharacters = newChars;
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

    function onHeaderLongPressed(data) {
        var msgIndex = data.messageIndex;
        PT.log('[PTTracker] HEADER_LONG_PRESSED messageIndex=' + msgIndex);
        PT.registerHeaderButtons(EXT_ID, [
            { label: '\u270F\uFE0F Edit',       action: 'edit_message_'       + msgIndex },
            { label: '\uD83D\uDD04 Regenerate', action: 'regenerate_message_' + msgIndex },
        ]);
    }

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    function init() {
        PT.log('[PTTracker] Initialising\u2026');

        var s   = getSettings();
        var ctx = PT.getContext();
        var charDefault = getCharacterHeartDefault(ctx && ctx.character);
        if (s.heartPoints === 0 && charDefault > 0) {
            s.heartPoints = charDefault;
        }
        PT.saveSettings();

        PT.registerOutputFilter(EXT_ID, OUTPUT_FILTER_PATTERN);
        PT.log('[PTTracker] Output filter registered.');

        scanRecentMessages();
        injectPrompt();

        PT.eventSource.on(PT.events.MESSAGE_RECEIVED,    onMessageReceived);
        PT.eventSource.on(PT.events.MESSAGE_EDITED,      onMessageEdited);
        PT.eventSource.on(PT.events.MESSAGE_DELETED,     onMessageDeleted);
        PT.eventSource.on(PT.events.GENERATION_STARTED,  onGenerationStarted);
        PT.eventSource.on(PT.events.GENERATION_STOPPED,  onGenerationStopped);
        PT.eventSource.on(PT.events.CHAT_CHANGED,        onChatChanged);
        PT.eventSource.on(PT.events.CHARACTER_CHANGED,   onCharacterChanged);
        PT.eventSource.on(PT.events.BUTTON_CLICKED,      onButtonClicked);
        PT.eventSource.on(PT.events.HEADER_LONG_PRESSED, onHeaderLongPressed);

        PT.log('[PTTracker] Ready.');
    }

    init();

})();
