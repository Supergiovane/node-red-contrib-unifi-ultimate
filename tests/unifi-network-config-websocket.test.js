"use strict";

const EventEmitter = require("events");
const registerNetworkConfigNode = require("../nodes/unifi-network-config");

const mockSocket = {
    on: jest.fn(),
    close: jest.fn(),
    readyState: 0
};
const mockWebSocket = jest.fn(() => mockSocket);

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
        mockSocket.on.mockClear();
        mockSocket.close.mockClear();
    });

    test("opens the stream with the official API key header", () => {
        const NetworkConfigNode = createHarness();
        const node = new NetworkConfigNode({
            host: "192.168.1.1",
            rejectUnauthorized: false
        });

        node.addClient({
            id: "unofficial-stream-client",
            shouldReceiveUnofficialNetworkEvents: () => true
        });

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
});
