"use strict";

const { EventEmitter } = require("events");
const registerProtectNode = require("../nodes/unifi-protect-device");

function createNode({ config = {}, serverOptions = {} } = {}) {
    let ProtectNode;
    let registration;
    const server = {
        addClient: jest.fn(),
        removeClient: jest.fn(),
        fetchDeviceByTypeAndId: jest.fn(async () => ({ id: "camera-1", name: "Driveway", modelKey: "camera" })),
        fetchLicensePlateEvent: jest.fn(),
        ...serverOptions
    };
    const RED = {
        nodes: {
            createNode(node) {
                const emitter = new EventEmitter();
                node.on = emitter.on.bind(emitter);
                node.emit = emitter.emit.bind(emitter);
                node.send = jest.fn();
                node.status = jest.fn();
                node.error = jest.fn();
                node.warn = jest.fn();
            },
            getNode: () => server,
            registerType(_name, constructor, options) {
                ProtectNode = constructor;
                registration = options;
            }
        }
    };
    registerProtectNode(RED);
    const node = new ProtectNode({
        name: "Gate LPR",
        server: "protect-config",
        deviceType: "camera",
        deviceId: "camera-1",
        capability: "observe",
        capabilityConfig: JSON.stringify({ observable: "licensePlate" }),
        ...config
    });
    return { node, server, registration };
}

function eventUpdate(extra = {}, type = "add") {
    return {
        type,
        item: {
            id: "event-1", modelKey: "event", device: "camera-1", type: "smartDetectZone",
            smartDetectTypes: ["vehicle", "licensePlate"], start: 1000, end: null,
            ...extra
        }
    };
}

const metadata = { licensePlate: { name: "AB123CD", confidenceLevel: 95 } };

describe("Protect LPR node", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("listens at deploy without emitting startup state, device updates or unrelated events", async () => {
        const { node, server, registration } = createNode();
        await Promise.resolve();
        expect(registration).toBeUndefined();
        expect(server.addClient).toHaveBeenCalledWith(node);
        expect(node.protectStreams).toEqual(["events"]);
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "camera-1", modelKey: "camera", isSmartDetecting: true } });
        await node.handleProtectEventUpdate(eventUpdate({ type: "motion" }));
        await node.handleProtectEventUpdate(eventUpdate({ smartDetectTypes: ["person"] }));
        await node.handleProtectEventUpdate(eventUpdate({ device: "camera-2", metadata }));
        expect(node.send).not.toHaveBeenCalled();
        expect(server.fetchLicensePlateEvent).not.toHaveBeenCalled();
        node.emit("close");
    });

    test("emits plate text once per event with context and allows the same plate in a new event", async () => {
        const { node, server } = createNode();
        await Promise.resolve();
        await node.handleProtectEventUpdate(eventUpdate({ metadata }));
        await node.handleProtectEventUpdate(eventUpdate({ metadata, end: 2000 }, "update"));
        expect(node.send).toHaveBeenCalledTimes(1);
        expect(node.send.mock.calls[0][0]).toMatchObject({
            payload: "AB123CD", topic: "Gate LPR", deviceName: "Driveway", eventName: "licensePlate",
            details: {
                lpr: { text: "AB123CD", confidence: 95, eventId: "event-1" },
                raw: { event: { metadata }, observable: "licensePlate" },
                unifiProtect: { observable: "licensePlate", eventType: "smartDetectZone" }
            }
        });
        await node.handleProtectEventUpdate(eventUpdate({ id: "event-2", metadata }));
        expect(node.send).toHaveBeenCalledTimes(2);
        expect(server.fetchLicensePlateEvent).not.toHaveBeenCalled();
        node.emit("close");
    });

    test("retrieves missing OCR through the config node without exposing credentials", async () => {
        const { node, server } = createNode();
        server.fetchLicensePlateEvent.mockResolvedValue({ id: "event-1", camera: "camera-1", metadata });
        await node.handleProtectEventUpdate(eventUpdate());
        expect(server.fetchLicensePlateEvent).toHaveBeenCalledWith("event-1", "camera-1", { quick: true });
        expect(node.send).toHaveBeenCalledTimes(1);
        expect(node.send.mock.calls[0][0].payload).toBe("AB123CD");
        expect(JSON.stringify(node.send.mock.calls)).not.toMatch(/lpr-user|lpr-secret|historyCredentials/);
        node.emit("close");
    });

    test("emits multiple plates and OCR corrections while filtering duplicate updates", async () => {
        const { node } = createNode();
        await node.handleProtectEventUpdate(eventUpdate({ metadata }));
        const corrected = { detectedThumbnails: [
            { type: "vehicle", name: "AB123CE" },
            { type: "vehicle", name: "EF456GH" }
        ] };
        await node.handleProtectEventUpdate(eventUpdate({ metadata: corrected }, "update"));
        await node.handleProtectEventUpdate(eventUpdate({ metadata: corrected, end: 2000 }, "update"));
        expect(node.send.mock.calls.map(([msg]) => msg.payload)).toEqual(["AB123CD", "AB123CE", "EF456GH"]);
        node.emit("close");
    });

    test("retains an update received during a lookup and serializes lookups for the same event", async () => {
        const { node, server } = createNode();
        let finishLookup;
        server.fetchLicensePlateEvent.mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve; }));
        const first = node.handleProtectEventUpdate(eventUpdate());
        await Promise.resolve();
        const second = node.handleProtectEventUpdate(eventUpdate({ end: 2000 }, "update"));
        expect(server.fetchLicensePlateEvent).toHaveBeenCalledTimes(1);
        server.fetchLicensePlateEvent.mockResolvedValue({ id: "event-1", camera: "camera-1", metadata });
        finishLookup({ id: "event-1", camera: "camera-1" });
        await Promise.all([first, second]);
        expect(server.fetchLicensePlateEvent).toHaveBeenCalledTimes(2);
        expect(node.send).toHaveBeenCalledTimes(1);
        expect(node.send.mock.calls[0][0].payload).toBe("AB123CD");
        node.emit("close");
    });

    test("waits for later OCR metadata without emitting empty results", async () => {
        const { node, server } = createNode();
        server.fetchLicensePlateEvent.mockResolvedValue({ id: "event-1", camera: "camera-1" });
        await node.handleProtectEventUpdate(eventUpdate());
        expect(node.send).not.toHaveBeenCalled();
        await node.handleProtectEventUpdate(eventUpdate({ metadata, end: 2000 }, "update"));
        expect(node.send.mock.calls[0][0].payload).toBe("AB123CD");
        node.emit("close");
    });

    test("reports missing shared credentials once and still accepts metadata from a later update", async () => {
        const { node, server } = createNode();
        server.fetchLicensePlateEvent.mockRejectedValue(Object.assign(
            new Error("Configure Local User and Local Password in the UniFi Protect config node."),
            { code: "UNIFI_PROTECT_HISTORY_CREDENTIALS_REQUIRED" }
        ));
        await node.handleProtectEventUpdate(eventUpdate());
        await node.handleProtectEventUpdate(eventUpdate({}, "update"));
        expect(server.fetchLicensePlateEvent).toHaveBeenCalledTimes(2);
        expect(node.send).toHaveBeenCalledTimes(1);
        expect(node.send.mock.calls[0][0]).toEqual([null, expect.objectContaining({
            error: expect.objectContaining({ message: expect.stringContaining("Local User and Local Password") })
        })]);
        await node.handleProtectEventUpdate(eventUpdate({ metadata }));
        expect(node.send.mock.calls[1][0].payload).toBe("AB123CD");
        node.emit("close");
    });

    test("forwards lookup failures to the error output and can recover on the next update", async () => {
        const { node, server } = createNode();
        server.fetchLicensePlateEvent.mockRejectedValueOnce(new Error("Unable to read UniFi Protect license plate (HTTP 403)."));
        await node.handleProtectEventUpdate(eventUpdate());
        expect(node.error).toHaveBeenCalledTimes(1);
        expect(node.send.mock.calls[0][0][1].error.message).toContain("HTTP 403");
        server.fetchLicensePlateEvent.mockResolvedValue({ id: "event-1", camera: "camera-1", metadata });
        await node.handleProtectEventUpdate(eventUpdate({}, "update"));
        expect(node.send.mock.calls[1][0].payload).toBe("AB123CD");
        node.emit("close");
    });

    test("discards lookup results after the node closes", async () => {
        const { node, server } = createNode();
        let finishLookup;
        server.fetchLicensePlateEvent.mockImplementation(() => new Promise((resolve) => { finishLookup = resolve; }));
        const pending = node.handleProtectEventUpdate(eventUpdate());
        await Promise.resolve();
        node.emit("close");
        finishLookup({ id: "event-1", camera: "camera-1", metadata });
        await pending;
        expect(node.send).not.toHaveBeenCalled();
        expect(server.removeClient).toHaveBeenLastCalledWith(node);
    });

    test("warms the configured account when LPR observation starts", async () => {
        const prepareLicensePlateSession = jest.fn(async () => {});
        const { node } = createNode({ serverOptions: { prepareLicensePlateSession } });
        await Promise.resolve();
        expect(prepareLicensePlateSession).toHaveBeenCalledTimes(1);
        node.emit("close");
    });

    test("native plate text bypasses an outstanding lookup and its stale result", async () => {
        const { node, server } = createNode();
        let finishLookup;
        server.fetchLicensePlateEvent.mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve; }));
        const pending = node.handleProtectEventUpdate(eventUpdate());
        await Promise.resolve();
        node.handleProtectEventUpdate(eventUpdate({ metadata }, "update"));
        expect(node.send.mock.calls[0][0].payload).toBe("AB123CD");
        finishLookup({ id: "event-1", camera: "camera-1", metadata: { licensePlate: { name: "OLD123", confidenceLevel: 40 } } });
        await pending;
        expect(node.send).toHaveBeenCalledTimes(1);
        node.emit("close");
    });

    test("emits an early low-confidence reading, then a correction without another live event", async () => {
        const { node, server } = createNode();
        server.fetchLicensePlateEvent
            .mockResolvedValueOnce({ id: "event-1", camera: "camera-1", metadata: { licensePlate: { name: "AB123CE", confidenceLevel: 30 } } })
            .mockResolvedValue({ id: "event-1", camera: "camera-1", metadata });
        await node.handleProtectEventUpdate(eventUpdate());
        expect(node.send.mock.calls[0][0]).toMatchObject({ payload: "AB123CE", details: { lpr: { confidence: 30, isUpdate: false } } });
        await jest.advanceTimersByTimeAsync(150);
        expect(node.send.mock.calls[1][0]).toMatchObject({ payload: "AB123CD", details: { lpr: { confidence: 95, isUpdate: true } } });
        await jest.runAllTimersAsync();
        expect(node.send).toHaveBeenCalledTimes(2);
        expect(server.fetchLicensePlateEvent).toHaveBeenCalledTimes(6);
        node.emit("close");
    });

    test("starts looking at vehicle detection before the live LPR classification arrives", async () => {
        const { node, server } = createNode();
        server.fetchLicensePlateEvent.mockResolvedValue({ id: "event-1", camera: "camera-1", metadata });
        await node.handleProtectEventUpdate(eventUpdate({ smartDetectTypes: ["vehicle"] }));
        expect(server.fetchLicensePlateEvent).toHaveBeenCalledWith("event-1", "camera-1", { quick: true });
        expect(node.send.mock.calls[0][0].payload).toBe("AB123CD");
        node.emit("close");
    });

    test("vehicle detection alone never invents plate text from unrelated thumbnail names", async () => {
        const { node, server } = createNode();
        server.fetchLicensePlateEvent.mockResolvedValue({ id: "event-1", camera: "camera-1", smartDetectTypes: ["vehicle"], metadata: { detectedThumbnails: [{ type: "vehicle", name: "Car" }] } });
        await node.handleProtectEventUpdate(eventUpdate({ smartDetectTypes: ["vehicle"] }));
        await jest.runAllTimersAsync();
        expect(node.send).not.toHaveBeenCalled();
        node.emit("close");
    });

    test("emits improved confidence for unchanged text, suppressing duplicates and regressions", async () => {
        const { node } = createNode();
        await node.handleProtectEventUpdate(eventUpdate({ metadata: { licensePlate: { name: "AB123CD", confidenceLevel: 30 } } }));
        await node.handleProtectEventUpdate(eventUpdate({ metadata }, "update"));
        await node.handleProtectEventUpdate(eventUpdate({ metadata }, "update"));
        await node.handleProtectEventUpdate(eventUpdate({ metadata: { licensePlate: { name: "AB123CD", confidenceLevel: 70 } } }, "update"));
        expect(node.send).toHaveBeenCalledTimes(2);
        expect(node.send.mock.calls.map(([message]) => message.payload)).toEqual(["AB123CD", "AB123CD"]);
        expect(node.send.mock.calls[1][0].details.lpr).toMatchObject({ confidence: 95, isUpdate: true });
        expect(node.send.mock.calls[1][0].details.lpr).not.toHaveProperty("revision");
        node.emit("close");
    });

    test("cancels scheduled OCR refinements on close", async () => {
        const { node, server } = createNode();
        server.fetchLicensePlateEvent.mockResolvedValue({ id: "event-1", camera: "camera-1", metadata });
        await node.handleProtectEventUpdate(eventUpdate());
        node.emit("close");
        await jest.runAllTimersAsync();
        expect(server.fetchLicensePlateEvent).toHaveBeenCalledTimes(1);
    });

    test("preserves existing All and camel-case smart detection observations", async () => {
        const all = createNode({ config: { capabilityConfig: '{"observable":"all"}' } });
        await Promise.resolve();
        all.node.send.mockClear();
        await all.node.handleProtectEventUpdate(eventUpdate());
        expect(all.node.send.mock.calls[0][0].payload.event.type).toBe("smartDetectZone");
        all.node.emit("close");
        const smart = createNode({ config: { capabilityConfig: '{"observable":"smartDetectZone"}' } });
        await Promise.resolve();
        smart.node.send.mockClear();
        await smart.node.handleProtectEventUpdate(eventUpdate());
        expect(smart.node.send.mock.calls[0][0].payload).toBe(true);
        expect(smart.node.send.mock.calls[1][0].payload.event.type).toBe("smartDetectZone");
        smart.node.emit("close");
    });
});
