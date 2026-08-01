"use strict";

const {
    normalizePresenceMatchBy,
    normalizeClientMatchName,
    getClientNameCandidates,
    findActiveClientsByName,
    resolveClientResourceId
} = require("../nodes/utils/unifi-network-presence-utils");

describe("unifi network presence utilities", () => {
    test("keeps id matching as the backward-compatible default", () => {
        expect(normalizePresenceMatchBy()).toBe("id");
        expect(normalizePresenceMatchBy("unexpected")).toBe("id");
        expect(normalizePresenceMatchBy("name")).toBe("name");
        expect(normalizePresenceMatchBy(" NAME ")).toBe("name");
    });

    test("normalizes client names for exact case-insensitive matching", () => {
        expect(normalizeClientMatchName("  Massimo's iPhone (offline) ")).toBe("massimo's iphone");
        expect(normalizeClientMatchName("Kitchen   iPad")).toBe("kitchen ipad");
    });

    test("collects aliases and hostnames from normalized and raw clients", () => {
        expect(getClientNameCandidates({
            name: "Massimo's iPhone",
            hostname: "iPhone-15",
            raw: { display_name: "Personal phone", hostname: "iPhone-15" }
        })).toEqual(["Massimo's iPhone", "iPhone-15", "Personal phone"]);
    });

    test("finds a renamed-id active client by hostname and ignores offline records", () => {
        const clients = [
            { id: "old-id", hostname: "Massimo-iPhone", offline: true },
            { id: "new-private-id", hostname: "massimo-iphone", online: true }
        ];

        expect(findActiveClientsByName(clients, "Massimo-iPhone").map((client) => client.id))
            .toEqual(["new-private-id"]);
    });

    test("treats duplicate active names as matches and resolves common id shapes", () => {
        const matches = findActiveClientsByName([
            { id: "first", name: "Kitchen iPad" },
            { clientId: "second", displayName: "KITCHEN IPAD" }
        ], "kitchen ipad");

        expect(matches).toHaveLength(2);
        expect(resolveClientResourceId(matches[0])).toBe("first");
        expect(resolveClientResourceId(matches[1])).toBe("second");
        expect(resolveClientResourceId({ mac: "aa:bb:cc:dd:ee:ff" })).toBe("aa:bb:cc:dd:ee:ff");
    });
});
