"use strict";

const {
    appendStatusTimestamp,
    resolveNodeName,
    attachDetails,
    buildErrorOutputMessage,
    parseBoolean
} = require("./utils/common-utils");

const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

function parsePositiveSeconds(value, fallbackValue) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return fallbackValue;
    }
    return Math.max(1, Math.trunc(numeric));
}

function normalizeString(value) {
    return String(value || "").trim();
}

module.exports = function(RED) {
    function UnifiNetworkClientWatcherNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.server = RED.nodes.getNode(config.server);
        // "Watch by" selects what the node tracks. Only "network" exists today;
        // the field keeps the door open for future watch criteria.
        node.watchBy = normalizeString(config.watchBy) || "network";
        node.networkId = normalizeString(config.networkId);
        node.networkName = normalizeString(config.networkName);
        node.pollIntervalSeconds = parsePositiveSeconds(config.pollInterval, 30);
        node.emitInitial = parseBoolean(config.emitInitial);
        node.timeout = DEFAULT_REQUEST_TIMEOUT_MS;

        node.pollTimer = null;
        node.pollInProgress = false;
        node.knownByMac = null; // null until the first successful poll baseline.

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
            const currentByMac = new Map();
            currentClients.forEach((client) => {
                const mac = normalizeString(client && client.mac).toLowerCase();
                if (mac) {
                    currentByMac.set(mac, client);
                }
            });

            // First successful poll only establishes the baseline so existing
            // clients are not all reported as fresh joins (unless requested).
            if (node.knownByMac === null) {
                node.knownByMac = currentByMac;
                if (node.emitInitial) {
                    currentByMac.forEach((client) => emitClientEvent("joined", client));
                }
                return;
            }

            currentByMac.forEach((client, mac) => {
                if (!node.knownByMac.has(mac)) {
                    emitClientEvent("joined", client);
                }
            });
            node.knownByMac.forEach((client, mac) => {
                if (!currentByMac.has(mac)) {
                    emitClientEvent("left", client);
                }
            });

            node.knownByMac = currentByMac;
        }

        async function poll(reason) {
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
                const clients = await node.server.fetchActiveClientsOnNetwork(node.networkId);
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

        function runPoll(reason) {
            poll(reason).catch((error) => {
                setNodeStatus({ fill: "red", shape: "ring", text: "error" });
                node.send([null, buildErrorOutputMessage(error, node.name)]);
                node.error(error);
            });
        }

        function startPolling() {
            stopPolling();
            setNodeStatus({ fill: "blue", shape: "ring", text: `watching ${resolveNetworkLabel()}` });
            runPoll("startup");
            node.pollTimer = setInterval(() => runPoll("interval"), node.pollIntervalSeconds * 1000);
        }

        function stopPolling() {
            if (node.pollTimer) {
                clearInterval(node.pollTimer);
                node.pollTimer = null;
            }
        }

        node.on("input", function(_msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };
            // A manual trigger forces an immediate poll between intervals.
            poll("manual-input").then(() => {
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

    RED.nodes.registerType("unifi-network-client-watcher", UnifiNetworkClientWatcherNode);
};
