"use strict";

const {
    decodeScopedDeviceId,
    resolveScopedIdentifiers
} = require("./utils/unifi-network-device-registry");
const { extractNetworkData } = require("./utils/unifi-network-utils");
const MIN_POWER_INTERVAL_SECONDS = 5;
const DEFAULT_POWER_INTERVAL_SECONDS = 15;

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

    if (["emitpoweratchange", "emit_power_consumption_at_change"].includes(lower)) {
        return {
            type: "observePower",
            payloadAction: "EMIT_POWER_CONSUMPTION_AT_CHANGE",
            observeMode: "change"
        };
    }

    if (["emitpoweratinterval", "emit_power_consumption_at_fixed_intervals"].includes(lower)) {
        return {
            type: "observePower",
            payloadAction: "EMIT_POWER_CONSUMPTION_AT_FIXED_INTERVALS",
            observeMode: "interval"
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

function resolvePowerIntervalSeconds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_POWER_INTERVAL_SECONDS;
    }
    const integer = Math.trunc(parsed);
    if (integer < MIN_POWER_INTERVAL_SECONDS) {
        return MIN_POWER_INTERVAL_SECONDS;
    }
    return integer;
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
        node.action = config.action || "cycle";
        node.powerIntervalSeconds = resolvePowerIntervalSeconds(config.powerIntervalSeconds);
        node.timeout = Number(config.timeout) > 0 ? Number(config.timeout) : 15000;
        node.powerPollTimer = null;
        node.isPowerObserving = false;
        node.lastObservedPowerW = undefined;
        node.hasObservedPower = false;

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
            if (!normalizedSiteId || typeof node.server.legacyApiRequest !== "function") {
                return "";
            }

            const response = await node.server.legacyApiRequest({
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
            const response = await node.server.apiRequest({
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
            const response = await node.server.legacyApiRequest({
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
            if (typeof node.server.legacyApiRequest !== "function") {
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
            node.status({ fill: "blue", shape: "dot", text: `${action.poeMode} p${portIdx}` });

            const response = await node.server.legacyApiRequest({
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
            node.status({ fill: "blue", shape: "dot", text: `${action.payloadAction} p${portIdx}` });

            const response = await node.server.apiRequest({
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

        async function emitPowerObservation(send, action, source, forcedEmit) {
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
                node.status({ fill: "yellow", shape: "ring", text: `port ${portIdx} unavailable` });
                return;
            }

            const currentPowerW = Number(selectedPort.poePowerW);
            const powerW = Number.isFinite(currentPowerW) ? currentPowerW : undefined;
            const powerChanged = hasPowerChanged(node.lastObservedPowerW, powerW);
            const shouldEmit = forcedEmit === true
                || action.observeMode === "interval"
                || !node.hasObservedPower
                || powerChanged;

            node.lastObservedPowerW = powerW;
            node.hasObservedPower = true;

            if (!shouldEmit) {
                node.status({
                    fill: "blue",
                    shape: "ring",
                    text: `watch p${portIdx} ${formatPowerText(powerW)}W`
                });
                return;
            }

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
                    observeMode: action.observeMode,
                        intervalSeconds: node.powerIntervalSeconds
                    }),
                    portPowerW: powerW,
                    powerConsumptionSwitchTotal: powerSnapshot.powerConsumptionSwitchTotal,
                    selectedPort
                }
            });
            decorateOutputMessage(
                output,
                output.payload,
                action.observeMode === "change"
                    ? "power-consumption-changed"
                    : "power-consumption-interval"
            );

            node.status({
                fill: "green",
                shape: "dot",
                text: `p${portIdx} ${formatPowerText(powerW)}W`
            });
            send(output);
        }

        function stopPowerObservation() {
            if (node.powerPollTimer) {
                clearInterval(node.powerPollTimer);
                node.powerPollTimer = null;
            }
            node.isPowerObserving = false;
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
            node.status({
                fill: "blue",
                shape: "ring",
                text: `observe every ${node.powerIntervalSeconds}s`
            });

            const send = node.send.bind(node);
            emitPowerObservation(send, action, "startup", true).catch(() => {
            });

            node.powerPollTimer = setInterval(() => {
                emitPowerObservation(send, action, "poll", false).catch(() => {
                });
            }, node.powerIntervalSeconds * 1000);
        }

        async function invoke(send) {
            if (!node.server) {
                throw new Error("Unifi Network configuration is missing.");
            }

            // The incoming message is only a trigger. The node always executes
            // the action configured in the editor.
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
                await emitPowerObservation(send, action, "manual", true);
                return;
            }

            const result = action.type === "poeMode"
                ? await invokePoeMode(deviceId, scoped, portIdx, action)
                : await invokePowerCycle(deviceId, scoped, portIdx, action);
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
            decorateOutputMessage(output, output.payload, `request:${action.payloadAction}`);

            node.status({ fill: "green", shape: "dot", text: `${action.payloadAction} ok` });
            send(output);
        }

        node.on("input", async function(_msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };

            try {
                await invoke(send);
                if (typeof done === "function") {
                    done();
                }
            } catch (error) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                if (typeof done === "function") {
                    done(error);
                } else {
                    node.error(error);
                }
            }
        });

        if (!node.server) {
            node.status({ fill: "red", shape: "ring", text: "no config" });
        } else if (!node.deviceId) {
            node.status({ fill: "grey", shape: "ring", text: "set device" });
        } else {
            const action = resolveConfiguredAction(node.action);
            if (actionOpensPowerObservation(action)) {
                startPowerObservation();
            } else {
                node.status({ fill: "grey", shape: "ring", text: "ready" });
            }
        }

        node.on("close", function(done) {
            try {
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
