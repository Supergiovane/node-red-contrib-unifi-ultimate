"use strict";

function normalizeString(value) {
    return String(value || "").trim();
}

function stripOfflineTag(value) {
    return normalizeString(value)
        .replace(/\s*\(\s*offline\s*\)\s*/ig, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizePresenceMatchBy(value) {
    return normalizeString(value).toLowerCase() === "name" ? "name" : "id";
}

function normalizeClientMatchName(value) {
    const cleaned = stripOfflineTag(value);
    try {
        return cleaned.normalize("NFKC").toLowerCase();
    } catch (error) {
        return cleaned.toLowerCase();
    }
}

function getClientNameCandidates(client) {
    const item = client && typeof client === "object" && !Array.isArray(client)
        ? client
        : {};
    const raw = item.raw && typeof item.raw === "object" && !Array.isArray(item.raw)
        ? item.raw
        : {};
    const values = [
        item.name,
        item.displayName,
        item.display_name,
        item.deviceName,
        item.hostname,
        item.host_name,
        item.last_hostname,
        raw.name,
        raw.displayName,
        raw.display_name,
        raw.deviceName,
        raw.hostname,
        raw.host_name,
        raw.last_hostname
    ];
    const candidates = [];
    const seen = new Set();

    values.forEach((value) => {
        const cleaned = stripOfflineTag(value);
        const normalized = normalizeClientMatchName(cleaned);
        if (!cleaned || !normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        candidates.push(cleaned);
    });

    return candidates;
}

function isExplicitlyOffline(client) {
    const item = client && typeof client === "object" && !Array.isArray(client)
        ? client
        : {};
    return item.offline === true
        || item.isOnline === false
        || item.online === false
        || item.connected === false
        || item.isConnected === false
        || normalizeString(item.connectionState).toLowerCase() === "disconnected"
        || normalizeString(item.status).toLowerCase() === "offline"
        || normalizeString(item.state).toLowerCase() === "offline";
}

function findActiveClientsByName(clients, targetName) {
    const wanted = normalizeClientMatchName(targetName);
    if (!wanted) {
        return [];
    }

    return (Array.isArray(clients) ? clients : []).filter((client) => {
        if (!client || typeof client !== "object" || Array.isArray(client) || isExplicitlyOffline(client)) {
            return false;
        }
        return getClientNameCandidates(client)
            .some((candidate) => normalizeClientMatchName(candidate) === wanted);
    });
}

function resolveClientResourceId(client) {
    const item = client && typeof client === "object" && !Array.isArray(client)
        ? client
        : {};
    return [
        item.id,
        item.clientId,
        item.client_id,
        item.user_id,
        item._id,
        item.macAddress,
        item.mac_address,
        item.mac
    ].map(normalizeString).find(Boolean) || "";
}

module.exports = {
    normalizePresenceMatchBy,
    normalizeClientMatchName,
    getClientNameCandidates,
    findActiveClientsByName,
    resolveClientResourceId
};
