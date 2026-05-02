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
        node.timeout = Number(config.timeout) > 0 ? Number(config.timeout) : 15000;
        node.currentDevice = null;
        node.isObserving = false;

        function sendOutputs(send, stateMsg, eventMsg) {
            // Keep the state and event channels explicit, mirroring the editor
            // labels and avoiding shape changes on the output array.
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

        async function fetchDeviceState(deviceType, deviceId, capabilityId, send, source) {
            const payload = await node.server.fetchDeviceByTypeAndId(deviceType, deviceId);
            node.currentDevice = payload;

            const stateMsg = {
                payload,
                device: payload,
                unifiAccess: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: source || "observe"
                })
            };

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
                    skippedMsg.device = node.currentDevice;
                    skippedMsg.unifiAccess = buildBaseMetadata(deviceType, deviceId, capabilityId, {
                        source: "request",
                        skipped: true,
                        safeCancel: true
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

            const stateMsg = {};
            stateMsg.payload = responseData;
            stateMsg.statusCode = response.statusCode;
            stateMsg.headers = response.headers;
            stateMsg.device = node.currentDevice;
            stateMsg.unifiAccess = buildBaseMetadata(deviceType, deviceId, capabilityId, {
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
                sendOutputs(node.send.bind(node), null, {
                    payload: eventPayload,
                    device: node.currentDevice,
                    RAW: eventPayload,
                    unifiAccess: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                        source: "events",
                        eventType: eventName
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
            if (typeof node.server.addClient === "function") {
                node.server.addClient(node);
            }
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

    RED.nodes.registerType("unifi-access-device", UnifiAccessDeviceNode);
};
