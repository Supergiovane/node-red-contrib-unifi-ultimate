"use strict";

function parseBoolean(value) {
    return value === true || value === "true" || value === 1 || value === "1";
}

function parseIntervalSeconds(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 5) {
        return fallback;
    }
    return Math.trunc(numeric);
}

function buildStatusTimestampText() {
    const now = new Date();
    const time = now.toTimeString().split(" ")[0];
    return `(day ${now.getDate()}, ${time})`;
}

function appendStatusTimestamp(text) {
    const normalized = String(text === undefined || text === null ? "" : text).trim();
    const suffix = buildStatusTimestampText();
    return normalized ? `${normalized} ${suffix}` : suffix;
}

function resolveNodeName(value) {
    return String(value || "").trim();
}

function resolveDeviceName(value) {
    return String(value || "").trim();
}

// Superset version — includes hostname and macAddress for Network nodes; harmless for Protect/Access.
function extractDeviceNameFromPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return "";
    }

    return resolveDeviceName(
        payload.name
        || payload.displayName
        || payload.hostname
        || payload.alias
        || payload.full_name
        || payload.macAddress
        || payload.id
    );
}

function attachDeviceNameToPayload(payload, deviceName) {
    if (!deviceName) {
        return payload;
    }

    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        return {
            ...payload,
            deviceName
        };
    }

    return payload;
}

function attachDetails(outputMsg, details) {
    if (!outputMsg || typeof outputMsg !== "object" || Array.isArray(outputMsg)) {
        return;
    }
    if (!details || typeof details !== "object" || Array.isArray(details)) {
        return;
    }

    outputMsg.details = {
        ...(outputMsg.details && typeof outputMsg.details === "object" && !Array.isArray(outputMsg.details)
            ? outputMsg.details
            : {}),
        ...details
    };
}

function buildErrorOutputMessage(error, nodeName) {
    return {
        topic: String(nodeName || "").trim() || undefined,
        payload: null,
        error: {
            message: String(error && error.message ? error.message : error)
        }
    };
}

module.exports = {
    parseBoolean,
    parseIntervalSeconds,
    buildStatusTimestampText,
    appendStatusTimestamp,
    resolveNodeName,
    resolveDeviceName,
    extractDeviceNameFromPayload,
    attachDeviceNameToPayload,
    attachDetails,
    buildErrorOutputMessage
};
