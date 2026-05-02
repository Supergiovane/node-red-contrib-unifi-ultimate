"use strict";

const {
    buildBaseUrlFromHost,
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

module.exports = function(RED) {
    function UnifiProtectConfigNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.host = String(config.host || "").trim();
        node.baseUrl = buildBaseUrlFromHost(node.host);
        node.authHeader = (config.authHeader || "X-API-Key").trim() || "X-API-Key";
        node.rejectUnauthorized = config.rejectUnauthorized !== false && config.rejectUnauthorized !== "false";
        node.nodeClients = [];
        node.wsDevices = null;
        node.wsEvents = null;
        node.reconnectTimer = null;
        node.isClosing = false;

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
            const requestHeaders = buildRequestHeaders(node.authHeader, apiKey, headers);
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
                        [node.authHeader]: apiKey,
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

        node.on("close", function(done) {
            try {
                node.isClosing = true;
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
