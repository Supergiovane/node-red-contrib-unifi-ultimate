"use strict";

const EventEmitter = require("events");
const registerPresenceNode = require("../nodes/unifi-network-presence");
const { CEREBRUM_REGISTRY_KEY, getCerebrumRegistry } = require("../nodes/utils/cerebrumIntegration");
const { createUnifiAccessCerebrum, createUnifiNetworkCerebrum } = require("../nodes/utils/unifiCerebrum");

beforeEach(() => {
    delete globalThis[CEREBRUM_REGISTRY_KEY];
});

describe("UniFi → Cerebrum integration", () => {
    test("a presence node publishes home/away and is removed on close", async () => {
        let PresenceNode;
        const server = {
            addClient: jest.fn(),
            removeClient: jest.fn(),
            refreshPresenceObservationScheduler: jest.fn(),
            requestPresenceObservationNow: jest.fn(async () => ({
                found: true,
                connected: true,
                statusCode: 200,
                client: { id: "phone-id", hostname: "Massimo-iPhone" }
            }))
        };
        registerPresenceNode({
            nodes: {
                createNode(node) {
                    const emitter = new EventEmitter();
                    node.id = "presence-node";
                    node.on = emitter.on.bind(emitter);
                    node.emit = emitter.emit.bind(emitter);
                    node.status = jest.fn();
                    node.send = jest.fn();
                    node.error = jest.fn();
                    node.warn = jest.fn();
                },
                getNode: jest.fn(() => server),
                registerType(_name, constructor) {
                    PresenceNode = constructor;
                }
            }
        });
        const node = new PresenceNode({ server: "network-config", clientId: "site::phone-id", deviceName: "Telefono Max", pollInterval: 10, onlineHysteresis: 0, offlineHysteresis: 0 });
        const provider = getCerebrumRegistry().providers.get("unifi-network-presence:presence-node");
        expect(provider).toMatchObject({ adapterId: "unifi-network" });
        expect(provider.callService).toBeUndefined();
        const events = [];
        provider.subscribe((event) => events.push(event));

        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(events.map((event) => [event.entityId, event.state])).toEqual([["presence-node/presence", "home"]]);
        expect(events[0]).toMatchObject({ resourceName: "Telefono Max", kind: "presence" });
        expect(await provider.getEntity("presence-node/presence")).toMatchObject({ state: "home" });
        node.emit("close", () => {});
        expect(getCerebrumRegistry().providers.has("unifi-network-presence:presence-node")).toBe(false);
    });

    test("the network config lists devices and clients on demand", async () => {
        const configNode = {
            id: "net1",
            name: "Casa",
            getApiKey: () => "key",
            fetchDevices: jest.fn(async (type) => type === "device"
                ? [{ id: "ap1", name: "AP soggiorno", model: "U6-Lite", state: "ONLINE", ipAddress: "10.0.0.2" }, { id: "sw1", name: "Switch", state: "OFFLINE" }]
                : [{ id: "c1", name: "Telefono Max", type: "WIRELESS", ipAddress: "10.0.0.50" }])
        };
        const integration = createUnifiNetworkCerebrum({ configNode });
        const provider = getCerebrumRegistry().providers.get("unifi-network:net1");
        expect(provider.isReady()).toBe(true);
        const entities = await provider.listEntities();
        expect(entities.map((entity) => [entity.id, entity.state])).toEqual([
            ["device/ap1", "online"],
            ["device/sw1", "offline"],
            ["client/c1", "connected"]
        ]);
        expect(await provider.getEntity("client/c1")).toMatchObject({ name: "Telefono Max", connection: "WIRELESS" });
        integration.dispose();
        expect(getCerebrumRegistry().providers.has("unifi-network:net1")).toBe(false);
    });

    test("the Access config publishes door position and Access events", async () => {
        const integration = createUnifiAccessCerebrum({ configNode: { id: "acc1", name: "Ingresso" } });
        const provider = getCerebrumRegistry().providers.get("unifi-access:acc1");
        const events = [];
        provider.subscribe((event) => events.push(event));
        const location = { id: "door1", name: "Portone" };
        integration.handleNotification({ event: "access.device.dps_status", data: { location, object: { status: "open" } } });
        integration.handleNotification({ event: "access.doorbell.incoming", data: { location } });
        integration.handleNotification({ event: "access.device.dps_status", data: { location, object: { status: "close" } } });
        expect(events.map((event) => [event.entityId, event.eventType, event.state])).toEqual([
            ["acc1/door/door1", "state_changed", "open"],
            ["acc1/door/door1", "access_event", "access.doorbell.incoming"],
            ["acc1/door/door1", "state_changed", "close"]
        ]);
        expect(await provider.getEntity("acc1/door/door1")).toMatchObject({ name: "Portone", state: "close", lastEvent: "access.device.dps_status" });
        integration.dispose();
    });
});
