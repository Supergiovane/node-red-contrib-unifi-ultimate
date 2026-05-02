#!/usr/bin/env node
"use strict";

const {
    fetchDeveloperPortalReport,
    writeReport
} = require("./unifi-registry-discovery-common");
const registry = require("../nodes/utils/unifi-network-device-registry");

async function main() {
    const report = await fetchDeveloperPortalReport({
        product: "network",
        defaultVersion: "latest",
        registry
    });

    const outputPath = writeReport("network", report);
    const candidates = report.docs.filter((doc) => doc.registryStatus === "candidate").length;
    console.log(`Report scritto: ${outputPath}`);
    console.log(`Endpoint/capability candidate da valutare: ${candidates}`);
}

main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
});
