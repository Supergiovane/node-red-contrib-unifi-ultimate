"use strict";

const {
    buildCapabilityRequest,
    composeCapabilityExecution,
    getCapabilityDefinition,
    getDeviceTypeDefinition,
    resolveScopedIdentifiers
} = require("./utils/unifi-network-device-registry");
const { extractNetworkData } = require("./utils/unifi-network-utils");
const {
    parseBoolean,
    parseIntervalSeconds,
    buildStatusTimestampText,
    appendStatusTimestamp,
    resolveNodeName,
    resolveDeviceName,
    extractDeviceNameFromPayload,
    attachDeviceNameToPayload,
    attachDetails,
    buildErrorOutputMessage
} = require("./utils/common-utils");
const UNOFFICIAL_NETWORK_STREAM_CAPABILITY = "observeUnofficialEvents";
const UNOFFICIAL_POLL_INTERVAL_MS = 3000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function resolveDeviceType(configuredDeviceType) {
    return String(configuredDeviceType || "").trim();
}

function resolveDeviceId(configuredDeviceId) {
    return String(configuredDeviceId || "").trim();
}

function resolveCapabilityId(configuredCapabilityId) {
    return String(configuredCapabilityId || "observe").trim();
}

function parseCapabilityConfig(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }

    if (typeof value !== "string" || value.trim() === "") {
        return {};
    }

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    } catch (error) {
        return {};
    }
}

function resolveCapabilityConfig(configuredCapabilityConfig) {
    return parseCapabilityConfig(configuredCapabilityConfig);
}

function normalizeIdentifierKey(value) {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isTruthyOnlineValue(value) {
    if (value === true) {
        return true;
    }

    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "online" || normalized === "connected" || normalized === "active";
}

function isFalsyOnlineValue(value) {
    if (value === false) {
        return true;
    }

    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "offline" || normalized === "disconnected" || normalized === "inactive";
}

function resolveClientOnlineState(client) {
    const item = client && typeof client === "object" && !Array.isArray(client)
        ? client
        : {};

    if (item.__unifiUltimateOnline === true) {
        return true;
    }
    if (item.__unifiUltimateOnline === false) {
        return false;
    }
    if (item.offline === true) {
        return false;
    }

    const negativeCandidates = [
        item.isOnline,
        item.online,
        item.connected,
        item.isConnected,
        item.connectionState,
        item.status,
        item.state
    ];
    if (negativeCandidates.some(isFalsyOnlineValue)) {
        return false;
    }

    const positiveCandidates = [
        item.isOnline,
        item.online,
        item.connected,
        item.isConnected,
        item.connectionState,
        item.status,
        item.state
    ];
    return positiveCandidates.some(isTruthyOnlineValue);
}

function getFirstNonEmptyString(values) {
    const list = Array.isArray(values) ? values : [];
    for (const value of list) {
        const normalized = String(value === undefined || value === null ? "" : value).trim();
        if (normalized) {
            return normalized;
        }
    }
    return "";
}

function buildNodeStatus(deviceType, payload) {
    const normalizedType = String(deviceType || "").trim();
    const item = payload && typeof payload === "object" ? payload : {};

    if (normalizedType === "site") {
        return item.name || item.displayName || item.id || "site";
    }

    const baseName = item.hostname || item.displayName || item.name || item.macAddress || item.id;
    const state = item.status || item.state || item.model || item.ipAddress;
    if (baseName && state) {
        return `${baseName} ${state}`;
    }

    return baseName || normalizedType || "ready";
}

function extractNetworkEventName(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return "event";
    }

    const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
    return String(
        payload.event
        || payload.type
        || payload.eventType
        || payload.message
        || payload.action
        || meta.message
        || "event"
    ).trim() || "event";
}

function summarizePortForFingerprint(port) {
    const item = port && typeof port === "object" && !Array.isArray(port)
        ? port
        : {};
    const idxRaw = item.idx ?? item.index ?? item.portIdx ?? item.port_index ?? item.id;
    const idxNumeric = Number(idxRaw);
    const idx = Number.isFinite(idxNumeric) ? Math.trunc(idxNumeric) : null;
    const poe = item.poe && typeof item.poe === "object" ? item.poe : {};

    return {
        idx,
        name: String(item.name || item.portName || ""),
        connector: String(item.connector || item.medium || ""),
        state: String(item.state || item.status || ""),
        speedMbps: item.speedMbps !== undefined ? Number(item.speedMbps) : undefined,
        maxSpeedMbps: item.maxSpeedMbps !== undefined ? Number(item.maxSpeedMbps) : undefined,
        poeEnabled: poe.enabled === true ? true : poe.enabled === false ? false : undefined,
        poeState: String(poe.state || ""),
        poeType: poe.type !== undefined ? Number(poe.type) : undefined
    };
}

function resolvePortDisplayName(portSummary) {
    const item = portSummary && typeof portSummary === "object" ? portSummary : {};
    const explicitName = String(item.name || "").trim();
    if (explicitName) {
        return explicitName;
    }

    const idx = Number(item.idx);
    if (Number.isFinite(idx) && idx > 0) {
        return `Port ${Math.trunc(idx)}`;
    }

    return "Port";
}

function summarizePortsFromDevice(payload) {
    const item = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
    const ports = Array.isArray(item.interfaces && item.interfaces.ports)
        ? item.interfaces.ports
        : Array.isArray(item.ports)
            ? item.ports
            : [];

    return ports
        .map((port) => summarizePortForFingerprint(port))
        .filter((entry) => Number.isInteger(entry.idx) && entry.idx >= 0)
        .sort((left, right) => left.idx - right.idx);
}

function buildDeviceChangeSummary(deviceType, previousPayload, nextPayload) {
    const normalizedType = String(deviceType || "").trim();
    if (normalizedType !== "device") {
        return {
            kind: "device",
            changed: true
        };
    }

    const previousPorts = summarizePortsFromDevice(previousPayload);
    const nextPorts = summarizePortsFromDevice(nextPayload);
    const previousByIndex = new Map(previousPorts.map((port) => [port.idx, port]));
    const nextByIndex = new Map(nextPorts.map((port) => [port.idx, port]));
    const allIndexes = Array.from(new Set(previousPorts.concat(nextPorts).map((port) => port.idx))).sort((a, b) => a - b);
    const changedPorts = [];

    allIndexes.forEach((idx) => {
        const before = previousByIndex.get(idx);
        const after = nextByIndex.get(idx);
        const beforeComparable = before
            ? {
                state: before.state,
                speedMbps: before.speedMbps,
                maxSpeedMbps: before.maxSpeedMbps,
                poeEnabled: before.poeEnabled,
                poeState: before.poeState,
                poeType: before.poeType
            }
            : null;
        const afterComparable = after
            ? {
                state: after.state,
                speedMbps: after.speedMbps,
                maxSpeedMbps: after.maxSpeedMbps,
                poeEnabled: after.poeEnabled,
                poeState: after.poeState,
                poeType: after.poeType
            }
            : null;

        if (JSON.stringify(beforeComparable) === JSON.stringify(afterComparable)) {
            return;
        }

        const reference = after || before || { idx };
        changedPorts.push({
            portIdx: idx,
            portName: resolvePortDisplayName(reference),
            connector: String(reference.connector || ""),
            before: beforeComparable,
            after: afterComparable
        });
    });

    return {
        kind: "device-ports",
        changed: changedPorts.length > 0,
        portCount: changedPorts.length,
        ports: changedPorts
    };
}

function extractPortIndexFromEventPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return undefined;
    }

    const candidates = [
        payload.portIdx,
        payload.port_idx,
        payload.port,
        payload.switchPort,
        payload.switch_port,
        payload.switch_port_idx,
        payload.interface,
        payload.interfaceIdx,
        payload.interface_idx
    ];

    for (const value of candidates) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) {
            return Math.trunc(parsed);
        }
    }

    return undefined;
}

function extractReadableToken(payload, paths) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(paths)) {
        return "";
    }

    for (const path of paths) {
        const segments = String(path || "").split(".").filter(Boolean);
        let current = payload;
        for (const segment of segments) {
            if (!current || typeof current !== "object" || Array.isArray(current)) {
                current = undefined;
                break;
            }
            current = current[segment];
        }

        const normalized = String(current || "").trim();
        if (normalized) {
            return normalized;
        }
    }

    return "";
}

function buildEventTransitionSummary(before, after) {
    const values = [];
    if (before && after && before.poeEnabled !== after.poeEnabled) {
        values.push(`PoE ${before.poeEnabled === true ? "on" : before.poeEnabled === false ? "off" : "n/a"} -> ${after.poeEnabled === true ? "on" : after.poeEnabled === false ? "off" : "n/a"}`);
    }
    if (before && after && String(before.state || "") !== String(after.state || "")) {
        values.push(`state ${String(before.state || "n/a")} -> ${String(after.state || "n/a")}`);
    }
    if (before && after && String(before.poeState || "") !== String(after.poeState || "")) {
        values.push(`PoE state ${String(before.poeState || "n/a")} -> ${String(after.poeState || "n/a")}`);
    }
    if (before && after && before.speedMbps !== after.speedMbps) {
        values.push(`speed ${before.speedMbps !== undefined ? before.speedMbps : "n/a"} -> ${after.speedMbps !== undefined ? after.speedMbps : "n/a"} Mbps`);
    }

    return values;
}

function buildReadableEventSummary(eventName, source, readable) {
    const normalizedName = String(eventName || "event").trim() || "event";
    const normalizedSource = String(source || "").trim();
    const details = [];

    if (readable && readable.portName) {
        details.push(readable.portName);
    }
    if (readable && readable.clientName) {
        details.push(`client ${readable.clientName}`);
    }
    if (readable && readable.switchName) {
        details.push(`switch ${readable.switchName}`);
    }
    if (readable && readable.siteName) {
        details.push(`site ${readable.siteName}`);
    }

    if (readable && readable.changeSummary && Array.isArray(readable.changeSummary.ports) && readable.changeSummary.ports.length === 1) {
        const change = readable.changeSummary.ports[0];
        const transitions = buildEventTransitionSummary(change.before, change.after);
        if (transitions.length > 0) {
            details.push(transitions.join(", "));
        }
    } else if (readable && readable.changeSummary && Number(readable.changeSummary.portCount) > 1) {
        details.push(`${readable.changeSummary.portCount} ports changed`);
    }

    const suffix = details.length > 0 ? `: ${details.join(" | ")}` : "";
    const sourcePrefix = normalizedSource ? `[${normalizedSource}] ` : "";
    return `${sourcePrefix}${normalizedName}${suffix}`;
}

function buildReadableEventPayload(options) {
    const safeOptions = options && typeof options === "object" ? options : {};
    const eventPayload = safeOptions.eventPayload && typeof safeOptions.eventPayload === "object" && !Array.isArray(safeOptions.eventPayload)
        ? safeOptions.eventPayload
        : {};
    const source = String(safeOptions.source || "").trim();
    const eventName = String(safeOptions.eventName || extractNetworkEventName(eventPayload) || "event").trim() || "event";
    const portIdx = safeOptions.portIdx !== undefined ? Number(safeOptions.portIdx) : extractPortIndexFromEventPayload(eventPayload);
    const normalizedPortIdx = Number.isFinite(portIdx) && portIdx >= 0 ? Math.trunc(portIdx) : undefined;
    const portName = String(safeOptions.portName || "").trim() || undefined;
    const changeSummary = safeOptions.changeSummary && typeof safeOptions.changeSummary === "object"
        ? safeOptions.changeSummary
        : undefined;
    const clientName = extractReadableToken(eventPayload, [
        "clientName",
        "client.name",
        "client.hostname",
        "hostname",
        "sta_name",
        "station.name"
    ]) || undefined;
    const switchName = extractReadableToken(eventPayload, [
        "switchName",
        "switch.name",
        "deviceName",
        "device.name",
        "ap_name",
        "sw"
    ]) || undefined;
    const siteName = extractReadableToken(eventPayload, [
        "siteName",
        "site.name",
        "site",
        "network.name"
    ]) || undefined;

    const readable = {
        eventType: eventName,
        source: source || undefined,
        portIdx: normalizedPortIdx,
        portName,
        clientName,
        switchName,
        siteName,
        changeSummary
    };

    const summary = buildReadableEventSummary(eventName, source, readable);
    return {
        ...eventPayload,
        eventType: eventName,
        source: source || undefined,
        summary,
        portIdx: normalizedPortIdx,
        portName,
        clientName,
        switchName,
        siteName,
        changes: changeSummary
    };
}

function buildObservationFingerprint(deviceType, payload) {
    const item = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
    const normalizedType = String(deviceType || "").trim();

    if (normalizedType === "device") {
        const ports = Array.isArray(item.interfaces && item.interfaces.ports)
            ? item.interfaces.ports
            : Array.isArray(item.ports)
                ? item.ports
                : [];
        const summarizedPorts = ports
            .map((port) => summarizePortForFingerprint(port))
            .filter((entry) => Number.isInteger(entry.idx) && entry.idx >= 0)
            .sort((left, right) => left.idx - right.idx);

        return JSON.stringify({
            id: item.id,
            name: item.name || item.displayName || item.hostname || "",
            state: item.state || item.status || "",
            ports: summarizedPorts
        });
    }

    if (normalizedType === "client") {
        return JSON.stringify({
            id: item.id,
            name: item.name || item.displayName || item.hostname || item.macAddress || "",
            state: item.state || item.status || "",
            ipAddress: item.ipAddress || item.ip || "",
            uplinkDeviceId: item.uplinkDeviceId || item.uplink_device_id || item.switchId || item.switch_id || "",
            uplinkPortIdx: item.uplinkPortIdx || item.uplink_port_idx || item.switchPort || item.switch_port || ""
        });
    }

    return JSON.stringify({
        id: item.id,
        name: item.name || item.displayName || "",
        state: item.state || item.status || ""
    });
}

module.exports = function(RED) {
    function UnifiNetworkDeviceNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.server = RED.nodes.getNode(config.server);
        node.deviceType = config.deviceType || "";
        node.deviceId = config.deviceId || "";
        node.capability = config.capability || "observe";
        node.capabilityConfig = config.capabilityConfig || "{}";
        node.autoEmit = parseBoolean(config.autoEmit);
        node.autoEmitIntervalSeconds = parseIntervalSeconds(config.autoEmitInterval, 60);
        node.autoEmitTimer = null;
        node.autoEmitInFlight = false;
        node.deviceName = resolveDeviceName(config.deviceName);
        node.timeout = DEFAULT_REQUEST_TIMEOUT_MS;
        node.currentDevice = null;
        node.isObserving = false;
        node.unofficialLastFingerprint = "";

        function setNodeStatus(status) {
            if (!status || typeof status !== "object" || Array.isArray(status)) {
                return;
            }
            node.status({
                ...status,
                text: appendStatusTimestamp(status.text)
            });
        }

        function resolveOutputDeviceName(payload) {
            const extracted = extractDeviceNameFromPayload(payload);
            if (extracted) {
                node.deviceName = extracted;
                return extracted;
            }

            return resolveDeviceName(node.deviceName);
        }

        function decorateOutputMessage(outputMsg, payload, eventName) {
            const nodeName = resolveNodeName(node.name);
            const resolvedDeviceName = resolveOutputDeviceName(payload);
            outputMsg.topic = nodeName;
            outputMsg.deviceName = resolvedDeviceName || undefined;
            outputMsg.eventName = String(eventName || "").trim() || undefined;
            outputMsg.payload = attachDeviceNameToPayload(outputMsg.payload, resolvedDeviceName);
        }

        function resolvePortNameFromCurrentDevice(portIdx) {
            const parsed = Number(portIdx);
            if (!Number.isFinite(parsed) || parsed < 0 || !node.currentDevice) {
                return undefined;
            }

            const ports = summarizePortsFromDevice(node.currentDevice);
            const matched = ports.find((port) => Number(port.idx) === Math.trunc(parsed));
            if (!matched) {
                return `Port ${Math.trunc(parsed)}`;
            }
            return resolvePortDisplayName(matched);
        }

        function buildBaseMetadata(deviceType, deviceId, capabilityId, extra) {
            // Scoped identifiers let downstream flows work with either plain
            // resource ids or the site/resource pair returned by UniFi Network.
            const scoped = resolveScopedIdentifiers(deviceType, deviceId, node.currentDevice);
            const nodeName = resolveNodeName(node.name);
            const resolvedDeviceName = resolveOutputDeviceName(node.currentDevice);
            return {
                nodeType: "device",
                name: nodeName || undefined,
                deviceName: resolvedDeviceName || undefined,
                deviceType,
                deviceId,
                siteId: scoped.siteId || undefined,
                resourceId: scoped.resourceId || undefined,
                capability: capabilityId,
                ...(extra || {})
            };
        }

        async function fetchDeviceState(deviceType, deviceId, capabilityId, send, source) {
            // Keep a local copy of the latest payload so action execution can
            // reuse it when composing follow-up requests.
            const payload = await node.server.fetchDeviceByTypeAndId(deviceType, deviceId);
            node.currentDevice = payload;
            if (isUnofficialNetworkStreamCapabilitySelected()) {
                node.unofficialLastFingerprint = buildObservationFingerprint(deviceType, payload);
            }

            const outputMsg = {};
            outputMsg.payload = payload;
            attachDetails(outputMsg, {
                device: payload,
                unifiNetwork: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: source || "observe"
                })
            });
            decorateOutputMessage(outputMsg, payload, source || "observe");

            setNodeStatus({ fill: "green", shape: "dot", text: buildNodeStatus(deviceType, payload) });
            send(outputMsg);
        }

        async function fetchDeviceTemperatures(deviceType, deviceId, capabilityId, send) {
            if (deviceType !== "device" || typeof node.server.fetchDeviceTemperatures !== "function") {
                throw new Error("Switch temperature reading is only available for UniFi device resources.");
            }

            const result = await node.server.fetchDeviceTemperatures(deviceId);
            const payload = result && result.payload && typeof result.payload === "object"
                ? result.payload
                : {};
            const sourceDevice = result && result.device && typeof result.device === "object"
                ? result.device
                : payload;
            node.currentDevice = sourceDevice;
            if (payload.deviceName) {
                node.deviceName = resolveDeviceName(payload.deviceName);
            }

            const temperatures = Array.isArray(payload.temperatures) ? payload.temperatures : [];
            const temperatureC = Number(payload.temperatureC);
            const maxTemperatureC = Number(payload.maxTemperatureC);
            const outputMsg = {};
            outputMsg.payload = Number.isFinite(temperatureC) ? temperatureC : null;
            attachDetails(outputMsg, {
                device: sourceDevice,
                temperature: payload,
                temperatureSources: result && result.sources,
                unifiNetwork: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: "request",
                    temperatureC: Number.isFinite(temperatureC) ? temperatureC : undefined,
                    maxTemperatureC: Number.isFinite(maxTemperatureC) ? maxTemperatureC : undefined,
                    temperatureCount: temperatures.length,
                    hasTemperatures: temperatures.length > 0
                })
            });
            decorateOutputMessage(outputMsg, outputMsg.payload, `request:${capabilityId}`);

            const statusTemperatureC = Number.isFinite(temperatureC) ? temperatureC : maxTemperatureC;
            const statusText = Number.isFinite(statusTemperatureC)
                ? `${statusTemperatureC} C`
                : "no temperature";
            setNodeStatus({ fill: temperatures.length > 0 ? "green" : "yellow", shape: "dot", text: statusText });
            send(outputMsg);
        }

        async function executeConfiguredCapabilityRequest(deviceType, deviceId, capabilityId, capabilityConfig) {
            const execution = composeCapabilityExecution(deviceType, capabilityId, capabilityConfig);
            const request = buildCapabilityRequest(deviceType, capabilityId, deviceId, execution.params, node.currentDevice);
            const response = await node.server.executeNetworkRequest({
                path: request.path,
                method: request.method,
                query: execution.query,
                headers: execution.headers,
                payload: execution.payload,
                timeout: node.timeout
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                setNodeStatus({ fill: "yellow", shape: "ring", text: `${response.statusCode}` });
                throw new Error(`UniFi Network request failed with status ${response.statusCode}`);
            }

            return {
                request,
                response,
                responseData: extractNetworkData(response.payload)
            };
        }

        async function fetchClientOnlineState(deviceType, deviceId, capabilityId, send) {
            if (deviceType !== "client") {
                throw new Error("Client online state is only available for Client resources.");
            }

            const scoped = resolveScopedIdentifiers(deviceType, deviceId);
            let client = await node.server.fetchDeviceByTypeAndId("client", deviceId);
            let selectedFromList = null;
            try {
                const clients = await node.server.fetchDevices("client");
                const selectedKeys = new Set([
                    scoped.resourceId,
                    client && client.id,
                    client && client.clientId,
                    client && client.macAddress,
                    client && client.mac
                ].map(normalizeIdentifierKey).filter(Boolean));
                selectedFromList = Array.isArray(clients)
                    ? clients.find((candidate) => {
                        const candidateScoped = resolveScopedIdentifiers("client", "", candidate);
                        if (scoped.siteId && candidateScoped.siteId && scoped.siteId !== candidateScoped.siteId) {
                            return false;
                        }
                        return [
                            candidateScoped.resourceId,
                            candidate && candidate.id,
                            candidate && candidate.clientId,
                            candidate && candidate.macAddress,
                            candidate && candidate.mac
                        ].some((value) => selectedKeys.has(normalizeIdentifierKey(value)));
                    }) || null
                    : null;
            } catch (error) {
                selectedFromList = null;
            }

            client = {
                ...(client && typeof client === "object" && !Array.isArray(client) ? client : {}),
                ...(selectedFromList && typeof selectedFromList === "object" && !Array.isArray(selectedFromList) ? selectedFromList : {})
            };
            node.currentDevice = client;

            const online = resolveClientOnlineState(client);
            const outputMsg = {};
            outputMsg.payload = online;
            attachDetails(outputMsg, {
                client,
                unifiNetwork: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: "request",
                    online
                })
            });
            decorateOutputMessage(outputMsg, outputMsg.payload, `request:${capabilityId}`);

            setNodeStatus({ fill: online ? "green" : "yellow", shape: "dot", text: online ? "online" : "offline" });
            send(outputMsg);
        }

        async function countOnlineClients(deviceType, deviceId, capabilityId, send) {
            if (deviceType !== "site") {
                throw new Error("Client count is only available for Site resources.");
            }

            const site = await node.server.fetchDeviceByTypeAndId("site", deviceId);
            node.currentDevice = site;
            const scoped = resolveScopedIdentifiers("site", deviceId, site);
            const clients = await node.server.fetchDevices("client");
            const siteClients = Array.isArray(clients)
                ? clients.filter((client) => {
                    const clientScoped = resolveScopedIdentifiers("client", "", client);
                    return !scoped.siteId || clientScoped.siteId === scoped.siteId;
                })
                : [];
            const onlineClients = siteClients.filter(resolveClientOnlineState);

            const outputMsg = {};
            outputMsg.payload = onlineClients.length;
            attachDetails(outputMsg, {
                site,
                clients: siteClients,
                onlineClients,
                unifiNetwork: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: "request",
                    onlineClientCount: onlineClients.length,
                    clientCount: siteClients.length
                })
            });
            decorateOutputMessage(outputMsg, outputMsg.payload, `request:${capabilityId}`);

            setNodeStatus({ fill: "green", shape: "dot", text: `${onlineClients.length} online` });
            send(outputMsg);
        }

        async function fetchDeviceSimpleStatistic(deviceType, deviceId, capabilityId, capabilityConfig, send) {
            if (deviceType !== "device") {
                throw new Error("Device statistics are only available for UniFi Device resources.");
            }

            const selectedDevice = await node.server.fetchDeviceByTypeAndId("device", deviceId);
            node.currentDevice = selectedDevice;
            const { request, response, responseData } = await executeConfiguredCapabilityRequest(deviceType, deviceId, capabilityId, capabilityConfig);
            const statistics = responseData && typeof responseData === "object" && !Array.isArray(responseData)
                ? responseData
                : {};
            const metricMap = {
                readDeviceCpu: {
                    key: "cpuUtilizationPct",
                    label: "CPU",
                    unit: "%"
                },
                readDeviceMemory: {
                    key: "memoryUtilizationPct",
                    label: "Memory",
                    unit: "%"
                },
                readDeviceUptime: {
                    key: "uptimeSec",
                    label: "Uptime",
                    unit: "s"
                }
            };
            const metric = metricMap[capabilityId];
            const value = Number(statistics[metric.key]);
            const payloadValue = Number.isFinite(value) ? value : null;

            const outputMsg = {};
            outputMsg.payload = payloadValue;
            attachDetails(outputMsg, {
                device: selectedDevice,
                statistics,
                response: {
                    statusCode: response.statusCode,
                    headers: response.headers,
                    method: request.method,
                    path: request.path
                },
                unifiNetwork: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: "request",
                    method: request.method,
                    path: request.path,
                    value: payloadValue
                })
            });
            decorateOutputMessage(outputMsg, outputMsg.payload, `request:${capabilityId}`);

            const statusText = payloadValue === null
                ? `${metric.label} n/a`
                : `${metric.label} ${payloadValue}${metric.unit}`;
            setNodeStatus({ fill: payloadValue === null ? "yellow" : "green", shape: "dot", text: statusText });
            send(outputMsg);
        }

        async function createGuestVoucher(deviceType, deviceId, capabilityId, capabilityConfig, send) {
            if (deviceType !== "site") {
                throw new Error("Guest vouchers are only available for Site resources.");
            }

            const site = await node.server.fetchDeviceByTypeAndId("site", deviceId);
            node.currentDevice = site;
            const { request, response, responseData } = await executeConfiguredCapabilityRequest(deviceType, deviceId, capabilityId, capabilityConfig);
            const vouchers = Array.isArray(responseData && responseData.vouchers)
                ? responseData.vouchers
                : Array.isArray(responseData)
                    ? responseData
                    : [];
            const codes = vouchers
                .map((voucher) => getFirstNonEmptyString([
                    voucher && voucher.code,
                    voucher && voucher.voucherCode,
                    voucher && voucher.id
                ]))
                .filter(Boolean);

            const outputMsg = {};
            outputMsg.payload = codes.length <= 1 ? (codes[0] || null) : codes;
            attachDetails(outputMsg, {
                site,
                vouchers,
                voucherCodes: codes,
                response: {
                    statusCode: response.statusCode,
                    headers: response.headers,
                    method: request.method,
                    path: request.path
                },
                unifiNetwork: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: "request",
                    method: request.method,
                    path: request.path,
                    voucherCount: vouchers.length
                })
            });
            decorateOutputMessage(outputMsg, outputMsg.payload, `request:${capabilityId}`);

            setNodeStatus({ fill: vouchers.length > 0 ? "green" : "yellow", shape: "dot", text: `${vouchers.length} voucher` });
            send(outputMsg);
        }

        async function invokeCapability(send, triggerSource) {
            if (!node.server) {
                throw new Error("Unifi Network configuration is missing.");
            }

            // The incoming message is only a trigger. The node always uses the
            // device, capability and options configured in the editor.
            const deviceType = resolveDeviceType(node.deviceType);
            const deviceId = resolveDeviceId(node.deviceId);
            const capabilityId = resolveCapabilityId(node.capability);
            const capabilityConfig = resolveCapabilityConfig(node.capabilityConfig);

            if (!getDeviceTypeDefinition(deviceType)) {
                throw new Error(`Unsupported device type: ${deviceType || "(empty)"}`);
            }

            const capability = getCapabilityDefinition(deviceType, capabilityId);
            if (!capability) {
                throw new Error(`Unsupported capability '${capabilityId}' for device type '${deviceType}'.`);
            }

            if (capability.mode === "observe" || capability.mode === "fetch") {
                // "observe" and "fetch" are read-only capabilities, so they can
                // reuse the same fetch path and only change the reported source.
                await fetchDeviceState(
                    deviceType,
                    deviceId,
                    capabilityId,
                    send,
                    triggerSource || (capability.mode === "fetch" ? "fetch" : "manual-refresh")
                );
                return;
            }

            if (capabilityId === "readSwitchTemperatures") {
                await fetchDeviceTemperatures(deviceType, deviceId, capabilityId, send);
                return;
            }

            if (capabilityId === "isClientOnline") {
                await fetchClientOnlineState(deviceType, deviceId, capabilityId, send);
                return;
            }

            if (capabilityId === "countOnlineClients") {
                await countOnlineClients(deviceType, deviceId, capabilityId, send);
                return;
            }

            if (capabilityId === "readDeviceCpu" || capabilityId === "readDeviceMemory" || capabilityId === "readDeviceUptime") {
                await fetchDeviceSimpleStatistic(deviceType, deviceId, capabilityId, capabilityConfig, send);
                return;
            }

            if (capabilityId === "createGuestVoucher") {
                await createGuestVoucher(deviceType, deviceId, capabilityId, capabilityConfig, send);
                return;
            }

            setNodeStatus({ fill: "blue", shape: "dot", text: `${capability.label}` });
            const { request, response, responseData } = await executeConfiguredCapabilityRequest(deviceType, deviceId, capabilityId, capabilityConfig);
            if (responseData && typeof responseData === "object" && !Array.isArray(responseData)) {
                node.currentDevice = responseData;
            }

            const outputMsg = {};
            outputMsg.payload = responseData;
            attachDetails(outputMsg, {
                response: {
                    statusCode: response.statusCode,
                    headers: response.headers,
                    method: request.method,
                    path: request.path
                },
                device: node.currentDevice,
                capabilityConfig,
                unifiNetwork: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: "request",
                    method: request.method,
                    path: request.path,
                    capabilityConfig
                })
            });
            decorateOutputMessage(outputMsg, responseData, `request:${capabilityId}`);

            setNodeStatus({ fill: "green", shape: "dot", text: `${capability.label}` });
            send(outputMsg);
        }

        function resolveConfiguredCapabilityDefinition() {
            const deviceType = resolveDeviceType(node.deviceType);
            const capabilityId = resolveCapabilityId(node.capability);
            return getCapabilityDefinition(deviceType, capabilityId);
        }

        function configuredCapabilityOpensEventStream() {
            const capability = resolveConfiguredCapabilityDefinition();
            return Boolean(capability && capability.opensEventStream === true);
        }

        function configuredCapabilitySupportsAutoEmit() {
            const capability = resolveConfiguredCapabilityDefinition();
            return Boolean(
                capability
                && capability.opensEventStream !== true
                && String(capability.method || "").trim().toUpperCase() !== "POST"
            );
        }

        function isUnofficialNetworkStreamCapabilitySelected() {
            return resolveCapabilityId(node.capability) === UNOFFICIAL_NETWORK_STREAM_CAPABILITY;
        }

        node.shouldReceiveUnofficialNetworkEvents = () => Boolean(node.isObserving && isUnofficialNetworkStreamCapabilitySelected());

        function shouldAutoReceiveConfiguredDevice() {
            return node.server
                && configuredCapabilityOpensEventStream()
                && node.deviceType
                && node.deviceId;
        }

        function shouldUseUnofficialPollingFallback() {
            return Boolean(
                node.server
                && node.isObserving
                && isUnofficialNetworkStreamCapabilitySelected()
                && node.deviceType
                && node.deviceId
            );
        }

        function refreshUnofficialPollingFallback() {
            if (node.server && typeof node.server.refreshUnofficialPollObservationScheduler === "function") {
                node.server.refreshUnofficialPollObservationScheduler();
            }
        }

        function startAutoReceive() {
            if (!shouldAutoReceiveConfiguredDevice() || node.isObserving) {
                return;
            }

            node.isObserving = true;
            // The config node may have registered this client before it became
            // an active stream subscriber; force websocket bootstrap now.
            if (node.server && typeof node.server.ensureUnofficialNetworkWebSocket === "function") {
                try {
                    node.server.ensureUnofficialNetworkWebSocket();
                } catch (error) {
                }
            }
            const capabilityId = resolveCapabilityId(node.capability);

            // Emit an initial snapshot at startup so the flow has a known state
            // as soon as Node-RED starts.
            fetchDeviceState(node.deviceType, node.deviceId, capabilityId, node.send.bind(node), "startup").catch(() => {
            });
            refreshUnofficialPollingFallback();
        }

        function stopAutoEmitTimer() {
            if (node.autoEmitTimer) {
                clearInterval(node.autoEmitTimer);
                node.autoEmitTimer = null;
            }
            node.autoEmitInFlight = false;
        }

        function shouldStartAutoEmitTimer() {
            return Boolean(
                node.server
                && node.autoEmit
                && node.deviceType
                && node.deviceId
                && configuredCapabilitySupportsAutoEmit()
            );
        }

        function runAutoEmit() {
            if (node.autoEmitInFlight || !shouldStartAutoEmitTimer()) {
                return;
            }

            node.autoEmitInFlight = true;
            invokeCapability(node.send.bind(node), "interval")
                .catch((error) => {
                    setNodeStatus({ fill: "red", shape: "ring", text: "auto error" });
                    node.send([null, buildErrorOutputMessage(error, node.name)]);
                    node.error(error);
                })
                .finally(() => {
                    node.autoEmitInFlight = false;
                });
        }

        function startAutoEmitTimer() {
            stopAutoEmitTimer();
            if (!shouldStartAutoEmitTimer()) {
                return;
            }

            const intervalMs = node.autoEmitIntervalSeconds * 1000;
            node.autoEmitTimer = setInterval(runAutoEmit, intervalMs);
            setNodeStatus({ fill: "grey", shape: "ring", text: `every ${node.autoEmitIntervalSeconds}s` });
        }

        node.on("input", async function(_msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };

            try {
                await invokeCapability(send, "manual-refresh");
                if (typeof done === "function") {
                    done();
                }
            } catch (error) {
                setNodeStatus({ fill: "red", shape: "ring", text: "error" });
                node.send([null, buildErrorOutputMessage(error, node.name)]);
                if (typeof done === "function") {
                    done(error);
                } else {
                    node.error(error);
                }
            }
        });

        node.handleNetworkEventUpdate = (eventPayload) => {
            try {
                if (!node.shouldReceiveUnofficialNetworkEvents()) {
                    return;
                }

                const eventName = extractNetworkEventName(eventPayload);
                const eventPortIdx = extractPortIndexFromEventPayload(eventPayload);
                const resolvedPortName = eventPortIdx !== undefined ? resolvePortNameFromCurrentDevice(eventPortIdx) : undefined;
                const readablePayload = buildReadableEventPayload({
                    eventName,
                    source: "events",
                    eventPayload,
                    portIdx: eventPortIdx,
                    portName: resolvedPortName
                });
                setNodeStatus({ fill: "blue", shape: "ring", text: String(readablePayload.summary || eventName) });
                const output = {};
                output.payload = attachDeviceNameToPayload(readablePayload, resolveOutputDeviceName(node.currentDevice));
                if (eventPortIdx !== undefined) {
                    output.portIdx = eventPortIdx;
                    output.portName = resolvedPortName;
                    output.payload.portIdx = eventPortIdx;
                    output.payload.portName = output.portName;
                }
                attachDetails(output, {
                    rawEvent: eventPayload,
                    device: node.currentDevice,
                    unifiNetwork: buildBaseMetadata(node.deviceType, node.deviceId, node.capability, {
                        source: "events",
                        eventType: eventName,
                        portIdx: eventPortIdx,
                        portName: resolvedPortName,
                        unofficialStream: true
                    })
                });
                decorateOutputMessage(output, output.payload, eventName);
                node.send(output);
            } catch (error) {
            }
        };

        node.getUnofficialNetworkPollDescriptor = () => {
            if (!shouldUseUnofficialPollingFallback()) {
                return null;
            }
            return {
                deviceType: node.deviceType,
                deviceId: node.deviceId,
                intervalMs: UNOFFICIAL_POLL_INTERVAL_MS
            };
        };

        node.handleUnofficialNetworkPollUpdate = (update) => {
            try {
                if (!shouldUseUnofficialPollingFallback()) {
                    return;
                }
                const latest = update && update.latest;
                const nextFingerprint = buildObservationFingerprint(node.deviceType, latest);
                if (!nextFingerprint) {
                    return;
                }

                if (!node.unofficialLastFingerprint) {
                    node.currentDevice = latest;
                    node.unofficialLastFingerprint = nextFingerprint;
                    return;
                }

                if (node.unofficialLastFingerprint === nextFingerprint) {
                    return;
                }

                const previousDeviceSnapshot = node.currentDevice;
                const changeSummary = buildDeviceChangeSummary(node.deviceType, previousDeviceSnapshot, latest);
                node.currentDevice = latest;
                node.unofficialLastFingerprint = nextFingerprint;
                const primaryPortChange = changeSummary && Array.isArray(changeSummary.ports) && changeSummary.ports.length === 1
                    ? changeSummary.ports[0]
                    : null;
                const resolvedEventName = primaryPortChange
                    ? `port-${primaryPortChange.portIdx}-changed`
                    : "state-changed";
                setNodeStatus({ fill: "blue", shape: "ring", text: resolvedEventName });
                const readablePayload = buildReadableEventPayload({
                    eventName: resolvedEventName,
                    source: "poll-fallback",
                    eventPayload: {},
                    portIdx: primaryPortChange ? primaryPortChange.portIdx : undefined,
                    portName: primaryPortChange ? primaryPortChange.portName : undefined,
                    changeSummary
                });
                const output = {};
                output.payload = attachDeviceNameToPayload({
                    ...readablePayload,
                    device: latest,
                }, resolveOutputDeviceName(latest));
                if (primaryPortChange) {
                    output.portIdx = primaryPortChange.portIdx;
                    output.portName = primaryPortChange.portName;
                }
                attachDetails(output, {
                    device: latest,
                    changeSummary,
                    unifiNetwork: buildBaseMetadata(node.deviceType, node.deviceId, node.capability, {
                        source: "poll-fallback",
                        eventType: resolvedEventName,
                        changeSummary,
                        portIdx: primaryPortChange ? primaryPortChange.portIdx : undefined,
                        portName: primaryPortChange ? primaryPortChange.portName : undefined,
                        unofficialStream: true
                    })
                });
                decorateOutputMessage(output, output.payload, resolvedEventName);
                node.send(output);
            } catch (error) {
            }
        };

        if (node.server && typeof node.server.addClient === "function") {
            node.server.addClient(node);
        }

        if (shouldAutoReceiveConfiguredDevice()) {
            startAutoReceive();
        } else if (configuredCapabilityOpensEventStream() && (!node.deviceType || !node.deviceId)) {
            setNodeStatus({ fill: "grey", shape: "ring", text: "set device" });
        } else if (shouldStartAutoEmitTimer()) {
            startAutoEmitTimer();
        } else {
            setNodeStatus({ fill: "grey", shape: "ring", text: "ready" });
        }

        node.on("close", function(done) {
            try {
                node.isObserving = false;
                stopAutoEmitTimer();
                if (node.server && typeof node.server.removeClient === "function") {
                    node.server.removeClient(node);
                }
                refreshUnofficialPollingFallback();
            } catch (error) {
            } finally {
                if (typeof done === "function") {
                    done();
                }
            }
        });
    }

    RED.nodes.registerType("unifi-network-device", UnifiNetworkDeviceNode);
};
