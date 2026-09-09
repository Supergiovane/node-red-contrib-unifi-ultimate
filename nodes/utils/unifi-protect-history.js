"use strict";

const { createHash } = require("crypto");

const {
    SMART_CAMERA_EVENTS,
    normalizeSearchText
} = require("./knx-ai-camera-registry");

const PROTECT_HISTORY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROTECT_HISTORY_PAGE_SIZE = 100;
const PROTECT_HISTORY_MAX_RESULTS = 100;
const PROTECT_HISTORY_PAGINATION_TTL_MS = 5 * 60 * 1000;
const PROTECT_HISTORY_PAGINATION_MAX_QUERIES = 32;

function normalizeText(value, maxLength = 240) {
    return String(value === undefined || value === null ? "" : value).trim().slice(0, maxLength);
}

function uniqueStrings(values, maxItems = 32) {
    return Array.from(new Set((Array.isArray(values) ? values : [values])
        .map((value) => normalizeText(value, 160))
        .filter(Boolean)))
        .slice(0, maxItems);
}

function normalizeHistoryEventType(value) {
    const compact = normalizeSearchText(value).replace(/\s+/g, "");
    if (["smartdetect", "smartdetection", "objectdetect", "objectdetection"].includes(compact)) return "smartDetect";
    if (["smartdetectline", "line", "linecrossing", "crossline"].includes(compact)) return "smartDetectLine";
    if (["smartdetectzone", "zone", "intrusion", "intrusionzone"].includes(compact)) return "smartDetectZone";
    if (["smartdetectloiterzone", "loiter", "loiterzone"].includes(compact)) return "smartDetectLoiterZone";
    if (["motion", "movement", "movimento"].includes(compact)) return "motion";
    if (["ring", "doorbell"].includes(compact)) return "ring";
    if (["smartaudiodetect", "audio"].includes(compact)) return "smartAudioDetect";
    return normalizeText(value, 80);
}

function expandHistoryEventTypes(values) {
    const requested = uniqueStrings(values).map(normalizeHistoryEventType).filter(Boolean);
    const expanded = [];
    requested.forEach((type) => {
        if (type === "motion" || type === "smartDetect") {
            expanded.push("motion", "smartDetectZone", "smartDetectLine", "smartDetectLoiterZone");
            return;
        }
        if (SMART_CAMERA_EVENTS.has(type)) expanded.push(type);
    });
    return Array.from(new Set(expanded));
}

function normalizeObjectTypes(values) {
    return uniqueStrings(values, 12)
        .map((value) => normalizeSearchText(value).replace(/\s+/g, ""))
        .filter(Boolean);
}

function parseHistoryTime(value, fallback, label) {
    const text = normalizeText(value, 80);
    if (!text) return fallback;
    const parsed = new Date(text).getTime();
    if (!Number.isFinite(parsed)) throw new Error(`Invalid Protect history ${label} timestamp.`);
    return parsed;
}

function normalizeProtectHistoryRequest(request = {}, { now = Date.now() } = {}) {
    const source = request && typeof request === "object" && !Array.isArray(request) ? request : {};
    const end = parseHistoryTime(source.to || source.end, Number(now) + 10000, "end");
    const start = parseHistoryTime(source.from || source.start, end - PROTECT_HISTORY_DEFAULT_WINDOW_MS, "start");
    if (start > end) throw new Error("Protect history start must not be after end.");
    const limit = Math.max(1, Math.min(PROTECT_HISTORY_MAX_RESULTS, Math.floor(Number(source.limit) || 20)));
    const offset = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(source.offset) || 0)));
    const requestedEventTypes = uniqueStrings(Array.isArray(source.eventTypes) ? source.eventTypes : [source.eventType]);
    const expandedEventTypes = expandHistoryEventTypes(requestedEventTypes);
    if (requestedEventTypes.length && !expandedEventTypes.length) {
        throw new Error("Unsupported UniFi Protect historical event type.");
    }
    // Protect has controller versions with unreliable range pagination when
    // the types parameter is omitted. Asking for every supported camera event
    // keeps the result deterministic without widening the public contract.
    const eventTypes = expandedEventTypes.length ? expandedEventTypes : Array.from(SMART_CAMERA_EVENTS);
    const objectTypes = normalizeObjectTypes(Array.isArray(source.objectTypes) ? source.objectTypes : [source.objectType]);
    return {
        cameraId: normalizeText(source.cameraId, 200),
        cameraName: normalizeText(source.cameraName, 240),
        start,
        end,
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        limit,
        offset,
        pageSize: PROTECT_HISTORY_PAGE_SIZE,
        eventTypes,
        objectTypes,
        query: {
            start,
            end,
            limit: PROTECT_HISTORY_PAGE_SIZE,
            offset,
            orderDirection: "DESC",
            withoutDescriptions: "false",
            ...(eventTypes.length ? { types: eventTypes } : {}),
            ...(objectTypes.length ? { smartDetectTypes: objectTypes } : {})
        }
    };
}

function getHeader(response, name) {
    const headers = response && response.headers && typeof response.headers === "object" ? response.headers : {};
    const wanted = String(name || "").toLowerCase();
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
    return key ? headers[key] : undefined;
}

function extractProtectHistorySessionHeaders(response) {
    const rawCookies = getHeader(response, "set-cookie");
    const cookieValues = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
        .map((value) => normalizeText(value, 8192).split(";", 1)[0])
        .filter((value) => /^[^=;\s]+=[^;]+$/.test(value));
    if (!cookieValues.length) throw new Error("UniFi OS login did not return a session cookie.");
    const csrf = normalizeText(getHeader(response, "x-csrf-token"), 4096);
    return {
        Cookie: cookieValues.join("; "),
        ...(csrf ? { "X-CSRF-Token": csrf } : {})
    };
}

function fingerprintProtectHistoryPage(events) {
    if (!Array.isArray(events) || events.length === 0) return "";
    const hash = createHash("sha256");
    events.forEach((event) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) {
            hash.update(JSON.stringify([normalizeText(event, 500)]));
        } else {
            hash.update(JSON.stringify([
                normalizeText(event.id || event.eventId, 200),
                normalizeText(event.device || event.camera || event.cameraId, 200),
                normalizeText(event.type || event.eventType, 100),
                normalizeText(event.start === undefined ? event.timestamp : event.start, 100),
                normalizeText(event.end, 100),
                normalizeText(event.thumbnail || event.thumbnailId, 200)
            ]));
        }
        hash.update("\n");
    });
    return hash.digest("hex");
}

function createProtectHistoryPaginationGuard({
    ttlMs = PROTECT_HISTORY_PAGINATION_TTL_MS,
    maxQueries = PROTECT_HISTORY_PAGINATION_MAX_QUERIES
} = {}) {
    const states = new Map();
    const normalizedTtl = Math.max(1000, Number(ttlMs) || PROTECT_HISTORY_PAGINATION_TTL_MS);
    const normalizedMaxQueries = Math.max(1, Math.floor(Number(maxQueries) || PROTECT_HISTORY_PAGINATION_MAX_QUERIES));

    function prune(now, currentKey) {
        states.forEach((state, key) => {
            if (key !== currentKey && now - state.updatedAt > normalizedTtl) states.delete(key);
        });
        while (!states.has(currentKey) && states.size >= normalizedMaxQueries) {
            const oldest = Array.from(states.entries())
                .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
            if (!oldest) break;
            states.delete(oldest[0]);
        }
    }

    return {
        evaluate({ key, offset = 0, pageSize = PROTECT_HISTORY_PAGE_SIZE, events, now = Date.now() } = {}) {
            const queryKey = normalizeText(key, 4096) || "default";
            const pageOffset = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(offset) || 0)));
            const normalizedPageSize = Math.max(1, Math.floor(Number(pageSize) || PROTECT_HISTORY_PAGE_SIZE));
            const page = Array.isArray(events) ? events : [];
            const signature = fingerprintProtectHistoryPage(page);
            const checkedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
            prune(checkedAt, queryKey);

            let state = states.get(queryKey);
            if (!state || pageOffset === 0) {
                state = { signatures: new Map(), updatedAt: checkedAt };
                states.set(queryKey, state);
            }
            const previousOffset = signature ? state.signatures.get(signature) : undefined;
            // Re-reading an explicit offset is legitimate. A controller returning
            // a page already seen at a different offset is not: continuing from
            // it would let callers paginate forever without new evidence.
            const duplicatePage = pageOffset > 0
                && previousOffset !== undefined
                && previousOffset !== pageOffset;
            if (signature) state.signatures.set(signature, pageOffset);
            state.updatedAt = checkedAt;

            const candidateOffset = pageOffset + page.length;
            const madeProgress = page.length > 0
                && Number.isSafeInteger(candidateOffset)
                && candidateOffset > pageOffset
                && !duplicatePage;
            const hasMore = page.length >= normalizedPageSize && madeProgress;
            return {
                duplicatePage,
                duplicateOffset: duplicatePage ? previousOffset : null,
                madeProgress,
                hasMore,
                nextOffset: hasMore ? candidateOffset : null,
                signature
            };
        },
        clear() {
            states.clear();
        }
    };
}

function selectProtectHistoryEvents(events, request) {
    const normalized = normalizeProtectHistoryRequest(request, { now: request && request.end || Date.now() });
    const wantedCameraId = normalizeText(normalized.cameraId, 200);
    const wantedTypes = new Set(normalized.eventTypes);
    const wantedObjects = new Set(normalized.objectTypes);
    return (Array.isArray(events) ? events : [])
        .filter((event) => {
            if (!event || typeof event !== "object") return false;
            if (wantedCameraId && normalizeText(event.cameraId || event.device, 200) !== wantedCameraId) return false;
            if (wantedTypes.size && !wantedTypes.has(normalizeHistoryEventType(event.eventType || event.type))) return false;
            if (wantedObjects.size) {
                const detected = normalizeObjectTypes(event.objectTypes || event.smartDetectTypes || []);
                if (!detected.some((type) => wantedObjects.has(type))) return false;
            }
            return true;
        })
        .sort((left, right) => new Date(right.at || right.start || 0).getTime() - new Date(left.at || left.start || 0).getTime())
        .slice(0, normalized.limit);
}

module.exports = {
    PROTECT_HISTORY_DEFAULT_WINDOW_MS,
    PROTECT_HISTORY_MAX_RESULTS,
    PROTECT_HISTORY_PAGE_SIZE,
    createProtectHistoryPaginationGuard,
    expandHistoryEventTypes,
    extractProtectHistorySessionHeaders,
    fingerprintProtectHistoryPage,
    normalizeProtectHistoryRequest,
    selectProtectHistoryEvents
};
