"use strict";

jest.mock("../nodes/utils/unifi-network-utils", () => ({ ...jest.requireActual("../nodes/utils/unifi-network-utils"), doRequest: jest.fn() }));
const { doRequest } = require("../nodes/utils/unifi-network-utils");
const { installNetworkMonitorReads } = require("../nodes/utils/unifi-network-monitor");
const response = (data) => ({ statusCode: 200, payload: { meta: { rc: "ok" }, data } });
const sites = [{ external_id: "site-1", _id: "legacy-site", name: "office" }, { external_id: "site-2", name: "home" }];
const health = [{ subsystem: "www", status: "ok" }];

function server() {
    const node = { baseUrl: "https://controller.test/proxy/network/integration", credentials: { apiKey: "key", localUsername: "local", localPassword: "password" },
        legacyApiRequest: jest.fn(async ({ path }) => path === "/api/self/sites" ? response(sites) : path.endsWith("/stat/health") ? response(health) : response([])),
        fetchDeviceByTypeAndId: jest.fn(async () => ({ state: "OFFLINE" })) };
    installNetworkMonitorReads(node);
    return node;
}

describe("Network monitor reads", () => {
    afterEach(() => jest.resetAllMocks());
    test("uses API key and scopes health and events to the selected site", async () => {
        const node = server();
        const result = await node.readSimpleMonitor({ kind: "observeInternet", target: "site-1" });
        expect(result).toEqual({ health, events: [], site: "office", wanEventsAvailable: true });
        expect(node.legacyApiRequest.mock.calls.map(([request]) => request.path)).toEqual(["/api/self/sites", "/api/s/office/stat/health", "/api/s/office/stat/event"]);
        expect(doRequest).not.toHaveBeenCalled();
        await node.readSimpleMonitor({ kind: "observeInternet", target: "site-2" });
        expect(node.legacyApiRequest.mock.calls[3][0].path).toBe("/api/s/home/stat/health");
    });

    test("falls back to a shared local session only on local API auth rejection", async () => {
        const node = server();
        node.legacyApiRequest.mockResolvedValue({ statusCode: 401 });
        doRequest.mockImplementation(async (url, options) => {
            if (options.method === "POST") return { statusCode: 200, headers: { "set-cookie": "TOKEN=session; Secure" } };
            return url.pathname === "/proxy/network/api/self/sites" ? response(sites) : response(health);
        });
        await node.readSimpleMonitor({ kind: "observeInternet", target: "site-1" });
        await node.readSimpleMonitor({ kind: "observeInternet", target: "site-2" });
        expect(doRequest.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(1);
        expect(node.legacyApiRequest).toHaveBeenCalledTimes(1);
        for (const [url, options] of doRequest.mock.calls.filter((call) => call[1].method === "GET")) {
            expect(url.pathname.startsWith("/proxy/network/api/")).toBe(true);
            expect(options.headers.Cookie).toBe("TOKEN=session");
            expect(options.headers).not.toHaveProperty("X-API-Key");
            expect(options.headers).not.toHaveProperty("Authorization");
        }
    });

    test("unknown sites and read errors never become Internet outages", async () => {
        const node = server();
        await expect(node.readSimpleMonitor({ kind: "observeInternet", target: "unknown-site" })).rejects.toThrow("Cannot match");
        expect(node.legacyApiRequest).toHaveBeenCalledTimes(1);
        node.legacyApiRequest.mockResolvedValue({ statusCode: 500, payload: "private-diagnostics" });
        await expect(node.readSimpleMonitor({ kind: "observeInternet", target: "site-1" })).rejects.toThrow("HTTP 500");
    });

    test("missing event support leaves health monitoring usable and explicitly flagged", async () => {
        const node = server();
        node.legacyApiRequest.mockImplementation(async ({ path }) => path === "/api/self/sites" ? response(sites) : path.endsWith("health") ? response(health) : { statusCode: 404 });
        const result = await node.readSimpleMonitor({ kind: "observeInternet", target: "site-1" });
        expect(result.health).toEqual(health);
        expect(result.wanEventsAvailable).toBe(false);
    });

    test("device monitoring continues to use existing device reads", async () => {
        const node = server();
        expect(await node.readSimpleMonitor({ kind: "observeAvailability", target: "site-1::ap-1" })).toEqual({ state: "OFFLINE" });
        expect(node.fetchDeviceByTypeAndId).toHaveBeenCalledWith("device", "site-1::ap-1");
        expect(node.legacyApiRequest).not.toHaveBeenCalled();
    });
});
