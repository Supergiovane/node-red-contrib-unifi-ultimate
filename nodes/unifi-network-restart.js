"use strict";

const {
    resolveScopedIdentifiers
} = require("./utils/unifi-network-device-registry");
const {
    appendStatusTimestamp,
    resolveNodeName,
    attachDetails,
    buildErrorOutputMessage
} = require("./utils/common-utils");

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
// Cap parallel requests so a large fleet does not flood the controller while
// still finishing the batch faster than a strictly sequential loop.
const DEFAULT_CONCURRENCY = 4;

function normalizeString(value) {
    return String(value || "").trim();
}

function parseDeviceIds(value) {
    // The editor stores the selection as a JSON array string, but tolerate an
    // already-parsed array or a comma separated fallback for hand edits.
    if (Array.isArray(value)) {
        return value.map(normalizeString).filter(Boolean);
    }

    const raw = normalizeString(value);
    if (!raw) {
        return [];
    }

    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.map(normalizeString).filter(Boolean);
        }
    } catch (error) {
        // Not JSON: fall back to a comma separated list.
    }

    return raw.split(",").map(normalizeString).filter(Boolean);
}

function parseDeviceNames(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }

    const raw = normalizeString(value);
    if (!raw) {
        return {};
    }

    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        return {};
    }
}

function resolveOperation(value) {
    const normalized = normalizeString(value).toLowerCase();
    if (["powercyclepoe", "powercycle", "poe", "power_cycle_poe"].includes(normalized)) {
        return "powerCyclePoe";
    }
    return "restartDevices";
}

async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    async function pump() {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    }

    const runners = [];
    const runnerCount = Math.max(1, Math.min(limit, items.length));
    for (let i = 0; i < runnerCount; i += 1) {
        runners.push(pump());
    }

    await Promise.all(runners);
    return results;
}

module.exports = function(RED) {
    function UnifiNetworkRestartNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.server = RED.nodes.getNode(config.server);
        node.operation = resolveOperation(config.operation);
        node.deviceIds = parseDeviceIds(config.deviceIds);
        node.deviceNames = parseDeviceNames(config.deviceNames);
        node.timeout = DEFAULT_REQUEST_TIMEOUT_MS;

        function setNodeStatus(status) {
            if (!status || typeof status !== "object" || Array.isArray(status)) {
                return;
            }
            node.status({
                ...status,
                text: appendStatusTimestamp(status.text)
            });
        }

        function resolveDeviceLabel(deviceId, scoped) {
            const stored = normalizeString(node.deviceNames && node.deviceNames[deviceId]);
            if (stored) {
                return stored;
            }
            return normalizeString(scoped && scoped.resourceId) || deviceId;
        }

        function buildScopeError(deviceId) {
            return {
                deviceId,
                deviceName: normalizeString(node.deviceNames && node.deviceNames[deviceId]) || deviceId,
                ok: false,
                error: "Device selection is invalid. Re-open the node and re-select the device."
            };
        }

        async function restartDevice(deviceId) {
            const scoped = resolveScopedIdentifiers("device", deviceId);
            if (!scoped.siteId || !scoped.resourceId) {
                return buildScopeError(deviceId);
            }

            const deviceName = resolveDeviceLabel(deviceId, scoped);
            const path = `/v1/sites/${encodeURIComponent(scoped.siteId)}/devices/${encodeURIComponent(scoped.resourceId)}/actions`;

            try {
                const response = await node.server.executeNetworkRequest({
                    path,
                    method: "POST",
                    payload: { action: "RESTART" },
                    timeout: node.timeout
                });

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    return {
                        deviceId,
                        deviceName,
                        siteId: scoped.siteId,
                        resourceId: scoped.resourceId,
                        action: "RESTART",
                        ok: false,
                        statusCode: response.statusCode,
                        error: `Restart request failed (${response.statusCode}).`
                    };
                }

                return {
                    deviceId,
                    deviceName,
                    siteId: scoped.siteId,
                    resourceId: scoped.resourceId,
                    action: "RESTART",
                    ok: true,
                    statusCode: response.statusCode
                };
            } catch (error) {
                return {
                    deviceId,
                    deviceName,
                    siteId: scoped.siteId,
                    resourceId: scoped.resourceId,
                    action: "RESTART",
                    ok: false,
                    error: String(error && error.message ? error.message : error)
                };
            }
        }

        async function resolvePoePorts(deviceId) {
            if (typeof node.server.fetchDevicePortsPowerLite !== "function") {
                return [];
            }
            const ports = await node.server.fetchDevicePortsPowerLite(deviceId);
            if (!Array.isArray(ports)) {
                return [];
            }
            // A power cycle only makes sense on ports actively delivering PoE.
            return ports.filter((port) => normalizeString(port && port.poeEnabled).toLowerCase() === "on");
        }

        async function powerCycleDevicePorts(deviceId) {
            const scoped = resolveScopedIdentifiers("device", deviceId);
            if (!scoped.siteId || !scoped.resourceId) {
                return buildScopeError(deviceId);
            }

            const deviceName = resolveDeviceLabel(deviceId, scoped);
            const base = {
                deviceId,
                deviceName,
                siteId: scoped.siteId,
                resourceId: scoped.resourceId,
                action: "POWER_CYCLE"
            };

            let poePorts;
            try {
                poePorts = await resolvePoePorts(deviceId);
            } catch (error) {
                return {
                    ...base,
                    ok: false,
                    error: `Unable to read PoE ports: ${String(error && error.message ? error.message : error)}`
                };
            }

            if (poePorts.length === 0) {
                return {
                    ...base,
                    ok: true,
                    skipped: true,
                    portsCycled: 0,
                    ports: [],
                    note: "No PoE ports actively delivering power."
                };
            }

            const portResults = [];
            for (const port of poePorts) {
                const portIdx = Number(port.idx);
                const path = `/v1/sites/${encodeURIComponent(scoped.siteId)}/devices/${encodeURIComponent(scoped.resourceId)}/interfaces/ports/${encodeURIComponent(String(portIdx))}/actions`;
                try {
                    const response = await node.server.executeNetworkRequest({
                        path,
                        method: "POST",
                        payload: { action: "POWER_CYCLE" },
                        timeout: node.timeout
                    });

                    const ok = response.statusCode >= 200 && response.statusCode < 300;
                    portResults.push({
                        portIdx,
                        portName: normalizeString(port.name) || `Port ${portIdx}`,
                        ok,
                        statusCode: response.statusCode,
                        error: ok ? undefined : `Power cycle failed (${response.statusCode}).`
                    });
                } catch (error) {
                    portResults.push({
                        portIdx,
                        portName: normalizeString(port.name) || `Port ${portIdx}`,
                        ok: false,
                        error: String(error && error.message ? error.message : error)
                    });
                }
            }

            const failedPorts = portResults.filter((entry) => !entry.ok);
            return {
                ...base,
                ok: failedPorts.length === 0,
                portsCycled: portResults.length - failedPorts.length,
                portsFailed: failedPorts.length,
                ports: portResults,
                error: failedPorts.length > 0
                    ? `${failedPorts.length} of ${portResults.length} port(s) failed.`
                    : undefined
            };
        }

        function refreshProgressStatus(done, total) {
            const label = node.operation === "powerCyclePoe" ? "power cycle" : "restart";
            setNodeStatus({
                fill: "blue",
                shape: "dot",
                text: `${label} ${done}/${total}`
            });
        }

        async function invoke(send) {
            if (!node.server) {
                throw new Error("Unifi Network configuration is missing.");
            }
            if (typeof node.server.executeNetworkRequest !== "function") {
                throw new Error("This node requires the UniFi Network configuration helper.");
            }
            if (!Array.isArray(node.deviceIds) || node.deviceIds.length === 0) {
                throw new Error("No devices selected. Open the node and choose at least one device.");
            }

            const total = node.deviceIds.length;
            let completed = 0;
            refreshProgressStatus(0, total);

            const worker = node.operation === "powerCyclePoe"
                ? powerCycleDevicePorts
                : restartDevice;

            const results = await runWithConcurrency(node.deviceIds, DEFAULT_CONCURRENCY, async (deviceId) => {
                const result = await worker(deviceId);
                completed += 1;
                refreshProgressStatus(completed, total);
                return result;
            });

            const succeeded = results.filter((entry) => entry && entry.ok).length;
            const failed = results.length - succeeded;
            const nodeName = resolveNodeName(node.name);

            const output = {
                topic: nodeName || undefined,
                eventName: node.operation,
                payload: {
                    operation: node.operation,
                    total: results.length,
                    succeeded,
                    failed,
                    results
                }
            };
            attachDetails(output, {
                unifiNetworkRestart: {
                    nodeType: "network-restart",
                    name: nodeName || undefined,
                    operation: node.operation,
                    total: results.length,
                    succeeded,
                    failed
                }
            });

            if (failed === 0) {
                setNodeStatus({ fill: "green", shape: "dot", text: `${succeeded}/${results.length} ok` });
            } else if (succeeded === 0) {
                setNodeStatus({ fill: "red", shape: "ring", text: `0/${results.length} ok` });
            } else {
                setNodeStatus({ fill: "yellow", shape: "ring", text: `${succeeded}/${results.length} ok` });
            }

            send([output, null]);
        }

        node.on("input", async function(msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };

            try {
                await invoke(send);
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

        if (!node.server) {
            setNodeStatus({ fill: "red", shape: "ring", text: "no config" });
        } else if (!Array.isArray(node.deviceIds) || node.deviceIds.length === 0) {
            setNodeStatus({ fill: "grey", shape: "ring", text: "select devices" });
        } else {
            const label = node.operation === "powerCyclePoe" ? "power cycle" : "restart";
            setNodeStatus({ fill: "grey", shape: "ring", text: `ready (${node.deviceIds.length} ${label})` });
        }
    }

    RED.nodes.registerType("unifi-network-restart", UnifiNetworkRestartNode);
};
