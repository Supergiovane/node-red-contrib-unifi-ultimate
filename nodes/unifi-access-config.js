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
    const DOORBELL_EVENT_INCOMING_PREFIX = "access.doorbell.incoming";
    const DOORBELL_EVENT_COMPLETED_PREFIX = "access.doorbell.completed";
    const DOORBELL_EVENT_REMOTE_VIEW = "access.remote_view";
    const DOORBELL_EVENT_REMOTE_VIEW_CHANGE = "access.remote_view.change";
    const DOORBELL_LOG_EVENT_REMOTE_CALL_REQUEST = "access.remotecall.request";
    const DOORBELL_LOG_EVENT_DOOR_UNLOCK = "access.door.unlock";
    const DOORBELL_LOG_POLL_INTERVAL_MS = 10000;
    const DOORBELL_LOG_POLL_LOOKBACK_SECONDS = 45;
    const DOORBELL_LOG_ACTIVE_WINDOW_MS = 25000;

    function normalizeEventName(value) {
        return String(value || "").trim().toLowerCase();
    }

    function normalizeString(value) {
        return String(value || "").trim();
    }

    function isDoorbellIncomingEvent(eventName) {
        return eventName.startsWith(DOORBELL_EVENT_INCOMING_PREFIX) || eventName === DOORBELL_EVENT_REMOTE_VIEW;
    }

    function isDoorbellCompletedEvent(eventName) {
        return eventName.startsWith(DOORBELL_EVENT_COMPLETED_PREFIX) || eventName === DOORBELL_EVENT_REMOTE_VIEW_CHANGE;
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

    function isLikelyDoorbellDeviceId(value) {
        return /^[0-9a-f]{12}$/i.test(String(value || "").trim());
    }

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
        node.activeDoorbellRequests = new Map();
        node.doorbellLogPollTimer = null;
        node.doorbellLogPollInFlight = false;
        node.doorbellLogPollCursor = 0;
        node.seenDoorbellLogIds = new Set();

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

        // Leaf nodes must delegate outbound UniFi Access calls to the config node.
        node.executeAccessRequest = async (request) => node.apiRequest(request || {});

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

        node.setActiveDoorbell = (deviceId, entry) => {
            const normalizedId = normalizeString(deviceId);
            if (!normalizedId) {
                return;
            }

            const previous = node.activeDoorbells.get(normalizedId);
            if (previous && normalizeString(previous.requestId)) {
                node.activeDoorbellRequests.delete(normalizeString(previous.requestId));
            }

            const normalizedEntry = entry && typeof entry === "object" ? { ...entry } : {};
            normalizedEntry.requestId = normalizeString(normalizedEntry.requestId);
            node.activeDoorbells.set(normalizedId, normalizedEntry);

            if (normalizedEntry.requestId) {
                node.activeDoorbellRequests.set(normalizedEntry.requestId, normalizedId);
            }
        };

        node.clearActiveDoorbell = (deviceId, expectedRequestIds) => {
            const normalizedId = normalizeString(deviceId);
            if (!normalizedId) {
                return false;
            }

            const current = node.activeDoorbells.get(normalizedId);
            if (!current) {
                return false;
            }

            const requestId = normalizeString(current.requestId);
            const expectedIds = Array.isArray(expectedRequestIds)
                ? expectedRequestIds.map((value) => normalizeString(value)).filter(Boolean)
                : [];

            // Ignore stale completion events that target an older request id.
            if (expectedIds.length > 0 && requestId && !expectedIds.includes(requestId)) {
                return false;
            }

            node.activeDoorbells.delete(normalizedId);
            if (requestId && node.activeDoorbellRequests.get(requestId) === normalizedId) {
                node.activeDoorbellRequests.delete(requestId);
            }
            return true;
        };

        node.updateDoorbellState = (payload) => {
            // Track doorbell lifecycle so "Cancel Doorbell" can avoid sending a
            // blind cancel when no active ring is currently known.
            const event = payload && typeof payload === "object" ? payload : {};
            const eventName = normalizeEventName(event.event);
            if (!isDoorbellIncomingEvent(eventName) && !isDoorbellCompletedEvent(eventName)) {
                return;
            }

            const data = event.data && typeof event.data === "object" ? event.data : {};
            const device = data.device && typeof data.device === "object" ? data.device : {};
            const objectData = event.object && typeof event.object === "object" ? event.object : {};
            const nestedObjectData = data.object && typeof data.object === "object" ? data.object : {};

            const requestId = firstNonEmptyString([
                data.request_id,
                data.remote_call_request_id,
                objectData.request_id,
                nestedObjectData.request_id
            ]);
            const clearRequestId = firstNonEmptyString([
                data.clear_request_id,
                objectData.clear_request_id,
                nestedObjectData.clear_request_id
            ]);
            let deviceId = firstNonEmptyString([
                device.id,
                data.device_id,
                data.uah_id,
                data.uah_device_id,
                objectData.device_id,
                nestedObjectData.device_id,
                data.connected_uah_id
            ]);

            if (!deviceId && requestId) {
                deviceId = normalizeString(node.activeDoorbellRequests.get(requestId));
            }
            if (!deviceId && clearRequestId) {
                deviceId = normalizeString(node.activeDoorbellRequests.get(clearRequestId));
            }

            if (isDoorbellIncomingEvent(eventName)) {
                if (clearRequestId) {
                    const previousDeviceId = normalizeString(node.activeDoorbellRequests.get(clearRequestId));
                    if (previousDeviceId) {
                        node.clearActiveDoorbell(previousDeviceId, [clearRequestId]);
                    }
                }

                // Use the requestId as fallback storage key when the event does not
                // carry a recognisable device id (e.g. physical button presses or
                // triggers from external systems). hasAnyActiveDoorbell() will still
                // return true so the cancel guard can allow the request through.
                const storageKey = deviceId || requestId;
                if (!storageKey) {
                    return;
                }

                node.setActiveDoorbell(storageKey, {
                    requestId,
                    deviceId,
                    updatedAt: Date.now(),
                    expiresAt: Date.now() + ACTIVE_DOORBELL_TTL_MS,
                    source: "event",
                    payload
                });
                return;
            }

            if (!deviceId) {
                if (requestId) {
                    const mappedDeviceId = normalizeString(node.activeDoorbellRequests.get(requestId));
                    if (mappedDeviceId) {
                        node.clearActiveDoorbell(mappedDeviceId, [requestId]);
                    }
                }
                if (clearRequestId) {
                    const mappedDeviceId = normalizeString(node.activeDoorbellRequests.get(clearRequestId));
                    if (mappedDeviceId) {
                        node.clearActiveDoorbell(mappedDeviceId, [clearRequestId]);
                    }
                }
                return;
            }

            node.clearActiveDoorbell(deviceId, [requestId, clearRequestId].filter(Boolean));
        };

        node.extractDoorbellDeviceIdFromLogEntry = (entry) => {
            const source = entry && entry._source && typeof entry._source === "object" ? entry._source : {};
            const targets = Array.isArray(source.target) ? source.target : [];

            // Prefer direct intercom targets.
            for (const target of targets) {
                const targetType = normalizeString(target && target.type).toLowerCase();
                const targetId = normalizeString(target && target.id);
                if (!isLikelyDoorbellDeviceId(targetId)) {
                    continue;
                }
                if (targetType.includes("intercom") && !targetType.includes("viewer")) {
                    return targetId;
                }
            }

            // Fallback: parse the device id from activity resource ids such as
            // "protect_<deviceId>_<uuid>".
            for (const target of targets) {
                const targetType = normalizeString(target && target.type).toLowerCase();
                const targetId = normalizeString(target && target.id);
                if (!targetType.includes("resource") || !targetId) {
                    continue;
                }

                const match = targetId.match(/(?:^|_)([0-9a-f]{12})(?:_|$)/i);
                if (match && isLikelyDoorbellDeviceId(match[1])) {
                    return normalizeString(match[1]);
                }
            }

            return "";
        };

        node.processDoorbellLogEntry = (entry) => {
            const source = entry && entry._source && typeof entry._source === "object" ? entry._source : {};
            const event = source.event && typeof source.event === "object" ? source.event : {};
            const eventType = normalizeEventName(event.type);
            const logKey = normalizeEventName(event.log_key);
            const deviceId = node.extractDoorbellDeviceIdFromLogEntry(entry);

            // Doorbell request log means a ring has just started.
            if (eventType === DOORBELL_LOG_EVENT_REMOTE_CALL_REQUEST) {
                if (!deviceId) {
                    return false;
                }

                const published = Number(event.published);
                const publishedMs = Number.isFinite(published) && published > 0 ? published : Date.now();
                const expiresAt = Math.min(
                    publishedMs + DOORBELL_LOG_ACTIVE_WINDOW_MS,
                    Date.now() + DOORBELL_LOG_ACTIVE_WINDOW_MS
                );
                if (expiresAt <= Date.now()) {
                    return false;
                }

                node.setActiveDoorbell(deviceId, {
                    requestId: "",
                    updatedAt: publishedMs,
                    expiresAt,
                    source: "logs",
                    payload: entry
                });
                return true;
            }

            // Access writes call-end outcomes as access.door.unlock with a
            // doorbell-specific log key (for example "missed"). Treat those as
            // completion signals and clear the tracked ring.
            if (eventType === DOORBELL_LOG_EVENT_DOOR_UNLOCK && logKey.includes("access.doorbell.")) {
                if (!deviceId) {
                    return false;
                }
                node.clearActiveDoorbell(deviceId);
                return true;
            }

            return false;
        };

        node.pollDoorbellLogs = async ({ since, until }) => {
            if (!node.baseUrl || !node.getApiToken() || !since || !until || until <= since) {
                return 0;
            }

            const response = await node.apiRequest({
                path: "/api/v1/developer/system/logs",
                method: "POST",
                query: {
                    page_size: 200,
                    page_num: 1
                },
                payload: {
                    topic: "all",
                    since,
                    until
                },
                timeout: 10000
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                return 0;
            }

            const logPayload = extractAccessData(response.payload);
            const hits = Array.isArray(logPayload && logPayload.hits) ? logPayload.hits : [];
            let matchedEvents = 0;

            for (const entry of hits) {
                const logId = normalizeString(entry && entry._id);
                if (logId) {
                    if (node.seenDoorbellLogIds.has(logId)) {
                        continue;
                    }
                    node.seenDoorbellLogIds.add(logId);
                }

                if (node.processDoorbellLogEntry(entry)) {
                    matchedEvents += 1;
                }
            }

            if (node.seenDoorbellLogIds.size > 2000) {
                node.seenDoorbellLogIds.clear();
            }

            return matchedEvents;
        };

        node.refreshDoorbellState = async (options) => {
            const lookbackSeconds = Number(options && options.lookbackSeconds) > 0
                ? Math.floor(Number(options.lookbackSeconds))
                : DOORBELL_LOG_POLL_LOOKBACK_SECONDS;
            const until = Math.floor(Date.now() / 1000);
            const since = Math.max(0, until - lookbackSeconds);
            return node.pollDoorbellLogs({ since, until });
        };

        node.runDoorbellLogPoll = async () => {
            if (node.doorbellLogPollInFlight) {
                return;
            }
            node.doorbellLogPollInFlight = true;

            try {
                const until = Math.floor(Date.now() / 1000);
                const baseCursor = Number(node.doorbellLogPollCursor) > 0
                    ? Number(node.doorbellLogPollCursor)
                    : until - DOORBELL_LOG_POLL_LOOKBACK_SECONDS;
                const since = Math.max(0, baseCursor - 2);
                await node.pollDoorbellLogs({ since, until });
                node.doorbellLogPollCursor = until;
            } catch (error) {
                node.warn(`Access doorbell log polling failed: ${error && error.message ? error.message : error}`);
            } finally {
                node.doorbellLogPollInFlight = false;
            }
        };

        node.ensureDoorbellLogPolling = () => {
            if (node.isClosing || node.nodeClients.length === 0 || node.doorbellLogPollTimer) {
                return;
            }

            node.doorbellLogPollCursor = Math.floor(Date.now() / 1000) - DOORBELL_LOG_POLL_LOOKBACK_SECONDS;
            node.runDoorbellLogPoll();
            node.doorbellLogPollTimer = setInterval(() => {
                try {
                    node.runDoorbellLogPoll();
                } catch (error) {
                    node.warn(`Access doorbell log poll timer failed: ${error && error.message ? error.message : error}`);
                }
            }, DOORBELL_LOG_POLL_INTERVAL_MS);
        };

        node.stopDoorbellLogPolling = () => {
            if (node.doorbellLogPollTimer) {
                clearInterval(node.doorbellLogPollTimer);
                node.doorbellLogPollTimer = null;
            }
            node.doorbellLogPollInFlight = false;
        };

        node.purgeExpiredDoorbells = () => {
            // Clean stale entries opportunistically instead of running a
            // dedicated timer for such a small in-memory cache.
            const now = Date.now();
            Array.from(node.activeDoorbells.entries()).forEach(([deviceId, entry]) => {
                const expiresAt = Number(entry && entry.expiresAt);
                if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) {
                    node.clearActiveDoorbell(deviceId);
                }
            });
        };

        node.getActiveDoorbell = (deviceId) => {
            node.purgeExpiredDoorbells();
            const normalizedId = normalizeString(deviceId);
            if (!normalizedId) {
                return null;
            }

            return node.activeDoorbells.get(normalizedId) || null;
        };

        node.hasActiveDoorbell = (deviceId) => Boolean(node.getActiveDoorbell(deviceId));

        node.hasAnyActiveDoorbell = () => {
            node.purgeExpiredDoorbells();
            return node.activeDoorbells.size > 0;
        };

        node.markDoorbellTriggered = (deviceId, metadata) => {
            // Manual trigger requests can arrive before the websocket confirms
            // the ring, so pre-mark them as active for safe cancel behavior.
            const normalizedId = normalizeString(deviceId);
            if (!normalizedId) {
                return;
            }

            node.setActiveDoorbell(normalizedId, {
                requestId: metadata && typeof metadata === "object" ? metadata.requestId : "",
                updatedAt: Date.now(),
                expiresAt: Date.now() + ACTIVE_DOORBELL_TTL_MS,
                source: "request",
                ...(metadata && typeof metadata === "object" ? metadata : {})
            });
        };

        node.markDoorbellCanceled = (deviceId) => {
            const normalizedId = normalizeString(deviceId);
            if (!normalizedId) {
                node.activeDoorbells.clear();
                node.activeDoorbellRequests.clear();
                return;
            }

            node.clearActiveDoorbell(normalizedId);
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
                try {
                    if (node.wsNotifications === ws) {
                        node.wsNotifications = null;
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
                node.ensureDoorbellLogPolling();
            } catch (error) {
                node.warn(`Unable to initialize Access websocket: ${error && error.message ? error.message : error}`);
            }
        };

        node.removeClient = (client) => {
            node.nodeClients = node.nodeClients.filter((entry) => entry && client && entry.id !== client.id);
            if (node.nodeClients.length === 0) {
                node.closeWebSocket();
                node.stopDoorbellLogPolling();
            }
        };

        node.on("close", function(done) {
            try {
                node.isClosing = true;
                node.activeDoorbells.clear();
                node.activeDoorbellRequests.clear();
                node.closeWebSocket();
                node.stopDoorbellLogPolling();
            } catch (error) {
            } finally {
                if (typeof done === "function") {
                    done();
                }
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
