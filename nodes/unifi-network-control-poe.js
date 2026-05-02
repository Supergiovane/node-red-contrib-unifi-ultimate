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
    const upper = normalized.toUpperCase();

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

module.exports = function(RED) {
    function UnifiNetworkControlPoeNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.server = RED.nodes.getNode(config.server);
        node.deviceId = config.deviceId || "";
        node.portIdx = config.portIdx;
        node.action = config.action || "cycle";
        node.timeout = Number(config.timeout) > 0 ? Number(config.timeout) : 15000;

        function buildMetadata(deviceId, payloadAction, portIdx, extra) {
            // The emitted metadata keeps both the scoped ids and the exact action
            // that ended up being accepted by the controller.
            const scoped = decodeScopedDeviceId(deviceId);
            return {
                nodeType: "poe-control",
                deviceId,
                siteId: scoped.siteId || undefined,
                resourceId: scoped.resourceId || undefined,
                action: payloadAction,
                portIdx,
                ...(extra || {})
            };
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
            const result = action.type === "poeMode"
                ? await invokePoeMode(deviceId, scoped, portIdx, action)
                : await invokePowerCycle(deviceId, scoped, portIdx, action);

            const output = {};
            output.payload = extractNetworkData(result.response.payload);
            output.statusCode = result.response.statusCode;
            output.headers = result.response.headers;
            output.unifiNetworkPoe = result.metadata;

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
            node.status({ fill: "grey", shape: "ring", text: "ready" });
        }
    }

    RED.nodes.registerType("unifi-network-control-poe", UnifiNetworkControlPoeNode);
};
