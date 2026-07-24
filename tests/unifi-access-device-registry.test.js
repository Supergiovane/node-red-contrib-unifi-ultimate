"use strict";

const {
    buildCapabilityRequest,
    getCapabilitiesForType,
    getDeviceTypeDefinition,
    summarizeDevice
} = require("../nodes/utils/unifi-access-device-registry");

describe("new read-only UniFi Access resources", () => {
    test.each([
        ["visitor", "/api/v1/developer/visitors", "/api/v1/developer/visitors/:id", true],
        ["accessPolicy", "/api/v1/developer/access_policies", "/api/v1/developer/access_policies/:id", false],
        ["schedule", "/api/v1/developer/access_policies/schedules", "/api/v1/developer/access_policies/schedules/:id", false],
        ["holidayGroup", "/api/v1/developer/access_policies/holiday_groups", "/api/v1/developer/access_policies/holiday_groups/:id", false],
        ["doorGroup", "/api/v1/developer/door_groups", "/api/v1/developer/door_groups/:id", false]
    ])("%s exposes state reads with the expected event behavior", (type, listPath, detailPath, supportsEvents) => {
        expect(getDeviceTypeDefinition(type)).toMatchObject({
            type,
            listPath,
            detailPath
        });

        const capabilityIds = getCapabilitiesForType(type).map((capability) => capability.id);
        expect(capabilityIds).toContain("getDetails");
        expect(capabilityIds.includes("observe")).toBe(supportsEvents);
    });

    test("door groups expose the topology read action", () => {
        expect(buildCapabilityRequest("doorGroup", "readDoorGroupTopology", "group-id"))
            .toMatchObject({
                method: "GET",
                path: "/api/v1/developer/door_groups/topology"
            });
    });

    test("recent system logs use a bounded POST collection request", () => {
        const definition = getDeviceTypeDefinition("systemLog");
        const payload = definition.listPayload();

        expect(definition).toMatchObject({
            listMethod: "POST",
            listPath: "/api/v1/developer/system/logs",
            collectionPath: "hits",
            supportsEvents: false
        });
        expect(payload).toMatchObject({ topic: "all" });
        expect(payload.until - payload.since).toBe(86400);
        expect(getCapabilitiesForType("systemLog").map((capability) => capability.id))
            .toEqual(["getDetails"]);
    });

    test("summarizes visitors and log entries for editor selectors", () => {
        expect(summarizeDevice("visitor", {
            id: "visitor-1",
            first_name: "Ada",
            last_name: "Lovelace",
            status: "ACTIVE"
        })).toMatchObject({
            id: "visitor-1",
            name: "Ada Lovelace",
            state: "ACTIVE"
        });

        expect(summarizeDevice("systemLog", {
            _id: "log-1",
            event: "access.door.unlock",
            created_at: "2026-07-24T12:00:00Z"
        })).toMatchObject({
            id: "log-1",
            name: "access.door.unlock",
            state: "2026-07-24T12:00:00Z"
        });
    });
});
