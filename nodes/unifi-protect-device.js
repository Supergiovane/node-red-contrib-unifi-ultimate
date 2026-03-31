"use strict";

const {
    getDeviceTypeDefinition,
    getCapabilityDefinition,
    buildCapabilityRequest,
    composeCapabilityExecution,
    resolveObservableState,
    resolveObservableEventValue
} = require("./utils/unifi-protect-device-registry");

function resolveDeviceType(configuredDeviceType, msg) {
    return String(msg.deviceType || configuredDeviceType || "").trim();
}

function resolveDeviceId(configuredDeviceId, msg) {
    return String(msg.deviceId || msg.resourceId || configuredDeviceId || "").trim();
}

function resolveCapabilityId(configuredCapabilityId, msg) {
    return String(msg.capability || configuredCapabilityId || "observe").trim();
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

function resolveCapabilityConfig(configuredCapabilityConfig, msg) {
    if (msg && msg.capabilityConfig && typeof msg.capabilityConfig === "object" && !Array.isArray(msg.capabilityConfig)) {
        return msg.capabilityConfig;
    }

    return parseCapabilityConfig(configuredCapabilityConfig);
}

function buildNodeStatus(deviceType, payload) {
    const label = payload && payload.name ? payload.name : deviceType;
    const state = payload && payload.state ? payload.state : "ready";
    return `${label} ${state}`;
}

module.exports = function(RED) {
    function UnifiProtectDeviceNode(config) {
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
        node.currentObservableValue = false;
        node.isObserving = false;

        function sendOutputs(send, stateMsg, eventMsg) {
            send([stateMsg || null, eventMsg || null]);
        }

        function buildBaseMetadata(deviceType, deviceId, capabilityId, extra) {
            return {
                nodeType: "device",
                deviceType,
                deviceId,
                capability: capabilityId,
                ...(extra || {})
            };
        }

        function buildObservedStateMessage(deviceType, deviceId, capabilityConfig, payload, source, extra) {
            const observable = String(capabilityConfig.observable || "").trim();
            if (observable) {
                const observableValue = resolveObservableState(deviceType, payload, observable, node.currentObservableValue);
                node.currentObservableValue = Boolean(observableValue);

                return {
                    payload: node.currentObservableValue,
                    RAW: {
                        device: payload,
                        observable,
                        source: source || "observe",
                        ...(extra || {})
                    },
                    device: payload,
                    unifiProtect: buildBaseMetadata(deviceType, deviceId, "observe", {
                        source: source || "observe",
                        observable,
                        ...(extra || {})
                    })
                };
            }

            return {
                payload,
                device: payload,
                unifiProtect: buildBaseMetadata(deviceType, deviceId, "observe", { source: source || "observe", ...(extra || {}) })
            };
        }

        async function fetchDeviceState(deviceType, deviceId, capabilityConfig, send, source) {
            const payload = await node.server.fetchDeviceByTypeAndId(deviceType, deviceId);
            node.currentDevice = payload;

            const stateMsg = buildObservedStateMessage(deviceType, deviceId, capabilityConfig, payload, source);

            node.status({ fill: "green", shape: "dot", text: buildNodeStatus(deviceType, payload) });
            sendOutputs(send, stateMsg, null);
        }

        async function invokeCapability(msg, send) {
            if (!node.server) {
                throw new Error("Unifi Protect configuration is missing.");
            }

            const deviceType = resolveDeviceType(node.deviceType, msg);
            const deviceId = resolveDeviceId(node.deviceId, msg);
            const capabilityId = resolveCapabilityId(node.capability, msg);
            const capabilityConfig = resolveCapabilityConfig(node.capabilityConfig, msg);
            if (!getDeviceTypeDefinition(deviceType)) {
                throw new Error(`Unsupported device type: ${deviceType || "(empty)"}`);
            }

            const capability = getCapabilityDefinition(deviceType, capabilityId);
            if (!capability) {
                throw new Error(`Unsupported capability '${capabilityId}' for device type '${deviceType}'.`);
            }

            if (capability.mode === "observe") {
                await fetchDeviceState(deviceType, deviceId, capabilityConfig, send, "manual-refresh");
                return;
            }

            const execution = composeCapabilityExecution(deviceType, capabilityId, capabilityConfig, msg);
            const request = buildCapabilityRequest(deviceType, capabilityId, deviceId, execution.params);

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
                throw new Error(`UniFi Protect request failed with status ${response.statusCode}`);
            }

            if (response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)) {
                node.currentDevice = response.payload;
            }

            const stateMsg = RED.util.cloneMessage(msg);
            stateMsg.payload = response.payload;
            stateMsg.statusCode = response.statusCode;
            stateMsg.headers = response.headers;
            stateMsg.device = node.currentDevice;
            stateMsg.unifiProtect = buildBaseMetadata(deviceType, deviceId, capabilityId, {
                source: "request",
                method: request.method,
                path: request.path,
                capabilityConfig
            });

            node.status({ fill: "green", shape: "dot", text: `${capability.label}` });
            sendOutputs(send, stateMsg, null);
        }

        function shouldObserveConfiguredDevice() {
            return node.server && node.capability === "observe" && node.deviceType && node.deviceId;
        }

        function startObservation() {
            if (!shouldObserveConfiguredDevice() || node.isObserving) {
                return;
            }

            node.server.removeClient(node);
            node.server.addClient(node);
            node.isObserving = true;

            fetchDeviceState(node.deviceType, node.deviceId, parseCapabilityConfig(node.capabilityConfig), node.send.bind(node), "startup").catch(() => {
            });
        }

        node.on("input", async function(msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };

            try {
                await invokeCapability(msg, send);
                done();
            } catch (error) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done(error);
            }
        });

        node.handleProtectDeviceUpdate = (update) => {
            try {
                const item = update && update.item;
                if (!item || !node.isObserving) {
                    return;
                }

                const deviceDefinition = getDeviceTypeDefinition(node.deviceType);
                if (!deviceDefinition || item.modelKey !== deviceDefinition.modelKey || item.id !== node.deviceId) {
                    return;
                }

                node.currentDevice = item;
                const capabilityConfig = parseCapabilityConfig(node.capabilityConfig);
                node.status({ fill: "green", shape: "dot", text: buildNodeStatus(node.deviceType, item) });
                sendOutputs(node.send.bind(node), buildObservedStateMessage(
                    node.deviceType,
                    node.deviceId,
                    capabilityConfig,
                    item,
                    "devices",
                    { updateType: update.type || "" }
                ), null);
            } catch (error) {
            }
        };

        node.handleProtectEventUpdate = (update) => {
            try {
                const item = update && update.item;
                if (!item || item.modelKey !== "event" || !node.isObserving || item.device !== node.deviceId) {
                    return;
                }

                const capabilityConfig = parseCapabilityConfig(node.capabilityConfig);
                const observable = String(capabilityConfig.observable || "").trim();
                if (observable) {
                    const observation = resolveObservableEventValue(node.deviceType, item, observable);
                    if (observation.matched) {
                        node.currentObservableValue = Boolean(observation.value);
                        node.status({ fill: "blue", shape: "ring", text: `${item.type || "event"}` });
                        sendOutputs(node.send.bind(node), {
                            payload: node.currentObservableValue,
                            RAW: {
                                device: node.currentDevice,
                                event: item,
                                observable,
                                source: "events"
                            },
                            device: node.currentDevice,
                            unifiProtect: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                                source: "events",
                                observable,
                                eventType: item.type || "",
                                updateType: update.type || ""
                            })
                        }, null);
                        return;
                    }
                }

                node.status({ fill: "blue", shape: "ring", text: `${item.type || "event"}` });
                sendOutputs(node.send.bind(node), null, {
                    payload: {
                        device: node.currentDevice,
                        event: item
                    },
                    device: node.currentDevice,
                    unifiProtect: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                        source: "events",
                        eventType: item.type || "",
                        updateType: update.type || ""
                    })
                });
            } catch (error) {
            }
        };

        if (!node.server) {
            node.status({ fill: "red", shape: "ring", text: "config missing" });
        } else if (node.capability === "observe" && (!node.deviceType || !node.deviceId)) {
            node.status({ fill: "yellow", shape: "ring", text: "select device" });
        } else {
            startObservation();
        }

        node.on("close", function(done) {
            if (node.server && typeof node.server.removeClient === "function") {
                node.server.removeClient(node);
            }
            node.isObserving = false;
            done();
        });
    }

    RED.nodes.registerType("unifi-protect-device", UnifiProtectDeviceNode);
};
