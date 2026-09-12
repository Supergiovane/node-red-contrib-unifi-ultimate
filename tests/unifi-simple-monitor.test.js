"use strict";

const { createSimpleMonitorProcessor, installSimpleMonitorScheduler, deviceOffline } = require("../nodes/utils/unifi-simple-monitor");

function processor(kind, options = {}) {
    const emit = jest.fn();
    const reportError = jest.fn();
    const result = createSimpleMonitorProcessor({ kind, options, emit, reportError, status: jest.fn() });
    return { ...result, emit, reportError };
}

describe("simple monitoring transitions", () => {
    beforeEach(() => jest.useFakeTimers({ now: 1000000 }));
    afterEach(() => jest.useRealTimers());

    test("door requires sustained physical opening, emits once and recovers once", () => {
        const monitor = processor("observeDoorOpenTooLong", { delaySeconds: 120 });
        const open = () => monitor.handle({ latest: { door_position_status: "open" } });
        open();
        jest.advanceTimersByTime(119000);
        open();
        expect(monitor.emit).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1000);
        open(); open();
        expect(monitor.emit).toHaveBeenCalledTimes(1);
        expect(monitor.emit).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }), "doorOpenTooLong", expect.objectContaining({ monitor: expect.objectContaining({ durationSeconds: 120 }) }));
        monitor.handle({ latest: { door_position_status: "close" } });
        monitor.handle({ latest: { door_position_status: "close" } });
        expect(monitor.emit).toHaveBeenCalledTimes(2);
        expect(monitor.emit.mock.calls[1][1]).toBe("doorClosed");
    });

    test("unlock without a DPS does not count as an open door", () => {
        const monitor = processor("observeDoorOpenTooLong");
        monitor.handle({ latest: { door_lock_relay_status: "unlock", door_position_status: null } });
        jest.advanceTimersByTime(300000);
        monitor.handle({ latest: { door_lock_relay_status: "unlock" } });
        expect(monitor.emit).not.toHaveBeenCalled();
        expect(monitor.reportError).toHaveBeenCalledTimes(1);
        expect(monitor.reportError.mock.calls[0][0].message).toContain("DPS");
    });

    test("brief outages, controller failures and unknown states reset a pending alarm", () => {
        const monitor = processor("observeAvailability", { delaySeconds: 60 });
        const sample = (state) => monitor.handle({ latest: { state } });
        sample("OFFLINE");
        jest.advanceTimersByTime(50000);
        sample("ONLINE"); sample("OFFLINE");
        jest.advanceTimersByTime(50000);
        monitor.handle({ error: new Error("Controller unreachable") });
        jest.advanceTimersByTime(100000);
        sample("OFFLINE");
        expect(monitor.emit).not.toHaveBeenCalled();
        jest.advanceTimersByTime(60000);
        sample("ADOPTING"); sample("OFFLINE");
        expect(monitor.emit).not.toHaveBeenCalled();
        jest.advanceTimersByTime(60000);
        sample("OFFLINE"); sample("ONLINE");
        expect(monitor.emit.mock.calls.map((call) => call[1])).toEqual(["deviceOffline", "deviceRestored"]);
    });

    test("a controller error after an alarm cannot fabricate recovery", () => {
        const monitor = processor("observeAvailability", { delaySeconds: 0 });
        monitor.handle({ latest: { state: 0 } });
        monitor.handle({ error: new Error("Connection lost") });
        monitor.handle({ latest: { state: 0 } });
        expect(monitor.emit).toHaveBeenCalledTimes(1);
        monitor.handle({ latest: { state: 1 } });
        expect(monitor.emit.mock.calls[1][1]).toBe("deviceRestored");
    });

    test.each([null, {}, { state: "UPGRADING" }, { state: "PENDING_ADOPTION" }])("does not invent an offline state from %j", (device) => {
        expect(deviceOffline(device)).toBeUndefined();
    });

    test("Internet status comes from WWW, never from a single WAN transition", () => {
        const monitor = processor("observeInternet", { delaySeconds: 0 });
        const sample = (status, events = []) => monitor.handle({ latest: { health: [{ subsystem: "wan", status: "error" }, { subsystem: "www", status }], events } });
        const event = { key: "EVT_GW_WANTransition", _id: "1", iface: "eth9", state: "failover", time: Date.now() };
        sample("ok", [event]); sample("ok", [event]);
        expect(monitor.emit.mock.calls.map((call) => call[1])).toEqual(["wanFailover"]);
        sample("error"); sample("ok");
        expect(monitor.emit.mock.calls.map((call) => call[1])).toEqual(["wanFailover", "internetOffline", "internetRestored"]);
    });

    test("old, duplicate, late and unsupported WAN events are ignored", () => {
        const monitor = processor("observeInternet");
        const events = (rows) => monitor.handle({ latest: { health: [{ subsystem: "www", status: "ok" }], events: rows } });
        const base = { key: "EVT_GW_WANTransition", iface: "eth9", state: "active" };
        events([{ ...base, _id: "old", time: 999999 }, { ...base, key: "guessedEvent", time: 1000000 }]);
        jest.advanceTimersByTime(10000);
        events([{ ...base, _id: "new", time: 1010000 }]);
        events([{ ...base, _id: "late", time: 1005000, state: "failover" }, { ...base, _id: "new", time: 1010000 }]);
        expect(monitor.emit).toHaveBeenCalledTimes(1);
        expect(monitor.emit.mock.calls[0][1]).toBe("wanActive");
    });
});

describe("shared monitor scheduler", () => {
    beforeEach(() => jest.useFakeTimers({ now: 1000000 }));
    afterEach(() => jest.useRealTimers());
    const client = (id, target = "one") => ({ id, getSimpleMonitorDescriptor: () => ({ kind: "observeAvailability", target, intervalMs: 5000 }), handleSimpleMonitorUpdate: jest.fn() });

    test("shares one read, works with a connected websocket, stops on removal", async () => {
        const a = client("a"), b = client("b");
        const node = { nodeClients: [a, b], isUnofficialNetworkWebSocketConnected: () => true };
        const read = jest.fn(async () => ({ state: "OFFLINE" }));
        installSimpleMonitorScheduler(node, read);
        node.refreshSimpleMonitorScheduler();
        await node.pollSimpleMonitors();
        expect(read).toHaveBeenCalledTimes(1);
        expect(a.handleSimpleMonitorUpdate).toHaveBeenCalledTimes(1);
        expect(b.handleSimpleMonitorUpdate).toHaveBeenCalledTimes(1);
        node.nodeClients = [];
        node.refreshSimpleMonitorScheduler();
        await jest.advanceTimersByTimeAsync(10000);
        expect(read).toHaveBeenCalledTimes(1);
        node.stopSimpleMonitorScheduler();
        expect(jest.getTimerCount()).toBe(0);
    });

    test("no overlapping reads or delivery to removed/closed nodes", async () => {
        const a = client("a");
        const node = { nodeClients: [a] };
        let resolve;
        const read = jest.fn(() => new Promise((done) => { resolve = done; }));
        installSimpleMonitorScheduler(node, read);
        const pending = node.pollSimpleMonitors();
        await node.pollSimpleMonitors();
        expect(read).toHaveBeenCalledTimes(1);
        node.stopSimpleMonitorScheduler();
        resolve({ state: "OFFLINE" });
        await pending;
        expect(a.handleSimpleMonitorUpdate).not.toHaveBeenCalled();
    });

    test("staggered subscribers share the target's fastest interval", async () => {
        const a = client("a");
        const node = { nodeClients: [a] };
        const read = jest.fn(async () => ({ state: "ONLINE" }));
        installSimpleMonitorScheduler(node, read);
        await node.pollSimpleMonitors();
        jest.advanceTimersByTime(2000);
        const b = client("b");
        b.getSimpleMonitorDescriptor = () => ({ kind: "observeAvailability", target: "one", intervalMs: 10000 });
        node.nodeClients.push(b);
        await node.pollSimpleMonitors();
        expect(read).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(3000);
        await node.pollSimpleMonitors();
        expect(read).toHaveBeenCalledTimes(2);
        expect(b.handleSimpleMonitorUpdate).toHaveBeenCalledTimes(1);
        node.stopSimpleMonitorScheduler();
    });

    test("delivers errors separately while other targets still work", async () => {
        const a = client("a"), b = client("b", "two");
        const node = { nodeClients: [a, b] };
        installSimpleMonitorScheduler(node, async ({ target }) => {
            if (target === "one") throw new Error("No connection");
            return { state: "ONLINE" };
        });
        await node.pollSimpleMonitors();
        expect(a.handleSimpleMonitorUpdate.mock.calls[0][0].error.message).toBe("No connection");
        expect(b.handleSimpleMonitorUpdate.mock.calls[0][0].latest.state).toBe("ONLINE");
        node.stopSimpleMonitorScheduler();
    });
});
