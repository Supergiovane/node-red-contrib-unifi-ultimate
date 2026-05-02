"use strict";

const {
    buildCapabilityRequest,
    composeCapabilityExecution,
    getCapabilityDefinition,
    getDeviceTypeDefinition,
    matchesEvent
} = require("./utils/unifi-access-device-registry");
const { extractAccessData } = require("./utils/unifi-access-utils");

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

    if (normalizedType === "door") {
        const label = item.name || item.full_name || "door";
        const stateParts = [item.door_lock_relay_status, item.door_position_status].filter(Boolean);
        return stateParts.length > 0 ? `${label} ${stateParts.join("/")}` : label;
    }

    return item.alias || item.name || item.type || normalizedType || "ready";
}

function requiresDeviceSpecificCapabilityValidation(deviceType, capabilityId) {
    // Doorbell capabilities depend on the exact device subtype, so the live
    // payload is needed before the registry can validate them.
    return String(deviceType || "").trim() === "device" && ["triggerDoorbell", "cancelDoorbell"].includes(String(capabilityId || "").trim());
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

module.exports = function(RED) {
    function UnifiAccessDeviceNode(config) {
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
            // Access now emits on a single output pin. When both state and
            // event messages are available, forward them in sequence.
            try {
                if (stateMsg) {
                    send(stateMsg);
                }
                if (eventMsg) {
                    send(eventMsg);
                }
            } catch (error) {
                node.warn(`Access output send failed: ${error && error.message ? error.message : error}`);
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

        async function fetchDeviceState(deviceType, deviceId, capabilityId, send, source) {
            const payload = await node.server.fetchDeviceByTypeAndId(deviceType, deviceId);
            node.currentDevice = payload;

            const stateMsg = {
                payload
            };
            decorateOutputMessage(stateMsg, payload, source || "observe");
            attachDetails(stateMsg, {
                device: payload,
                unifiAccess: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: source || "observe"
                })
            });

            node.status({ fill: "green", shape: "dot", text: buildNodeStatus(deviceType, payload) });
            sendOutputs(send, stateMsg, null);
        }

        async function invokeCapability(send) {
            if (!node.server) {
                throw new Error("Unifi Access configuration is missing.");
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

            if (capabilityId === "cancelDoorbell") {
                const hasTrackedDoorbell = () => {
                    const hasByDevice = deviceId && typeof node.server.hasActiveDoorbell === "function"
                        ? node.server.hasActiveDoorbell(deviceId)
                        : false;
                    const hasByAny = typeof node.server.hasAnyActiveDoorbell === "function"
                        ? node.server.hasAnyActiveDoorbell()
                        : true;
                    // When the node is bound to one explicit device, only
                    // trust per-device tracking. Global fallback can cause
                    // false positives that re-enable the cancel toggle bug.
                    return deviceId ? hasByDevice : hasByAny;
                };

                // Prevent toggling: on some device types the cancel endpoint
                // acts as a trigger when called with no active ring.
                let hasActiveDoorbell = hasTrackedDoorbell();

                if (!hasActiveDoorbell && typeof node.server.refreshDoorbellState === "function") {
                    // Some Access devices do not emit the expected doorbell
                    // websocket event family. Refresh from system logs once
                    // before deciding that no active ring is present.
                    await node.server.refreshDoorbellState({ lookbackSeconds: 45 });
                    hasActiveDoorbell = hasTrackedDoorbell();
                }

                if (!hasActiveDoorbell) {
                    const skippedMsg = {};
                    skippedMsg.payload = {
                        skipped: true,
                        reason: "No active doorbell ring is currently tracked by the UniFi Access configuration node."
                    };
                    decorateOutputMessage(skippedMsg, node.currentDevice, "request:cancelDoorbell:skipped");
                    attachDetails(skippedMsg, {
                        device: node.currentDevice,
                        unifiAccess: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                            source: "request",
                            skipped: true,
                            safeCancel: true
                        })
                    });

                    node.status({ fill: "yellow", shape: "ring", text: "no ring" });
                    sendOutputs(send, skippedMsg, null);
                    return;
                }
            }

            if (capability.mode === "observe" || capability.mode === "fetch") {
                // Read-only capabilities reuse the same fetch path and only
                // differ in the source metadata attached to the output.
                await fetchDeviceState(
                    deviceType,
                    deviceId,
                    capabilityId,
                    send,
                    capability.mode === "fetch" ? "fetch" : "manual-refresh"
                );
                return;
            }

            const execution = composeCapabilityExecution(deviceType, capabilityId, capabilityConfig, selectedDevice);
            const request = buildCapabilityRequest(deviceType, capabilityId, deviceId, selectedDevice);

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
                throw new Error(`UniFi Access request failed with status ${response.statusCode}`);
            }

            const responseData = extractAccessData(response.payload);
            if (responseData && typeof responseData === "object" && !Array.isArray(responseData)) {
                node.currentDevice = responseData;
            }

            if (capabilityId === "triggerDoorbell" && typeof node.server.markDoorbellTriggered === "function") {
                // Track the ring on the shared config node so a later cancel
                // request can be validated safely.
                node.server.markDoorbellTriggered(deviceId, {
                    requestId: String(
                        responseData && typeof responseData === "object"
                            ? (responseData.request_id || responseData.remote_call_request_id || "")
                            : ""
                    ).trim(),
                    capabilityConfig
                });
            }

            if (capabilityId === "cancelDoorbell" && typeof node.server.markDoorbellCanceled === "function") {
                node.server.markDoorbellCanceled(deviceId);
            }

            const stateMsg = {
                payload: responseData
            };
            decorateOutputMessage(stateMsg, responseData, `request:${capabilityId}`);
            attachDetails(stateMsg, {
                response: {
                    statusCode: response.statusCode,
                    headers: response.headers,
                    method: request.method,
                    path: request.path
                },
                capabilityConfig,
                device: node.currentDevice,
                unifiAccess: buildBaseMetadata(deviceType, deviceId, capabilityId, {
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

            node.isObserving = true;

            // Emit one initial snapshot so the flow starts with a known state
            // before websocket events arrive.
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

        node.handleAccessEventUpdate = (eventPayload) => {
            try {
                // Event matching is delegated to the registry because Access
                // events differ across doors, hubs, intercoms and devices.
                if (!node.isObserving || !matchesEvent(node.deviceType, node.deviceId, node.currentDevice, eventPayload)) {
                    return;
                }
                const eventName = String(eventPayload.event || "").trim();

                node.status({ fill: "blue", shape: "ring", text: eventName || "event" });
                const resolvedDeviceName = resolveOutputDeviceName(node.currentDevice);
                const eventMsg = {
                    payload: attachDeviceNameToPayload(eventPayload, resolvedDeviceName),
                    topic: resolveNodeName(node.name),
                    deviceName: resolvedDeviceName || undefined,
                    eventName: eventName || "event"
                };
                attachDetails(eventMsg, {
                    raw: eventPayload,
                    device: node.currentDevice,
                    unifiAccess: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                        source: "events",
                        eventType: eventName
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
            if (typeof node.server.addClient === "function") {
                node.server.addClient(node);
            }
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

    RED.nodes.registerType("unifi-access-device", UnifiAccessDeviceNode);
};
