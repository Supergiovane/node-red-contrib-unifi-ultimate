"use strict";

const KNX_AI_CAMERA_REGISTRY_KEY = Symbol.for("node-red.knx-ai.camera-adapters.v1");
const SMART_CAMERA_EVENTS = new Set([
    "motion",
    "ring",
    "smartAudioDetect",
    "smartDetectZone",
    "smartDetectLine",
    "smartDetectLoiterZone"
]);

function normalizeText(value, maxLength = 240) {
    return String(value === undefined || value === null ? "" : value).trim().slice(0, maxLength);
}

function normalizeSearchText(value) {
    return normalizeText(value, 300)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

// This is the vendor-neutral KNX AI camera adapter contract. Keep this registry
// shape aligned with KNX Ultimate: an adapter describes package capabilities,
// while each configured controller registers a provider implementing
// listCameras(), takeSnapshot(), and subscribe(). The shared Symbol avoids any
// direct package dependency or flow wiring.
function getKnxAiCameraRegistry() {
    const existing = globalThis[KNX_AI_CAMERA_REGISTRY_KEY];
    if (existing && existing.version === 1 && existing.adapters instanceof Map && existing.providers instanceof Map) {
        return existing;
    }

    const registry = {
        version: 1,
        adapters: new Map(),
        providers: new Map(),
        listeners: new Set(),
        registerAdapter(adapter) {
            if (!adapter || !adapter.id) return;
            this.adapters.set(String(adapter.id), Object.freeze({ ...adapter }));
            this.listeners.forEach((listener) => {
                try { listener({ type: "adapter_registered", adapter: this.adapters.get(String(adapter.id)) }); } catch (error) { }
            });
        },
        registerProvider(provider) {
            if (!provider || !provider.id) return;
            this.providers.set(String(provider.id), provider);
            this.listeners.forEach((listener) => {
                try { listener({ type: "provider_registered", provider }); } catch (error) { }
            });
        },
        unregisterProvider(providerId) {
            const id = String(providerId || "");
            const provider = this.providers.get(id);
            if (!provider) return;
            this.providers.delete(id);
            this.listeners.forEach((listener) => {
                try { listener({ type: "provider_unregistered", provider }); } catch (error) { }
            });
        },
        subscribe(listener) {
            if (typeof listener !== "function") return () => { };
            this.listeners.add(listener);
            return () => this.listeners.delete(listener);
        }
    };
    globalThis[KNX_AI_CAMERA_REGISTRY_KEY] = registry;
    return registry;
}

function collectNamedScopes(camera, scopeKind) {
    if (!camera || typeof camera !== "object" || Array.isArray(camera)) return [];
    const branchPattern = scopeKind === "line"
        ? /(line|lines|smart.?detect.?line)/i
        : /(zone|zones|smart.?detect.?zone|loiter)/i;
    const idKeys = scopeKind === "line"
        ? ["lineId", "lineID", "line_id", "id", "index"]
        : ["zoneId", "zoneID", "zone_id", "id", "index"];
    const byId = new Map();
    const visited = new Set();

    function firstValue(value, keys) {
        for (const key of keys) {
            if (value && value[key] !== undefined && value[key] !== null && String(value[key]).trim()) return value[key];
        }
        return undefined;
    }

    function add(idValue, labelValue) {
        const id = normalizeText(idValue, 160);
        if (!id || byId.has(id)) return;
        byId.set(id, {
            id,
            name: normalizeText(labelValue, 240) || `${scopeKind === "line" ? "Line" : "Zone"} ${id}`
        });
    }

    function collect(candidate) {
        if (candidate === undefined || candidate === null) return;
        if (typeof candidate === "string" || typeof candidate === "number") {
            add(candidate, "");
            return;
        }
        if (Array.isArray(candidate)) {
            candidate.forEach((entry) => {
                if (entry && typeof entry === "object") {
                    add(firstValue(entry, idKeys), firstValue(entry, ["name", "displayName", "label", "title"]));
                } else {
                    add(entry, "");
                }
            });
            return;
        }
        if (typeof candidate === "object") {
            add(firstValue(candidate, idKeys), firstValue(candidate, ["name", "displayName", "label", "title"]));
            Object.entries(candidate).forEach(([key, value]) => {
                if (/^-?\d+$/.test(key)) {
                    add(key, value && typeof value === "object" ? firstValue(value, ["name", "displayName", "label", "title"]) : "");
                }
            });
        }
    }

    function walk(value, depth) {
        if (!value || typeof value !== "object" || visited.has(value) || depth > 8) return;
        visited.add(value);
        Object.entries(value).forEach(([key, nested]) => {
            if (branchPattern.test(key)) collect(nested);
            walk(nested, depth + 1);
        });
    }

    walk(camera, 0);
    return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function collectEventScopeIds(event, scopeKind) {
    if (!event || typeof event !== "object") return [];
    const keyPattern = scopeKind === "line"
        ? /(lineIds?|smart.?detect.?lineIds?)/i
        : /(zoneIds?|smart.?detect.?zoneIds?|loiterZoneIds?)/i;
    const idKeys = scopeKind === "line"
        ? ["lineId", "lineID", "line_id", "id"]
        : ["zoneId", "zoneID", "zone_id", "id"];
    const ids = new Set();
    const visited = new Set();

    function add(value) {
        const id = normalizeText(value, 160);
        if (id) ids.add(id);
    }

    function collect(value) {
        if (value === undefined || value === null) return;
        if (typeof value === "string" || typeof value === "number") return add(value);
        if (Array.isArray(value)) return value.forEach(collect);
        if (typeof value === "object") {
            for (const key of idKeys) {
                if (value[key] !== undefined) add(value[key]);
            }
        }
    }

    function walk(value, depth) {
        if (!value || typeof value !== "object" || visited.has(value) || depth > 8) return;
        visited.add(value);
        Object.entries(value).forEach(([key, nested]) => {
            if (keyPattern.test(key)) collect(nested);
            walk(nested, depth + 1);
        });
    }

    walk(event, 0);
    return Array.from(ids);
}

function collectDetectedObjectTypes(event) {
    const types = new Set();
    const visited = new Set();
    const keyPattern = /(smart.?detect.?types?|detection.?types?|object.?types?|detected.?objects?)/i;

    function add(value) {
        if (typeof value === "string" || typeof value === "number") {
            const normalized = normalizeSearchText(value);
            if (normalized) types.add(normalized);
            return;
        }
        if (Array.isArray(value)) value.forEach(add);
        if (value && typeof value === "object") {
            ["type", "label", "name", "objectType"].forEach((key) => {
                if (value[key] !== undefined) add(value[key]);
            });
        }
    }

    function walk(value, depth) {
        if (!value || typeof value !== "object" || visited.has(value) || depth > 8) return;
        visited.add(value);
        Object.entries(value).forEach(([key, nested]) => {
            if (keyPattern.test(key)) add(nested);
            walk(nested, depth + 1);
        });
    }

    walk(event, 0);
    return Array.from(types).slice(0, 12);
}

function normalizeProtectCameraEvent({ event, camera, controllerId, controllerName } = {}) {
    if (!event || typeof event !== "object" || event.modelKey !== "event") return null;
    const eventType = normalizeText(event.type, 80);
    const nativeCameraId = normalizeText(event.device, 160);
    if (!nativeCameraId || !SMART_CAMERA_EVENTS.has(eventType)) return null;
    const scopeKind = eventType === "smartDetectLine" ? "line"
        : ["smartDetectZone", "smartDetectLoiterZone"].includes(eventType) ? "zone" : "";
    const scopeIds = scopeKind ? collectEventScopeIds(event, scopeKind) : [];
    const knownScopes = scopeKind ? collectNamedScopes(camera, scopeKind) : [];
    const scopeId = scopeIds[0] || "";
    const scope = knownScopes.find((item) => item.id === scopeId);
    const cameraName = normalizeText(camera && (camera.name || camera.displayName), 240) || nativeCameraId;
    return {
        source: "unifi-ultimate",
        controllerId: normalizeText(controllerId, 160),
        controllerName: normalizeText(controllerName, 240),
        cameraId: `${normalizeText(controllerId, 160)}:${nativeCameraId}`,
        nativeCameraId,
        cameraName,
        eventId: normalizeText(event.id, 160),
        eventType,
        active: event.end === null || event.end === undefined,
        scopeId,
        scopeName: scope ? scope.name : "",
        scopeIds,
        objectTypes: collectDetectedObjectTypes(event),
        at: new Date(Number(event.start || event.timestamp || Date.now())).toISOString(),
        raw: event
    };
}

module.exports = {
    KNX_AI_CAMERA_REGISTRY_KEY,
    SMART_CAMERA_EVENTS,
    collectDetectedObjectTypes,
    collectEventScopeIds,
    collectNamedScopes,
    getKnxAiCameraRegistry,
    normalizeProtectCameraEvent,
    normalizeSearchText
};
