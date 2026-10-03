"use strict";

function readAlarmState(deviceType, device) {
    if (deviceType === "alarmHub") {
        const value = device && device.alarmHub && device.alarmHub.armed;
        if (value === true || value === "on") return true;
        if (value === false || value === "off") return false;
        return undefined;
    }
    const status = device && device.armMode && device.armMode.status;
    return deviceType === "nvr" && typeof status === "string" && status.trim()
        ? status : undefined;
}

function matchesDeviceUpdate(deviceType, deviceId, item, modelKey) {
    if (!item || item.id !== deviceId) return false;
    // Partial updates may omit the model key. IDs still scope them to the
    // configured device. Protect also represents Alarm Hubs as Link Stations.
    return !item.modelKey || item.modelKey === modelKey
        || (deviceType === "alarmHub" && item.modelKey === "linkStation")
        || (deviceType === "alarmHub" && item.modelKey === "linkstation");
}

function mergeDeviceUpdate(previous, update) {
    const result = { ...(previous || {}) };
    for (const [key, value] of Object.entries(update)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) continue;
        result[key] = value && typeof value === "object" && !Array.isArray(value)
            ? mergeDeviceUpdate(result[key] && typeof result[key] === "object" ? result[key] : null, value)
            : value;
    }
    return result;
}

function buildRequestError(response, method, path, secrets) {
    const statusCode = Number(response.statusCode);
    const body = response.payload;
    const detail = body && typeof body === "object"
        ? (body.message || (body.error && body.error.message) || (typeof body.error === "string" ? body.error : ""))
        : typeof body === "string" ? body : "";
    let apiMessage = typeof detail === "string" ? detail : "";
    for (const secret of secrets || []) {
        if (typeof secret === "string" && secret) apiMessage = apiMessage.split(secret).join("[redacted]");
    }
    apiMessage = apiMessage.replace(/(bearer\s+)\S+/gi, "$1[redacted]")
        .replace(/((?:password|token|api[-_ ]?key|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
        .replace(/[\r\n\t]+/g, " ").slice(0, 500);
    let hint = "";
    if (statusCode === 401) hint = " Check the Protect API key and its validity.";
    if (statusCode === 403) hint = " Check the Protect permissions of the account associated with the API key.";
    if (statusCode === 400 && path.startsWith("/v1/arm-profiles")) {
        hint = " Arm profile commands require Protect's local Alarm Manager; check the alarm mode and selected profile. A 400 response alone does not identify a permission failure.";
    }
    const error = new Error(`UniFi Protect request failed with status ${statusCode}.${hint}${apiMessage ? ` API: ${apiMessage}` : ""}`);
    error.protectResponse = { statusCode, method, path, ...(apiMessage ? { apiMessage } : {}) };
    return error;
}

module.exports = { readAlarmState, matchesDeviceUpdate, mergeDeviceUpdate, buildRequestError };
