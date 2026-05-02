#!/usr/bin/env node
"use strict";

const {
    fetchAccessPdfReport,
    writeReport
} = require("./unifi-registry-discovery-common");
const registry = require("../nodes/utils/unifi-access-device-registry");

async function main() {
    const report = await fetchAccessPdfReport({
        registry
    });

    const outputPath = writeReport("access", report);
    const candidates = report.docs.filter((doc) => doc.registryStatus === "candidate").length;
    console.log(`Report scritto: ${outputPath}`);
    console.log(`Endpoint/capability candidate da valutare: ${candidates}`);
}

main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
});
