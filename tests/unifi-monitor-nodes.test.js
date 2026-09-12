"use strict";

const { EventEmitter } = require("events");
const { installSimpleMonitorScheduler } = require("../nodes/utils/unifi-simple-monitor");

function harness(product, capability, deviceType, options) {
    let Constructor;
    let state = product === "access" ? { id: "one", name: "Front door", door_position_status: "close" } : { id: "one", name: "AP", state: "ONLINE" };
    const server = { nodeClients: [],
        addClient(node) { this.nodeClients.push(node); },
        removeClient(node) { this.nodeClients = this.nodeClients.filter((entry) => entry !== node); this.refreshSimpleMonitorScheduler(); },
        fetchDeviceByTypeAndId: jest.fn(async () => state),
        readSimpleMonitor: jest.fn(async () => state) };
    installSimpleMonitorScheduler(server, async () => state);
    require(`../nodes/unifi-${product}-device`)({ nodes: {
        createNode(node) {
            const emitter = new EventEmitter();
            node.id = "leaf"; node.on = emitter.on.bind(emitter); node.emit = emitter.emit.bind(emitter);
            for (const method of ["send", "warn", "error", "status"]) node[method] = jest.fn();
        },
        getNode: () => server, registerType: (_type, fn) => { Constructor = fn; }
    } });
    const node = new Constructor({ server: "config", name: "Test monitor", deviceType, deviceId: "one", capability, capabilityConfig: JSON.stringify(options) });
    return { node, server, setState: (value) => { state = value; }, close: () => { node.emit("close"); server.stopSimpleMonitorScheduler(); } };
}

describe("monitor leaf nodes", () => {
    beforeEach(() => jest.useFakeTimers({ now: 1000000 }));
    afterEach(() => jest.useRealTimers());

    test("Access polling confirms the threshold; only this door's DPS closure restores it", async () => {
        const h = harness("access", "observeDoorOpenTooLong", "door", { delaySeconds: 10 });
        await jest.advanceTimersByTimeAsync(5000);
        expect(h.node.send).not.toHaveBeenCalled();
        h.setState({ id: "one", name: "Front door", door_position_status: "open" });
        await jest.advanceTimersByTimeAsync(15000);
        expect(h.node.send).toHaveBeenCalledTimes(1);
        expect(h.node.send.mock.calls[0][0]).toEqual(expect.objectContaining({ eventName: "doorOpenTooLong", payload: expect.objectContaining({ open: true }) }));
        h.node.handleAccessEventUpdate({ event: "access.device.dps_status", data: { location: { id: "another-door" }, object: { status: "close" } } });
        expect(h.node.send).toHaveBeenCalledTimes(1);
        h.node.handleAccessEventUpdate({ event: "access.device.dps_status", data: { location: { id: "one" }, object: { status: "close" } } });
        expect(h.node.send.mock.calls[1][0].eventName).toBe("doorClosed");
        h.close();
        expect(jest.getTimerCount()).toBe(0);
    });

    test("Network offline/restored reports friendly values and closes the shared timer", async () => {
        const h = harness("network", "observeAvailability", "device", { delaySeconds: 5, pollSeconds: 5 });
        await jest.advanceTimersByTimeAsync(5000);
        expect(h.node.send).not.toHaveBeenCalled();
        h.setState({ state: "OFFLINE", name: "AP" });
        await jest.advanceTimersByTimeAsync(10000);
        h.setState({ state: "ONLINE", name: "AP" });
        await jest.advanceTimersByTimeAsync(5000);
        expect(h.node.send.mock.calls.map(([message]) => message.eventName)).toEqual(["deviceOffline", "deviceRestored"]);
        expect(h.node.send.mock.calls[1][0]).toEqual(expect.objectContaining({ deviceName: "AP", topic: "Test monitor", payload: expect.objectContaining({ online: true }) }));
        h.close();
        await jest.advanceTimersByTimeAsync(10000);
        expect(h.node.send).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(0);
    });
});
