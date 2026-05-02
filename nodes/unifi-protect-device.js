"use strict";

const {
    getDeviceTypeDefinition,
    getCapabilityDefinition,
    buildCapabilityRequest,
    composeCapabilityExecution,
    resolveObservableState,
    resolveObservableEventValue
} = require("./utils/unifi-protect-device-registry");

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
        || payload.alias
        || payload.full_name
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
    if (!details || typeof details !== "object" || Array.isArray(details)) {
        return;
    }

    const currentDetails = outputMsg.details && typeof outputMsg.details === "object" && !Array.isArray(outputMsg.details)
        ? outputMsg.details
        : {};

    outputMsg.details = {
        ...currentDetails,
        ...details
    };
}

function resolveConfiguredObservable(capabilityConfig) {
    const observable = String(
        capabilityConfig && capabilityConfig.observable !== undefined
            ? capabilityConfig.observable
            : ""
    ).trim().toLowerCase();
    return observable === "all" ? "" : observable;
}

function resolveConfiguredObservableScope(capabilityConfig) {
    return String(
        capabilityConfig && capabilityConfig.observableScopeId !== undefined
            ? capabilityConfig.observableScopeId
            : ""
    ).trim();
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
        node.deviceName = resolveDeviceName(config.deviceName);
        node.timeout = Number(config.timeout) > 0 ? Number(config.timeout) : 15000;
        node.currentDevice = null;
        node.currentObservableValue = false;
        node.isObserving = false;

        function resolveOutputDeviceName(payload) {
            const extracted = extractDeviceNameFromPayload(payload);
            if (extracted) {
                node.deviceName = extracted;
                return extracted;
            }

            return resolveDeviceName(node.deviceName) || extractDeviceNameFromPayload(node.currentDevice);
        }

        function decorateOutputMessage(outputMsg, payload, eventName) {
            const nodeName = resolveNodeName(node.name);
            const resolvedDeviceName = resolveOutputDeviceName(payload);
            outputMsg.topic = nodeName;
            outputMsg.deviceName = resolvedDeviceName || undefined;
            outputMsg.eventName = String(eventName || "").trim() || undefined;
            outputMsg.payload = attachDeviceNameToPayload(outputMsg.payload, resolvedDeviceName);
        }

        function sendOutputs(send, stateMsg, eventMsg) {
            // Protect now emits on a single output pin. When both state and
            // event messages are available, forward them in sequence.
            try {
                if (stateMsg) {
                    send(stateMsg);
                }
                if (eventMsg) {
                    send(eventMsg);
                }
            } catch (error) {
                node.warn(`Protect output send failed: ${error && error.message ? error.message : error}`);
            }
        }

        function buildBaseMetadata(deviceType, deviceId, capabilityId, extra) {
            const nodeName = resolveNodeName(node.name);
            const resolvedDeviceName = resolveOutputDeviceName(node.currentDevice);
            return {
                nodeType: "device",
                name: nodeName || undefined,
                deviceName: resolvedDeviceName || undefined,
                deviceType,
                deviceId,
                capability: capabilityId,
                ...(extra || {})
            };
        }

        function buildObservedStateMessage(deviceType, deviceId, capabilityConfig, payload, source, extra, eventName) {
            const resolvedDeviceName = resolveOutputDeviceName(payload);
            const observable = resolveConfiguredObservable(capabilityConfig);
            if (observable) {
                // Observables let the node collapse complex Protect payloads into
                // a stable boolean while preserving the original context in details.raw.
                const observableValue = resolveObservableState(deviceType, payload, observable, node.currentObservableValue);
                node.currentObservableValue = Boolean(observableValue);

                const outputMsg = {
                    payload: node.currentObservableValue,
                    topic: resolveNodeName(node.name),
                    deviceName: resolvedDeviceName || undefined,
                    eventName: String(eventName || source || "observe").trim() || undefined
                };
                attachDetails(outputMsg, {
                    raw: {
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
                });
                return outputMsg;
            }

            const outputMsg = {
                payload: attachDeviceNameToPayload(payload, resolvedDeviceName),
                topic: resolveNodeName(node.name),
                deviceName: resolvedDeviceName || undefined,
                eventName: String(eventName || source || "observe").trim() || undefined
            };
            attachDetails(outputMsg, {
                device: payload,
                unifiProtect: buildBaseMetadata(deviceType, deviceId, "observe", { source: source || "observe", ...(extra || {}) })
            });
            return outputMsg;
        }

        async function fetchDeviceState(deviceType, deviceId, capabilityConfig, send, source) {
            const payload = await node.server.fetchDeviceByTypeAndId(deviceType, deviceId);
            node.currentDevice = payload;

            const stateMsg = buildObservedStateMessage(deviceType, deviceId, capabilityConfig, payload, source);

            node.status({ fill: "green", shape: "dot", text: buildNodeStatus(deviceType, payload) });
            sendOutputs(send, stateMsg, null);
        }

        async function invokeCapability(send) {
            if (!node.server) {
                throw new Error("Unifi Protect configuration is missing.");
            }

            // The incoming message is only a trigger. The node always uses the
            // device, capability and options configured in the editor.
            const deviceType = resolveDeviceType(node.deviceType);
            const deviceId = resolveDeviceId(node.deviceId);
            const capabilityId = resolveCapabilityId(node.capability);
            const capabilityConfig = resolveCapabilityConfig(node.capabilityConfig);
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

            const execution = composeCapabilityExecution(deviceType, capabilityId, capabilityConfig, selectedDevice);
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

            const stateMsg = {
                payload: response.payload
            };
            decorateOutputMessage(stateMsg, response.payload, `request:${capabilityId}`);
            attachDetails(stateMsg, {
                response: {
                    statusCode: response.statusCode,
                    headers: response.headers,
                    method: request.method,
                    path: request.path
                },
                capabilityConfig,
                device: node.currentDevice,
                unifiProtect: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: "request",
                    method: request.method,
                    path: request.path,
                    capabilityConfig
                })
            });

            node.status({ fill: "green", shape: "dot", text: `${capability.label}` });
            sendOutputs(send, stateMsg, null);
        }

        function resolveConfiguredCapabilityDefinition() {
            const deviceType = resolveDeviceType(node.deviceType);
            const capabilityId = resolveCapabilityId(node.capability);
            return getCapabilityDefinition(deviceType, capabilityId, node.currentDevice);
        }

        function configuredCapabilityOpensEventStream() {
            const capability = resolveConfiguredCapabilityDefinition();
            if (capability) {
                return capability.opensEventStream === true;
            }
            return resolveCapabilityId(node.capability) === "observe";
        }

        function shouldObserveConfiguredDevice() {
            return node.server && configuredCapabilityOpensEventStream() && node.deviceType && node.deviceId;
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
                    { updateType: update.type || "" },
                    update.type || "devices"
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
                const observable = resolveConfiguredObservable(capabilityConfig);
                const observableScopeId = resolveConfiguredObservableScope(capabilityConfig);
                if (observable) {
                    // When the user selected an observable, events can update the
                    // boolean state output directly instead of only the event port.
                    const observation = resolveObservableEventValue(node.deviceType, item, observable, observableScopeId);
                    if (observation.matched) {
                        const resolvedDeviceName = resolveOutputDeviceName(node.currentDevice);
                        node.currentObservableValue = Boolean(observation.value);
                        node.status({ fill: "blue", shape: "ring", text: `${item.type || "event"}` });
                        const stateMsg = {
                            payload: node.currentObservableValue,
                            topic: resolveNodeName(node.name),
                            deviceName: resolvedDeviceName || undefined,
                            eventName: String(item.type || "event").trim()
                        };
                        attachDetails(stateMsg, {
                            raw: {
                                device: node.currentDevice,
                                event: item,
                                observable,
                                observableScopeId: observableScopeId || undefined,
                                source: "events"
                            },
                            device: node.currentDevice,
                            unifiProtect: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                                source: "events",
                                observable,
                                observableScopeId: observableScopeId || undefined,
                                eventType: item.type || "",
                                updateType: update.type || ""
                            })
                        });
                        const eventMsg = {
                            payload: attachDeviceNameToPayload({
                                device: node.currentDevice,
                                event: item
                            }, resolvedDeviceName),
                            topic: resolveNodeName(node.name),
                            deviceName: resolvedDeviceName || undefined,
                            eventName: String(item.type || "event").trim()
                        };
                        attachDetails(eventMsg, {
                            raw: item,
                            device: node.currentDevice,
                            unifiProtect: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                                source: "events",
                                observable,
                                observableScopeId: observableScopeId || undefined,
                                eventType: item.type || "",
                                updateType: update.type || ""
                            })
                        });
                        sendOutputs(node.send.bind(node), stateMsg, eventMsg);
                        return;
                    }

                    if (observation.eventTypeMatched) {
                        return;
                    }
                }

                node.status({ fill: "blue", shape: "ring", text: `${item.type || "event"}` });
                const resolvedDeviceName = resolveOutputDeviceName(node.currentDevice);
                const eventMsg = {
                    payload: attachDeviceNameToPayload({
                        device: node.currentDevice,
                        event: item
                    }, resolvedDeviceName),
                    topic: resolveNodeName(node.name),
                    deviceName: resolvedDeviceName || undefined,
                    eventName: String(item.type || "event").trim()
                };
                attachDetails(eventMsg, {
                    raw: item,
                    device: node.currentDevice,
                    unifiProtect: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                        source: "events",
                        eventType: item.type || "",
                        updateType: update.type || ""
                    })
                });
                sendOutputs(node.send.bind(node), null, eventMsg);
            } catch (error) {
            }
        };

        if (!node.server) {
            node.status({ fill: "red", shape: "ring", text: "config missing" });
        } else if (configuredCapabilityOpensEventStream() && (!node.deviceType || !node.deviceId)) {
            node.status({ fill: "yellow", shape: "ring", text: "select device" });
        } else {
            startObservation();
        }

        node.on("close", function(done) {
            try {
                if (node.server && typeof node.server.removeClient === "function") {
                    node.server.removeClient(node);
                }
                node.isObserving = false;
            } catch (error) {
            } finally {
                if (typeof done === "function") {
                    done();
                }
            }
        });
    }

    RED.nodes.registerType("unifi-protect-device", UnifiProtectDeviceNode);
};
