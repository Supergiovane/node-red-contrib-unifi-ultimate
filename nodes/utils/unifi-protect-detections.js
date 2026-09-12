"use strict";

const { extractLicensePlates, isLicensePlateEvent } = require("./unifi-protect-lpr");
const { boundedNumber } = require("./unifi-simple-monitor");
const DETECTION_TYPES = ["all", "motion", "person", "vehicle", "animal", "licensePlate", "ring"];
const DETECTION_FIELD = {
    id: "detectionType", label: "Detection", type: "select", defaultValue: "all", reloadOnChange: true,
    options: ["All detections", "Motion", "Person", "Vehicle", "Animal", "License plate (LPR)", "Doorbell ring"]
        .map((label, index) => ({ value: DETECTION_TYPES[index], label }))
};
const KNOWN_PLATES_FIELD = {
    id: "knownPlates", label: "Optional Known plates", type: "textarea", defaultValue: "",
    placeholder: "AB123CD = Family car\nXY456ZT = Delivery van\nLEAVE BLANK to send all plates to the flow",
    tip: "One PLATE = name per line; unknown plates are sent too.",
    helpText: "Optional: one PLATE = friendly name per line. Matching ignores case, spaces and hyphens; it never guesses similar characters. Plate names are saved in the flow."
};

function plateKey(value) { return String(value || "").toUpperCase().replace(/[\s-]+/g, ""); }
function parseKnownPlates(value) {
    const result = new Map();
    const lines = String(value || "").split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > 500) throw new Error("Use at most 500 known plates.");
    lines.forEach((line, index) => {
        const split = line.indexOf("=");
        const key = plateKey(line.slice(0, split));
        const name = line.slice(split + 1).trim();
        if (split < 1 || !key || !name) throw new Error(`Known plates: line ${index + 1} must contain PLATE = friendly name.`);
        if (result.has(key) && result.get(key) !== name) throw new Error(`Known plates: line ${index + 1} repeats a plate with a different name.`);
        result.set(key, name);
    });
    return result;
}

function namePlate(plate, knownPlates) {
    const name = knownPlates.get(plateKey(plate.text));
    return { ...plate, known: name !== undefined, ...(name !== undefined ? { name } : {}) };
}

function matchesDetection(event, filter = "all") {
    if (!DETECTION_TYPES.includes(filter)) throw new Error("Select a supported detection type.");
    if (!event || !["motion", "ring", "smartDetectZone", "smartDetectLine", "smartDetectLoiterZone"].includes(event.type)) return false;
    if (filter === "all") return true;
    if (filter === "licensePlate") return isLicensePlateEvent(event);
    if (filter === "motion" || filter === "ring") return event.type === filter;
    return Array.isArray(event.smartDetectTypes) && event.smartDetectTypes.includes(filter);
}

function describeDetection(event, knownPlates = new Map()) {
    return {
        eventId: event.id,
        cameraId: event.device || event.camera || event.cameraId,
        type: event.type,
        start: event.start,
        end: event.end === undefined ? null : event.end,
        objectTypes: Array.isArray(event.smartDetectTypes) ? event.smartDetectTypes.slice() : [],
        plates: extractLicensePlates(event).map((plate) => namePlate(plate, knownPlates))
    };
}

async function readRecentDetections(request, cameraId, options = {}, now = Date.now()) {
    const hours = boundedNumber(options.hours, 24, 0.05, 168);
    const limit = Math.floor(boundedNumber(options.limit, 20, 1, 100));
    const offset = Math.floor(boundedNumber(options.offset, 0, 0, Number.MAX_SAFE_INTEGER));
    const from = now - hours * 3600000;
    const filter = options.detectionType || "all";
    const names = parseKnownPlates(options.knownPlates);
    matchesDetection(null, filter); // Validate before making any request.
    const events = [];
    const seen = new Set();
    const pages = new Set();
    let nextOffset = offset;
    let hasMore = false;
    let stoppedReason = "end";
    // Controllers differ in filtering/pagination support. Bound the scan and
    // expose continuation rather than silently presenting an incomplete search.
    for (let page = 0; page < 10; page += 1) {
        const response = await request({
            path: "events", method: "GET", timeout: 25000, query: {
                cameras: [cameraId], start: from, end: now, limit: 100, offset: nextOffset,
                orderDirection: "DESC", withoutDescriptions: "false",
                types: ["motion", "ring", "smartDetectZone", "smartDetectLine", "smartDetectLoiterZone"]
            }
        });
        if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Unable to read recent detections (HTTP ${response.statusCode}). Check the local account's recording permissions.`);
        const payload = response.payload;
        const sourceRows = Array.isArray(payload) ? payload : payload && (payload.events || payload.data);
        if (!Array.isArray(sourceRows)) throw new Error("Protect returned an unsupported event history format.");
        const rows = sourceRows.slice(0, 100);
        const signature = JSON.stringify(rows.map((row) => row && [row.id, row.start]));
        if (rows.length && pages.has(signature)) { hasMore = true; stoppedReason = "repeated-page"; break; }
        pages.add(signature);
        let consumed = 0;
        for (const row of rows) {
            consumed += 1;
            if (!row || !row.id || seen.has(row.id)) continue;
            seen.add(row.id);
            const start = Number(row.start);
            if ((row.device || row.camera || row.cameraId) !== cameraId || !Number.isFinite(start) || start < from || start > now || !matchesDetection(row, filter)) continue;
            events.push(describeDetection(row, names));
            if (events.length >= limit) break;
        }
        nextOffset += consumed;
        hasMore = consumed < rows.length || rows.length >= 100;
        if (events.length >= limit) { stoppedReason = hasMore ? "limit" : "end"; break; }
        if (!hasMore) { stoppedReason = "end"; break; }
        stoppedReason = "scan-limit";
    }
    return { events, from: new Date(from).toISOString(), to: new Date(now).toISOString(), offset, nextOffset: hasMore ? nextOffset : null, hasMore, stoppedReason };
}

module.exports = { DETECTION_FIELD, KNOWN_PLATES_FIELD, parseKnownPlates, namePlate, matchesDetection, describeDetection, readRecentDetections };
