"use strict";

const { decodeScopedDeviceId } = require("./utils/unifi-network-device-registry");
const {
    buildStatusTimestampText,
    appendStatusTimestamp,
    resolveNodeName,
    resolveDeviceName,
    extractDeviceNameFromPayload,
    attachDetails,
    buildErrorOutputMessage,
    parseBoolean
} = require("./utils/common-utils");
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

function normalizeString(value) {
    return String(value || "").trim();
}

function parseConfirmPolls(value, fallbackValue) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 1) {
        return fallbackValue;
    }
    return Math.max(1, Math.trunc(numeric));
}

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

// "Network (join/leave)" mode. Polls the connected clients of a network and
// emits a message when one joins or leaves. A debounce (consecutive-poll
// confirmation) absorbs the transient flapping UniFi shows while it classifies
// a freshly connected client onto its network. Shares the same polling engine
// idea as the single-client presence mode above.
function setupNetworkClientWatch(node, config) {
    node.networkId = normalizeString(config.networkId);
    node.networkName = normalizeString(config.networkName);
    node.pollIntervalSeconds = parsePositiveSeconds(config.pollInterval, 30);
    node.emitInitial = parseBoolean(config.emitInitial);
    node.joinConfirmPolls = parseConfirmPolls(config.joinConfirmPolls, 1);
    node.leaveConfirmPolls = parseConfirmPolls(config.leaveConfirmPolls, 3);
    node.timeout = DEFAULT_REQUEST_TIMEOUT_MS;

    node.pollTimer = null;
    node.pollInProgress = false;
    node.confirmed = null;          // null until the first successful poll baseline.
    node.presentStreak = new Map(); // mac -> consecutive polls seen present (pending join).
    node.absentStreak = new Map();  // mac -> consecutive polls seen absent (pending leave).

    function setNodeStatus(status) {
        if (!status || typeof status !== "object" || Array.isArray(status)) {
            return;
        }
        node.status({
            ...status,
            text: appendStatusTimestamp(status.text)
        });
    }

    function resolveNetworkLabel() {
        return node.networkName || "network";
    }

    function emitClientEvent(eventName, client) {
        const nodeName = resolveNodeName(node.name);
        const deviceName = normalizeString(client && client.name) || normalizeString(client && client.mac) || "Client";
        const networkName = normalizeString(client && client.networkName) || node.networkName;

        const outputMsg = {
            topic: nodeName,
            eventName,
            deviceName,
            network: networkName || undefined,
            payload: {
                event: eventName,
                deviceName,
                mac: normalizeString(client && client.mac) || undefined,
                network: networkName || undefined,
                networkId: normalizeString(client && client.networkId) || node.networkId || undefined,
                isGuest: client && client.isGuest === true,
                isWired: client && client.isWired === true,
                ipAddress: normalizeString(client && client.ipAddress) || undefined
            }
        };
        attachDetails(outputMsg, { client });

        node.send([outputMsg, null]);
    }

    function diffAndEmit(currentClients) {
        const presentByMac = new Map();
        currentClients.forEach((client) => {
            const mac = normalizeString(client && client.mac).toLowerCase();
            if (mac) {
                presentByMac.set(mac, client);
            }
        });

        // First successful poll only establishes the baseline so existing
        // clients are not all reported as fresh joins (unless requested).
        if (node.confirmed === null) {
            node.confirmed = presentByMac;
            node.presentStreak.clear();
            node.absentStreak.clear();
            if (node.emitInitial) {
                presentByMac.forEach((client) => emitClientEvent("joined", client));
            }
            return;
        }

        // Candidate joins: present now. Confirm once seen for enough polls.
        presentByMac.forEach((client, mac) => {
            node.absentStreak.delete(mac);
            if (node.confirmed.has(mac)) {
                node.confirmed.set(mac, client); // keep latest client info
                return;
            }
            const streak = (node.presentStreak.get(mac) || 0) + 1;
            if (streak >= node.joinConfirmPolls) {
                node.presentStreak.delete(mac);
                node.confirmed.set(mac, client);
                emitClientEvent("joined", client);
            } else {
                node.presentStreak.set(mac, streak);
            }
        });

        // Candidate leaves: confirmed members now absent. Confirm after enough
        // consecutive absences so a transient drop does not fire a false leave.
        Array.from(node.confirmed.keys()).forEach((mac) => {
            if (presentByMac.has(mac)) {
                return;
            }
            const streak = (node.absentStreak.get(mac) || 0) + 1;
            if (streak >= node.leaveConfirmPolls) {
                const client = node.confirmed.get(mac);
                node.absentStreak.delete(mac);
                node.confirmed.delete(mac);
                emitClientEvent("left", client);
            } else {
                node.absentStreak.set(mac, streak);
            }
        });

        // Forget pending joins for clients that vanished before confirming.
        Array.from(node.presentStreak.keys()).forEach((mac) => {
            if (!presentByMac.has(mac)) {
                node.presentStreak.delete(mac);
            }
        });
    }

    async function poll() {
        if (node.pollInProgress) {
            return;
        }
        if (!node.server || typeof node.server.fetchActiveClientsOnNetwork !== "function") {
            throw new Error("Unifi Network configuration is missing or incompatible.");
        }
        if (!node.networkId) {
            throw new Error("No network selected. Open the node and choose a network.");
        }

        node.pollInProgress = true;
        try {
            // Pass the known network name so the config helper can skip its
            // per-poll networkconf lookup.
            const clients = await node.server.fetchActiveClientsOnNetwork(node.networkId, node.networkName);
            const list = Array.isArray(clients) ? clients : [];
            diffAndEmit(list);
            setNodeStatus({
                fill: "green",
                shape: "dot",
                text: `${list.length} on ${resolveNetworkLabel()}`
            });
        } finally {
            node.pollInProgress = false;
        }
    }

    function runPoll() {
        poll().catch((error) => {
            setNodeStatus({ fill: "red", shape: "ring", text: "error" });
            node.send([null, buildErrorOutputMessage(error, node.name)]);
            node.error(error);
        });
    }

    function stopPolling() {
        if (node.pollTimer) {
            clearInterval(node.pollTimer);
            node.pollTimer = null;
        }
    }

    function startPolling() {
        stopPolling();
        // Re-baseline on (re)deploy so existing members are not re-announced.
        node.confirmed = null;
        node.presentStreak.clear();
        node.absentStreak.clear();
        setNodeStatus({ fill: "blue", shape: "ring", text: `watching ${resolveNetworkLabel()}` });
        runPoll();
        node.pollTimer = setInterval(runPoll, node.pollIntervalSeconds * 1000);
    }

    node.on("input", function(_msg, send, done) {
        // A manual trigger forces an immediate poll between intervals.
        poll().then(() => {
            if (typeof done === "function") {
                done();
            }
        }).catch((error) => {
            setNodeStatus({ fill: "red", shape: "ring", text: "error" });
            node.send([null, buildErrorOutputMessage(error, node.name)]);
            if (typeof done === "function") {
                done(error);
            } else {
                node.error(error);
            }
        });
    });

    if (!node.server) {
        setNodeStatus({ fill: "red", shape: "ring", text: "no config" });
    } else if (!node.networkId) {
        setNodeStatus({ fill: "grey", shape: "ring", text: "select network" });
    } else {
        startPolling();
    }

    node.on("close", function(done) {
        try {
            stopPolling();
        } catch (error) {
        } finally {
            if (typeof done === "function") {
                done();
            }
        }
    });
}

module.exports = function(RED) {
    function UnifiNetworkPresenceNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.server = RED.nodes.getNode(config.server);
        // "Watch by" selects the mode. "presence" (default) tracks a single
        // client; "network" watches a network for clients joining/leaving.
        node.watchBy = normalizeString(config.watchBy) || "presence";
        if (node.watchBy === "network") {
            setupNetworkClientWatch(node, config);
            return;
        }

        node.clientId = config.clientId || "";
        node.pollIntervalSeconds = parsePositiveSeconds(config.pollInterval, 10);
        node.onlineHysteresisSeconds = parseNonNegativeSeconds(config.onlineHysteresis, 15);
        node.offlineHysteresisSeconds = parseNonNegativeSeconds(config.offlineHysteresis, 30);
        // Optional "resend" timer: when > 0 the last saved presence value is
        // re-emitted on this cadence even if it has not changed. 0 disables it.
        node.repeatIntervalSeconds = parseNonNegativeSeconds(config.repeatInterval, 0);
        node.timeout = DEFAULT_REQUEST_TIMEOUT_MS;
        node.deviceName = resolveDeviceName(config.deviceName);

        node.isObserving = false;
        node.repeatTimer = null;
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
            const extracted = extractDeviceNameFromPayload(payload) || extractDeviceNameFromPayload(node.lastKnownClient);
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
                repeatIntervalSeconds: node.repeatIntervalSeconds,
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
            const presenceError = new Error(errorMessage);
            node.send([null, buildErrorOutputMessage(presenceError, node.name)]);
            node.error(presenceError);
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

        function resendCurrentPresence() {
            // Re-emit the last debounced presence value without polling again.
            // Skip until a value has actually been determined at least once.
            if (node.currentPresence === null) {
                return;
            }
            const clientId = resolveClientId(node.clientId);
            if (!clientId) {
                return;
            }
            emitPresence(node.currentPresence, clientId, "repeat", "repeat");
        }

        function stopRepeatTimer() {
            if (node.repeatTimer) {
                clearInterval(node.repeatTimer);
                node.repeatTimer = null;
            }
        }

        function startRepeatTimer() {
            stopRepeatTimer();
            if (node.repeatIntervalSeconds > 0) {
                node.repeatTimer = setInterval(resendCurrentPresence, node.repeatIntervalSeconds * 1000);
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
                setNodeStatus({ fill: "red", shape: "ring", text: "error" });
                node.send([null, buildErrorOutputMessage(error, node.name)]);
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
            startRepeatTimer();
            updateStatus();
            requestPresenceSnapshot("startup").then((snapshot) => {
                processPresenceSnapshot(snapshot);
            }).catch((error) => {
                setNodeStatus({ fill: "red", shape: "ring", text: "error" });
                node.send([null, buildErrorOutputMessage(error, node.name)]);
                node.error(error);
            });
        }

        node.on("close", function(done) {
            try {
                stopRepeatTimer();
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
