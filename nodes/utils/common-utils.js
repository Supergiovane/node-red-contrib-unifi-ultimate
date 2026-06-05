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

function normalizePort(value) {
    // Accept a TCP port from the editor and reduce it to a clean "1".."65535"
    // string, or empty when missing/invalid so callers can fall back to defaults.
    if (value === undefined || value === null) {
        return "";
    }

    const str = String(value).trim();
    if (!str || !/^\d+$/.test(str)) {
        return "";
    }

    const num = Number(str);
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
        return "";
    }

    return String(num);
}

function hostHasExplicitPort(host) {
    if (!host) {
        return false;
    }

    if (host.startsWith("[")) {
        // IPv6 literal: a port is only present when "]:" appears (e.g. [::1]:443).
        return host.includes("]:");
    }

    // Bare host or IPv4: a single trailing :<digits> is a port.
    return (host.match(/:/g) || []).length === 1 && /:\d+$/.test(host);
}

function applyPortToHost(host, port) {
    // Combine a normalized host with the dedicated port field. A port already
    // embedded in the host string always wins, so the separate field only fills
    // the gap when the host carries none.
    const normalizedHost = String(host || "").trim();
    if (!normalizedHost) {
        return "";
    }

    const normalizedPort = normalizePort(port);
    if (!normalizedPort || hostHasExplicitPort(normalizedHost)) {
        return normalizedHost;
    }

    return `${normalizedHost}:${normalizedPort}`;
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
    normalizePort,
    applyPortToHost,
    buildStatusTimestampText,
    appendStatusTimestamp,
    resolveNodeName,
    resolveDeviceName,
    extractDeviceNameFromPayload,
    attachDeviceNameToPayload,
    attachDetails,
    buildErrorOutputMessage
};
