"use strict";

const { decodeScopedDeviceId } = require("./utils/unifi-network-device-registry");

function parsePositiveSeconds(value, fallbackValue) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return fallbackValue;
    }

    return Math.max(1, Math.trunc(numeric));
}

function parseNonNegativeSeconds(value, fallbackValue) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        return fallbackValue;
    }

    return Math.max(0, Math.trunc(numeric));
}

function resolveClientId(configuredClientId) {
    return String(configuredClientId || "").trim();
}

function resolveNodeName(value) {
    return String(value || "").trim();
}

function resolveDeviceName(value) {
    return String(value || "").trim();
}

function extractDeviceNameFromClient(client) {
    if (!client || typeof client !== "object" || Array.isArray(client)) {
        return "";
    }

    return resolveDeviceName(
        client.name
        || client.displayName
        || client.hostname
        || client.alias
        || client.full_name
        || client.macAddress
        || client.id
    );
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

module.exports = function(RED) {
    function UnifiNetworkPresenceNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.server = RED.nodes.getNode(config.server);
        node.clientId = config.clientId || "";
        node.pollIntervalSeconds = parsePositiveSeconds(config.pollInterval, 10);
        node.onlineHysteresisSeconds = parseNonNegativeSeconds(config.onlineHysteresis, 15);
        node.offlineHysteresisSeconds = parseNonNegativeSeconds(config.offlineHysteresis, 30);
        node.timeout = Number(config.timeout) > 0 ? Number(config.timeout) : 8000;
        node.deviceName = resolveDeviceName(config.deviceName);

        node.isObserving = false;
        node.currentPresence = null;
        node.lastConnectedAt = 0;
        node.firstOnlineDetectedAt = 0;
        node.firstOfflineDetectedAt = 0;
        node.lastKnownClient = null;

        function setNodeStatus(status) {
            if (!status || typeof status !== "object" || Array.isArray(status)) {
                return;
            }
            node.status({
                ...status,
                text: appendStatusTimestamp(status.text)
            });
        }

        function updateStatus() {
            // The status dot mirrors the debounced presence state rather than the
            // most recent poll result, so the editor reflects hysteresis too.
            if (node.currentPresence === true) {
                setNodeStatus({ fill: "green", shape: "dot", text: "present" });
                return;
            }

            if (node.currentPresence === false) {
                setNodeStatus({ fill: "grey", shape: "ring", text: "away" });
                return;
            }

            setNodeStatus({ fill: "blue", shape: "ring", text: "checking" });
        }

        function resolveOutputDeviceName(payload) {
            const extracted = extractDeviceNameFromClient(payload) || extractDeviceNameFromClient(node.lastKnownClient);
            if (extracted) {
                node.deviceName = extracted;
                return extracted;
            }

            return resolveDeviceName(node.deviceName);
        }

        function buildMetadata(clientId, source, extra) {
            // Include hysteresis settings in the emitted metadata so a flow can
            // inspect how the boolean presence value was produced.
            const scoped = decodeScopedDeviceId(clientId);
            const nodeName = resolveNodeName(node.name);
            const resolvedDeviceName = resolveOutputDeviceName(node.lastKnownClient);
            return {
                nodeType: "presence",
                name: nodeName || undefined,
                deviceName: resolvedDeviceName || undefined,
                clientId,
                siteId: scoped.siteId || undefined,
                resourceId: scoped.resourceId || undefined,
                source,
                pollIntervalSeconds: node.pollIntervalSeconds,
                onlineHysteresisSeconds: node.onlineHysteresisSeconds,
                offlineHysteresisSeconds: node.offlineHysteresisSeconds,
                ...(extra || {})
            };
        }

        function emitPresence(present, clientId, source, reason, raw) {
            // Emit a normalized boolean payload while still exposing the last
            // known UniFi client object for richer downstream logic.
            const nodeName = resolveNodeName(node.name);
            const resolvedDeviceName = resolveOutputDeviceName(node.lastKnownClient);
            const outputMsg = {
                payload: present,
                topic: nodeName,
                deviceName: resolvedDeviceName || undefined,
                eventName: String(reason || source || "").trim() || undefined,
                present
            };

            attachDetails(outputMsg, {
                client: node.lastKnownClient,
                unifiNetworkPresence: buildMetadata(clientId, source, {
                    reason
                })
            });

            if (raw !== undefined) {
                attachDetails(outputMsg, { raw });
            }

            try {
                node.send(outputMsg);
            } catch (error) {
                node.warn(`Presence output send failed: ${error && error.message ? error.message : error}`);
            }
        }

        function setPresent(clientId, source, raw) {
            node.firstOfflineDetectedAt = 0;
            node.firstOnlineDetectedAt = 0;
            node.lastConnectedAt = Date.now();

            if (node.currentPresence !== true) {
                node.currentPresence = true;
                emitPresence(true, clientId, source, "connected", raw);
            }

            updateStatus();
        }

        function setAway(clientId, source, raw, reason) {
            node.firstOnlineDetectedAt = 0;
            if (node.currentPresence !== false) {
                node.currentPresence = false;
                emitPresence(false, clientId, source, reason || "disconnected", raw);
            }

            updateStatus();
        }

        function applyOfflineHysteresis(clientId, source, raw, reason) {
            const now = Date.now();
            node.firstOnlineDetectedAt = 0;

            // A short Wi-Fi disconnect is common on roaming clients; wait for a
            // stable absence before flipping the output to false.
            if (node.currentPresence !== false && node.offlineHysteresisSeconds > 0) {
                if (!node.firstOfflineDetectedAt) {
                    node.firstOfflineDetectedAt = now;
                    setNodeStatus({ fill: "yellow", shape: "ring", text: `away in ${node.offlineHysteresisSeconds}s` });
                    return;
                }

                const elapsed = now - node.firstOfflineDetectedAt;
                const required = node.offlineHysteresisSeconds * 1000;
                if (elapsed < required) {
                    const remaining = Math.max(1, Math.ceil((required - elapsed) / 1000));
                    setNodeStatus({ fill: "yellow", shape: "ring", text: `away in ${remaining}s` });
                    return;
                }
            }

            setAway(clientId, source, raw, reason);
        }

        function applyOnlineHysteresis(clientId, source, raw) {
            const now = Date.now();
            node.firstOfflineDetectedAt = 0;

            // Symmetric hysteresis on reconnect avoids bouncing back to true
            // after a single transient positive poll.
            if (node.currentPresence !== true && node.onlineHysteresisSeconds > 0) {
                if (!node.firstOnlineDetectedAt) {
                    node.firstOnlineDetectedAt = now;
                    setNodeStatus({ fill: "yellow", shape: "ring", text: `back in ${node.onlineHysteresisSeconds}s` });
                    return;
                }

                const elapsed = now - node.firstOnlineDetectedAt;
                const required = node.onlineHysteresisSeconds * 1000;
                if (elapsed < required) {
                    const remaining = Math.max(1, Math.ceil((required - elapsed) / 1000));
                    setNodeStatus({ fill: "yellow", shape: "ring", text: `back in ${remaining}s` });
                    return;
                }
            }

            setPresent(clientId, source, raw);
        }

        function processPresenceSnapshot(snapshot) {
            const clientId = resolveClientId(node.clientId);
            if (!clientId) {
                setNodeStatus({ fill: "red", shape: "ring", text: "set client" });
                return;
            }

            const source = String(snapshot && snapshot.source || "poll");
            const connected = snapshot && snapshot.connected === true;
            const statusCode = Number(snapshot && snapshot.statusCode);
            const client = snapshot && snapshot.client && typeof snapshot.client === "object" && !Array.isArray(snapshot.client)
                ? snapshot.client
                : null;
            if (client) {
                node.lastKnownClient = client;
            }

            if (connected) {
                applyOnlineHysteresis(clientId, source, client);
                return;
            }

            if (statusCode === 404 || snapshot && snapshot.found === false) {
                applyOfflineHysteresis(clientId, source, {
                    statusCode: Number.isFinite(statusCode) ? statusCode : 404
                }, "not-connected");
                return;
            }

            setNodeStatus({ fill: "red", shape: "ring", text: "error" });
            const errorMessage = String(snapshot && (snapshot.error || snapshot.message) || "Presence polling failed");
            node.error(new Error(errorMessage));
        }

        async function requestPresenceSnapshot(source) {
            if (!node.server) {
                throw new Error("Unifi Network configuration is missing.");
            }

            const clientId = resolveClientId(node.clientId);
            if (!clientId) {
                throw new Error("Missing client id.");
            }

            if (typeof node.server.requestPresenceObservationNow !== "function") {
                throw new Error("Unifi Network config node is missing presence request helper.");
            }
            return node.server.requestPresenceObservationNow({
                clientId,
                timeout: node.timeout,
                source: source || "manual-input"
            });
        }

        function startObservation() {
            if (node.isObserving) {
                return;
            }
            node.isObserving = true;
            if (node.server && typeof node.server.refreshPresenceObservationScheduler === "function") {
                node.server.refreshPresenceObservationScheduler();
            }
        }

        function stopObservation() {
            node.isObserving = false;
            if (node.server && typeof node.server.refreshPresenceObservationScheduler === "function") {
                node.server.refreshPresenceObservationScheduler();
            }
        }

        node.on("input", async function(_msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };

            try {
                processPresenceSnapshot(await requestPresenceSnapshot("manual-input"));
                if (typeof done === "function") {
                    done();
                }
            } catch (error) {
                if (typeof done === "function") {
                    done(error);
                } else {
                    node.error(error);
                }
            }
        });

        node.getNetworkPresenceObservationDescriptor = () => {
            if (!node.isObserving) {
                return null;
            }
            const clientId = resolveClientId(node.clientId);
            if (!clientId) {
                return null;
            }
            return {
                clientId,
                pollIntervalSeconds: node.pollIntervalSeconds,
                timeout: node.timeout
            };
        };

        node.handleNetworkPresenceObservationUpdate = (event) => {
            try {
                if (!node.isObserving) {
                    return;
                }
                processPresenceSnapshot(event);
            } catch (error) {
            }
        };

        if (!node.server) {
            setNodeStatus({ fill: "red", shape: "ring", text: "no config" });
        } else if (!node.clientId) {
            setNodeStatus({ fill: "grey", shape: "ring", text: "set client" });
        } else {
            if (node.server && typeof node.server.addClient === "function") {
                node.server.addClient(node);
            }
            startObservation();
            updateStatus();
            requestPresenceSnapshot("startup").then((snapshot) => {
                processPresenceSnapshot(snapshot);
            }).catch((error) => {
                setNodeStatus({ fill: "red", shape: "ring", text: "error" });
                node.error(error);
            });
        }

        node.on("close", function(done) {
            try {
                stopObservation();
                if (node.server && typeof node.server.removeClient === "function") {
                    node.server.removeClient(node);
                }
            } catch (error) {
            } finally {
                if (typeof done === "function") {
                    done();
                }
            }
        });
    }

    RED.nodes.registerType("unifi-network-presence", UnifiNetworkPresenceNode);
};
