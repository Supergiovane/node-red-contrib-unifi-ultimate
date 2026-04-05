"use strict";

const {
    buildBaseUrlFromHost,
    buildQueryString,
    doRequest,
    buildRequestHeaders,
    buildRequestBody,
    extractNetworkData,
    normalizeNetworkCollection
} = require("./utils/unifi-network-utils");
const {
    getCapabilitiesForType,
    getCapabilityOptions,
    getDeviceTypeDefinition,
    getDeviceTypes,
    resolveScopedIdentifiers,
    summarizeDevice
} = require("./utils/unifi-network-device-registry");

module.exports = function(RED) {
    const API_KEY_HEADER = "X-API-Key";

    function UnifiNetworkConfigNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.host = String(config.host || "").trim();
        node.baseUrl = buildBaseUrlFromHost(node.host);
        node.rejectUnauthorized = config.rejectUnauthorized !== false && config.rejectUnauthorized !== "false";
        node.nodeClients = [];

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
                throw new Error("The configured host is empty or invalid.");
            }

            const apiKey = node.getApiKey();
            if (!apiKey) {
                throw new Error("The UniFi Network API key is missing.");
            }

            // All Network requests go through the official integration proxy, so
            // callers only provide relative API paths plus optional query/payload.
            const queryString = buildQueryString(query);
            const normalizedPath = String(path || "").startsWith("/") ? String(path || "") : `/${String(path || "")}`;
            const requestUrl = new URL(`${node.baseUrl}${normalizedPath}${queryString}`);
            const requestMethod = String(method || "GET").toUpperCase();
            const requestHeaders = buildRequestHeaders(API_KEY_HEADER, apiKey, headers);
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

        node.fetchPagedCollection = async ({
            path,
            baseQuery,
            timeout = 15000,
            pageSize = 200
        }) => {
            // UniFi Network collection endpoints are paged. This helper keeps
            // loading pages until the API itself proves the dataset is complete.
            const collected = [];
            let offset = 0;
            let pageCount = 0;
            const maxPages = 1000;

            while (true) {
                if (pageCount >= maxPages) {
                    throw new Error("Failed to load collection: pagination did not converge.");
                }
                pageCount += 1;

                const response = await node.apiRequest({
                    path,
                    method: "GET",
                    query: {
                        ...(baseQuery || {}),
                        offset,
                        limit: pageSize
                    },
                    timeout
                });

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    throw new Error(`Failed to load collection (${response.statusCode})`);
                }

                const payload = response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)
                    ? response.payload
                    : {};
                const items = normalizeNetworkCollection(response.payload);
                collected.push(...items);

                // Different controller versions expose pagination hints with
                // slightly different fields, so evaluate all known variants.
                const totalCount = Number(payload.totalCount);
                const count = Number(payload.count);
                const responseLimit = Number(payload.limit);
                const effectiveLimit = Number.isFinite(responseLimit) && responseLimit > 0
                    ? Math.trunc(responseLimit)
                    : pageSize;
                const pageItems = items.length;

                if (pageItems === 0) {
                    break;
                }

                if (Number.isFinite(totalCount) && totalCount >= 0) {
                    if (collected.length >= totalCount) {
                        break;
                    }
                } else if (Number.isFinite(count) && count >= 0 && count < effectiveLimit) {
                    break;
                } else if (pageItems < effectiveLimit) {
                    break;
                }

                offset += pageItems;
            }

            return collected;
        };

        node.fetchSites = async () => {
            // Sites are the root scope for nearly all other Network resources.
            return node.fetchPagedCollection({
                path: "/v1/sites"
            });
        };

        node.fetchDevices = async (deviceType) => {
            const definition = getDeviceTypeDefinition(deviceType);
            if (!definition) {
                throw new Error(`Unsupported device type: ${deviceType}`);
            }

            if (definition.type === "site") {
                return node.fetchSites();
            }

            const sites = await node.fetchSites();
            const results = await Promise.all(sites.map(async (site) => {
                const siteId = String(site && site.id || "").trim();
                if (!siteId) {
                    return [];
                }

                // The official API is site-scoped, so cross-site discovery is
                // implemented by querying each site and flattening the results.
                const siteName = String(site.name || site.displayName || siteId).trim();
                const listPath = definition.listPath.replace(/\{siteId\}/g, encodeURIComponent(siteId));
                try {
                    const items = await node.fetchPagedCollection({
                        path: listPath
                    });
                    return items.map((item) => ({
                        ...item,
                        siteId,
                        siteName
                    }));
                } catch (error) {
                    return [];
                }
            }));

            const flat = results.flat();
            const dedupMap = new Map();

            flat.forEach((item) => {
                // De-duplicate defensively in case the controller returns the
                // same object more than once across refreshes or aliases.
                const id = String(item && item.id || "").trim();
                const siteId = String(item && item.siteId || "").trim();
                const key = id && siteId
                    ? `${siteId}::${id}`
                    : JSON.stringify(item);
                if (!dedupMap.has(key)) {
                    dedupMap.set(key, item);
                }
            });

            return Array.from(dedupMap.values());
        };

        node.fetchDeviceByTypeAndId = async (deviceType, deviceId) => {
            const definition = getDeviceTypeDefinition(deviceType);
            if (!definition) {
                throw new Error(`Unsupported device type: ${deviceType}`);
            }

            if (definition.type === "site") {
                const sites = await node.fetchSites();
                const selectedId = String(deviceId || "").trim();
                return sites.find((site) => String(site.id || "").trim() === selectedId) || null;
            }

            const scoped = resolveScopedIdentifiers(deviceType, deviceId);
            if (!scoped.siteId || !scoped.resourceId) {
                throw new Error("This selection requires both site and item id.");
            }

            // Detail paths differ for devices and clients, but both are already
            // encoded in the registry definition through detailPath.
            const detailPath = String(definition.detailPath || "")
                .replace(/\{siteId\}/g, encodeURIComponent(scoped.siteId))
                .replace(/\{deviceId\}/g, encodeURIComponent(scoped.resourceId))
                .replace(/\{clientId\}/g, encodeURIComponent(scoped.resourceId));

            const response = await node.apiRequest({
                path: detailPath,
                method: "GET"
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Failed to load ${deviceType} ${scoped.resourceId} (${response.statusCode})`);
            }

            const payload = extractNetworkData(response.payload);
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                return payload;
            }

            return {
                ...payload,
                siteId: payload.siteId || scoped.siteId
            };
        };

        node.fetchCapabilityOptions = async (deviceType, deviceId, capabilityId, capabilityConfig) => {
            // Dynamic option builders may need the live selected device to infer
            // supported actions, fields or value ranges.
            const selectedDevice = deviceId
                ? await node.fetchDeviceByTypeAndId(deviceType, deviceId)
                : null;

            return getCapabilityOptions(deviceType, capabilityId, {
                deviceId,
                device: selectedDevice,
                capabilityConfig,
                fetchDevices: node.fetchDevices,
                fetchDevice: node.fetchDeviceByTypeAndId
            });
        };

        node.fetchCapabilities = async (deviceType, deviceId) => {
            const selectedDevice = deviceId
                ? await node.fetchDeviceByTypeAndId(deviceType, deviceId)
                : null;

            return getCapabilitiesForType(deviceType, selectedDevice);
        };

        function extractDevicePorts(device) {
            // Switch port information moves around depending on hardware family
            // and firmware version, so probe several common shapes.
            const item = device && typeof device === "object" && !Array.isArray(device)
                ? device
                : {};

            const candidates = [
                item.interfaces && item.interfaces.ports,
                item.interfaces && item.interfaces.ethernet && item.interfaces.ethernet.ports,
                item.ports,
                item.port_table,
                item.portTable
            ].filter((entry) => Array.isArray(entry));

            const ports = candidates.length > 0 ? candidates[0] : [];

            return ports
                .map((port, index) => {
                    const normalized = port && typeof port === "object" ? port : {};
                    const rawIdx = normalized.idx ?? normalized.index ?? normalized.portIdx ?? normalized.port_index ?? normalized.id;
                    const idxNumeric = Number(rawIdx);
                    const idx = Number.isFinite(idxNumeric) ? Math.trunc(idxNumeric) : index + 1;
                    const poe = normalized.poe && typeof normalized.poe === "object" ? normalized.poe : {};
                    const poeEnabled = poe.enabled;

                    return {
                        idx,
                        name: String(normalized.name || normalized.portName || `Port ${idx}`),
                        state: String(normalized.state || normalized.status || ""),
                        poeEnabled: poeEnabled === true
                            ? "on"
                            : poeEnabled === false
                                ? "off"
                                : ""
                    };
                })
                .filter((port) => Number.isInteger(port.idx) && port.idx >= 0)
                .sort((a, b) => a.idx - b.idx);
        }

        node.fetchDevicePorts = async (deviceId) => {
            const device = await node.fetchDeviceByTypeAndId("device", deviceId);
            return extractDevicePorts(device);
        };

        node.addClient = (client) => {
            if (!client) {
                return;
            }

            // Store each consumer only once so config-node fan-out stays clean.
            node.nodeClients = node.nodeClients.filter((entry) => entry && entry.id !== client.id);
            node.nodeClients.push(client);
        };

        node.removeClient = (client) => {
            node.nodeClients = node.nodeClients.filter((entry) => entry && client && entry.id !== client.id);
        };

        node.on("close", function(done) {
            node.nodeClients = [];
            if (typeof done === "function") {
                done();
            }
        });
    }

    RED.nodes.registerType("unifi-network-config", UnifiNetworkConfigNode, {
        credentials: {
            apiKey: { type: "password" }
        }
    });

    RED.httpAdmin.get("/unifiNetwork/device-types", RED.auth.needsPermission("unifi-network-config.read"), async (req, res) => {
        try {
            // The editor only needs a lightweight label/type list here.
            res.json(getDeviceTypes().map((definition) => ({
                type: definition.type,
                label: definition.label
            })));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.get("/unifiNetwork/device-capabilities", RED.auth.needsPermission("unifi-network-config.read"), async (req, res) => {
        try {
            const serverId = String(req.query.serverId || "").trim();
            const deviceType = String(req.query.deviceType || "").trim();
            const deviceId = String(req.query.deviceId || "").trim();
            if (!deviceType) {
                res.status(400).json({ error: "Missing deviceType" });
                return;
            }

            if (!serverId || !deviceId) {
                // Without a selected device, return the generic capability set
                // for the chosen resource family.
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

    RED.httpAdmin.get("/unifiNetwork/device-capability-options", RED.auth.needsPermission("unifi-network-config.read"), async (req, res) => {
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

    RED.httpAdmin.get("/unifiNetwork/devices", RED.auth.needsPermission("unifi-network-config.read"), async (req, res) => {
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

    RED.httpAdmin.get("/unifiNetwork/device-ports", RED.auth.needsPermission("unifi-network-config.read"), async (req, res) => {
        try {
            const serverId = String(req.query.serverId || "").trim();
            const deviceId = String(req.query.deviceId || "").trim();
            if (!serverId) {
                res.status(400).json({ error: "Missing serverId" });
                return;
            }
            if (!deviceId) {
                res.status(400).json({ error: "Missing deviceId" });
                return;
            }

            const server = RED.nodes.getNode(serverId);
            if (!server || typeof server.fetchDevicePorts !== "function") {
                res.status(404).json({ error: "Configuration node not found" });
                return;
            }

            res.json(await server.fetchDevicePorts(deviceId));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

};
