"use strict";

const {
    buildBaseUrlFromHost,
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
    collectNamedScopes,
    getKnxAiCameraRegistry,
    normalizeProtectCameraEvent,
    normalizeSearchText
} = require("./utils/knx-ai-camera-registry");

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

module.exports = function(RED) {
    const knxAiCameraRegistry = getKnxAiCameraRegistry();
    knxAiCameraRegistry.registerAdapter({
        id: "unifi-ultimate",
        title: "UniFi Ultimate / Protect",
        packageName: "node-red-contrib-unifi-ultimate",
        capabilities: ["camera_catalog", "snapshot", "motion", "smart_events", "zones", "lines"]
    });

    function UnifiProtectConfigNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.host = String(config.host || "").trim();
        node.port = normalizePort(config.port);
        node.baseUrl = buildBaseUrlFromHost(node.host, node.port);
        // UniFi controllers almost always use self-signed certificates, so accept
        // them unless the user explicitly opted into strict verification.
        node.rejectUnauthorized = config.rejectUnauthorized === true || config.rejectUnauthorized === "true";
        node.nodeClients = [];
        node.wsDevices = null;
        node.wsEvents = null;
        node.reconnectTimer = null;
        node.isClosing = false;
        node.knxAiCameraCache = { at: 0, cameras: [] };
        node.knxAiCameraListeners = new Set();

        node.getApiKey = () => node.credentials && node.credentials.apiKey;

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
                fetchAssetFiles: node.fetchAssetFiles
            });
        };

        node.fetchCapabilities = async (deviceType, deviceId) => {
            const selectedDevice = deviceId
                ? await node.fetchDeviceByTypeAndId(deviceType, deviceId)
                : null;

            return getCapabilitiesForType(deviceType, selectedDevice);
        };

        node.listKnxAiCameras = async ({ force = false } = {}) => {
            const now = Date.now();
            if (!force && node.knxAiCameraCache.cameras.length > 0 && (now - node.knxAiCameraCache.at) < 30000) {
                return node.knxAiCameraCache.cameras.slice();
            }
            const cameras = (await node.fetchDevices("camera")).map((camera) => {
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
            node.knxAiCameraCache = { at: now, cameras };
            return cameras.slice();
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
                camera,
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
                    if (kind === "devices" && node.wsDevices === ws) {
                        node.wsDevices = null;
                    }
                    if (kind === "events" && node.wsEvents === ws) {
                        node.wsEvents = null;
                    }
                    node.scheduleReconnect();
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

        node.ensureWebSockets = () => {
            if (node.isClosing || node.nodeClients.length === 0) {
                return;
            }

            // Devices and events are split into two streams by the Protect API.
            if (!node.wsDevices) {
                node.attachSocket("devices", "/v1/subscribe/devices", node.broadcastDeviceUpdate);
            }

            if (!node.wsEvents) {
                node.attachSocket("events", "/v1/subscribe/events", node.broadcastEventUpdate);
            }
        };

        node.closeWebSockets = () => {
            if (node.reconnectTimer) {
                clearTimeout(node.reconnectTimer);
                node.reconnectTimer = null;
            }

            if (node.wsDevices) {
                try {
                    node.wsDevices.close();
                } catch (error) {
                }
                node.wsDevices = null;
            }

            if (node.wsEvents) {
                try {
                    node.wsEvents.close();
                } catch (error) {
                }
                node.wsEvents = null;
            }
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
            }
        };

        const knxAiBridgeClient = {
            id: `knx-ai-camera-adapter:${node.id}`,
            handleProtectDeviceUpdate(update) {
                const item = update && update.item;
                if (item && item.modelKey === "camera") node.knxAiCameraCache = { at: 0, cameras: [] };
            },
            handleProtectEventUpdate(update) {
                const item = update && update.item;
                if (!item || item.modelKey !== "event" || node.knxAiCameraListeners.size === 0) return;
                Promise.resolve(node.listKnxAiCameras()).then((cameras) => {
                    const camera = cameras.find((entry) => entry.nativeCameraId === String(item.device || ""));
                    const event = normalizeProtectCameraEvent({
                        event: item,
                        camera: camera && camera.raw,
                        controllerId: node.id,
                        controllerName: node.name || node.host || node.id
                    });
                    if (!event) return;
                    node.knxAiCameraListeners.forEach((listener) => {
                        try { listener(event); } catch (error) { }
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
            capabilities: ["camera_catalog", "snapshot", "motion", "smart_events", "zones", "lines"],
            listCameras: (options) => node.listKnxAiCameras(options),
            takeSnapshot: (request) => node.takeKnxAiCameraSnapshot(request),
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
                knxAiCameraRegistry.unregisterProvider(knxAiProvider.id);
                node.knxAiCameraListeners.clear();
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
