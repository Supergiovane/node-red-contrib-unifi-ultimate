"use strict";

const { EventEmitter } = require("events");
const { parseKnownPlates, namePlate, readRecentDetections } = require("../nodes/utils/unifi-protect-detections");

const now = Date.parse("2026-09-12T12:00:00Z");
const detection = (id, extra = {}) => ({ id, device: "camera-1", type: "smartDetectZone", start: now - 1000, smartDetectTypes: ["person"], ...extra });
const response = (payload) => ({ statusCode: 200, payload });

describe("Protect detections", () => {
    test("known plates ignore presentation differences but preserve OCR and leading zeros", () => {
        const names = parseKnownPlates("00-AB 123 = Family car\nCD456EF = Van");
        expect(namePlate({ text: "00ab123", confidence: 97 }, names)).toEqual({ text: "00ab123", confidence: 97, known: true, name: "Family car" });
        expect(namePlate({ text: "OOAB123" }, names)).toEqual({ text: "OOAB123", known: false });
        expect(() => parseKnownPlates("AB123CD")).toThrow("line 1");
        expect(() => parseKnownPlates("AB123CD = A\nAB-123-CD = B")).toThrow("different name");
    });

    test("history filters camera, time and detection locally when controller ignores filters", async () => {
        const request = jest.fn(async () => response([
            detection("person"), detection("other", { device: "camera-2" }),
            detection("old", { start: now - 25 * 3600000 }), detection("future", { start: now + 1000 }),
            detection("motion", { type: "motion", smartDetectTypes: [] })
        ]));
        const result = await readRecentDetections(request, "camera-1", { detectionType: "person" }, now);
        expect(result.events.map((item) => item.eventId)).toEqual(["person"]);
        expect(result.hasMore).toBe(false);
        expect(request.mock.calls[0][0].query).toEqual(expect.objectContaining({ cameras: ["camera-1"], orderDirection: "DESC" }));
    });

    test("history exposes normalized LPR names without image downloads", async () => {
        const request = jest.fn(async () => response([detection("plate", {
            smartDetectTypes: ["licensePlate"], metadata: { licensePlate: { name: "AB123CD", confidenceLevel: 90 } }
        })]));
        const result = await readRecentDetections(request, "camera-1", { detectionType: "licensePlate", knownPlates: "AB123CD = Family car" }, now);
        expect(result.events[0].plates[0]).toEqual({ text: "AB123CD", confidence: 90, known: true, name: "Family car" });
        expect(request).toHaveBeenCalledTimes(1);
    });

    test("history scans past non-matching pages and reports accurate continuation", async () => {
        const first = Array.from({ length: 100 }, (_, i) => detection(`motion-${i}`, { type: "motion", smartDetectTypes: [] }));
        const second = Array.from({ length: 100 }, (_, i) => detection(`person-${i}`));
        const request = jest.fn().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(second));
        const result = await readRecentDetections(request, "camera-1", { detectionType: "person", limit: 2 }, now);
        expect(result.events).toHaveLength(2);
        expect(result).toEqual(expect.objectContaining({ hasMore: true, nextOffset: 102, stoppedReason: "limit" }));
        expect(request.mock.calls[1][0].query.offset).toBe(100);
    });

    test("repeated pages stop the scan and mark it incomplete", async () => {
        const request = jest.fn(async () => response(Array.from({ length: 100 }, (_, i) => detection(`${i}`, { type: "motion" }))));
        const result = await readRecentDetections(request, "camera-1", { detectionType: "ring" }, now);
        expect(request).toHaveBeenCalledTimes(2);
        expect(result).toEqual(expect.objectContaining({ hasMore: true, stoppedReason: "repeated-page" }));
    });

    test("an empty page after a full page correctly marks the search complete", async () => {
        const request = jest.fn().mockResolvedValueOnce(response(Array.from({ length: 100 }, (_, i) => detection(`${i}`, { type: "motion" })))).mockResolvedValueOnce(response([]));
        const result = await readRecentDetections(request, "camera-1", { detectionType: "ring" }, now);
        expect(result).toEqual(expect.objectContaining({ hasMore: false, nextOffset: null, stoppedReason: "end" }));
    });

    test("bounds pathological scans and discards private error details", async () => {
        const request = jest.fn(async ({ query }) => response(Array.from({ length: 100 }, (_, i) => detection(`${query.offset}-${i}`, { type: "motion" }))));
        const result = await readRecentDetections(request, "camera-1", { detectionType: "ring" }, now);
        expect(request).toHaveBeenCalledTimes(10);
        expect(result.stoppedReason).toBe("scan-limit");
        await expect(readRecentDetections(async () => ({ statusCode: 403, payload: { error: "private-details" } }), "camera-1", {}, now)).rejects.toThrow("HTTP 403");
    });
});

function createLeaf(capability, options = {}, serverOptions = {}) {
    let Constructor;
    const server = { addClient: jest.fn(), removeClient: jest.fn(), fetchDeviceByTypeAndId: jest.fn(async () => ({ id: "camera-1", name: "Driveway" })),
        takeKnxAiCameraEventSnapshot: jest.fn(async ({ eventId }) => ({ eventId, data: Buffer.from("event-jpeg"), mediaType: "image/jpeg" })),
        ...serverOptions };
    require("../nodes/unifi-protect-device")({ nodes: {
        createNode(node) {
            const emitter = new EventEmitter();
            node.on = emitter.on.bind(emitter); node.emit = emitter.emit.bind(emitter);
            for (const method of ["send", "status", "error", "warn"]) node[method] = jest.fn();
        },
        getNode: () => server, registerType: (_type, fn) => { Constructor = fn; }
    } });
    const node = new Constructor({ server: "config", deviceType: "camera", deviceId: "camera-1", capability, capabilityConfig: JSON.stringify(options), name: "Driveway" });
    return { node, server };
}
async function flush() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }
function update(node, event) { node.handleProtectEventUpdate({ type: "add", item: { ...event, modelKey: "event" } }); }

describe("Protect photo and history nodes", () => {
    test("event photo emits only the matching event's image once, without startup state", async () => {
        const { node, server } = createLeaf("observeWithImage", { detectionType: "person" });
        await flush();
        expect(node.send).not.toHaveBeenCalled();
        update(node, detection("other", { device: "camera-2" }));
        update(node, detection("motion", { type: "motion", smartDetectTypes: [] }));
        update(node, detection("one")); update(node, detection("one"));
        await flush();
        update(node, detection("one", { end: now }));
        expect(server.takeKnxAiCameraEventSnapshot).toHaveBeenCalledTimes(1);
        expect(server.takeKnxAiCameraEventSnapshot).toHaveBeenCalledWith({ eventId: "one" });
        expect(node.send).toHaveBeenCalledTimes(1);
        expect(node.send.mock.calls[0][0]).toEqual(expect.objectContaining({ eventName: "detectionWithImage", image: Buffer.from("event-jpeg"), imageType: "image/jpeg", payload: expect.objectContaining({ eventId: "one" }) }));
        node.emit("close");
    });

    test("image failure uses output 2 and a later event update can retry", async () => {
        const snapshot = jest.fn().mockRejectedValueOnce(new Error("HTTP 404")).mockResolvedValueOnce({ data: Buffer.from("jpeg"), mediaType: "image/jpeg" });
        const { node } = createLeaf("observeWithImage", {}, { takeKnxAiCameraEventSnapshot: snapshot });
        update(node, detection("one")); await flush();
        expect(node.send.mock.calls[0][0][0]).toBeNull();
        update(node, detection("one", { end: now })); await flush();
        expect(node.send.mock.calls[1][0].eventName).toBe("detectionWithImage");
        node.emit("close");
    });

    test("an update during a failed image request is retried, and close suppresses pending delivery", async () => {
        let reject;
        const snapshot = jest.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValueOnce({ data: Buffer.from("jpeg"), mediaType: "image/jpeg" });
        const { node } = createLeaf("observeWithImage", {}, { takeKnxAiCameraEventSnapshot: snapshot });
        update(node, detection("one")); await flush();
        update(node, detection("one", { end: now }));
        reject(new Error("not ready")); await flush();
        expect(snapshot).toHaveBeenCalledTimes(2);
        node.emit("close");
        update(node, detection("two")); await flush();
        expect(snapshot).toHaveBeenCalledTimes(2);
    });

    test("recent history action uses configured options and sends the list on an Inject trigger", async () => {
        const read = jest.fn(async () => ({ events: [{ eventId: "one" }], hasMore: false, nextOffset: null }));
        const { node } = createLeaf("getRecentDetections", { hours: 24, detectionType: "person" }, { readRecentDetections: read });
        const send = jest.fn();
        await new Promise((resolve, reject) => node.emit("input", { payload: { hours: 99 } }, send, (error) => error ? reject(error) : resolve()));
        expect(read).toHaveBeenCalledWith("camera-1", { hours: 24, detectionType: "person" });
        expect(send.mock.calls[0][0]).toEqual(expect.objectContaining({ eventName: "recentDetections", payload: [{ eventId: "one" }], details: expect.objectContaining({ history: { hasMore: false, nextOffset: null } }) }));
        node.emit("close");
    });
});
