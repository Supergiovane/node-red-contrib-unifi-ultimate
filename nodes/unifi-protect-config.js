"use strict";

const {
    buildBaseUrlFromHost,
    buildControllerBaseUrlFromHost,
    normalizePort,
    buildQueryString,
    doRequest,
    buildRequestHeaders,
    buildRequestBody
} = require("./utils/unifi-protect-utils");
const {
    getDeviceTypes,
    getDeviceTypeDefinition,
    getCapabilitiesForType,
    getCapabilityOptions,
    buildDevicePath,
    normalizeDeviceCollection,
    summarizeDevice
} = require("./utils/unifi-protect-device-registry");
const {
    SMART_CAMERA_EVENTS,
    collectNamedScopes,
    getKnxAiCameraRegistry,
    normalizeProtectCameraEvent,
    normalizeSearchText
} = require("./utils/knx-ai-camera-registry");
const {
    createProtectHistoryPaginationGuard,
    extractProtectHistorySessionHeaders,
    normalizeProtectHistoryRequest,
    selectProtectHistoryEvents
} = require("./utils/unifi-protect-history");

function extractProtectErrorDetail(response) {
    let payload = response && response.payload;
    if (Buffer.isBuffer(payload)) {
        const text = payload.length <= 8192 ? payload.toString("utf8").trim() : "";
        if (!text) return "";
        try { payload = JSON.parse(text); } catch (error) { payload = text; }
    }
    if (typeof payload === "string") {
        const text = payload.trim();
        if (!text) return "";
        try { payload = JSON.parse(text); } catch (error) { return text.slice(0, 300); }
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    const nestedError = payload.error && typeof payload.error === "object" ? payload.error : {};
    const detail = payload.detail
        || payload.message
        || payload.error_description
        || nestedError.detail
        || nestedError.message
        || (typeof payload.error === "string" ? payload.error : "");
    return String(detail || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);
}

function createSnapshotError({ camera, response, retriedWithStandardQuality }) {
    const statusCode = Number(response && response.statusCode) || 0;
    const detail = extractProtectErrorDetail(response);
    const cameraState = String(camera && camera.raw && camera.raw.state || camera && camera.state || "")
        .trim()
        .toUpperCase();
    const isOffline = /\boffline\b/i.test(detail)
        || (statusCode === 503 && cameraState === "DISCONNECTED");
    let message;
    if (isOffline) {
        const stateDetail = cameraState ? `; state: ${cameraState}` : "";
        message = `UniFi Protect snapshot for '${camera.cameraName}' is unavailable because Protect reports that the camera is offline (HTTP ${statusCode || 503}${stateDetail}).`;
    } else if (statusCode === 429) {
        const retryAfter = response && response.headers && response.headers["retry-after"];
        const retryDetail = retryAfter ? `; retry after ${retryAfter} second(s)` : "";
        message = `UniFi Protect temporarily rate-limited the snapshot for '${camera.cameraName}' (HTTP 429${retryDetail}).`;
    } else {
        const apiDetail = detail ? `: ${detail}` : "";
        const retryDetail = retriedWithStandardQuality ? " after one standard-quality retry" : "";
        message = `UniFi Protect snapshot for '${camera.cameraName}' failed (HTTP ${statusCode || "unknown"}${apiDetail})${retryDetail}.`;
    }
    const error = new Error(message);
    error.code = isOffline ? "UNIFI_PROTECT_CAMERA_OFFLINE" : statusCode === 429 ? "UNIFI_PROTECT_RATE_LIMITED" : "UNIFI_PROTECT_SNAPSHOT_FAILED";
    error.statusCode = statusCode;
    error.cameraState = cameraState;
    return error;
}

const PROTECT_CAMERA_EVENT_DEDUPE_TTL_MS = 60 * 60 * 1000;
const PROTECT_CAMERA_EVENT_DEDUPE_MAX_ENTRIES = 2048;

function cloneProviderMetadataWithoutRaw(value) {
    if (Array.isArray(value)) return value.map(cloneProviderMetadataWithoutRaw);
    if (!value || typeof value !== "object") return value;
    const clone = {};
    Object.entries(value).forEach(([key, nested]) => {
        if (key === "raw") return;
        clone[key] = cloneProviderMetadataWithoutRaw(nested);
    });
    return clone;
}

function sortedSemanticValues(values) {
    return Array.from(new Set((Array.isArray(values) ? values : [])
        .map((value) => String(value === undefined || value === null ? "" : value).trim())
        .filter(Boolean)))
        .sort();
}

function createProtectCameraEventDeduper({
    ttlMs = PROTECT_CAMERA_EVENT_DEDUPE_TTL_MS,
    maxEntries = PROTECT_CAMERA_EVENT_DEDUPE_MAX_ENTRIES
} = {}) {
    const entries = new Map();
    const normalizedTtl = Math.max(1000, Number(ttlMs) || PROTECT_CAMERA_EVENT_DEDUPE_TTL_MS);
    const normalizedMaxEntries = Math.max(1, Math.floor(Number(maxEntries) || PROTECT_CAMERA_EVENT_DEDUPE_MAX_ENTRIES));
    let lastPrunedAt = 0;

    function prune(now, force = false) {
        if (!force && entries.size < normalizedMaxEntries && now - lastPrunedAt < Math.min(normalizedTtl, 60000)) return;
        entries.forEach((entry, key) => {
            if (now - entry.seenAt > normalizedTtl) entries.delete(key);
        });
        lastPrunedAt = now;
    }

    return {
        shouldForward(event, sourceEvent, now = Date.now()) {
            if (!event || typeof event !== "object") return false;
            const checkedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
            prune(checkedAt);
            const eventId = String(event.eventId || "").trim();
            const key = eventId
                ? `id:${eventId}`
                : `fallback:${event.cameraId || event.nativeCameraId || ""}:${event.eventType || ""}:${event.at || ""}`;
            const rawEnd = sourceEvent && sourceEvent.end !== undefined && sourceEvent.end !== null
                ? String(sourceEvent.end)
                : null;
            const fingerprint = JSON.stringify({
                source: event.source || "",
                controllerId: event.controllerId || "",
                controllerName: event.controllerName || "",
                cameraId: event.cameraId || "",
                nativeCameraId: event.nativeCameraId || "",
                cameraName: event.cameraName || "",
                eventId,
                eventType: event.eventType || "",
                at: event.at || "",
                active: event.active === true,
                end: rawEnd,
                scopeId: event.scopeId || "",
                scopeName: event.scopeName || "",
                scopeIds: sortedSemanticValues(event.scopeIds),
                objectTypes: sortedSemanticValues(event.objectTypes)
            });
            const previous = entries.get(key);
            const isDuplicate = previous
                && previous.fingerprint === fingerprint
                && checkedAt - previous.seenAt <= normalizedTtl;

            // Refresh insertion order even for duplicates so a noisy active event
            // remains suppressed until it has actually gone quiet for the TTL.
            entries.delete(key);
            entries.set(key, { fingerprint, seenAt: checkedAt });
            if (entries.size > normalizedMaxEntries) {
                const oldestKey = entries.keys().next().value;
                if (oldestKey !== undefined) entries.delete(oldestKey);
            }
            return !isDuplicate;
        },
        clear() {
            entries.clear();
            lastPrunedAt = 0;
        }
    };
}

module.exports = function(RED) {
    const knxAiCameraRegistry = getKnxAiCameraRegistry();
    knxAiCameraRegistry.registerAdapter({
        id: "unifi-ultimate",
        title: "UniFi Ultimate / Protect",
        packageName: "node-red-contrib-unifi-ultimate",
        capabilities: ["camera_catalog", "snapshot", "motion", "smart_events", "zones", "lines", "event_history", "event_snapshot"]
    });

    function UnifiProtectConfigNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.host = String(config.host || "").trim();
        node.port = normalizePort(config.port);
        node.baseUrl = buildBaseUrlFromHost(node.host, node.port);
        node.controllerBaseUrl = buildControllerBaseUrlFromHost(node.host, node.port);
        // UniFi controllers almost always use self-signed certificates, so accept
        // them unless the user explicitly opted into strict verification.
        node.rejectUnauthorized = config.rejectUnauthorized === true || config.rejectUnauthorized === "true";
        node.nodeClients = [];
        node.wsDevices = null;
        node.wsEvents = null;
        node.reconnectTimer = null;
        node.isClosing = false;
        node.knxAiCameraCache = { at: 0, cameras: [] };
        node.knxAiCameraRefresh = null;
        node.knxAiCameraRefreshAgain = false;
        node.knxAiCameraListeners = new Set();
        node.protectHistoryPaginationGuard = createProtectHistoryPaginationGuard();
        node.protectCameraEventDeduper = createProtectCameraEventDeduper();

        // Historical credentials used to belong to this config node. Remove any
        // legacy values from the runtime credential cache so a subsequent deploy
        // also removes them from Node-RED's encrypted credential file. History
        // callers now own those credentials and provide them for each operation.
        if (node.credentials && typeof node.credentials === "object") {
            const hadLegacyHistoryCredentials = Object.prototype.hasOwnProperty.call(node.credentials, "historyUsername")
                || Object.prototype.hasOwnProperty.call(node.credentials, "historyPassword");
            if (hadLegacyHistoryCredentials) {
                const apiKey = node.credentials.apiKey;
                node.credentials = apiKey === undefined ? {} : { apiKey };
                if (RED.nodes && typeof RED.nodes.addCredentials === "function") {
                    // Do not log either the old credentials or failures from this
                    // best-effort migration. Node-RED persists the sanitized cache
                    // through its normal encrypted credential/deploy lifecycle.
                    Promise.resolve(RED.nodes.addCredentials(node.id, node.credentials)).catch(() => { });
                }
            }
        }

        node.getApiKey = () => node.credentials && node.credentials.apiKey;

        const providerIsConfigured = () => Boolean(node.baseUrl && node.getApiKey());
        node.knxAiCameraProviderHealth = {
            connected: false,
            ready: false,
            status: providerIsConfigured() ? "degraded" : "unavailable",
            checkedAt: "",
            lastSeenAt: "",
            lastError: providerIsConfigured()
                ? "The UniFi Protect camera catalog has not been checked yet."
                : "The UniFi Protect host or API key is not configured."
        };
        node.updateKnxAiCameraProviderHealth = ({ ok, error } = {}) => {
            const checkedAt = new Date().toISOString();
            const configured = providerIsConfigured() && !node.isClosing;
            const healthy = configured && ok === true;
            const message = healthy
                ? ""
                : String(error && (error.message || error) || (configured
                    ? "The UniFi Protect camera catalog is unavailable."
                    : "The UniFi Protect host or API key is not configured."));
            node.knxAiCameraProviderHealth = {
                connected: healthy,
                ready: healthy,
                status: healthy ? "healthy" : "unavailable",
                checkedAt,
                lastSeenAt: healthy ? checkedAt : node.knxAiCameraProviderHealth.lastSeenAt,
                lastError: message.slice(0, 500)
            };
        };

        node.authenticateProtectHistory = async (historyCredentials) => {
            const source = historyCredentials && typeof historyCredentials === "object" && !Array.isArray(historyCredentials)
                ? historyCredentials
                : {};
            const username = String(source.username || "").trim();
            const password = String(source.password || "");
            if (!username || !password) {
                const error = new Error("UniFi Protect historical events require a local history username and password supplied by the caller.");
                error.code = "UNIFI_PROTECT_HISTORY_CREDENTIALS_REQUIRED";
                throw error;
            }
            if (!node.controllerBaseUrl) throw new Error("The configured IP is empty or invalid.");
            const headers = {
                Accept: "application/json",
                "Content-Type": "application/json"
            };
            const body = buildRequestBody(headers, "POST", {
                username,
                password,
                rememberMe: false
            });
            const response = await doRequest(new URL(`${node.controllerBaseUrl}/api/auth/login`), {
                method: "POST",
                headers,
                timeout: 15000,
                rejectUnauthorized: node.rejectUnauthorized
            }, body);
            if (response.statusCode < 200 || response.statusCode >= 300) {
                // Controller error bodies are deliberately excluded: some UniFi
                // versions may echo submitted login fields in diagnostic details.
                const error = new Error(`UniFi OS login for Protect history failed (HTTP ${response.statusCode || "unknown"}).`);
                error.code = "UNIFI_PROTECT_HISTORY_LOGIN_FAILED";
                error.statusCode = Number(response.statusCode) || 0;
                throw error;
            }
            return extractProtectHistorySessionHeaders(response);
        };

        node.executeProtectHistoryRequest = async (
            { path, method = "GET", query, headers, payload, timeout = 20000 } = {},
            { historyCredentials, retryAuthentication = true } = {},
            callSession = {}
        ) => {
            // The session may be reused only by HTTP attempts belonging to one
            // provider operation (for example delayed thumbnail retries). This
            // object is local to that operation and never retained on the node.
            if (!callSession.sessionHeaders) {
                callSession.sessionHeaders = await node.authenticateProtectHistory(historyCredentials);
            }
            const sessionHeaders = callSession.sessionHeaders;
            const normalizedPath = String(path || "").replace(/^\/+/, "");
            const requestUrl = new URL(`${node.controllerBaseUrl}/proxy/protect/api/${normalizedPath}${buildQueryString(query)}`);
            const requestMethod = String(method || "GET").toUpperCase();
            const requestHeaders = Object.assign({ Accept: "application/json" }, sessionHeaders, headers || {});
            const requestBody = buildRequestBody(requestHeaders, requestMethod, payload);
            const response = await doRequest(requestUrl, {
                method: requestMethod,
                headers: requestHeaders,
                timeout,
                rejectUnauthorized: node.rejectUnauthorized
            }, requestBody);
            const refreshedCsrf = response && response.headers && response.headers["x-csrf-token"];
            if (refreshedCsrf) callSession.sessionHeaders["X-CSRF-Token"] = String(refreshedCsrf);
            if (Number(response && response.statusCode) === 401
                && retryAuthentication
                && callSession.authenticationRetries !== 1) {
                callSession.authenticationRetries = 1;
                callSession.sessionHeaders = null;
                return node.executeProtectHistoryRequest(
                    { path, method, query, headers, payload, timeout },
                    { historyCredentials, retryAuthentication: false },
                    callSession
                );
            }
            return response;
        };

        node.apiRequest = async ({
            path,
            method = "GET",
            query,
            headers,
            payload,
            timeout = 15000
        }) => {
            if (!node.baseUrl) {
                throw new Error("The configured IP is empty or invalid.");
            }

            const apiKey = node.getApiKey();
            if (!apiKey) {
                throw new Error("The UniFi Protect API key is missing.");
            }

            // Protect requests all share the same base proxy URL. Callers only
            // provide relative API paths and optional query/payload details.
            const queryString = buildQueryString(query);
            const normalizedPath = String(path || "").startsWith("/") ? String(path || "") : `/${String(path || "")}`;
            const requestUrl = new URL(`${node.baseUrl}${normalizedPath}${queryString}`);
            const requestMethod = String(method || "GET").toUpperCase();
            const requestHeaders = buildRequestHeaders(apiKey, headers);
            const requestBody = buildRequestBody(requestHeaders, requestMethod, payload);

            return doRequest(
                requestUrl,
                {
                    method: requestMethod,
                    headers: requestHeaders,
                    timeout,
                    rejectUnauthorized: node.rejectUnauthorized
                },
                requestBody
            );
        };

        // Leaf nodes must delegate outbound UniFi Protect calls to the config node.
        node.executeProtectRequest = async (request) => node.apiRequest(request || {});

        node.fetchDevices = async (deviceType) => {
            const definition = getDeviceTypeDefinition(deviceType);
            if (!definition) {
                throw new Error(`Unsupported device type: ${deviceType}`);
            }

            // Protect resource families have one direct collection endpoint each,
            // so discovery is simpler than Network's cross-site enumeration.
            const response = await node.apiRequest({ path: definition.listPath, method: "GET" });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Failed to load ${deviceType} devices (${response.statusCode})`);
            }
            return normalizeDeviceCollection(deviceType, response.payload);
        };

        node.fetchDeviceByTypeAndId = async (deviceType, deviceId) => {
            const path = buildDevicePath(deviceType, "detail", deviceId);
            const response = await node.apiRequest({
                path,
                method: "GET"
            });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Failed to load ${deviceType} ${deviceId || ""} (${response.statusCode})`);
            }
            return response.payload;
        };

        node.fetchAssetFiles = async (fileType) => {
            const normalizedType = String(fileType || "").trim();
            if (!normalizedType) {
                throw new Error("Missing file type.");
            }

            // Asset files are used by dynamic editor options such as doorbell
            // image messages.
            const response = await node.apiRequest({
                path: `/v1/files/${encodeURIComponent(normalizedType)}`,
                method: "GET"
            });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Failed to load files for ${normalizedType} (${response.statusCode})`);
            }

            return Array.isArray(response.payload)
                ? response.payload
                : [];
        };

        node.fetchArmProfiles = async () => {
            const response = await node.apiRequest({
                path: "/v1/arm-profiles",
                method: "GET"
            });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Failed to load Protect arm profiles (${response.statusCode})`);
            }

            return Array.isArray(response.payload)
                ? response.payload
                : [];
        };

        node.fetchCapabilityOptions = async (deviceType, deviceId, capabilityId, capabilityConfig) => {
            const selectedDevice = deviceId
                ? await node.fetchDeviceByTypeAndId(deviceType, deviceId)
                : null;

            return getCapabilityOptions(deviceType, capabilityId, {
                deviceId,
                device: selectedDevice,
                capabilityConfig,
                fetchDevice: node.fetchDeviceByTypeAndId,
                fetchDevices: node.fetchDevices,
                fetchAssetFiles: node.fetchAssetFiles,
                fetchArmProfiles: node.fetchArmProfiles
            });
        };

        node.fetchCapabilities = async (deviceType, deviceId) => {
            const selectedDevice = deviceId
                ? await node.fetchDeviceByTypeAndId(deviceType, deviceId)
                : null;

            return getCapabilitiesForType(deviceType, selectedDevice);
        };

        node.listKnxAiCameras = async ({ force = false, allowStale = false } = {}) => {
            const now = Date.now();
            const cachedCameras = Array.isArray(node.knxAiCameraCache.cameras)
                ? node.knxAiCameraCache.cameras.slice()
                : [];
            const cacheIsFresh = node.knxAiCameraCache.at > 0
                && (now - node.knxAiCameraCache.at) < 30000;
            if (!force && cacheIsFresh) {
                return node.knxAiCameraCache.cameras.slice();
            }
            if (node.knxAiCameraRefresh) {
                if (!force && allowStale && cachedCameras.length > 0) return cachedCameras;
                return (await node.knxAiCameraRefresh).slice();
            }

            let refresh;
            refresh = Promise.resolve().then(() => node.fetchDevices("camera")).then((devices) => {
                const cameras = devices.map((camera) => {
                    const nativeCameraId = String(camera && camera.id || "").trim();
                    const cameraName = String(camera && (camera.name || camera.displayName) || nativeCameraId).trim();
                    const cameraState = String(camera && camera.state || "").trim().toUpperCase();
                    const objectTypes = Array.from(new Set([].concat(
                        camera && camera.smartDetectSettings && Array.isArray(camera.smartDetectSettings.objectTypes)
                            ? camera.smartDetectSettings.objectTypes
                            : [],
                        camera && camera.featureFlags && Array.isArray(camera.featureFlags.smartDetectTypes)
                            ? camera.featureFlags.smartDetectTypes
                            : []
                    ).map((value) => String(value || "").trim()).filter(Boolean)));
                    return {
                        id: `${node.id}:${nativeCameraId}`,
                        cameraId: `${node.id}:${nativeCameraId}`,
                        nativeCameraId,
                        cameraName,
                        name: cameraName,
                        aliases: [cameraName, nativeCameraId].filter(Boolean),
                        controllerId: node.id,
                        controllerName: node.name || node.host || node.id,
                        adapterId: "unifi-ultimate",
                        adapterTitle: "UniFi Ultimate / Protect",
                        source: "unifi-ultimate",
                        state: cameraState,
                        online: cameraState ? cameraState === "CONNECTED" : null,
                        objectTypes,
                        lines: collectNamedScopes(camera, "line"),
                        zones: collectNamedScopes(camera, "zone"),
                        raw: camera
                    };
                }).filter((camera) => camera.nativeCameraId);
                node.knxAiCameraCache = { at: Date.now(), cameras };
                node.updateKnxAiCameraProviderHealth({ ok: true });
                return cameras;
            }).catch((error) => {
                node.updateKnxAiCameraProviderHealth({ ok: false, error });
                throw error;
            }).finally(() => {
                if (node.knxAiCameraRefresh !== refresh) return;
                node.knxAiCameraRefresh = null;
                if (!node.knxAiCameraRefreshAgain || node.isClosing) return;
                node.knxAiCameraRefreshAgain = false;
                node.knxAiCameraCache = { at: 0, cameras: node.knxAiCameraCache.cameras };
                Promise.resolve(node.listKnxAiCameras({ force: true })).catch((error) => {
                    node.warn(`Unable to refresh the KNX AI camera catalog: ${error && error.message ? error.message : error}`);
                });
            });
            node.knxAiCameraRefresh = refresh;

            if (!force && allowStale && cachedCameras.length > 0) {
                refresh.catch((error) => {
                    node.warn(`Unable to refresh the KNX AI camera catalog: ${error && error.message ? error.message : error}`);
                });
                return cachedCameras;
            }
            return (await refresh).slice();
        };

        node.resolveKnxAiCamera = async ({ cameraId, cameraName } = {}) => {
            const cameras = await node.listKnxAiCameras();
            const requestedId = String(cameraId || "").trim();
            const requestedName = normalizeSearchText(cameraName);
            const exact = cameras.filter((camera) => {
                return requestedId && [camera.id, camera.cameraId, camera.nativeCameraId].includes(requestedId)
                    || requestedName && [camera.cameraName, camera.name].concat(camera.aliases || []).some((value) => normalizeSearchText(value) === requestedName);
            });
            if (exact.length === 1) return exact[0];
            if (exact.length > 1) throw new Error("The camera name is ambiguous.");
            const partial = requestedName ? cameras.filter((camera) => {
                return [camera.cameraName, camera.name].concat(camera.aliases || []).some((value) => {
                    const candidate = normalizeSearchText(value);
                    return candidate && (candidate.includes(requestedName) || requestedName.includes(candidate));
                });
            }) : [];
            if (partial.length === 1) return partial[0];
            if (partial.length > 1) throw new Error("The camera name is ambiguous.");
            throw new Error("Camera not found in this UniFi Protect controller.");
        };

        node.takeKnxAiCameraSnapshot = async ({ cameraId, cameraName, highQuality = false } = {}) => {
            const camera = await node.resolveKnxAiCamera({ cameraId, cameraName });
            const supportsHighQuality = camera.raw
                && camera.raw.featureFlags
                && camera.raw.featureFlags.supportFullHdSnapshot === true;
            const requestHighQuality = highQuality === true && supportsHighQuality;
            const requestSnapshot = (useHighQuality) => node.apiRequest({
                path: `/v1/cameras/${encodeURIComponent(camera.nativeCameraId)}/snapshot`,
                method: "GET",
                // The Protect API defaults to standard quality. Do not send the
                // highQuality flag unless this camera explicitly advertises it.
                query: useHighQuality ? { highQuality: "true" } : {},
                headers: { Accept: "image/jpeg" },
                timeout: 20000
            });
            let response = await requestSnapshot(requestHighQuality);
            const statusCode = Number(response && response.statusCode) || 0;
            const firstErrorDetail = extractProtectErrorDetail(response);
            const cameraState = String(camera && camera.raw && camera.raw.state || "").trim().toUpperCase();
            const cameraIsOffline = /\boffline\b/i.test(firstErrorDetail)
                || (statusCode === 503 && cameraState === "DISCONNECTED");
            const shouldRetryStandard = !cameraIsOffline && (requestHighQuality
                ? [400, 409, 422, 500, 502, 503, 504].includes(statusCode)
                : [502, 503, 504].includes(statusCode));
            let retriedWithStandardQuality = false;
            if (shouldRetryStandard) {
                // Some Protect/camera combinations reject forced full-HD
                // snapshots with 503 even though a normal snapshot is ready.
                retriedWithStandardQuality = true;
                response = await requestSnapshot(false);
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw createSnapshotError({ camera, response, retriedWithStandardQuality });
            }
            if (!Buffer.isBuffer(response.payload) || response.payload.length === 0) {
                throw new Error("UniFi Protect returned an empty or invalid snapshot.");
            }
            const contentTypeHeader = response.headers && response.headers["content-type"];
            const mediaType = String(Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader || "image/jpeg")
                .split(";")[0]
                .trim()
                .toLowerCase();
            return {
                data: response.payload,
                mediaType,
                camera: cloneProviderMetadataWithoutRaw(camera),
                statusCode: response.statusCode
            };
        };

        node.queryKnxAiCameraEvents = async (request = {}, { historyCredentials, historyQueryScope } = {}) => {
            const normalized = normalizeProtectHistoryRequest(request);
            const requestSource = request && typeof request === "object" && !Array.isArray(request) ? request : {};
            const paginationKey = JSON.stringify({
                // This is an opaque, non-secret caller id (for example a
                // Cerebrum node id). It prevents otherwise identical paginated
                // searches from different callers contaminating each other.
                historyQueryScope: String(historyQueryScope || "").trim().slice(0, 200),
                cameraId: normalized.cameraId,
                cameraName: normalized.cameraName,
                start: requestSource.from !== undefined || requestSource.start !== undefined ? normalized.start : "default",
                end: requestSource.to !== undefined || requestSource.end !== undefined ? normalized.end : "default",
                eventTypes: normalized.eventTypes,
                objectTypes: normalized.objectTypes
            });
            const requestedCamera = normalized.cameraId || normalized.cameraName
                ? await node.resolveKnxAiCamera({ cameraId: normalized.cameraId, cameraName: normalized.cameraName })
                : null;
            const response = await node.executeProtectHistoryRequest({
                path: "events",
                method: "GET",
                query: Object.assign({}, normalized.query, requestedCamera
                    ? { cameras: [requestedCamera.nativeCameraId] }
                    : {}),
                timeout: 25000
            }, { historyCredentials });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                // History responses are source-owned and may contain sensitive
                // controller diagnostics. Expose only the status code upstream.
                throw new Error(`Unable to retrieve UniFi Protect historical events (HTTP ${response.statusCode || "unknown"}).`);
            }
            const payload = Array.isArray(response.payload)
                ? response.payload
                : response.payload && Array.isArray(response.payload.events)
                    ? response.payload.events
                    : response.payload && Array.isArray(response.payload.data)
                        ? response.payload.data
                        : [];
            const cameras = await node.listKnxAiCameras();
            const events = payload.map((item) => {
                if (!item || typeof item !== "object") return null;
                const nativeCameraId = String(item.device || item.camera || item.cameraId || "").trim();
                const startValue = item.start === undefined || item.start === null ? item.timestamp : item.start;
                const numericStart = Number(startValue);
                const start = Number.isFinite(numericStart) ? numericStart : Date.parse(String(startValue || ""));
                if (!nativeCameraId || !Number.isFinite(start)) return null;
                const numericEnd = Number(item.end);
                const parsedEnd = item.end === null || item.end === undefined
                    ? null
                    : Number.isFinite(numericEnd)
                        ? numericEnd
                        : Date.parse(String(item.end));
                const camera = cameras.find((candidate) => candidate.nativeCameraId === nativeCameraId);
                const event = normalizeProtectCameraEvent({
                    event: Object.assign({}, item, {
                        modelKey: "event",
                        type: item.type || item.eventType,
                        device: nativeCameraId,
                        start
                    }),
                    camera: camera && camera.raw,
                    controllerId: node.id,
                    controllerName: node.name || node.host || node.id
                });
                if (!event) return null;
                return Object.assign({}, event, {
                    endAt: Number.isFinite(parsedEnd) ? new Date(parsedEnd).toISOString() : "",
                    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
                    // Protect does not consistently include thumbnail/thumbnailId
                    // in historical event rows even though the event-id endpoint
                    // can return the JPEG. The endpoint is the authoritative
                    // availability check; an exact event id is enough to try it.
                    thumbnailAvailable: Boolean(event.eventId)
                });
            }).filter(Boolean);
            const selected = selectProtectHistoryEvents(events, Object.assign({}, normalized, {
                cameraId: requestedCamera && requestedCamera.id || ""
            }));
            const continuation = node.protectHistoryPaginationGuard.evaluate({
                key: paginationKey,
                offset: normalized.offset,
                pageSize: normalized.pageSize,
                events: payload
            });
            return {
                events: continuation.duplicatePage ? [] : selected.map(cloneProviderMetadataWithoutRaw),
                from: normalized.from,
                to: normalized.to,
                offset: normalized.offset,
                nextOffset: continuation.nextOffset,
                hasMore: continuation.hasMore,
                scannedEvents: payload.length,
                duplicatePage: continuation.duplicatePage,
                continuationStoppedReason: continuation.duplicatePage
                    ? "duplicate_page"
                    : !continuation.madeProgress && payload.length >= normalized.pageSize
                        ? "no_progress"
                        : ""
            };
        };

        node.takeKnxAiCameraEventSnapshot = async (request = {}, { historyCredentials } = {}) => {
            const requestSource = request && typeof request === "object" && !Array.isArray(request) ? request : {};
            const id = String(requestSource.eventId || "").trim().replace(/^e-/, "");
            if (!id || id.length > 200) throw new Error("A valid UniFi Protect event id is required.");
            let response;
            // This session is scoped to the current provider invocation and lets
            // 404 thumbnail retries avoid creating additional UniFi OS sessions.
            const callSession = {};
            for (let attempt = 0; attempt < 4; attempt += 1) {
                response = await node.executeProtectHistoryRequest({
                    path: `events/${encodeURIComponent(id)}/thumbnail`,
                    method: "GET",
                    headers: { Accept: "image/jpeg" },
                    timeout: 25000
                }, { historyCredentials }, callSession);
                if (response.statusCode !== 404 || attempt === 3) break;
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (!response || response.statusCode < 200 || response.statusCode >= 300) {
                // Do not forward controller response bodies into chat/tool errors.
                throw new Error(`Unable to retrieve the UniFi Protect event snapshot (HTTP ${response && response.statusCode || "unknown"}).`);
            }
            if (!Buffer.isBuffer(response.payload) || response.payload.length === 0) {
                throw new Error("UniFi Protect returned an empty or invalid event snapshot.");
            }
            const contentTypeHeader = response.headers && response.headers["content-type"];
            const mediaType = String(Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader || "image/jpeg")
                .split(";")[0]
                .trim()
                .toLowerCase();
            return {
                data: response.payload,
                mediaType,
                eventId: id,
                statusCode: response.statusCode
            };
        };

        node.buildWebSocketUrl = (path) => {
            // Reuse the configured HTTPS base URL and only swap protocol for the
            // matching websocket scheme.
            const url = new URL(`${node.baseUrl}${path}`);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            return url.toString();
        };

        node.broadcastDeviceUpdate = (update) => {
            // The config node is the single websocket consumer; individual
            // runtime nodes subscribe through addClient/removeClient.
            node.nodeClients.forEach((client) => {
                try {
                    if (client && typeof client.handleProtectDeviceUpdate === "function") {
                        client.handleProtectDeviceUpdate(update);
                    }
                } catch (error) {
                }
            });
        };

        node.broadcastEventUpdate = (update) => {
            node.nodeClients.forEach((client) => {
                try {
                    if (client && typeof client.handleProtectEventUpdate === "function") {
                        client.handleProtectEventUpdate(update);
                    }
                } catch (error) {
                }
            });
        };

        node.scheduleReconnect = () => {
            if (node.isClosing || node.reconnectTimer || node.nodeClients.length === 0) {
                return;
            }

            // Back off a little before reconnecting so temporary controller
            // restarts do not cause a tight reconnect loop.
            node.reconnectTimer = setTimeout(() => {
                node.reconnectTimer = null;
                try {
                    node.ensureWebSockets();
                } catch (error) {
                    node.warn(`Protect websocket reconnect failed: ${error && error.message ? error.message : error}`);
                }
            }, 5000);
        };

        node.attachSocket = (kind, path, handler) => {
            let WebSocket;
            const apiKey = node.getApiKey();
            if (!apiKey || !node.baseUrl) {
                return;
            }

            // Load ws lazily so HTTP-only users do not pay the dependency cost
            // until live observation is actually needed.
            try {
                ({ WebSocket } = require("ws"));
            } catch (error) {
                node.warn("The 'ws' dependency is not installed. UniFi Protect event streams are disabled until dependencies are installed.");
                return;
            }

            let ws;
            try {
                ws = new WebSocket(node.buildWebSocketUrl(path), {
                    headers: {
                        "X-API-Key": apiKey,
                        Accept: "application/json"
                    },
                    rejectUnauthorized: node.rejectUnauthorized
                });
            } catch (error) {
                node.warn(`Unable to open Protect websocket '${kind}': ${error && error.message ? error.message : error}`);
                node.scheduleReconnect();
                return;
            }

            ws.on("message", (rawData) => {
                try {
                    // Protect streams send JSON messages; malformed frames are
                    // ignored so one bad packet does not kill the whole stream.
                    const text = Buffer.isBuffer(rawData) ? rawData.toString("utf8") : String(rawData);
                    const parsed = JSON.parse(text);
                    handler(parsed);
                } catch (error) {
                }
            });

            ws.on("close", () => {
                try {
                    let wasActive = false;
                    if (kind === "devices" && node.wsDevices === ws) {
                        node.wsDevices = null;
                        wasActive = true;
                    }
                    if (kind === "events" && node.wsEvents === ws) {
                        node.wsEvents = null;
                        wasActive = true;
                    }
                    if (wasActive) node.scheduleReconnect();
                } catch (error) {
                }
            });

            ws.on("error", () => {
                try {
                    ws.close();
                } catch (error) {
                }
            });

            if (kind === "devices") {
                node.wsDevices = ws;
            } else {
                node.wsEvents = ws;
            }
        };

        const clientNeedsProtectStream = (client, kind, handlerName) => {
            if (!client || typeof client[handlerName] !== "function") return false;
            if (!Array.isArray(client.protectStreams)) return true;
            return client.protectStreams.some((stream) => String(stream || "").trim().toLowerCase() === kind);
        };

        node.closeWebSocket = (kind) => {
            const propertyName = kind === "devices" ? "wsDevices" : "wsEvents";
            const socket = node[propertyName];
            if (!socket) return;
            // Clear ownership before close so the close callback knows this was
            // intentional and does not schedule an unnecessary reconnect.
            node[propertyName] = null;
            try {
                socket.close();
            } catch (error) {
            }
        };

        node.ensureWebSockets = () => {
            if (node.isClosing) return;

            const needsDevices = node.nodeClients.some((client) => clientNeedsProtectStream(client, "devices", "handleProtectDeviceUpdate"));
            const needsEvents = node.nodeClients.some((client) => clientNeedsProtectStream(client, "events", "handleProtectEventUpdate"));

            // Devices and events are independent Protect streams. Open only the
            // streams requested by active clients and close any no longer used.
            if (needsDevices && !node.wsDevices) {
                node.attachSocket("devices", "/v1/subscribe/devices", node.broadcastDeviceUpdate);
            } else if (!needsDevices) {
                node.closeWebSocket("devices");
            }

            if (needsEvents && !node.wsEvents) {
                node.attachSocket("events", "/v1/subscribe/events", node.broadcastEventUpdate);
            } else if (!needsEvents) {
                node.closeWebSocket("events");
            }
        };

        node.closeWebSockets = () => {
            if (node.reconnectTimer) {
                clearTimeout(node.reconnectTimer);
                node.reconnectTimer = null;
            }

            node.closeWebSocket("devices");
            node.closeWebSocket("events");
        };

        node.addClient = (client) => {
            if (!client) {
                return;
            }
            // Keep the websocket connection alive only while at least one node
            // needs live Protect updates.
            node.nodeClients = node.nodeClients.filter((entry) => entry && entry.id !== client.id);
            node.nodeClients.push(client);
            try {
                node.ensureWebSockets();
            } catch (error) {
                node.warn(`Unable to initialize Protect websockets: ${error && error.message ? error.message : error}`);
            }
        };

        node.removeClient = (client) => {
            node.nodeClients = node.nodeClients.filter((entry) => entry && client && entry.id !== client.id);
            if (node.nodeClients.length === 0) {
                node.closeWebSockets();
            } else {
                node.ensureWebSockets();
            }
        };

        const knxAiBridgeClient = {
            id: `knx-ai-camera-adapter:${node.id}`,
            protectStreams: ["events"],
            handleProtectDeviceUpdate(update) {
                const item = update && update.item;
                if (item && item.modelKey === "camera") {
                    node.knxAiCameraCache = { at: 0, cameras: node.knxAiCameraCache.cameras };
                    if (node.knxAiCameraRefresh) node.knxAiCameraRefreshAgain = true;
                }
            },
            handleProtectEventUpdate(update) {
                const item = update && update.item;
                if (!item || item.modelKey !== "event" || node.knxAiCameraListeners.size === 0) return;
                const eventType = String(item.type || "").trim();
                if (!SMART_CAMERA_EVENTS.has(eventType)) return;
                Promise.resolve(node.listKnxAiCameras({ allowStale: true })).then((cameras) => {
                    const camera = cameras.find((entry) => entry.nativeCameraId === String(item.device || ""));
                    const event = normalizeProtectCameraEvent({
                        event: item,
                        camera: camera && camera.raw,
                        controllerId: node.id,
                        controllerName: node.name || node.host || node.id
                    });
                    if (!event) return;
                    if (!node.protectCameraEventDeduper.shouldForward(event, item)) return;
                    const publicEvent = cloneProviderMetadataWithoutRaw(event);
                    node.knxAiCameraListeners.forEach((listener) => {
                        try { listener(publicEvent); } catch (error) { }
                    });
                }).catch((error) => {
                    node.warn(`KNX AI camera event adapter failed: ${error && error.message ? error.message : error}`);
                });
            }
        };

        const knxAiProvider = {
            id: `unifi-ultimate:${node.id}`,
            adapterId: "unifi-ultimate",
            title: "UniFi Ultimate / Protect",
            packageName: "node-red-contrib-unifi-ultimate",
            controllerId: node.id,
            controllerName: node.name || node.host || node.id,
            eventRetention: "none",
            get connected() {
                return node.knxAiCameraProviderHealth.connected;
            },
            get ready() {
                return node.knxAiCameraProviderHealth.ready;
            },
            isReady() {
                return node.knxAiCameraProviderHealth.ready === true;
            },
            get health() {
                return Object.assign({}, node.knxAiCameraProviderHealth);
            },
            get lastError() {
                return node.knxAiCameraProviderHealth.lastError;
            },
            get lastSeenAt() {
                return node.knxAiCameraProviderHealth.lastSeenAt;
            },
            capabilities: ["camera_catalog", "snapshot", "motion", "smart_events", "zones", "lines", "event_history", "event_snapshot"],
            historyCredentialsMode: "per_call",
            listCameras: async (options) => (await node.listKnxAiCameras(options)).map(cloneProviderMetadataWithoutRaw),
            takeSnapshot: (request) => node.takeKnxAiCameraSnapshot(request),
            queryEvents: (request, options) => node.queryKnxAiCameraEvents(request, options),
            takeEventSnapshot: (request, options) => node.takeKnxAiCameraEventSnapshot(request, options),
            subscribe(listener) {
                if (typeof listener !== "function") return () => { };
                const wasEmpty = node.knxAiCameraListeners.size === 0;
                node.knxAiCameraListeners.add(listener);
                if (wasEmpty) node.addClient(knxAiBridgeClient);
                return () => {
                    node.knxAiCameraListeners.delete(listener);
                    if (node.knxAiCameraListeners.size === 0) node.removeClient(knxAiBridgeClient);
                };
            }
        };
        node.knxAiCameraProvider = knxAiProvider;
        knxAiCameraRegistry.registerProvider(knxAiProvider);

        node.on("close", function(done) {
            try {
                node.isClosing = true;
                node.updateKnxAiCameraProviderHealth({ ok: false, error: "The UniFi Protect config node is closing." });
                knxAiCameraRegistry.unregisterProvider(knxAiProvider.id);
                node.knxAiCameraListeners.clear();
                node.protectHistoryPaginationGuard.clear();
                node.protectCameraEventDeduper.clear();
                node.removeClient(knxAiBridgeClient);
                node.closeWebSockets();
            } catch (error) {
            } finally {
                if (typeof done === "function") {
                    done();
                }
            }
        });
    }

    RED.nodes.registerType("unifi-protect-config", UnifiProtectConfigNode, {
        credentials: {
            apiKey: { type: "password" }
        }
    });

    RED.httpAdmin.get("/unifiProtect/device-types", RED.auth.needsPermission("unifi-protect-config.read"), async (req, res) => {
        try {
            // The editor only needs the list of supported resource families.
            res.json(getDeviceTypes().map((definition) => ({
                type: definition.type,
                label: definition.label,
                modelKey: definition.modelKey
            })));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.get("/unifiProtect/device-capabilities", RED.auth.needsPermission("unifi-protect-config.read"), async (req, res) => {
        try {
            const serverId = String(req.query.serverId || "").trim();
            const deviceType = String(req.query.deviceType || "").trim();
            const deviceId = String(req.query.deviceId || "").trim();
            if (!deviceType) {
                res.status(400).json({ error: "Missing deviceType" });
                return;
            }

            if (!serverId || !deviceId) {
                // Before a concrete device is selected, return the generic
                // capability set for the chosen device family.
                res.json(getCapabilitiesForType(deviceType));
                return;
            }

            const server = RED.nodes.getNode(serverId);
            if (!server || typeof server.fetchCapabilities !== "function") {
                res.status(404).json({ error: "Configuration node not found" });
                return;
            }

            res.json(await server.fetchCapabilities(deviceType, deviceId));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.get("/unifiProtect/device-capability-options", RED.auth.needsPermission("unifi-protect-config.read"), async (req, res) => {
        try {
            const serverId = req.query.serverId;
            const deviceType = String(req.query.deviceType || "").trim();
            const deviceId = String(req.query.deviceId || "").trim();
            const capabilityId = String(req.query.capability || "").trim();
            let capabilityConfig = {};

            if (!serverId) {
                res.status(400).json({ error: "Missing serverId" });
                return;
            }
            if (!deviceType) {
                res.status(400).json({ error: "Missing deviceType" });
                return;
            }
            if (!capabilityId) {
                res.status(400).json({ error: "Missing capability" });
                return;
            }

            if (req.query.capabilityConfig) {
                try {
                    const parsed = JSON.parse(String(req.query.capabilityConfig));
                    capabilityConfig = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
                } catch (error) {
                    capabilityConfig = {};
                }
            }

            const server = RED.nodes.getNode(serverId);
            if (!server || typeof server.fetchCapabilityOptions !== "function") {
                res.status(404).json({ error: "Configuration node not found" });
                return;
            }

            const options = await server.fetchCapabilityOptions(deviceType, deviceId, capabilityId, capabilityConfig);
            res.json(options);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.get("/unifiProtect/devices", RED.auth.needsPermission("unifi-protect-config.read"), async (req, res) => {
        try {
            const serverId = req.query.serverId;
            const deviceType = String(req.query.deviceType || "").trim();
            if (!serverId) {
                res.status(400).json({ error: "Missing serverId" });
                return;
            }
            if (!deviceType) {
                res.status(400).json({ error: "Missing deviceType" });
                return;
            }

            const server = RED.nodes.getNode(serverId);
            if (!server || typeof server.fetchDevices !== "function") {
                res.status(404).json({ error: "Configuration node not found" });
                return;
            }

            const devices = await server.fetchDevices(deviceType);
            res.json(devices.map((device) => summarizeDevice(deviceType, device)));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

};
