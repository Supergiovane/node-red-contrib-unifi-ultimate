"use strict";

const {
    decodeScopedDeviceId,
    resolveScopedIdentifiers
} = require("./utils/unifi-network-device-registry");
const { extractNetworkData } = require("./utils/unifi-network-utils");

function resolveDeviceId(configuredDeviceId, msg) {
    if (msg && (msg.deviceId || msg.resourceId || msg.siteId)) {
        const explicitDeviceId = String(msg.deviceId || "").trim();
        if (explicitDeviceId) {
            return explicitDeviceId;
        }

        const siteId = String(msg.siteId || "").trim();
        const resourceId = String(msg.resourceId || "").trim();
        if (siteId && resourceId) {
            return `${siteId}::${resourceId}`;
        }
    }

    return String(configuredDeviceId || "").trim();
}

function resolvePortIdx(configuredPortIdx, msg) {
    const fromMsg = Number(msg && msg.portIdx);
    if (Number.isFinite(fromMsg) && fromMsg >= 0) {
        return Math.trunc(fromMsg);
    }

    const configured = Number(configuredPortIdx);
    if (Number.isFinite(configured) && configured >= 0) {
        return Math.trunc(configured);
    }

    return NaN;
}

function resolveActionCandidates(value) {
    const normalized = String(value || "").trim();
    const upper = normalized.toUpperCase();

    // Different UniFi Network versions have exposed slightly different action
    // names, so try the most common aliases in a safe order.
    if (!upper) {
        return ["POWER_ON", "ENABLE_POE"];
    }

    if (["ENABLE", "ON", "POWER_ON"].includes(upper)) {
        return ["POWER_ON", "ENABLE_POE"];
    }
    if (["DISABLE", "OFF", "POWER_OFF"].includes(upper)) {
        return ["POWER_OFF", "DISABLE_POE"];
    }
    if (["CYCLE", "POWER_CYCLE"].includes(upper)) {
        return ["POWER_CYCLE"];
    }

    return [upper];
}

module.exports = function(RED) {
    function UnifiNetworkControlPoeNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.server = RED.nodes.getNode(config.server);
        node.deviceId = config.deviceId || "";
        node.portIdx = config.portIdx;
        node.action = config.action || "enable";
        node.timeout = Number(config.timeout) > 0 ? Number(config.timeout) : 15000;

        function buildMetadata(deviceId, payloadAction, portIdx, extra) {
            // The emitted metadata keeps both the scoped ids and the exact action
            // that ended up being accepted by the controller.
            const scoped = decodeScopedDeviceId(deviceId);
            return {
                nodeType: "poe-control",
                deviceId,
                siteId: scoped.siteId || undefined,
                resourceId: scoped.resourceId || undefined,
                action: payloadAction,
                portIdx,
                ...(extra || {})
            };
        }

        async function invoke(msg, send) {
            if (!node.server) {
                throw new Error("Unifi Network configuration is missing.");
            }

            // Allow the incoming message to override switch, port and action so
            // the node can be reused in templates and subflows.
            const deviceId = resolveDeviceId(node.deviceId, msg);
            if (!deviceId) {
                throw new Error("Missing switch device id.");
            }

            const scoped = resolveScopedIdentifiers("device", deviceId);
            if (!scoped.siteId || !scoped.resourceId) {
                throw new Error("Device selection is invalid. Re-select the device from the editor.");
            }

            const portIdx = resolvePortIdx(node.portIdx, msg);
            if (!Number.isFinite(portIdx)) {
                throw new Error("Missing port index.");
            }

            const path = `/v1/sites/${encodeURIComponent(scoped.siteId)}/devices/${encodeURIComponent(scoped.resourceId)}/interfaces/ports/${encodeURIComponent(String(portIdx))}/actions`;
            const actionCandidates = resolveActionCandidates(msg.action || node.action);
            const requestedAction = String(msg.action || node.action || "").trim() || "enable";

            let response = null;
            let usedAction = "";

            for (let index = 0; index < actionCandidates.length; index += 1) {
                // Stop on the first accepted action value to keep behavior
                // deterministic across controller versions.
                const candidate = actionCandidates[index];
                node.status({ fill: "blue", shape: "dot", text: `${candidate} p${portIdx}` });

                response = await node.server.apiRequest({
                    path,
                    method: "POST",
                    payload: {
                        action: candidate
                    },
                    timeout: node.timeout
                });

                if (response.statusCode >= 200 && response.statusCode < 300) {
                    usedAction = candidate;
                    break;
                }
            }

            if (!response || response.statusCode < 200 || response.statusCode >= 300) {
                const statusCode = response ? response.statusCode : 0;
                node.status({ fill: "yellow", shape: "ring", text: `${statusCode || "failed"}` });
                throw new Error(`PoE control request failed (${statusCode}).`);
            }

            const output = RED.util.cloneMessage(msg);
            output.payload = extractNetworkData(response.payload);
            output.statusCode = response.statusCode;
            output.headers = response.headers;
            output.unifiNetworkPoe = buildMetadata(deviceId, usedAction, portIdx, {
                source: "request",
                requestedAction,
                method: "POST",
                path
            });

            node.status({ fill: "green", shape: "dot", text: `${usedAction} ok` });
            send(output);
        }

        node.on("input", async function(msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };

            try {
                await invoke(msg, send);
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

        if (!node.server) {
            node.status({ fill: "red", shape: "ring", text: "no config" });
        } else if (!node.deviceId) {
            node.status({ fill: "grey", shape: "ring", text: "set device" });
        } else {
            node.status({ fill: "grey", shape: "ring", text: "ready" });
        }
    }

    RED.nodes.registerType("unifi-network-control-poe", UnifiNetworkControlPoeNode);
};
