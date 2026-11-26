"use strict";

// Publishes UniFi Network and UniFi Access to Cerebrum Ultimate, read-only.
// - Network config: network devices and clients, read on demand.
// - Network presence node: home/away of the watched device, or the clients
//   joining and leaving the watched network.
// - Access config: door position and Access events (doorbell, unlocks...).
// Nothing can be commanded from Cerebrum. UniFi Protect cameras are already
// published through the Cerebrum camera registry.

const { registerCerebrumIntegration } = require("./cerebrumIntegration");

const text = (value) => (value === undefined || value === null ? "" : String(value).trim());
const first = (...values) => values.map(text).find(Boolean) || "";

const publishEntity = (integration, entity, eventType = "state_changed") => {
    const details = { ...entity };
    ["id", "name", "kind", "capability", "state"].forEach((key) => delete details[key]);
    integration.emit({
        entityId: entity.id,
        eventType,
        state: entity.state,
        resourceName: entity.name,
        resourceType: entity.kind,
        kind: entity.kind,
        capability: entity.capability,
        details
    });
};

const NETWORK_ADAPTER = Object.freeze({
    id: "unifi-network",
    title: "UniFi Network",
    packageName: "node-red-contrib-unifi-ultimate",
    kind: "network",
    capabilities: ["network-devices", "network-clients", "presence"],
    access: "observe",
    operations: [
        { id: "list-entities", description: "UniFi Network: access points, switches and gateways with their state (online/offline), model and IP; connected clients (phones, computers, IoT) with name, IP and connection type; presence of the watched devices (home/away). Filter with a query: the client list can be long. Read-only." },
        { id: "read-entity", description: "Current state of one UniFi Network device, client or presence by its exact id." }
    ]
});

function mapNetworkDevice(device) {
    const state = first(device.state, device.status).toLowerCase();
    return {
        id: `device/${first(device.id, device.macAddress, device.mac)}`,
        name: first(device.name, device.model, device.macAddress, device.mac),
        kind: "network_device",
        capability: "status",
        state: state === "1" ? "online" : state === "0" ? "offline" : (state || "unknown"),
        model: first(device.model),
        ipAddress: first(device.ipAddress, device.ip),
        site: first(device.siteName)
    };
}

function mapNetworkClient(client) {
    return {
        id: `client/${first(client.id, client.macAddress, client.mac)}`,
        name: first(client.name, client.hostname, client.macAddress, client.mac),
        kind: "network_client",
        capability: "presence",
        state: "connected",
        connection: first(client.type, client.isWired === true ? "WIRED" : ""),
        ipAddress: first(client.ipAddress, client.ip),
        connectedAt: first(client.connectedAt),
        site: first(client.siteName)
    };
}

function createUnifiNetworkCerebrum({ configNode }) {
    const fetchList = async (type, mapper) => {
        const items = await configNode.fetchDevices(type);
        return (Array.isArray(items) ? items : []).map(mapper).filter((entity) => entity.id.split("/")[1]);
    };
    const integration = registerCerebrumIntegration({
        adapter: NETWORK_ADAPTER,
        provider: {
            id: `unifi-network:${configNode.id}`,
            title: `UniFi Network ${configNode.name || ""}`.trim(),
            ownerNodeId: configNode.id,
            isReady: () => Boolean(configNode.getApiKey && configNode.getApiKey()),
            listEntities: async () => {
                const [devices, clients] = await Promise.all([
                    fetchList("device", mapNetworkDevice),
                    fetchList("client", mapNetworkClient).catch(() => [])
                ]);
                return devices.concat(clients);
            },
            getEntity: async (id) => {
                const wanted = text(id);
                const list = wanted.startsWith("client/")
                    ? await fetchList("client", mapNetworkClient)
                    : await fetchList("device", mapNetworkDevice);
                return list.find((entity) => entity.id === wanted) || null;
            }
        }
    });
    return { provider: integration.provider, dispose: integration.dispose };
}

// One provider per presence node: its own entities, updated by its events.
function createUnifiPresenceCerebrum({ node, deviceName: configuredName = "" }) {
    const entitiesById = new Map();
    const integration = registerCerebrumIntegration({
        adapter: NETWORK_ADAPTER,
        provider: {
            id: `unifi-network-presence:${node.id}`,
            title: `UniFi presence ${node.name || ""}`.trim(),
            ownerNodeId: node.id,
            ready: true,
            listEntities: async () => Array.from(entitiesById.values()).map((entity) => ({ ...entity })),
            getEntity: async (id) => {
                const entity = entitiesById.get(text(id));
                return entity ? { ...entity } : null;
            }
        }
    });
    const update = (entity) => {
        entitiesById.set(entity.id, entity);
        publishEntity(integration, entity);
    };
    return {
        provider: integration.provider,
        dispose: integration.dispose,
        // Single watched device: home / away.
        presence(present, deviceName, reason) {
            update({
                id: `${node.id}/presence`,
                // The name given in the node (e.g. "Max's phone") beats the hostname.
                name: first(configuredName, deviceName, node.clientName, node.name, "UniFi device"),
                kind: "presence",
                capability: "presence",
                state: present ? "home" : "away",
                reason: text(reason)
            });
        },
        // Network watch: a client joined or left.
        client(eventName, client, networkName) {
            const mac = first(client && client.mac, client && client.macAddress);
            if (!mac) return;
            update({
                id: `${node.id}/client/${mac}`,
                name: first(client && client.name, mac),
                kind: "network_client",
                capability: "presence",
                state: eventName === "joined" ? "connected" : "disconnected",
                network: text(networkName),
                ipAddress: first(client && client.ipAddress)
            });
        }
    };
}

const ACCESS_ADAPTER = Object.freeze({
    id: "unifi-access",
    title: "UniFi Access",
    packageName: "node-red-contrib-unifi-ultimate",
    kind: "security",
    capabilities: ["doors", "door-position", "doorbell", "access-events"],
    access: "observe",
    operations: [
        { id: "list-entities", description: "UniFi Access doors: door position (open/close) and the last Access event of each door (doorbell ring, unlock, access granted or denied). Read-only." },
        { id: "read-entity", description: "Current state of one UniFi Access door by its exact id." }
    ]
});

function createUnifiAccessCerebrum({ configNode }) {
    const entitiesById = new Map();
    const integration = registerCerebrumIntegration({
        adapter: ACCESS_ADAPTER,
        provider: {
            id: `unifi-access:${configNode.id}`,
            title: `UniFi Access ${configNode.name || ""}`.trim(),
            ownerNodeId: configNode.id,
            ready: true,
            listEntities: async () => Array.from(entitiesById.values()).map((entity) => ({ ...entity })),
            getEntity: async (id) => {
                const entity = entitiesById.get(text(id));
                return entity ? { ...entity } : null;
            }
        }
    });

    // payload: one notification of the Access WebSocket.
    function handleNotification(payload) {
        if (!payload || typeof payload !== "object") return;
        const eventName = text(payload.event);
        if (!eventName) return;
        const data = payload.data && typeof payload.data === "object" ? payload.data : {};
        const location = data.location && typeof data.location === "object" ? data.location : {};
        const doorId = first(location.id, data.device_id, data.deviceId) || "site";
        const doorName = first(location.name, data.device_name, data.deviceName) || `Door ${doorId}`;
        const position = eventName === "access.device.dps_status" ? first(data.object && data.object.status) : "";
        const previous = entitiesById.get(`${configNode.id}/door/${doorId}`) || {};
        const entity = {
            id: `${configNode.id}/door/${doorId}`,
            name: doorName,
            kind: "door",
            capability: "open_close",
            state: position || previous.state || "unknown",
            lastEvent: eventName,
            at: new Date().toISOString()
        };
        entitiesById.set(entity.id, entity);
        if (position) publishEntity(integration, entity);
        else publishEntity(integration, { ...entity, state: eventName }, "access_event");
    }

    return { handleNotification, provider: integration.provider, dispose: integration.dispose };
}

module.exports = {
    createUnifiAccessCerebrum,
    createUnifiNetworkCerebrum,
    createUnifiPresenceCerebrum,
    mapNetworkClient,
    mapNetworkDevice
};
