"use strict";

const {
    expandHistoryEventTypes,
    extractProtectHistorySessionHeaders,
    normalizeProtectHistoryRequest,
    selectProtectHistoryEvents
} = require("../nodes/utils/unifi-protect-history");

describe("UniFi Protect history helpers", () => {
    test("expands ordinary motion into the complete detection family", () => {
        expect(expandHistoryEventTypes(["movimento"])).toEqual([
            "motion",
            "smartDetectZone",
            "smartDetectLine",
            "smartDetectLoiterZone"
        ]);
    });

    test("builds a bounded descending history page with explicit continuation", () => {
        const now = Date.parse("2026-09-09T12:00:00.000Z");
        const request = normalizeProtectHistoryRequest({
            from: "2026-09-09T08:00:00.000Z",
            to: "2026-09-09T11:00:00.000Z",
            eventType: "motion",
            objectTypes: ["Person"],
            offset: 100,
            limit: 999
        }, { now });
        expect(request).toMatchObject({
            from: "2026-09-09T08:00:00.000Z",
            to: "2026-09-09T11:00:00.000Z",
            offset: 100,
            limit: 100,
            pageSize: 100,
            objectTypes: ["person"]
        });
        expect(request.query).toMatchObject({
            offset: 100,
            limit: 100,
            orderDirection: "DESC",
            smartDetectTypes: ["person"]
        });
    });

    test("uses explicit supported camera types for an unfiltered history page", () => {
        const request = normalizeProtectHistoryRequest({}, {
            now: Date.parse("2026-09-09T12:00:00.000Z")
        });

        expect(request.query.types).toEqual(expect.arrayContaining([
            "motion",
            "ring",
            "smartDetectZone",
            "smartDetectLine"
        ]));
        expect(() => normalizeProtectHistoryRequest({ eventType: "recording" }))
            .toThrow("Unsupported UniFi Protect historical event type");
    });

    test("extracts only cookie pairs and the CSRF token from login", () => {
        expect(extractProtectHistorySessionHeaders({
            headers: {
                "set-cookie": [
                    "TOKEN=secret-token; Path=/; HttpOnly; Secure",
                    "other=value; Path=/"
                ],
                "x-csrf-token": "csrf-token"
            }
        })).toEqual({
            Cookie: "TOKEN=secret-token; other=value",
            "X-CSRF-Token": "csrf-token"
        });
    });

    test("filters normalized events without retaining an arbitrary first match", () => {
        const events = [
            { eventId: "old", cameraId: "controller:cam-1", eventType: "motion", objectTypes: [], at: "2026-09-09T09:00:00Z" },
            { eventId: "new", cameraId: "controller:cam-1", eventType: "smartDetectZone", objectTypes: ["person"], at: "2026-09-09T10:00:00Z" },
            { eventId: "other", cameraId: "controller:cam-2", eventType: "motion", objectTypes: [], at: "2026-09-09T11:00:00Z" }
        ];
        const selected = selectProtectHistoryEvents(events, {
            cameraId: "controller:cam-1",
            eventType: "motion",
            from: "2026-09-09T08:00:00Z",
            to: "2026-09-09T12:00:00Z",
            limit: 1
        });
        expect(selected.map((event) => event.eventId)).toEqual(["new"]);
    });
});
