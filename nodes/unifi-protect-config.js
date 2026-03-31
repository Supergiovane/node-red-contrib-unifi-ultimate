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
            return getCapabilityOptions(deviceType, capabilityId, {
                deviceId,
                capabilityConfig,
                fetchDevice: node.fetchDeviceByTypeAndId,
                fetchDevices: node.fetchDevices,
                fetchAssetFiles: node.fetchAssetFiles
            });
        };

        node.buildWebSocketUrl = (path) => {
            const url = new URL(`${node.baseUrl}${path}`);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            return url.toString();
        };

        node.broadcastDeviceUpdate = (update) => {
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

            node.reconnectTimer = setTimeout(() => {
                node.reconnectTimer = null;
                node.ensureWebSockets();
            }, 5000);
        };

        node.attachSocket = (kind, path, handler) => {
            let WebSocket;
            const apiKey = node.getApiKey();
            if (!apiKey || !node.baseUrl) {
                return;
            }

            try {
                ({ WebSocket } = require("ws"));
            } catch (error) {
                node.warn("The 'ws' dependency is not installed. UniFi Protect event streams are disabled until dependencies are installed.");
                return;
            }

            const ws = new WebSocket(node.buildWebSocketUrl(path), {
                headers: {
                    [node.authHeader]: apiKey,
                    Accept: "application/json"
                },
                rejectUnauthorized: node.rejectUnauthorized
            });

            ws.on("message", (rawData) => {
                try {
                    const text = Buffer.isBuffer(rawData) ? rawData.toString("utf8") : String(rawData);
                    const parsed = JSON.parse(text);
                    handler(parsed);
                } catch (error) {
                }
            });

            ws.on("close", () => {
                if (kind === "devices" && node.wsDevices === ws) {
                    node.wsDevices = null;
                }
                if (kind === "events" && node.wsEvents === ws) {
                    node.wsEvents = null;
                }
                node.scheduleReconnect();
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
            node.nodeClients = node.nodeClients.filter((entry) => entry && entry.id !== client.id);
            node.nodeClients.push(client);
            node.ensureWebSockets();
        };

        node.removeClient = (client) => {
            node.nodeClients = node.nodeClients.filter((entry) => entry && client && entry.id !== client.id);
            if (node.nodeClients.length === 0) {
                node.closeWebSockets();
            }
        };

        node.on("close", function(done) {
            node.isClosing = true;
            node.closeWebSockets();
            done();
        });
    }

    RED.nodes.registerType("unifi-protect-config", UnifiProtectConfigNode, {
        credentials: {
            apiKey: { type: "password" }
        }
    });

    RED.httpAdmin.get("/unifiProtect/device-types", RED.auth.needsPermission("unifi-protect-config.read"), async (req, res) => {
        try {
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
            const deviceType = String(req.query.deviceType || "").trim();
            if (!deviceType) {
                res.status(400).json({ error: "Missing deviceType" });
                return;
            }

            res.json(getCapabilitiesForType(deviceType));
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
