"use strict";

const EventEmitter = require("events");
const registerPresenceNode = require("../nodes/unifi-network-presence");

function createHarness(server) {
    let PresenceNode;
    const RED = {
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
    };

    registerPresenceNode(RED);
    return PresenceNode;
}

function createServer(snapshot) {
    return {
        addClient: jest.fn(),
        removeClient: jest.fn(),
        refreshPresenceObservationScheduler: jest.fn(),
        requestPresenceObservationNow: jest.fn(async () => snapshot || {
            found: false,
            connected: false,
            statusCode: 404,
            client: null
        })
    };
}

describe("unifi network presence node", () => {
    test("keeps existing configurations on id matching", async () => {
        const server = createServer();
        const PresenceNode = createHarness(server);
        const node = new PresenceNode({
            server: "network-config",
            clientId: "site::client-id",
            deviceName: "Existing phone",
            pollInterval: 10,
            onlineHysteresis: 0,
            offlineHysteresis: 0
        });

        await new Promise((resolve) => setImmediate(resolve));
        expect(node.getNetworkPresenceObservationDescriptor()).toMatchObject({
            clientId: "site::client-id",
            matchBy: "id",
            clientName: "Existing phone"
        });
        expect(server.requestPresenceObservationNow).toHaveBeenCalledWith(expect.objectContaining({
            clientId: "site::client-id",
            matchBy: "id"
        }));
        node.emit("close");
    });

    test("passes the saved name to startup and shared polling descriptors", async () => {
        const server = createServer({
            found: true,
            connected: true,
            statusCode: 200,
            matchBy: "name",
            clientName: "Massimo-iPhone",
            matchedClientId: "site::rotated-private-id",
            matchCount: 1,
            client: { id: "rotated-private-id", hostname: "Massimo-iPhone" }
        });
        const PresenceNode = createHarness(server);
        const node = new PresenceNode({
            server: "network-config",
            clientId: "site::old-private-id",
            matchBy: "name",
            clientName: "Massimo-iPhone",
            deviceName: "Massimo-iPhone",
            pollInterval: 15,
            onlineHysteresis: 0,
            offlineHysteresis: 0
        });

        await new Promise((resolve) => setImmediate(resolve));
        expect(node.getNetworkPresenceObservationDescriptor()).toEqual({
            clientId: "site::old-private-id",
            matchBy: "name",
            clientName: "Massimo-iPhone",
            pollIntervalSeconds: 15,
            timeout: 8000
        });
        expect(server.requestPresenceObservationNow).toHaveBeenCalledWith(expect.objectContaining({
            clientId: "site::old-private-id",
            matchBy: "name",
            clientName: "Massimo-iPhone"
        }));
        expect(node.lastMatchedClientId).toBe("site::rotated-private-id");
        node.emit("close");
    });
});
