"use strict";

const { EventEmitter } = require("events");

jest.mock("../nodes/utils/unifi-protect-utils", () => {
    const actual = jest.requireActual("../nodes/utils/unifi-protect-utils");
    return Object.assign({}, actual, { doRequest: jest.fn() });
});

const { doRequest } = require("../nodes/utils/unifi-protect-utils");
const { KNX_AI_CAMERA_REGISTRY_KEY } = require("../nodes/utils/knx-ai-camera-registry");

function createProtectConfigNode(credentials = {
    apiKey: "integration-key",
    historyUsername: "cerebrum-history",
    historyPassword: "history-secret"
}) {
    let ProtectConfigNode;
    const RED = {
        auth: { needsPermission: () => (req, res, next) => next() },
        httpAdmin: { get: jest.fn() },
        nodes: {
            createNode(node) {
                const emitter = new EventEmitter();
                node.id = "protect-history-auth";
                node.credentials = credentials;
                node.on = emitter.on.bind(emitter);
                node.emit = emitter.emit.bind(emitter);
                node.warn = jest.fn();
            },
            registerType(type, constructor) {
                if (type === "unifi-protect-config") ProtectConfigNode = constructor;
            }
        }
    };
    require("../nodes/unifi-protect-config")(RED);
    return new ProtectConfigNode({
        name: "Casa",
        host: "192.168.1.10",
        port: "443",
        rejectUnauthorized: false
    });
}

describe("UniFi Protect history authentication", () => {
    afterEach(() => {
        jest.clearAllMocks();
        delete globalThis[KNX_AI_CAMERA_REGISTRY_KEY];
    });

    test("keeps local credentials in the login request and sends only the session to Protect history", async () => {
        doRequest
            .mockResolvedValueOnce({
                statusCode: 200,
                headers: {
                    "set-cookie": ["TOKEN=private-session; Path=/; HttpOnly; Secure"],
                    "x-csrf-token": "csrf-1"
                },
                payload: { unique_id: "user-1" }
            })
            .mockResolvedValueOnce({
                statusCode: 200,
                headers: { "content-type": "application/json" },
                payload: []
            });
        const node = createProtectConfigNode();

        await node.executeProtectHistoryRequest({
            path: "events",
            query: { limit: 100, types: ["motion", "smartDetectZone"] }
        });

        expect(doRequest).toHaveBeenCalledTimes(2);
        const [loginUrl, loginOptions, loginBody] = doRequest.mock.calls[0];
        expect(loginUrl.toString()).toBe("https://192.168.1.10/api/auth/login");
        expect(loginOptions).toMatchObject({
            method: "POST",
            rejectUnauthorized: false,
            headers: expect.objectContaining({ "Content-Type": "application/json" })
        });
        expect(JSON.parse(loginBody)).toEqual({
            username: "cerebrum-history",
            password: "history-secret",
            rememberMe: false
        });

        const [historyUrl, historyOptions, historyBody] = doRequest.mock.calls[1];
        expect(historyUrl.pathname).toBe("/proxy/protect/api/events");
        expect(historyUrl.searchParams.get("limit")).toBe("100");
        expect(historyUrl.searchParams.getAll("types")).toEqual(["motion", "smartDetectZone"]);
        expect(historyOptions.headers).toMatchObject({
            Cookie: "TOKEN=private-session",
            "X-CSRF-Token": "csrf-1"
        });
        expect(historyOptions.headers).not.toHaveProperty("X-API-Key");
        expect(JSON.stringify(historyOptions.headers)).not.toContain("history-secret");
        expect(historyBody).toBeUndefined();
        node.emit("close");
    });

    test("does not advertise private history when local credentials are not configured", () => {
        const node = createProtectConfigNode({ apiKey: "integration-key" });

        expect(node.knxAiCameraProvider.capabilities).not.toContain("event_history");
        expect(node.knxAiCameraProvider).not.toHaveProperty("queryEvents");
        expect(node.knxAiCameraProvider).not.toHaveProperty("takeEventSnapshot");
        node.emit("close");
    });

    test("authenticates again once after an expired session", async () => {
        doRequest
            .mockResolvedValueOnce({
                statusCode: 200,
                headers: { "set-cookie": "TOKEN=session-1; Path=/" },
                payload: {}
            })
            .mockResolvedValueOnce({ statusCode: 401, headers: {}, payload: { message: "Unauthorized" } })
            .mockResolvedValueOnce({
                statusCode: 200,
                headers: { "set-cookie": "TOKEN=session-2; Path=/", "x-csrf-token": "csrf-2" },
                payload: {}
            })
            .mockResolvedValueOnce({ statusCode: 200, headers: {}, payload: [{ id: "event-1" }] });
        const node = createProtectConfigNode();

        const response = await node.executeProtectHistoryRequest({ path: "events" });

        expect(response.statusCode).toBe(200);
        expect(doRequest).toHaveBeenCalledTimes(4);
        expect(doRequest.mock.calls[3][1].headers).toMatchObject({
            Cookie: "TOKEN=session-2",
            "X-CSRF-Token": "csrf-2"
        });
        node.emit("close");
    });
});
