"use strict";

const {
    buildBaseUrlFromHost,
    buildQueryString,
    doRequest,
    buildRequestHeaders,
    buildRequestBody,
    extractAccessData,
    normalizeAccessCollection
} = require("./utils/unifi-access-utils");
const {
    getCapabilitiesForType,
    getCapabilityOptions,
    getDeviceTypeDefinition,
    getDeviceTypes,
    summarizeDevice
} = require("./utils/unifi-access-device-registry");

module.exports = function(RED) {
    // Doorbell requests are "best effort" from the public API perspective, so
    // keep a short-lived in-memory ledger to validate later cancel requests.
    const ACTIVE_DOORBELL_TTL_MS = 180000;

    function UnifiAccessConfigNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.host = String(config.host || "").trim();
        node.baseUrl = buildBaseUrlFromHost(node.host);
        node.rejectUnauthorized = config.rejectUnauthorized !== false && config.rejectUnauthorized !== "false";
        node.nodeClients = [];
        node.wsNotifications = null;
        node.reconnectTimer = null;
        node.isClosing = false;
        node.activeDoorbells = new Map();

        node.getApiToken = () => node.credentials && node.credentials.apiToken;

        node.apiRequest = async ({
            path,
            method = "GET",
            query,
            headers,
            payload,
            timeout = 15000
        }) => {
            if (!node.baseUrl) {
                throw new Error("The configured host is empty or invalid.");
            }

            const apiToken = String(node.getApiToken() || "").trim();
            if (!apiToken) {
                throw new Error("The UniFi Access API token is missing.");
            }

            // Access uses bearer authentication against the controller directly,
            // so all callers only need to provide the relative path and options.
            const queryString = buildQueryString(query);
            const normalizedPath = String(path || "").startsWith("/") ? String(path || "") : `/${String(path || "")}`;
            const requestUrl = new URL(`${node.baseUrl}${normalizedPath}${queryString}`);
            const requestMethod = String(method || "GET").toUpperCase();
            const requestHeaders = buildRequestHeaders(apiToken, headers);
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

        node.fetchDevices = async (deviceType) => {
            const definition = getDeviceTypeDefinition(deviceType);
            if (!definition) {
                throw new Error(`Unsupported device type: ${deviceType}`);
            }

            const response = await node.apiRequest({
                path: definition.listPath,
                method: "GET",
                // Some Access device inventories only refresh reliably when this
                // query flag is present.
                query: deviceType === "device" ? { refresh: "true" } : undefined
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Failed to load ${deviceType} entries (${response.statusCode})`);
            }

            return normalizeAccessCollection(response.payload);
        };

        node.fetchDeviceByTypeAndId = async (deviceType, deviceId) => {
            const definition = getDeviceTypeDefinition(deviceType);
            if (!definition) {
                throw new Error(`Unsupported device type: ${deviceType}`);
            }

            if (definition.detailPath) {
                // Doors expose a direct detail endpoint, while generic devices
                // may need to be looked up from the collection response.
                const response = await node.apiRequest({
                    path: definition.detailPath.replace(":id", encodeURIComponent(String(deviceId || "").trim())),
                    method: "GET"
                });

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    throw new Error(`Failed to load ${deviceType} ${deviceId || ""} (${response.statusCode})`);
                }

                return extractAccessData(response.payload);
            }

            const items = await node.fetchDevices(deviceType);
            return items.find((entry) => String(entry.id || "").trim() === String(deviceId || "").trim()) || null;
        };

        node.fetchCapabilityOptions = async (deviceType, deviceId, capabilityId, capabilityConfig) => {
            const selectedDevice = deviceId
                ? await node.fetchDeviceByTypeAndId(deviceType, deviceId)
                : null;

            return getCapabilityOptions(deviceType, capabilityId, {
                deviceId,
                device: selectedDevice,
                capabilityConfig,
                fetchDevices: node.fetchDevices
            });
        };

        node.fetchCapabilities = async (deviceType, deviceId) => {
            const selectedDevice = deviceId
                ? await node.fetchDeviceByTypeAndId(deviceType, deviceId)
                : null;

            return getCapabilitiesForType(deviceType, selectedDevice);
        };

        node.buildWebSocketUrl = (path) => {
            // Rebuild the websocket URL from the configured HTTPS controller URL.
            const url = new URL(`${node.baseUrl}${path}`);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            return url.toString();
        };

        node.broadcastNotification = (payload) => {
            // The config node centralizes one websocket stream and fans it out
            // to all Access runtime nodes interested in events.
            node.nodeClients.forEach((client) => {
                try {
                    if (client && typeof client.handleAccessEventUpdate === "function") {
                        client.handleAccessEventUpdate(payload);
                    }
                } catch (error) {
                }
            });
        };

        node.updateDoorbellState = (payload) => {
            // Track doorbell lifecycle so "Cancel Doorbell" can avoid sending a
            // blind cancel when no active ring is currently known.
            const eventName = String(payload && payload.event || "").trim();
            const data = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
            const device = data.device && typeof data.device === "object" ? data.device : {};
            const deviceId = String(device.id || "").trim();
            const objectData = payload && payload.object && typeof payload.object === "object" ? payload.object : {};
            const nestedObjectData = data.object && typeof data.object === "object" ? data.object : {};
            const requestId = String(objectData.request_id || nestedObjectData.request_id || "").trim();

            if (!deviceId) {
                return;
            }

            if (eventName.startsWith("access.doorbell.incoming")) {
                node.activeDoorbells.set(deviceId, {
                    requestId,
                    updatedAt: Date.now(),
                    expiresAt: Date.now() + ACTIVE_DOORBELL_TTL_MS,
                    source: "event",
                    payload
                });
                return;
            }

            if (eventName.startsWith("access.doorbell.completed")) {
                // If a request id is present, use it to avoid deleting a newer
                // active ring with an old completion event.
                const current = node.activeDoorbells.get(deviceId);
                if (!current) {
                    return;
                }

                if (!requestId || !current.requestId || current.requestId === requestId) {
                    node.activeDoorbells.delete(deviceId);
                }
            }
        };

        node.purgeExpiredDoorbells = () => {
            // Clean stale entries opportunistically instead of running a
            // dedicated timer for such a small in-memory cache.
            const now = Date.now();
            Array.from(node.activeDoorbells.entries()).forEach(([deviceId, entry]) => {
                const expiresAt = Number(entry && entry.expiresAt);
                if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) {
                    node.activeDoorbells.delete(deviceId);
                }
            });
        };

        node.getActiveDoorbell = (deviceId) => {
            node.purgeExpiredDoorbells();
            const normalizedId = String(deviceId || "").trim();
            if (!normalizedId) {
                return null;
            }

            return node.activeDoorbells.get(normalizedId) || null;
        };

        node.hasAnyActiveDoorbell = () => {
            node.purgeExpiredDoorbells();
            return node.activeDoorbells.size > 0;
        };

        node.markDoorbellTriggered = (deviceId, metadata) => {
            // Manual trigger requests can arrive before the websocket confirms
            // the ring, so pre-mark them as active for safe cancel behavior.
            const normalizedId = String(deviceId || "").trim();
            if (!normalizedId) {
                return;
            }

            node.activeDoorbells.set(normalizedId, {
                requestId: "",
                updatedAt: Date.now(),
                expiresAt: Date.now() + ACTIVE_DOORBELL_TTL_MS,
                source: "request",
                ...(metadata && typeof metadata === "object" ? metadata : {})
            });
        };

        node.markDoorbellCanceled = () => {
            node.activeDoorbells.clear();
        };

        node.scheduleReconnect = () => {
            if (node.isClosing || node.reconnectTimer || node.nodeClients.length === 0) {
                return;
            }

            // Delay reconnect attempts slightly to avoid a busy loop while the
            // controller is restarting or upgrading.
            node.reconnectTimer = setTimeout(() => {
                node.reconnectTimer = null;
                try {
                    node.ensureWebSocket();
                } catch (error) {
                    node.warn(`Access websocket reconnect failed: ${error && error.message ? error.message : error}`);
                }
            }, 5000);
        };

        node.ensureWebSocket = () => {
            if (node.isClosing || node.nodeClients.length === 0 || node.wsNotifications) {
                return;
            }

            let WebSocket;
            const apiToken = String(node.getApiToken() || "").trim();
            if (!apiToken || !node.baseUrl) {
                return;
            }

            // Load ws only when live notifications are actually needed.
            try {
                ({ WebSocket } = require("ws"));
            } catch (error) {
                node.warn("The 'ws' dependency is not installed. UniFi Access event streams are disabled until dependencies are installed.");
                return;
            }

            let ws;
            try {
                ws = new WebSocket(node.buildWebSocketUrl("/api/v1/developer/devices/notifications"), {
                    headers: {
                        Authorization: `Bearer ${apiToken}`,
                        Accept: "application/json"
                    },
                    rejectUnauthorized: node.rejectUnauthorized
                });
            } catch (error) {
                node.warn(`Unable to open Access websocket: ${error && error.message ? error.message : error}`);
                node.scheduleReconnect();
                return;
            }

            ws.on("message", (rawData) => {
                try {
                    // Ignore malformed websocket frames rather than killing the
                    // whole notification stream.
                    const text = Buffer.isBuffer(rawData) ? rawData.toString("utf8") : String(rawData);
                    const parsed = JSON.parse(text);
                    node.updateDoorbellState(parsed);
                    node.broadcastNotification(parsed);
                } catch (error) {
                }
            });

            ws.on("close", () => {
                if (node.wsNotifications === ws) {
                    node.wsNotifications = null;
                }
                node.scheduleReconnect();
            });

            ws.on("error", () => {
                try {
                    ws.close();
                } catch (error) {
                }
            });

            node.wsNotifications = ws;
        };

        node.closeWebSocket = () => {
            if (node.reconnectTimer) {
                clearTimeout(node.reconnectTimer);
                node.reconnectTimer = null;
            }

            if (node.wsNotifications) {
                try {
                    node.wsNotifications.close();
                } catch (error) {
                }
                node.wsNotifications = null;
            }
        };

        node.addClient = (client) => {
            if (!client) {
                return;
            }

            // Maintain one entry per runtime node and spin up the websocket only
            // when the first client subscribes.
            node.nodeClients = node.nodeClients.filter((entry) => entry && entry.id !== client.id);
            node.nodeClients.push(client);
            try {
                node.ensureWebSocket();
            } catch (error) {
                node.warn(`Unable to initialize Access websocket: ${error && error.message ? error.message : error}`);
            }
        };

        node.removeClient = (client) => {
            node.nodeClients = node.nodeClients.filter((entry) => entry && client && entry.id !== client.id);
            if (node.nodeClients.length === 0) {
                node.closeWebSocket();
            }
        };

        node.on("close", function(done) {
            node.isClosing = true;
            node.activeDoorbells.clear();
            node.closeWebSocket();
            if (typeof done === "function") {
                done();
            }
        });
    }

    RED.nodes.registerType("unifi-access-config", UnifiAccessConfigNode, {
        credentials: {
            apiToken: { type: "password" }
        }
    });

    RED.httpAdmin.get("/unifiAccess/device-types", RED.auth.needsPermission("unifi-access-config.read"), async (req, res) => {
        try {
            // Editor bootstrap endpoint: return only the small list needed to
            // populate the "Control" dropdown.
            res.json(getDeviceTypes().map((definition) => ({
                type: definition.type,
                label: definition.label
            })));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.get("/unifiAccess/device-capabilities", RED.auth.needsPermission("unifi-access-config.read"), async (req, res) => {
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
                // capability set for the chosen Access family.
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

    RED.httpAdmin.get("/unifiAccess/device-capability-options", RED.auth.needsPermission("unifi-access-config.read"), async (req, res) => {
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

    RED.httpAdmin.get("/unifiAccess/devices", RED.auth.needsPermission("unifi-access-config.read"), async (req, res) => {
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
