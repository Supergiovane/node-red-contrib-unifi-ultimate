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
    // Capability options are persisted as JSON in the editor, but runtime
    // messages may already provide a parsed object.
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

function requiresDeviceSpecificCapabilityValidation(deviceType, capabilityId) {
    // Some camera actions only make sense on specific hardware variants, so the
    // registry needs the live device payload before validating them.
    return String(deviceType || "").trim() === "camera" && [
        "startPtzPatrol",
        "stopPtzPatrol",
        "gotoPtzPreset",
        "setDoorbellMessage",
        "disableMicPermanently"
    ].includes(String(capabilityId || "").trim());
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
            // Protect nodes always expose a state-oriented output and an event
            // output, even when only one of them is used for a given update.
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
                // Observables let the node collapse complex Protect payloads into
                // a stable boolean while preserving the original context in RAW.
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

            // Merge editor configuration with runtime overrides so one node can
            // drive multiple devices when required by the flow.
            const deviceType = resolveDeviceType(node.deviceType, msg);
            const deviceId = resolveDeviceId(node.deviceId, msg);
            const capabilityId = resolveCapabilityId(node.capability, msg);
            const capabilityConfig = resolveCapabilityConfig(node.capabilityConfig, msg);
            let selectedDevice = node.currentDevice;
            if (!getDeviceTypeDefinition(deviceType)) {
                throw new Error(`Unsupported device type: ${deviceType || "(empty)"}`);
            }

            if (requiresDeviceSpecificCapabilityValidation(deviceType, capabilityId) && deviceId) {
                selectedDevice = await node.server.fetchDeviceByTypeAndId(deviceType, deviceId);
                if (selectedDevice && typeof selectedDevice === "object" && !Array.isArray(selectedDevice)) {
                    node.currentDevice = selectedDevice;
                }
            }

            const capability = getCapabilityDefinition(deviceType, capabilityId, selectedDevice);
            if (!capability) {
                throw new Error(`Unsupported capability '${capabilityId}' for device type '${deviceType}'.`);
            }

            if (capability.mode === "observe") {
                // Manual input on an observe node acts like a forced refresh.
                await fetchDeviceState(deviceType, deviceId, capabilityConfig, send, "manual-refresh");
                return;
            }

            const execution = composeCapabilityExecution(deviceType, capabilityId, capabilityConfig, msg, selectedDevice);
            const request = buildCapabilityRequest(deviceType, capabilityId, deviceId, execution.params, selectedDevice);

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

            // Re-register the node to make sure the active websocket fan-out on
            // the config node uses the latest node instance.
            if (node.server && typeof node.server.removeClient === "function") {
                node.server.removeClient(node);
            }
            if (node.server && typeof node.server.addClient === "function") {
                node.server.addClient(node);
            }
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
                if (typeof done === "function") {
                    done();
                }
            } catch (error) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                if (typeof done === "function") {
                    done(error);
                } else {
                    node.error(error, msg);
                }
            }
        });

        node.handleProtectDeviceUpdate = (update) => {
            try {
                const item = update && update.item;
                if (!item || !node.isObserving) {
                    return;
                }

                // Only react to device updates that match both the selected
                // model family and the exact configured device id.
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
                    // When the user selected an observable, events can update the
                    // boolean state output directly instead of only the event port.
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
            if (typeof done === "function") {
                done();
            }
        });
    }

    RED.nodes.registerType("unifi-protect-device", UnifiProtectDeviceNode);
};
