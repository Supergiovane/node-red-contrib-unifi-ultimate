"use strict";

const {
    decodeScopedDeviceId,
    resolveScopedIdentifiers
} = require("./utils/unifi-network-device-registry");
const { extractNetworkData } = require("./utils/unifi-network-utils");

function normalizeString(value) {
    return String(value || "").trim();
}

function normalizeIdentifierKey(value) {
    const normalized = normalizeString(value).toLowerCase();
    return normalized ? normalized.replace(/[^a-z0-9]/g, "") : "";
}

function extractArrayPayload(payload) {
    const data = extractNetworkData(payload);
    if (Array.isArray(data)) {
        return data;
    }
    if (Array.isArray(payload)) {
        return payload;
    }
    if (payload && typeof payload === "object" && Array.isArray(payload.data)) {
        return payload.data;
    }
    return [];
}

function resolveDeviceId(configuredDeviceId) {
    return String(configuredDeviceId || "").trim();
}

function resolvePortIdx(configuredPortIdx) {
    const configured = Number(configuredPortIdx);
    if (Number.isFinite(configured) && configured >= 0) {
        return Math.trunc(configured);
    }

    return NaN;
}

function resolveConfiguredAction(value) {
    const normalized = String(value || "").trim();
    const lower = normalized.toLowerCase();
    const upper = normalized.toUpperCase();

    if (["msgpayload", "payload", "poecontrolledbymsgpayload"].includes(lower)) {
        return {
            type: "poeModeFromPayload",
            payloadAction: "POE_CONTROLLED_BY_MSG_PAYLOAD"
        };
    }

    if (["emitpowerconsumption", "emit_power_consumption"].includes(lower)) {
        return {
            type: "observePower",
            payloadAction: "EMIT_POWER_CONSUMPTION"
        };
    }

    if (!upper || ["CYCLE", "POWER_CYCLE"].includes(upper)) {
        return {
            type: "powerCycle",
            payloadAction: "POWER_CYCLE"
        };
    }

    if (["ENABLE", "ON", "POWER_ON", "ENABLE_POE", "AUTO"].includes(upper)) {
        return {
            type: "poeMode",
            payloadAction: "ENABLE_POE",
            poeMode: "auto"
        };
    }

    if (["DISABLE", "OFF", "POWER_OFF", "DISABLE_POE"].includes(upper)) {
        return {
            type: "poeMode",
            payloadAction: "DISABLE_POE",
            poeMode: "off"
        };
    }

    return {
        type: "powerCycle",
        payloadAction: upper
    };
}

function resolvePayloadBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "number") {
        if (value === 1) {
            return true;
        }
        if (value === 0) {
            return false;
        }
        return null;
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "on", "enable", "enabled"].includes(normalized)) {
            return true;
        }
        if (["false", "0", "off", "disable", "disabled"].includes(normalized)) {
            return false;
        }
        return null;
    }

    return null;
}

function resolveNodeName(value) {
    return String(value || "").trim();
}

function resolveDeviceName(value) {
    return String(value || "").trim();
}

function extractDeviceNameFromPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return "";
    }

    return resolveDeviceName(
        payload.name
        || payload.displayName
        || payload.hostname
        || payload.alias
        || payload.full_name
        || payload.macAddress
        || payload.id
    );
}

function attachDeviceNameToPayload(payload, deviceName) {
    if (!deviceName) {
        return payload;
    }

    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        return {
            ...payload,
            deviceName
        };
    }

    return payload;
}

function attachDetails(outputMsg, details) {
    if (!outputMsg || typeof outputMsg !== "object" || Array.isArray(outputMsg)) {
        return;
    }
    if (!details || typeof details !== "object" || Array.isArray(details)) {
        return;
    }

    outputMsg.details = {
        ...(outputMsg.details && typeof outputMsg.details === "object" && !Array.isArray(outputMsg.details)
            ? outputMsg.details
            : {}),
        ...details
    };
}

function buildStatusTimestampText() {
    const now = new Date();
    const time = now.toTimeString().split(" ")[0];
    return `(day ${now.getDate()}, ${time})`;
}

function appendStatusTimestamp(text) {
    const normalized = String(text === undefined || text === null ? "" : text).trim();
    const suffix = buildStatusTimestampText();
    return normalized ? `${normalized} ${suffix}` : suffix;
}

function resolveNumericPortIndex(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : NaN;
}

function summarizeSelectedPort(port) {
    const item = port && typeof port === "object" && !Array.isArray(port)
        ? port
        : null;
    if (!item) {
        return null;
    }

    const idx = resolveNumericPortIndex(item.idx);
    const power = Number(item.poePowerW);

    return {
        idx: Number.isFinite(idx) ? idx : undefined,
        name: normalizeString(item.name),
        state: normalizeString(item.state),
        poeState: normalizeString(item.poeState),
        poeEnabled: normalizeString(item.poeEnabled),
        poePowerW: Number.isFinite(power) ? power : undefined,
        connectedClientNames: Array.isArray(item.connectedClientNames)
            ? item.connectedClientNames.map((entry) => normalizeString(entry)).filter(Boolean)
            : undefined
    };
}

function attachPortConsumptionToPayload(payload, selectedPort, powerConsumptionSwitchTotal) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return payload;
    }

    const outputPayload = {
        ...payload,
        powerConsumptionSwitchTotal: Number.isFinite(Number(powerConsumptionSwitchTotal))
            ? Number(powerConsumptionSwitchTotal)
            : payload.powerConsumptionSwitchTotal
    };

    if (!selectedPort || typeof selectedPort !== "object") {
        return outputPayload;
    }

    outputPayload.portIdx = selectedPort.idx !== undefined ? selectedPort.idx : payload.portIdx;
    outputPayload.portName = selectedPort.name || payload.portName;
    outputPayload.portPowerW = selectedPort.poePowerW !== undefined ? selectedPort.poePowerW : payload.portPowerW;
    return outputPayload;
}

module.exports = function(RED) {
    function UnifiNetworkControlPoeNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.server = RED.nodes.getNode(config.server);
        node.deviceId = config.deviceId || "";
        node.deviceName = resolveDeviceName(config.deviceName);
        node.portIdx = config.portIdx;
        node.action = config.action || "msgPayload";
        node.timeout = Number(config.timeout) > 0 ? Number(config.timeout) : 15000;
        node.isPowerObserving = false;
        node.lastObservedPowerW = undefined;
        node.hasObservedPower = false;

        function setNodeStatus(status) {
            if (!status || typeof status !== "object" || Array.isArray(status)) {
                return;
            }
            node.status({
                ...status,
                text: appendStatusTimestamp(status.text)
            });
        }

        function resolvePowerObservationIntervalSeconds() {
            const configured = Number(node.server && node.server.powerObservationIntervalSeconds);
            if (Number.isFinite(configured) && configured >= 1) {
                return Math.trunc(configured);
            }
            return 15;
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

        function buildMetadata(deviceId, payloadAction, portIdx, extra) {
            // The emitted metadata keeps both the scoped ids and the exact action
            // that ended up being accepted by the controller.
            const scoped = decodeScopedDeviceId(deviceId);
            const nodeName = resolveNodeName(node.name);
            const resolvedDeviceName = resolveOutputDeviceName(null);
            return {
                nodeType: "poe-control",
                name: nodeName || undefined,
                deviceName: resolvedDeviceName || undefined,
                deviceId,
                siteId: scoped.siteId || undefined,
                resourceId: scoped.resourceId || undefined,
                action: payloadAction,
                portIdx,
                ...(extra || {})
            };
        }

        function actionOpensPowerObservation(action) {
            return action && action.type === "observePower";
        }

        function resolvePoeModeActionFromMessage(action, msg) {
            if (!action || action.type !== "poeModeFromPayload") {
                return action;
            }

            const payload = msg && typeof msg === "object" ? msg.payload : undefined;
            const payloadBoolean = resolvePayloadBoolean(payload);
            if (payloadBoolean === true) {
                return {
                    type: "poeMode",
                    payloadAction: "ENABLE_POE",
                    poeMode: "auto"
                };
            }
            if (payloadBoolean === false) {
                return {
                    type: "poeMode",
                    payloadAction: "DISABLE_POE",
                    poeMode: "off"
                };
            }

            throw new Error("When action is 'POE controlled by msg.payload', msg.payload must be true/false.");
        }

        function formatPowerText(powerW) {
            const numeric = Number(powerW);
            if (!Number.isFinite(numeric)) {
                return "n/a";
            }
            return String(Math.round(numeric * 1000) / 1000);
        }

        function hasPowerChanged(previousPowerW, nextPowerW) {
            const previous = Number(previousPowerW);
            const next = Number(nextPowerW);
            if (!Number.isFinite(previous) && !Number.isFinite(next)) {
                return false;
            }
            if (!Number.isFinite(previous) || !Number.isFinite(next)) {
                return true;
            }
            return Math.abs(previous - next) >= 0.001;
        }

        async function fetchSelectedPortSummary(deviceId, portIdx) {
            if (!node.server || typeof node.server.fetchDevicePorts !== "function") {
                return {
                    selectedPort: null,
                    powerConsumptionSwitchTotal: undefined
                };
            }

            try {
                const ports = await node.server.fetchDevicePorts(deviceId);
                if (!Array.isArray(ports)) {
                    return {
                        selectedPort: null,
                        powerConsumptionSwitchTotal: undefined
                    };
                }

                const wantedIdx = resolveNumericPortIndex(portIdx);
                const selected = ports.find((entry) => resolveNumericPortIndex(entry && entry.idx) === wantedIdx);
                const totalPower = ports.reduce((sum, entry) => {
                    const power = Number(entry && entry.poePowerW);
                    if (!Number.isFinite(power)) {
                        return sum;
                    }
                    return sum + power;
                }, 0);
                const totalPowerCount = ports.reduce((count, entry) => {
                    const power = Number(entry && entry.poePowerW);
                    return Number.isFinite(power) ? count + 1 : count;
                }, 0);
                const normalizedTotal = Math.round(totalPower * 1000) / 1000;
                return {
                    selectedPort: summarizeSelectedPort(selected),
                    powerConsumptionSwitchTotal: totalPowerCount > 0 && Number.isFinite(normalizedTotal)
                        ? normalizedTotal
                        : undefined
                };
            } catch (error) {
                return {
                    selectedPort: null,
                    powerConsumptionSwitchTotal: undefined
                };
            }
        }

        async function fetchLegacySiteName(siteId) {
            const normalizedSiteId = normalizeString(siteId);
            if (!normalizedSiteId || typeof node.server.executeLegacyNetworkRequest !== "function") {
                return "";
            }

            const response = await node.server.executeLegacyNetworkRequest({
                path: "/api/self/sites",
                method: "GET",
                timeout: node.timeout
            });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Unable to load UniFi legacy sites (${response.statusCode}).`);
            }

            const sites = extractArrayPayload(response.payload);
            const matched = sites.find((site) => {
                return [
                    site && site.external_id,
                    site && site._id,
                    site && site.id,
                    site && site.name,
                    site && site.desc
                ].some((value) => normalizeString(value) === normalizedSiteId);
            });

            return normalizeString(matched && matched.name);
        }

        async function fetchOfficialDevice(scoped) {
            const response = await node.server.executeNetworkRequest({
                path: `/v1/sites/${encodeURIComponent(scoped.siteId)}/devices/${encodeURIComponent(scoped.resourceId)}`,
                method: "GET",
                timeout: node.timeout
            });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                return null;
            }

            const data = extractNetworkData(response.payload);
            return data && typeof data === "object" && !Array.isArray(data)
                ? data
                : null;
        }

        async function fetchLegacyDevices(legacySiteName) {
            const response = await node.server.executeLegacyNetworkRequest({
                path: `/api/s/${encodeURIComponent(legacySiteName)}/stat/device`,
                method: "GET",
                timeout: node.timeout
            });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error(`Unable to load UniFi legacy devices (${response.statusCode}).`);
            }

            return extractArrayPayload(response.payload);
        }

        function findLegacyDevice(devices, scoped, officialDevice) {
            const wantedKeys = new Set();
            [
                scoped.resourceId,
                officialDevice && officialDevice.id,
                officialDevice && officialDevice.deviceId,
                officialDevice && officialDevice.device_id,
                officialDevice && officialDevice.macAddress,
                officialDevice && officialDevice.mac_address,
                officialDevice && officialDevice.mac
            ].forEach((value) => {
                const key = normalizeIdentifierKey(value);
                if (key) {
                    wantedKeys.add(key);
                }
            });

            return devices.find((device) => {
                return [
                    device && device._id,
                    device && device.id,
                    device && device.device_id,
                    device && device.mac
                ].some((value) => wantedKeys.has(normalizeIdentifierKey(value)));
            }) || null;
        }

        function buildPortOverrides(device, portIdx, poeMode) {
            const sourceOverrides = Array.isArray(device && device.port_overrides)
                ? device.port_overrides
                : [];
            const portOverrides = sourceOverrides.map((port) => ({ ...port }));
            const existing = portOverrides.find((port) => Number(port && port.port_idx) === portIdx);
            if (existing) {
                existing.poe_mode = poeMode;
                return portOverrides;
            }

            const sourcePort = Array.isArray(device && device.port_table)
                ? device.port_table.find((port) => Number(port && port.port_idx) === portIdx)
                : null;

            portOverrides.push({
                port_idx: portIdx,
                poe_mode: poeMode,
                portconf_id: sourcePort && sourcePort.portconf_id,
                port_security_mac_address: [],
                stp_port_mode: true,
                autoneg: true,
                port_security_enabled: false
            });
            return portOverrides;
        }

        async function invokePoeMode(deviceId, scoped, portIdx, action) {
            if (typeof node.server.executeLegacyNetworkRequest !== "function") {
                throw new Error("This action requires the UniFi Network legacy API helper.");
            }

            const legacySiteName = await fetchLegacySiteName(scoped.siteId);
            if (!legacySiteName) {
                throw new Error("Unable to resolve UniFi legacy site name.");
            }

            const officialDevice = await fetchOfficialDevice(scoped);
            const legacyDevices = await fetchLegacyDevices(legacySiteName);
            const legacyDevice = findLegacyDevice(legacyDevices, scoped, officialDevice);
            if (!legacyDevice || !legacyDevice._id) {
                throw new Error("Unable to resolve UniFi legacy device id.");
            }

            const path = `/api/s/${encodeURIComponent(legacySiteName)}/rest/device/${encodeURIComponent(legacyDevice._id)}`;
            const portOverrides = buildPortOverrides(legacyDevice, portIdx, action.poeMode);
            setNodeStatus({ fill: "blue", shape: "dot", text: `${action.poeMode} p${portIdx}` });

            const response = await node.server.executeLegacyNetworkRequest({
                path,
                method: "PUT",
                payload: {
                    port_overrides: portOverrides
                },
                timeout: node.timeout
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                const errorPayload = response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)
                    ? response.payload
                    : {};
                const errorDetail = String(errorPayload.message || errorPayload.code || "").trim();
                throw new Error(`PoE mode request failed (${response.statusCode})${errorDetail ? `: ${errorDetail}` : ""}.`);
            }

            return {
                response,
                metadata: buildMetadata(deviceId, action.payloadAction, portIdx, {
                    source: "legacy-port-overrides",
                    requestedAction: action.payloadAction,
                    poeMode: action.poeMode,
                    method: "PUT",
                    path
                })
            };
        }

        async function invokePowerCycle(deviceId, scoped, portIdx, action) {
            const path = `/v1/sites/${encodeURIComponent(scoped.siteId)}/devices/${encodeURIComponent(scoped.resourceId)}/interfaces/ports/${encodeURIComponent(String(portIdx))}/actions`;
            setNodeStatus({ fill: "blue", shape: "dot", text: `${action.payloadAction} p${portIdx}` });

            const response = await node.server.executeNetworkRequest({
                path,
                method: "POST",
                payload: {
                    action: action.payloadAction
                },
                timeout: node.timeout
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                const errorPayload = response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)
                    ? response.payload
                    : {};
                const errorDetail = String(errorPayload.message || errorPayload.code || "").trim();
                throw new Error(`PoE control request failed (${response.statusCode})${errorDetail ? `: ${errorDetail}` : ""}.`);
            }

            return {
                response,
                metadata: buildMetadata(deviceId, action.payloadAction, portIdx, {
                    source: "request",
                    requestedAction: action.payloadAction,
                    method: "POST",
                    path
                })
            };
        }

        async function emitPowerObservation(send, action, source) {
            if (!node.server) {
                throw new Error("Unifi Network configuration is missing.");
            }

            const deviceId = resolveDeviceId(node.deviceId);
            if (!deviceId) {
                throw new Error("Missing switch device id.");
            }

            const portIdx = resolvePortIdx(node.portIdx);
            if (!Number.isFinite(portIdx)) {
                throw new Error("Missing port index.");
            }

            const powerSnapshot = await fetchSelectedPortSummary(deviceId, portIdx);
            const selectedPort = powerSnapshot.selectedPort;
            if (!selectedPort) {
                setNodeStatus({ fill: "yellow", shape: "ring", text: `port ${portIdx} unavailable` });
                return;
            }

            const currentPowerW = Number(selectedPort.poePowerW);
            const powerW = Number.isFinite(currentPowerW) ? currentPowerW : undefined;
            const powerChanged = hasPowerChanged(node.lastObservedPowerW, powerW);

            node.lastObservedPowerW = powerW;
            node.hasObservedPower = true;

            const output = {
                payload: {
                    portIdx: selectedPort.idx !== undefined ? selectedPort.idx : portIdx,
                    portName: selectedPort.name || `Port ${portIdx}`,
                    portPowerW: powerW,
                    powerConsumptionSwitchTotal: powerSnapshot.powerConsumptionSwitchTotal,
                    powerChanged,
                    source
                }
            };
            attachDetails(output, {
                unifiNetworkPoe: {
                    ...buildMetadata(deviceId, action.payloadAction, portIdx, {
                        source,
                        intervalSeconds: resolvePowerObservationIntervalSeconds()
                    }),
                    portPowerW: powerW,
                    powerConsumptionSwitchTotal: powerSnapshot.powerConsumptionSwitchTotal,
                    selectedPort
                }
            });
            decorateOutputMessage(
                output,
                output.payload,
                "power-consumption-interval"
            );

            setNodeStatus({
                fill: "green",
                shape: "dot",
                text: `p${portIdx} ${formatPowerText(powerW)}W`
            });
            send(output);
        }

        function handlePowerObservationEvent(send, action, event) {
            const deviceId = resolveDeviceId(node.deviceId);
            const configuredPortIdx = resolvePortIdx(node.portIdx);
            const observedPortIdx = resolvePortIdx(event && event.portIdx);
            const portIdx = Number.isFinite(observedPortIdx)
                ? observedPortIdx
                : configuredPortIdx;
            const selectedPort = event && event.selectedPort && typeof event.selectedPort === "object"
                ? event.selectedPort
                : null;
            const powerW = Number(event && event.portPowerW);
            const normalizedPowerW = Number.isFinite(powerW) ? powerW : undefined;
            const source = String(event && event.source || "poll");
            if (!selectedPort || event.available === false) {
                setNodeStatus({ fill: "yellow", shape: "ring", text: `port ${portIdx} unavailable` });
                return;
            }

            const output = {
                payload: {
                    portIdx: selectedPort.idx !== undefined ? selectedPort.idx : portIdx,
                    portName: selectedPort.name || `Port ${portIdx}`,
                    portPowerW: normalizedPowerW,
                    powerConsumptionSwitchTotal: event.powerConsumptionSwitchTotal,
                    powerChanged: event.powerChanged === true,
                    source
                }
            };
            attachDetails(output, {
                unifiNetworkPoe: {
                    ...buildMetadata(deviceId, action.payloadAction, portIdx, {
                        source,
                        intervalSeconds: Number.isFinite(Number(event && event.intervalSeconds))
                            ? Math.trunc(Number(event.intervalSeconds))
                            : resolvePowerObservationIntervalSeconds()
                    }),
                    portPowerW: normalizedPowerW,
                    powerConsumptionSwitchTotal: event.powerConsumptionSwitchTotal,
                    selectedPort
                }
            });
            decorateOutputMessage(
                output,
                output.payload,
                "power-consumption-interval"
            );

            setNodeStatus({
                fill: "green",
                shape: "dot",
                text: `p${portIdx} ${formatPowerText(normalizedPowerW)}W`
            });
            send(output);
        }

        function stopPowerObservation() {
            node.isPowerObserving = false;
            if (node.server && typeof node.server.refreshPowerObservationScheduler === "function") {
                node.server.refreshPowerObservationScheduler();
            }
        }

        function startPowerObservation() {
            const action = resolveConfiguredAction(node.action);
            if (!actionOpensPowerObservation(action) || node.isPowerObserving) {
                return;
            }
            if (!node.server || !resolveDeviceId(node.deviceId) || !Number.isFinite(resolvePortIdx(node.portIdx))) {
                return;
            }

            node.isPowerObserving = true;
            node.hasObservedPower = false;
            node.lastObservedPowerW = undefined;
            setNodeStatus({
                fill: "blue",
                shape: "ring",
                text: `observe every ${resolvePowerObservationIntervalSeconds()}s`
            });
            if (node.server && typeof node.server.refreshPowerObservationScheduler === "function") {
                node.server.refreshPowerObservationScheduler();
            }
        }

        async function invoke(msg, send) {
            if (!node.server) {
                throw new Error("Unifi Network configuration is missing.");
            }

            // The node executes the action configured in the editor. The only
            // runtime override is the payload-driven action, which maps
            // msg.payload true/false to enable/disable PoE.
            const deviceId = resolveDeviceId(node.deviceId);
            if (!deviceId) {
                throw new Error("Missing switch device id.");
            }

            const scoped = resolveScopedIdentifiers("device", deviceId);
            if (!scoped.siteId || !scoped.resourceId) {
                throw new Error("Device selection is invalid. Re-select the device from the editor.");
            }

            const portIdx = resolvePortIdx(node.portIdx);
            if (!Number.isFinite(portIdx)) {
                throw new Error("Missing port index.");
            }

            const action = resolveConfiguredAction(node.action);
            if (actionOpensPowerObservation(action)) {
                await emitPowerObservation(send, action, "manual");
                return;
            }

            const effectiveAction = resolvePoeModeActionFromMessage(action, msg);

            const result = effectiveAction.type === "poeMode"
                ? await invokePoeMode(deviceId, scoped, portIdx, effectiveAction)
                : await invokePowerCycle(deviceId, scoped, portIdx, effectiveAction);
            const powerSnapshot = await fetchSelectedPortSummary(deviceId, portIdx);
            const selectedPort = powerSnapshot.selectedPort;

            const output = {};
            output.payload = attachPortConsumptionToPayload(
                extractNetworkData(result.response.payload),
                selectedPort,
                powerSnapshot.powerConsumptionSwitchTotal
            );
            attachDetails(output, {
                response: {
                    statusCode: result.response.statusCode,
                    headers: result.response.headers
                },
                unifiNetworkPoe: {
                    ...result.metadata,
                    portPowerW: selectedPort && selectedPort.poePowerW !== undefined
                        ? selectedPort.poePowerW
                        : undefined,
                    powerConsumptionSwitchTotal: powerSnapshot.powerConsumptionSwitchTotal,
                    selectedPort: selectedPort || undefined
                }
            });
            decorateOutputMessage(output, output.payload, `request:${effectiveAction.payloadAction}`);

            setNodeStatus({ fill: "green", shape: "dot", text: `${effectiveAction.payloadAction} ok` });
            send(output);
        }

        node.on("input", async function(msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };

            try {
                await invoke(msg, send);
                if (typeof done === "function") {
                    done();
                }
            } catch (error) {
                setNodeStatus({ fill: "red", shape: "ring", text: "error" });
                if (typeof done === "function") {
                    done(error);
                } else {
                    node.error(error);
                }
            }
        });

        node.getNetworkPoePowerObservationDescriptor = () => {
            if (!node.isPowerObserving) {
                return null;
            }
            const action = resolveConfiguredAction(node.action);
            if (!actionOpensPowerObservation(action)) {
                return null;
            }
            const deviceId = resolveDeviceId(node.deviceId);
            const portIdx = resolvePortIdx(node.portIdx);
            if (!deviceId || !Number.isFinite(portIdx)) {
                return null;
            }

            return {
                deviceId,
                portIdx
            };
        };

        node.handleNetworkPoePowerObservationUpdate = (event) => {
            try {
                if (!node.isPowerObserving) {
                    return;
                }
                const action = resolveConfiguredAction(node.action);
                if (!actionOpensPowerObservation(action)) {
                    return;
                }
                handlePowerObservationEvent(node.send.bind(node), action, event);
            } catch (error) {
            }
        };

        if (!node.server) {
            setNodeStatus({ fill: "red", shape: "ring", text: "no config" });
        } else if (!node.deviceId) {
            setNodeStatus({ fill: "grey", shape: "ring", text: "set device" });
        } else {
            if (typeof node.server.addClient === "function") {
                node.server.addClient(node);
            }
            const action = resolveConfiguredAction(node.action);
            if (actionOpensPowerObservation(action)) {
                startPowerObservation();
            } else {
                setNodeStatus({ fill: "grey", shape: "ring", text: "ready" });
            }
        }

        node.on("close", function(done) {
            try {
                if (node.server && typeof node.server.removeClient === "function") {
                    node.server.removeClient(node);
                }
                stopPowerObservation();
            } catch (error) {
            } finally {
                if (typeof done === "function") {
                    done();
                }
            }
        });
    }

    RED.nodes.registerType("unifi-network-control-poe", UnifiNetworkControlPoeNode);
};
