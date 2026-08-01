"use strict";

const fs = require("fs");
const path = require("path");

function readNodeEditor(fileName) {
    return fs.readFileSync(path.join(__dirname, "..", "nodes", fileName), "utf8");
}

describe("dynamic editor selection persistence", () => {
    test.each([
        "unifi-access-device.html",
        "unifi-protect-device.html",
        "unifi-network-device.html"
    ])("%s retains a saved device missing from discovery", (fileName) => {
        const source = readNodeEditor(fileName);
        expect(source).toContain("(saved; currently unavailable)");
        expect(source).toContain('.attr("data-unavailable", "true")');
    });

    test("network device retains its saved client while the list is loading", () => {
        const source = readNodeEditor("unifi-network-device.html");
        expect(source).toContain('const savedValue = getCurrentOrNodeValue($deviceId, node.deviceId, "")');
        expect(source).toContain('text(savedName + " (loading...)")');
    });

    test("presence protects both client and network selections", () => {
        const source = readNodeEditor("unifi-network-presence.html");
        const unavailableMarkers = source.match(/saved; currently unavailable/g) || [];
        expect(unavailableMarkers.length).toBeGreaterThanOrEqual(2);
        expect(source).toContain("function renderClientsLoading()");
        expect(source).toContain("function renderNetworksLoading()");
        expect(source).toContain("<i class=\"fa fa-font\"></i> Match name</label>");
        expect(source).toContain('<input type="text" id="node-input-clientName" readonly>');
    });

    test("restart retains configured devices missing from discovery", () => {
        const source = readNodeEditor("unifi-network-restart.html");
        expect(source).toContain("unifi-restart-device-unavailable");
        expect(source).toContain('text("saved; currently unavailable")');
        expect(source).toContain("storedIds.forEach(function (id)");
    });
});
