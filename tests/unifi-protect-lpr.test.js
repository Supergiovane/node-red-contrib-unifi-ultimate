"use strict";

const { extractLicensePlates, isLicensePlateEvent } = require("../nodes/utils/unifi-protect-lpr");
const { getCapabilityOptions, resolveObservableEventValue, resolveObservableState } = require("../nodes/utils/unifi-protect-device-registry");

function plateEvent(extra = {}) {
    return { type: "smartDetectZone", smartDetectTypes: ["vehicle", "licensePlate"], ...extra };
}

describe("Protect license plate extraction", () => {
    test("extracts legacy OCR text and confidence without converting leading zeroes", () => {
        expect(extractLicensePlates(plateEvent({
            metadata: { licensePlate: { name: " 001AB234 ", confidenceLevel: 94 } }
        }))).toEqual([{ text: "001AB234", confidence: 94 }]);
    });

    test("extracts multiple Protect 6 vehicle thumbnails and ignores named faces", () => {
        expect(extractLicensePlates(plateEvent({
            metadata: {
                detectedThumbnails: [
                    { type: "vehicle", name: "AB123CD", attributes: { color: { val: "black", confidence: 98 } } },
                    { type: "face", name: "A person" },
                    { type: "licensePlate", name: "EF456GH" },
                    { type: "vehicle", name: "AB123CD" }
                ]
            }
        }))).toEqual([{ text: "AB123CD" }, { text: "EF456GH" }]);
    });

    test("deduplicates the same plate across legacy metadata and thumbnails", () => {
        expect(extractLicensePlates(plateEvent({
            metadata: {
                licensePlate: { name: "AB123CD", confidenceLevel: 0 },
                detectedThumbnails: [{ type: "vehicle", name: "ab123cd" }]
            }
        }))).toEqual([{ text: "AB123CD", confidence: 0 }]);
    });

    test.each([null, {}, { metadata: null }, { metadata: [] },
        { metadata: { licensePlate: { name: {}, confidenceLevel: 99 } } },
        { metadata: { detectedThumbnails: [null, { type: "vehicle", name: "My car" }] } },
        plateEvent({ metadata: { licensePlate: { name: " " }, detectedThumbnails: "invalid" } })
    ])("ignores absent or invalid OCR metadata: %j", (event) => {
        expect(extractLicensePlates(event)).toEqual([]);
    });

    test("does not confuse detection confidence with OCR confidence", () => {
        expect(extractLicensePlates(plateEvent({
            score: 98,
            metadata: { licensePlate: { name: "AB123CD", confidenceLevel: "unknown" } }
        }))).toEqual([{ text: "AB123CD" }]);
    });

    test.each(["smartDetectZone", "smartDetectLine", "smartDetectLoiterZone"])("recognizes %s LPR events without requiring text yet", (type) => {
        expect(isLicensePlateEvent(plateEvent({ type }))).toBe(true);
        expect(isLicensePlateEvent(plateEvent({ type, smartDetectTypes: ["vehicle"] }))).toBe(false);
    });

    test("ignores unrelated event types even when they carry plate-like metadata", () => {
        expect(isLicensePlateEvent(plateEvent({ type: "ring" }))).toBe(false);
    });
});

describe("Protect LPR editor and observable", () => {
    test("offers a camera LPR event and keeps the selection when loading its fields", async () => {
        const result = await getCapabilityOptions("camera", "observe", {
            capabilityConfig: { observable: "licensePlate" }
        });
        expect(result.fields[0]).toMatchObject({
            id: "observable",
            defaultValue: "licensePlate",
            options: expect.arrayContaining([{ value: "licensePlate", label: "License Plate (LPR)" }]),
            helpText: expect.stringContaining("msg.payload")
        });
        const sensor = await getCapabilityOptions("sensor", "observe", {});
        expect(sensor.fields[0].options.map((option) => option.value)).not.toContain("licensePlate");
    });

    test("returns text even for a completed event, and never a boolean for a detection without OCR", () => {
        expect(resolveObservableEventValue("camera", plateEvent({
            end: 12345,
            metadata: { licensePlate: { name: "AB123CD" } }
        }), "licensePlate")).toMatchObject({ matched: true, value: "AB123CD" });
        expect(resolveObservableEventValue("camera", plateEvent(), "licensePlate")).toMatchObject({
            matched: false, value: undefined
        });
        expect(resolveObservableState("camera", { isSmartDetecting: true }, "licensePlate")).toBeUndefined();
    });
});
