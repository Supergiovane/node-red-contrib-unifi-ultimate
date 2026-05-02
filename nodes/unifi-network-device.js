"use strict";

const {
    buildCapabilityRequest,
    composeCapabilityExecution,
    getCapabilityDefinition,
    getDeviceTypeDefinition,
    resolveScopedIdentifiers
} = require("./utils/unifi-network-device-registry");
const { extractNetworkData } = require("./utils/unifi-network-utils");

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
        node.timeout = Number(config.timeout) > 0 ? Number(config.timeout) : 15000;
        node.currentDevice = null;
        node.isObserving = false;

        function buildBaseMetadata(deviceType, deviceId, capabilityId, extra) {
            // Scoped identifiers let downstream flows work with either plain
            // resource ids or the site/resource pair returned by UniFi Network.
            const scoped = resolveScopedIdentifiers(deviceType, deviceId, node.currentDevice);
            return {
                nodeType: "device",
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

            const outputMsg = {};
            outputMsg.payload = payload;
            outputMsg.device = payload;
            outputMsg.unifiNetwork = buildBaseMetadata(deviceType, deviceId, capabilityId, {
                source: source || "observe"
            });

            node.status({ fill: "green", shape: "dot", text: buildNodeStatus(deviceType, payload) });
            send(outputMsg);
        }

        async function invokeCapability(send) {
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
                    capability.mode === "fetch" ? "fetch" : "manual-refresh"
                );
                return;
            }

            const execution = composeCapabilityExecution(deviceType, capabilityId, capabilityConfig);
            const request = buildCapabilityRequest(deviceType, capabilityId, deviceId, execution.params, node.currentDevice);

            node.status({ fill: "blue", shape: "dot", text: `${capability.label}` });

            const response = await node.server.apiRequest({
                path: request.path,
                method: request.method,
                query: execution.query,
                headers: execution.headers,
                payload: execution.payload,
                timeout: node.timeout
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                node.status({ fill: "yellow", shape: "ring", text: `${response.statusCode}` });
                throw new Error(`UniFi Network request failed with status ${response.statusCode}`);
            }

            const responseData = extractNetworkData(response.payload);
            if (responseData && typeof responseData === "object" && !Array.isArray(responseData)) {
                node.currentDevice = responseData;
            }

            const outputMsg = {};
            outputMsg.payload = responseData;
            outputMsg.statusCode = response.statusCode;
            outputMsg.headers = response.headers;
            outputMsg.device = node.currentDevice;
            outputMsg.unifiNetwork = buildBaseMetadata(deviceType, deviceId, capabilityId, {
                source: "request",
                method: request.method,
                path: request.path,
                capabilityConfig
            });

            node.status({ fill: "green", shape: "dot", text: `${capability.label}` });
            send(outputMsg);
        }

        function shouldObserveConfiguredDevice() {
            return node.server && node.capability === "observe" && node.deviceType && node.deviceId;
        }

        function startObservation() {
            if (!shouldObserveConfiguredDevice() || node.isObserving) {
                return;
            }

            node.isObserving = true;

            // Emit an initial snapshot at startup so the flow has a known state
            // before any manual input arrives.
            fetchDeviceState(node.deviceType, node.deviceId, "observe", node.send.bind(node), "startup").catch(() => {
            });
        }

        node.on("input", async function(_msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };

            try {
                await invokeCapability(send);
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

        if (node.server && typeof node.server.addClient === "function") {
            node.server.addClient(node);
        }

        if (shouldObserveConfiguredDevice()) {
            startObservation();
        } else if (node.capability === "observe" && (!node.deviceType || !node.deviceId)) {
            node.status({ fill: "grey", shape: "ring", text: "set device" });
        } else {
            node.status({ fill: "grey", shape: "ring", text: "ready" });
        }

        node.on("close", function(done) {
            if (node.server && typeof node.server.removeClient === "function") {
                node.server.removeClient(node);
            }
            if (typeof done === "function") {
                done();
            }
        });
    }

    RED.nodes.registerType("unifi-network-device", UnifiNetworkDeviceNode);
};
