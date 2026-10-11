"use strict";

const EventEmitter = require("events");
const registerNetworkConfigNode = require("../nodes/unifi-network-config");

const mockSockets = [];
const mockWebSocket = jest.fn(() => {
    const listeners = {};
    const socket = {
        on: jest.fn((event, handler) => {
            (listeners[event] = listeners[event] || []).push(handler);
        }),
        close: jest.fn(),
        emitEvent: (event, ...args) => (listeners[event] || []).forEach((handler) => handler(...args)),
        readyState: 0
    };
    mockSockets.push(socket);
    return socket;
});

jest.mock("ws", () => ({
    WebSocket: mockWebSocket
}));

function createHarness() {
    let NetworkConfigNode;
    const RED = {
        settings: {},
        nodes: {
            createNode(node) {
                const emitter = new EventEmitter();
                node.id = "network-config-websocket-test";
                node.credentials = { apiKey: "secret" };
                node.on = emitter.on.bind(emitter);
                node.emit = emitter.emit.bind(emitter);
                node.status = jest.fn();
                node.warn = jest.fn();
            },
            getNode: jest.fn(),
            registerType(name, constructor) {
                if (name === "unifi-network-config") {
                    NetworkConfigNode = constructor;
                }
            }
        },
        httpAdmin: {
            get: jest.fn()
        },
        auth: {
            needsPermission: jest.fn(() => jest.fn())
        }
    };

    registerNetworkConfigNode(RED);
    return NetworkConfigNode;
}

describe("unifi network unofficial websocket", () => {
    beforeEach(() => {
        mockWebSocket.mockClear();
        mockSockets.length = 0;
    });

    test("opens the stream with the official API key header", async () => {
        const NetworkConfigNode = createHarness();
        const node = new NetworkConfigNode({
            host: "192.168.1.1",
            rejectUnauthorized: false
        });

        node.addClient({
            id: "unofficial-stream-client",
            shouldReceiveUnofficialNetworkEvents: () => true
        });
        await node.unofficialNetworkSync;

        expect(mockWebSocket).toHaveBeenCalledWith(
            "wss://192.168.1.1/proxy/network/wss/s/default/events",
            {
                headers: {
                    Accept: "application/json",
                    "X-API-Key": "secret"
                },
                rejectUnauthorized: false
            }
        );
        expect(node.warn).not.toHaveBeenCalledWith(expect.stringContaining("API_KEY_HEADER"));

        node.emit("close");
    });

    test("opens one stream per subscribed site and routes events to that site only", async () => {
        const NetworkConfigNode = createHarness();
        const node = new NetworkConfigNode({
            host: "192.168.1.1",
            rejectUnauthorized: false
        });
        node.legacyApiRequest = jest.fn(async () => ({
            statusCode: 200,
            payload: {
                data: [
                    { _id: "legacy-a", external_id: "site-a", name: "default" },
                    { _id: "legacy-b", external_id: "site-b", name: "x7k2p9qa" }
                ]
            }
        }));
        const clientA = {
            id: "client-a",
            shouldReceiveUnofficialNetworkEvents: () => true,
            getUnofficialNetworkSiteId: () => "site-a",
            handleNetworkEventUpdate: jest.fn()
        };
        const clientB = {
            id: "client-b",
            shouldReceiveUnofficialNetworkEvents: () => true,
            getUnofficialNetworkSiteId: () => "site-b",
            handleNetworkEventUpdate: jest.fn()
        };

        node.addClient(clientA);
        node.addClient(clientB);
        await node.unofficialNetworkSync;

        expect(mockWebSocket.mock.calls.map((call) => call[0]).sort()).toEqual([
            "wss://192.168.1.1/proxy/network/wss/s/default/events",
            "wss://192.168.1.1/proxy/network/wss/s/x7k2p9qa/events"
        ]);

        node.wsNetworkEvents.get("x7k2p9qa").emitEvent("message", Buffer.from(JSON.stringify({ meta: { message: "events" } })));
        expect(clientB.handleNetworkEventUpdate).toHaveBeenCalledTimes(1);
        expect(clientA.handleNetworkEventUpdate).not.toHaveBeenCalled();

        const siteBSocket = node.wsNetworkEvents.get("x7k2p9qa");
        node.removeClient(clientB);
        await node.unofficialNetworkSync;
        expect(siteBSocket.close).toHaveBeenCalled();
        expect(node.wsNetworkEvents.has("x7k2p9qa")).toBe(false);
        expect(node.wsNetworkEvents.has("default")).toBe(true);

        node.emit("close");
    });
});
