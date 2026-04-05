"use strict";

const { decodeScopedDeviceId } = require("./utils/unifi-network-device-registry");
const { extractNetworkData } = require("./utils/unifi-network-utils");

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

function resolveClientId(configuredClientId, msg) {
    // Accept both explicit clientId and the generic device/site/resource
    // overrides used by the other Network nodes.
    if (msg && (msg.clientId || msg.deviceId || msg.resourceId || msg.siteId)) {
        const direct = String(msg.clientId || msg.deviceId || "").trim();
        if (direct) {
            return direct;
        }

        const siteId = String(msg.siteId || "").trim();
        const resourceId = String(msg.resourceId || "").trim();
        if (siteId && resourceId) {
            return `${siteId}::${resourceId}`;
        }
    }

    return String(configuredClientId || "").trim();
}

function parseStatusCodeFromError(error) {
    const message = String(error && error.message || "");
    const match = message.match(/\((\d{3})\)\s*$/);
    if (!match) {
        return 0;
    }

    return Number(match[1]);
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

        node.pollTimer = null;
        node.pollInFlight = false;
        node.currentPresence = null;
        node.lastConnectedAt = 0;
        node.firstOnlineDetectedAt = 0;
        node.firstOfflineDetectedAt = 0;
        node.lastKnownClient = null;

        function updateStatus() {
            // The status dot mirrors the debounced presence state rather than the
            // most recent poll result, so the editor reflects hysteresis too.
            if (node.currentPresence === true) {
                node.status({ fill: "green", shape: "dot", text: "present" });
                return;
            }

            if (node.currentPresence === false) {
                node.status({ fill: "grey", shape: "ring", text: "away" });
                return;
            }

            node.status({ fill: "blue", shape: "ring", text: "checking" });
        }

        function buildMetadata(clientId, source, extra) {
            // Include hysteresis settings in the emitted metadata so a flow can
            // inspect how the boolean presence value was produced.
            const scoped = decodeScopedDeviceId(clientId);
            return {
                nodeType: "presence",
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
            const msg = {
                payload: present,
                present,
                client: node.lastKnownClient,
                unifiNetworkPresence: buildMetadata(clientId, source, {
                    reason
                })
            };

            if (raw !== undefined) {
                msg.raw = raw;
            }

            node.send(msg);
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
                    node.status({ fill: "yellow", shape: "ring", text: `away in ${node.offlineHysteresisSeconds}s` });
                    return;
                }

                const elapsed = now - node.firstOfflineDetectedAt;
                const required = node.offlineHysteresisSeconds * 1000;
                if (elapsed < required) {
                    const remaining = Math.max(1, Math.ceil((required - elapsed) / 1000));
                    node.status({ fill: "yellow", shape: "ring", text: `away in ${remaining}s` });
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
                    node.status({ fill: "yellow", shape: "ring", text: `back in ${node.onlineHysteresisSeconds}s` });
                    return;
                }

                const elapsed = now - node.firstOnlineDetectedAt;
                const required = node.onlineHysteresisSeconds * 1000;
                if (elapsed < required) {
                    const remaining = Math.max(1, Math.ceil((required - elapsed) / 1000));
                    node.status({ fill: "yellow", shape: "ring", text: `back in ${remaining}s` });
                    return;
                }
            }

            setPresent(clientId, source, raw);
        }

        async function checkPresence(source, inputMsg) {
            if (!node.server) {
                throw new Error("Unifi Network configuration is missing.");
            }

            // Manual input can override the configured client, which makes the
            // node reusable in advanced flows if needed.
            const clientId = resolveClientId(node.clientId, inputMsg || {});
            if (!clientId) {
                node.status({ fill: "red", shape: "ring", text: "set client" });
                return;
            }

            try {
                const scoped = decodeScopedDeviceId(clientId);
                if (!scoped.siteId || !scoped.resourceId) {
                    throw new Error("Client selection is invalid. Re-select the client from the editor.");
                }

                const response = await node.server.apiRequest({
                    path: `/v1/sites/${encodeURIComponent(scoped.siteId)}/clients/${encodeURIComponent(scoped.resourceId)}`,
                    method: "GET",
                    timeout: node.timeout
                });

                // The official "connected client details" endpoint returns 404
                // when the client is no longer connected.
                if (response.statusCode === 404) {
                    applyOfflineHysteresis(clientId, source, { statusCode: 404 }, "not-connected");
                    return;
                }

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    throw new Error(`Client lookup failed (${response.statusCode})`);
                }

                const client = extractNetworkData(response.payload);
                node.lastKnownClient = client && typeof client === "object"
                    ? client
                    : null;
                applyOnlineHysteresis(clientId, source, client);
            } catch (error) {
                const statusCode = parseStatusCodeFromError(error);
                const raw = {
                    statusCode,
                    message: error && error.message
                };

                if (statusCode === 404) {
                    applyOfflineHysteresis(clientId, source, raw, "not-connected");
                    return;
                }

                node.status({ fill: "red", shape: "ring", text: "error" });
                node.error(error);
            }
        }

        function scheduleNextPoll() {
            if (node.pollTimer) {
                clearTimeout(node.pollTimer);
            }

            node.pollTimer = setTimeout(async () => {
                // Never run overlapping polls; when UniFi is slow, simply defer
                // the next iteration instead of stacking requests.
                if (node.pollInFlight) {
                    scheduleNextPoll();
                    return;
                }

                node.pollInFlight = true;
                try {
                    await checkPresence("poll");
                } catch (error) {
                    node.status({ fill: "red", shape: "ring", text: "error" });
                    node.error(error);
                } finally {
                    node.pollInFlight = false;
                    scheduleNextPoll();
                }
            }, node.pollIntervalSeconds * 1000);
        }

        node.on("input", async function(msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };

            try {
                await checkPresence("manual-input", msg);
                if (typeof done === "function") {
                    done();
                }
            } catch (error) {
                if (typeof done === "function") {
                    done(error);
                } else {
                    node.error(error, msg);
                }
            }
        });

        if (!node.server) {
            node.status({ fill: "red", shape: "ring", text: "no config" });
        } else if (!node.clientId) {
            node.status({ fill: "grey", shape: "ring", text: "set client" });
        } else {
            updateStatus();
            checkPresence("startup").catch((error) => {
                node.status({ fill: "red", shape: "ring", text: "error" });
                node.error(error);
            }).finally(() => {
                scheduleNextPoll();
            });
        }

        node.on("close", function(done) {
            if (node.pollTimer) {
                clearTimeout(node.pollTimer);
                node.pollTimer = null;
            }
            if (typeof done === "function") {
                done();
            }
        });
    }

    RED.nodes.registerType("unifi-network-presence", UnifiNetworkPresenceNode);
};
