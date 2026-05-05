"use strict";

// Text-like media types that are safe to decode as utf8 text.
const TEXTUAL_EXACT_CONTENT_TYPES = [
    "application/x-www-form-urlencoded",
    "application/xml",
    "application/javascript",
    "application/ecmascript"
];

function normalizeContentType(contentType) {
    const value = Array.isArray(contentType) ? contentType[0] : contentType;
    return typeof value === "string" ? value.toLowerCase().split(";")[0].trim() : "";
}

function maybeParseBody(contentType, buffer) {
    // Remove optional charset/params and normalize case.
    const normalizedType = normalizeContentType(contentType);

    if (!buffer.length) {
        return "";
    }

    // Accept standard JSON and vendor/media types like application/problem+json.
    const isJsonType = normalizedType === "application/json" || normalizedType.endsWith("+json");
    // Classify media types that are text-based and can be safely coerced to string.
    const isTextType = normalizedType.startsWith("text/")
        || isJsonType
        || normalizedType.endsWith("+xml")
        || TEXTUAL_EXACT_CONTENT_TYPES.includes(normalizedType);

    // Prefer safety: if the response explicitly declares a non-text media type,
    // keep it as Buffer to avoid lossy utf8 coercion.
    if (normalizedType && !isTextType) {
        return buffer;
    }

    const raw = buffer.toString("utf8");
    if (!raw) {
        return raw;
    }

    const trimmed = raw.trim();
    // "Looks like JSON" probing is allowed only for unknown/textual responses.
    const canProbeJsonFromShape = !normalizedType || normalizedType.startsWith("text/");
    const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");

    if (isJsonType || (canProbeJsonFromShape && looksJson)) {
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            return raw;
        }
    }

    return raw;
}

module.exports = {
    maybeParseBody
};
