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
    encodeScopedDeviceId,
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

        node.legacyApiRequest = async ({
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

            const queryString = buildQueryString(query);
            const normalizedPath = String(path || "").startsWith("/") ? String(path || "") : `/${String(path || "")}`;
            const legacyBaseUrl = node.baseUrl.replace(/\/integration\/?$/, "");
            const requestUrl = new URL(`${legacyBaseUrl}${normalizedPath}${queryString}`);
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
                fetchDevice: node.fetchDeviceByTypeAndId,
                fetchDevicePorts: node.fetchDevicePorts
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
                                : "",
                        connectedClientNames: extractPortClientNamesFromRawPort(normalized)
                    };
                })
                .filter((port) => Number.isInteger(port.idx) && port.idx >= 0)
                .sort((a, b) => a.idx - b.idx);
        }

        function normalizeString(value) {
            return String(value || "").trim();
        }

        function normalizeIdentifierKey(value) {
            const normalized = normalizeString(value).toLowerCase();
            return normalized ? normalized.replace(/[^a-z0-9]/g, "") : "";
        }

        function addIdentifierKeys(set, value) {
            const normalized = normalizeString(value).toLowerCase();
            const compact = normalizeIdentifierKey(value);
            if (normalized) {
                set.add(normalized);
            }
            if (compact) {
                set.add(compact);
            }
        }

        function firstNonEmptyString(values) {
            for (const value of values) {
                const normalized = normalizeString(value);
                if (normalized) {
                    return normalized;
                }
            }
            return "";
        }

        function parsePortIndex(value) {
            if (value === undefined || value === null || value === "") {
                return undefined;
            }

            if (typeof value === "number" && Number.isFinite(value)) {
                const normalized = Math.trunc(value);
                return normalized >= 0 ? normalized : undefined;
            }

            const normalizedText = normalizeString(value);
            if (!normalizedText) {
                return undefined;
            }

            const direct = Number(normalizedText);
            if (Number.isFinite(direct)) {
                const parsedDirect = Math.trunc(direct);
                return parsedDirect >= 0 ? parsedDirect : undefined;
            }

            const match = normalizedText.match(/(\d+)/);
            if (!match) {
                return undefined;
            }

            const parsed = Number(match[1]);
            if (!Number.isFinite(parsed)) {
                return undefined;
            }

            const normalized = Math.trunc(parsed);
            return normalized >= 0 ? normalized : undefined;
        }

        function extractClientNameFromEntry(entry) {
            if (!entry) {
                return "";
            }

            if (typeof entry === "string" || typeof entry === "number") {
                return normalizeString(entry);
            }

            if (typeof entry !== "object" || Array.isArray(entry)) {
                return "";
            }

            return firstNonEmptyString([
                entry.name,
                entry.hostname,
                entry.displayName,
                entry.display_name,
                entry.clientName,
                entry.client_name,
                entry.alias,
                entry.macAddress,
                entry.mac,
                entry.ipAddress,
                entry.ip
            ]);
        }

        function extractPortClientNamesFromRawPort(port) {
            const normalizedPort = port && typeof port === "object" && !Array.isArray(port)
                ? port
                : {};
            const values = [];

            const directCollections = [
                normalizedPort.clients,
                normalizedPort.connectedClients,
                normalizedPort.connected_clients,
                normalizedPort.users,
                normalizedPort.user_list,
                normalizedPort.hosts,
                normalizedPort.devices,
                normalizedPort.client_list
            ];

            directCollections.forEach((collection) => {
                if (Array.isArray(collection)) {
                    collection.forEach((entry) => {
                        values.push(extractClientNameFromEntry(entry));
                    });
                }
            });

            values.push(extractClientNameFromEntry(normalizedPort.client));
            values.push(extractClientNameFromEntry(normalizedPort.user));
            values.push(extractClientNameFromEntry(normalizedPort.connectedClient));
            values.push(extractClientNameFromEntry(normalizedPort.connected_client));

            const dedupe = new Set();
            return values
                .map((value) => normalizeString(value))
                .filter((value) => {
                    if (!value || dedupe.has(value)) {
                        return false;
                    }
                    dedupe.add(value);
                    return true;
                });
        }

        function resolveClientUplinkAttachment(client, fallbackClientId) {
            const item = client && typeof client === "object" && !Array.isArray(client)
                ? client
                : {};
            const normalizedClientId = normalizeString(fallbackClientId);

            const uplinkCandidates = [
                item.uplink,
                item.connection && item.connection.uplink,
                item.wiredConnection,
                item.wired && item.wired.uplink,
                item.radio && item.radio.uplink
            ].filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
            const uplink = uplinkCandidates.length > 0 ? uplinkCandidates[0] : {};

            const clientScoped = resolveScopedIdentifiers("client", normalizedClientId, item);
            const parsedDeviceCandidate = resolveScopedIdentifiers(
                "device",
                firstNonEmptyString([
                    item.uplinkDeviceId,
                    item.uplink_device_id,
                    item.connectedDeviceId,
                    item.connected_device_id,
                    item.networkDeviceId,
                    item.network_device_id,
                    item.switchId,
                    item.switch_id,
                    item.accessPointId,
                    item.access_point_id,
                    item.apId,
                    item.ap_id,
                    uplink.deviceId,
                    uplink.device_id,
                    uplink.id,
                    uplink.remoteDeviceId,
                    uplink.remote_device_id,
                    uplink.parentDeviceId,
                    uplink.parent_device_id,
                    uplink.device && uplink.device.id,
                    uplink.remoteDevice && uplink.remoteDevice.id,
                    uplink.parentDevice && uplink.parentDevice.id
                ])
            );

            const siteId = firstNonEmptyString([
                parsedDeviceCandidate.siteId,
                item.siteId,
                item.site_id,
                clientScoped.siteId
            ]);
            const resourceId = firstNonEmptyString([
                parsedDeviceCandidate.resourceId,
                item.uplinkDeviceId,
                item.uplink_device_id,
                item.connectedDeviceId,
                item.connected_device_id,
                item.networkDeviceId,
                item.network_device_id,
                item.switchId,
                item.switch_id,
                item.accessPointId,
                item.access_point_id,
                item.apId,
                item.ap_id,
                uplink.deviceId,
                uplink.device_id,
                uplink.id,
                uplink.remoteDeviceId,
                uplink.remote_device_id,
                uplink.parentDeviceId,
                uplink.parent_device_id,
                uplink.device && uplink.device.id,
                uplink.remoteDevice && uplink.remoteDevice.id,
                uplink.parentDevice && uplink.parentDevice.id
            ]);

            const portIdx = [
                item.uplinkPortIdx,
                item.uplink_port_idx,
                item.uplinkPort,
                item.uplink_port,
                item.switchPort,
                item.switch_port,
                item.switch_port_idx,
                item.portIdx,
                item.port_idx,
                item.port,
                item.swPort,
                item.sw_port,
                item.wiredPort,
                item.wired_port,
                uplink.portIdx,
                uplink.port_index,
                uplink.port,
                uplink.remotePort,
                uplink.remotePortIdx,
                uplink.remote_port,
                uplink.remote_port_idx,
                uplink.devicePort,
                uplink.device_port,
                uplink.localPort,
                uplink.local_port,
                uplink.portNumber,
                uplink.port_number,
                uplink.port && uplink.port.idx,
                uplink.port && uplink.port.index
            ]
                .map((value) => parsePortIndex(value))
                .find((value) => Number.isInteger(value) && value >= 0);

            if (!siteId || !resourceId || !Number.isInteger(portIdx)) {
                return null;
            }

            return {
                siteId,
                resourceId,
                portIdx
            };
        }

        async function fetchLegacySiteName(siteId) {
            const normalizedSiteId = normalizeString(siteId);
            if (!normalizedSiteId) {
                return "";
            }

            node.legacySiteNameById = node.legacySiteNameById || new Map();
            if (node.legacySiteNameById.has(normalizedSiteId)) {
                return node.legacySiteNameById.get(normalizedSiteId);
            }

            const response = await node.legacyApiRequest({
                path: "/api/self/sites",
                method: "GET"
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Failed to load legacy sites (${response.statusCode})`);
            }

            const sites = normalizeNetworkCollection(response.payload);
            sites.forEach((site) => {
                const siteName = normalizeString(site && site.name);
                [
                    site && site.external_id,
                    site && site._id,
                    site && site.id,
                    site && site.name,
                    site && site.desc
                ].forEach((candidate) => {
                    const key = normalizeString(candidate);
                    if (key && siteName) {
                        node.legacySiteNameById.set(key, siteName);
                    }
                });
            });

            return node.legacySiteNameById.get(normalizedSiteId) || "";
        }

        async function fetchLegacySiteCollection(siteId, collectionPath) {
            const legacySiteName = await fetchLegacySiteName(siteId);
            if (!legacySiteName) {
                return [];
            }

            const response = await node.legacyApiRequest({
                path: `/api/s/${encodeURIComponent(legacySiteName)}${collectionPath}`,
                method: "GET"
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                return [];
            }

            return normalizeNetworkCollection(response.payload);
        }

        async function fetchLegacyClients(siteId) {
            const clients = await fetchLegacySiteCollection(siteId, "/stat/sta");
            return clients.map((client) => ({
                ...client,
                siteId
            }));
        }

        async function fetchLegacyDevices(siteId) {
            const devices = await fetchLegacySiteCollection(siteId, "/stat/device");
            return devices.map((device) => ({
                ...device,
                siteId
            }));
        }

        function buildLegacyClientSummary(client, siteId) {
            const item = client && typeof client === "object" && !Array.isArray(client)
                ? client
                : {};
            const macAddress = firstNonEmptyString([
                item.macAddress,
                item.mac_address,
                item.mac
            ]);
            const id = firstNonEmptyString([
                item.id,
                item.clientId,
                item.client_id,
                item.user_id,
                item._id,
                macAddress
            ]);

            return {
                ...item,
                id,
                clientId: id,
                siteId,
                macAddress,
                name: firstNonEmptyString([
                    item.name,
                    item.hostname,
                    item.displayName,
                    item.display_name,
                    macAddress,
                    id
                ]),
                ipAddress: firstNonEmptyString([
                    item.ipAddress,
                    item.ip_address,
                    item.ip,
                    item.last_ip
                ])
            };
        }

        function resolveLegacyClientAttachment(client, siteId) {
            const item = client && typeof client === "object" && !Array.isArray(client)
                ? client
                : {};
            const resourceId = firstNonEmptyString([
                item.sw_mac,
                item.switch_mac,
                item.uplink_mac,
                item.uplinkDeviceMac,
                item.uplink_device_mac,
                item.uplinkDeviceId,
                item.uplink_device_id
            ]);
            const portIdx = [
                item.sw_port,
                item.switch_port,
                item.switchPort,
                item.uplink_port,
                item.uplinkPort,
                item.port_idx,
                item.portIdx,
                item.port
            ]
                .map((value) => parsePortIndex(value))
                .find((value) => Number.isInteger(value) && value >= 0);

            if (!siteId || !resourceId || !Number.isInteger(portIdx)) {
                return null;
            }

            return {
                siteId,
                resourceId,
                portIdx
            };
        }

        node.fetchDevicePorts = async (deviceId) => {
            const device = await node.fetchDeviceByTypeAndId("device", deviceId);
            const ports = extractDevicePorts(device);
            if (!Array.isArray(ports) || ports.length === 0) {
                return [];
            }

            const scopedDevice = resolveScopedIdentifiers("device", deviceId, device);
            if (!scopedDevice.siteId || !scopedDevice.resourceId) {
                return ports;
            }

            const selectedDevice = device && typeof device === "object" && !Array.isArray(device)
                ? device
                : {};
            const selectedDeviceKeys = new Set();
            [
                scopedDevice.resourceId,
                selectedDevice.id,
                selectedDevice.deviceId,
                selectedDevice.device_id,
                selectedDevice.macAddress,
                selectedDevice.mac,
                selectedDevice.mac_address
            ].forEach((value) => addIdentifierKeys(selectedDeviceKeys, value));

            let clients = [];
            try {
                clients = await node.fetchDevices("client");
            } catch (error) {
                clients = [];
            }

            const clientsByPortIdx = new Map();
            function matchesSelectedDevice(attachment) {
                if (!attachment || attachment.siteId !== scopedDevice.siteId) {
                    return false;
                }
                const rawKey = normalizeString(attachment.resourceId).toLowerCase();
                const compactKey = normalizeIdentifierKey(attachment.resourceId);
                return selectedDeviceKeys.has(rawKey) || selectedDeviceKeys.has(compactKey);
            }

            function addEndpointToPort(portIdx, endpoint) {
                if (!Number.isInteger(portIdx) || portIdx < 0) {
                    return;
                }

                const list = clientsByPortIdx.get(portIdx) || [];
                list.push(endpoint);
                clientsByPortIdx.set(portIdx, list);
            }

            function addClientToPort(client, fallbackClientId, attachment) {
                if (!matchesSelectedDevice(attachment)) {
                    return;
                }

                const summary = summarizeDevice("client", client);
                addEndpointToPort(attachment.portIdx, {
                    id: normalizeString(summary.id || fallbackClientId),
                    name: normalizeString(summary.name || fallbackClientId || "Client"),
                    state: normalizeString(summary.state || ""),
                    siteId: normalizeString(summary.siteId || attachment.siteId),
                    resourceId: normalizeString(summary.resourceId || "")
                });
            }

            await Promise.all(clients.map(async (entry) => {
                const client = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
                if (!client) {
                    return;
                }

                const clientSiteId = normalizeString(client.siteId || client.site_id);
                if (clientSiteId && clientSiteId !== scopedDevice.siteId) {
                    return;
                }

                const fallbackClientId = firstNonEmptyString([
                    client.id,
                    client.clientId,
                    client.deviceId,
                    client.resourceId,
                    client.macAddress,
                    client.mac
                ]);
                const scopedClientId = encodeScopedDeviceId(clientSiteId || scopedDevice.siteId, fallbackClientId) || fallbackClientId;
                const attachment = resolveClientUplinkAttachment(client, scopedClientId);
                if (attachment) {
                    addClientToPort(client, scopedClientId, attachment);
                    return;
                }

                if (!scopedClientId) {
                    return;
                }

                try {
                    const detailedClient = await node.fetchDeviceByTypeAndId("client", scopedClientId);
                    const detailedAttachment = resolveClientUplinkAttachment(detailedClient, scopedClientId);
                    if (detailedAttachment) {
                        addClientToPort(detailedClient || client, scopedClientId, detailedAttachment);
                    }
                } catch (error) {
                }
            }));

            try {
                const legacyClients = await fetchLegacyClients(scopedDevice.siteId);
                legacyClients.forEach((legacyClient) => {
                    const attachment = resolveLegacyClientAttachment(legacyClient, scopedDevice.siteId);
                    if (!attachment) {
                        return;
                    }
                    const normalizedClient = buildLegacyClientSummary(legacyClient, scopedDevice.siteId);
                    addClientToPort(normalizedClient, normalizedClient.id, attachment);
                });
            } catch (error) {
            }

            try {
                const legacyDevices = await fetchLegacyDevices(scopedDevice.siteId);
                const legacyDeviceNamesByMac = new Map();
                legacyDevices.forEach((legacyDevice) => {
                    const mac = normalizeIdentifierKey(legacyDevice && legacyDevice.mac);
                    const name = firstNonEmptyString([
                        legacyDevice && legacyDevice.name,
                        legacyDevice && legacyDevice.displayName,
                        legacyDevice && legacyDevice.hostname,
                        legacyDevice && legacyDevice.mac
                    ]);
                    if (mac && name) {
                        legacyDeviceNamesByMac.set(mac, name);
                    }
                });

                const selectedLegacyDevice = legacyDevices.find((legacyDevice) => {
                    return [
                        legacyDevice && legacyDevice.device_id,
                        legacyDevice && legacyDevice.id,
                        legacyDevice && legacyDevice._id,
                        legacyDevice && legacyDevice.mac
                    ].some((value) => {
                        const rawKey = normalizeString(value).toLowerCase();
                        const compactKey = normalizeIdentifierKey(value);
                        return selectedDeviceKeys.has(rawKey) || selectedDeviceKeys.has(compactKey);
                    });
                });

                const downlinks = Array.isArray(selectedLegacyDevice && selectedLegacyDevice.downlink_table)
                    ? selectedLegacyDevice.downlink_table
                    : [];
                downlinks.forEach((downlink) => {
                    const portIdx = parsePortIndex(downlink && downlink.port_idx);
                    const mac = firstNonEmptyString([
                        downlink && downlink.mac,
                        downlink && downlink.chassis_id
                    ]);
                    const name = legacyDeviceNamesByMac.get(normalizeIdentifierKey(mac)) || mac;
                    if (!Number.isInteger(portIdx) || !name) {
                        return;
                    }
                    addEndpointToPort(portIdx, {
                        id: mac,
                        name,
                        state: "Device",
                        siteId: scopedDevice.siteId,
                        resourceId: mac
                    });
                });

                const lldpEntries = Array.isArray(selectedLegacyDevice && selectedLegacyDevice.lldp_table)
                    ? selectedLegacyDevice.lldp_table
                    : [];
                lldpEntries.forEach((entry) => {
                    const portIdx = parsePortIndex(entry && entry.local_port_idx);
                    const mac = firstNonEmptyString([
                        entry && entry.chassis_id,
                        entry && entry.mac
                    ]);
                    const name = firstNonEmptyString([
                        legacyDeviceNamesByMac.get(normalizeIdentifierKey(mac)),
                        entry && entry.system_name,
                        entry && entry.name,
                        mac
                    ]);
                    if (!Number.isInteger(portIdx) || !name) {
                        return;
                    }
                    addEndpointToPort(portIdx, {
                        id: mac,
                        name,
                        state: "Device",
                        siteId: scopedDevice.siteId,
                        resourceId: mac
                    });
                });
            } catch (error) {
            }

            return ports.map((port) => {
                const connectedClients = clientsByPortIdx.get(port.idx) || [];
                const directClientNames = Array.isArray(port.connectedClientNames)
                    ? port.connectedClientNames.map((name) => normalizeString(name)).filter(Boolean)
                    : [];
                const inferredClientNames = connectedClients
                    .map((client) => normalizeString(client.name))
                    .filter(Boolean);
                const namesDedupe = new Set();
                const connectedClientNames = directClientNames
                    .concat(inferredClientNames)
                    .filter((name) => {
                        if (namesDedupe.has(name)) {
                            return false;
                        }
                        namesDedupe.add(name);
                        return true;
                    });

                return {
                    ...port,
                    connectedClients,
                    connectedClientNames,
                    connectedClientCount: connectedClients.length
                };
            });
        };

        node.resolveClientAttachment = async (clientId) => {
            const normalizedClientId = normalizeString(clientId);
            if (!normalizedClientId) {
                throw new Error("Missing client id.");
            }

            const client = await node.fetchDeviceByTypeAndId("client", normalizedClientId);
            if (!client || typeof client !== "object" || Array.isArray(client)) {
                return {
                    found: false,
                    reason: "Client details are unavailable."
                };
            }

            const item = client;
            const attachment = resolveClientUplinkAttachment(item, normalizedClientId);
            if (!attachment) {
                return {
                    found: false,
                    reason: "Unable to infer switch/port from client details.",
                    client: summarizeDevice("client", item)
                };
            }

            return {
                found: true,
                clientId: normalizedClientId,
                client: summarizeDevice("client", item),
                deviceId: `${attachment.siteId}::${attachment.resourceId}`,
                portIdx: attachment.portIdx,
                siteId: attachment.siteId,
                resourceId: attachment.resourceId
            };
        };

        node.fetchClientsWithAttachment = async () => {
            let clients = [];
            let devices = [];
            try {
                clients = await node.fetchDevices("client");
            } catch (error) {
                clients = [];
            }
            try {
                devices = await node.fetchDevices("device");
            } catch (error) {
                devices = [];
            }

            const deviceNameByScopedId = new Map();
            const deviceNameByKey = new Map();
            const deviceScopedIdByKey = new Map();
            devices.forEach((entry) => {
                const item = entry && typeof entry === "object" && !Array.isArray(entry)
                    ? entry
                    : null;
                if (!item) {
                    return;
                }
                const siteId = normalizeString(item.siteId || item.site_id);
                const resourceId = normalizeString(item.id || item.deviceId);
                const scopedId = encodeScopedDeviceId(siteId, resourceId);
                if (!scopedId) {
                    return;
                }
                const summary = summarizeDevice("device", item);
                const deviceName = normalizeString(summary.name || resourceId || scopedId);
                deviceNameByScopedId.set(scopedId, deviceName);
                [
                    item.id,
                    item.deviceId,
                    item.device_id,
                    item.macAddress,
                    item.mac_address,
                    item.mac,
                    resourceId
                ].forEach((value) => {
                    const rawKey = normalizeString(value).toLowerCase();
                    const compactKey = normalizeIdentifierKey(value);
                    if (rawKey) {
                        deviceNameByKey.set(rawKey, deviceName);
                        deviceScopedIdByKey.set(rawKey, scopedId);
                    }
                    if (compactKey) {
                        deviceNameByKey.set(compactKey, deviceName);
                        deviceScopedIdByKey.set(compactKey, scopedId);
                    }
                });
            });

            function resolveAttachedDeviceId(attachment) {
                const rawKey = normalizeString(attachment && attachment.resourceId).toLowerCase();
                const compactKey = normalizeIdentifierKey(attachment && attachment.resourceId);
                return deviceScopedIdByKey.get(rawKey)
                    || deviceScopedIdByKey.get(compactKey)
                    || encodeScopedDeviceId(attachment && attachment.siteId, attachment && attachment.resourceId);
            }

            function resolveAttachedDeviceName(attachment, attachedDeviceId) {
                const rawKey = normalizeString(attachment && attachment.resourceId).toLowerCase();
                const compactKey = normalizeIdentifierKey(attachment && attachment.resourceId);
                return firstNonEmptyString([
                    deviceNameByScopedId.get(attachedDeviceId),
                    deviceNameByKey.get(rawKey),
                    deviceNameByKey.get(compactKey),
                    attachment && attachment.resourceId
                ]);
            }

            const attachedClients = clients
                .map((entry) => {
                    const item = entry && typeof entry === "object" && !Array.isArray(entry)
                        ? entry
                        : null;
                    if (!item) {
                        return null;
                    }

                    const fallbackClientId = firstNonEmptyString([
                        item.id,
                        item.clientId,
                        item.deviceId,
                        item.macAddress
                    ]);
                    const attachment = resolveClientUplinkAttachment(item, fallbackClientId);
                    if (!attachment) {
                        return null;
                    }

                    const clientSummary = summarizeDevice("client", item);
                    const attachedDeviceId = resolveAttachedDeviceId(attachment);
                    if (!attachedDeviceId) {
                        return null;
                    }

                    const attachedDeviceName = resolveAttachedDeviceName(attachment, attachedDeviceId);

                    return {
                        ...clientSummary,
                        attachment: {
                            deviceId: attachedDeviceId,
                            portIdx: attachment.portIdx,
                            deviceName: attachedDeviceName
                        }
                    };
                })
                .filter(Boolean);

            const siteIds = new Set();
            clients.forEach((client) => {
                const siteId = normalizeString(client && (client.siteId || client.site_id));
                if (siteId) {
                    siteIds.add(siteId);
                }
            });
            devices.forEach((device) => {
                const siteId = normalizeString(device && (device.siteId || device.site_id));
                if (siteId) {
                    siteIds.add(siteId);
                }
            });

            const legacyClients = [];
            await Promise.all(Array.from(siteIds).map(async (siteId) => {
                try {
                    const siteClients = await fetchLegacyClients(siteId);
                    legacyClients.push(...siteClients);
                } catch (error) {
                }
            }));

            const seenClientIds = new Set(attachedClients.map((client) => normalizeString(client.id)));
            legacyClients.forEach((legacyClient) => {
                const siteId = normalizeString(legacyClient && legacyClient.siteId);
                const attachment = resolveLegacyClientAttachment(legacyClient, siteId);
                if (!attachment) {
                    return;
                }

                const attachedDeviceId = resolveAttachedDeviceId(attachment);
                if (!attachedDeviceId) {
                    return;
                }

                const normalizedClient = buildLegacyClientSummary(legacyClient, siteId);
                const clientSummary = summarizeDevice("client", normalizedClient);
                const clientKey = normalizeString(clientSummary.id || normalizedClient.macAddress || normalizedClient.id);
                if (clientKey && seenClientIds.has(clientKey)) {
                    return;
                }
                if (clientKey) {
                    seenClientIds.add(clientKey);
                }

                attachedClients.push({
                    ...clientSummary,
                    attachment: {
                        deviceId: attachedDeviceId,
                        portIdx: attachment.portIdx,
                        deviceName: resolveAttachedDeviceName(attachment, attachedDeviceId)
                    }
                });
            });

            return attachedClients;
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

    RED.httpAdmin.get("/unifiNetwork/client-attachment", RED.auth.needsPermission("unifi-network-config.read"), async (req, res) => {
        try {
            const serverId = String(req.query.serverId || "").trim();
            const clientId = String(req.query.clientId || "").trim();
            if (!serverId) {
                res.status(400).json({ error: "Missing serverId" });
                return;
            }
            if (!clientId) {
                res.status(400).json({ error: "Missing clientId" });
                return;
            }

            const server = RED.nodes.getNode(serverId);
            if (!server || typeof server.resolveClientAttachment !== "function") {
                res.status(404).json({ error: "Configuration node not found" });
                return;
            }

            res.json(await server.resolveClientAttachment(clientId));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.get("/unifiNetwork/clients-with-attachment", RED.auth.needsPermission("unifi-network-config.read"), async (req, res) => {
        try {
            const serverId = String(req.query.serverId || "").trim();
            if (!serverId) {
                res.status(400).json({ error: "Missing serverId" });
                return;
            }

            const server = RED.nodes.getNode(serverId);
            if (!server || typeof server.fetchClientsWithAttachment !== "function") {
                res.status(404).json({ error: "Configuration node not found" });
                return;
            }

            res.json(await server.fetchClientsWithAttachment());
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

};
