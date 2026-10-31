"use strict";

const LICENSE_PLATE_EVENT_TYPES = ["smartDetectZone", "smartDetectLine", "smartDetectLoiterZone"];

function extractLicensePlates(event) {
    const metadata = event && event.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];

    const plates = new Map();
    function addPlate(name, confidence) {
        if (typeof name !== "string" || !name.trim()) return;
        const text = name.trim();
        const key = text.toUpperCase();
        const plate = plates.get(key) || { text };
        // Event scores and vehicle/color confidence are not OCR confidence.
        if (typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 100) {
            plate.confidence = confidence;
        }
        plates.set(key, plate);
    }

    // Older Protect versions report the OCR result directly; Protect 6 also
    // reports it as the name of a detected vehicle thumbnail.
    const legacyPlate = metadata.licensePlate;
    if (legacyPlate && typeof legacyPlate === "object") {
        addPlate(legacyPlate.name, legacyPlate.confidenceLevel);
    }
    const hasPlateType = Array.isArray(event.smartDetectTypes) && event.smartDetectTypes.includes("licensePlate");
    const thumbnails = Array.isArray(metadata.detectedThumbnails) ? metadata.detectedThumbnails : [];
    thumbnails.forEach((thumbnail) => {
        if (!thumbnail || typeof thumbnail !== "object") return;
        if (thumbnail.type === "licensePlate" || (thumbnail.type === "vehicle" && hasPlateType)) {
            // `name` is the OCR of a single frame and is often truncated or
            // misread ("4II0"); `matchedName` is the plate Protect settles on
            // across the whole track and shows in its own UI.
            const attributes = thumbnail.attributes && typeof thumbnail.attributes === "object" ? thumbnail.attributes : {};
            const matchedName = typeof attributes.matchedName === "string" ? attributes.matchedName.trim() : "";
            addPlate(matchedName || thumbnail.name);
        }
    });
    return Array.from(plates.values());
}

function isLicensePlateEvent(event) {
    return Boolean(event && LICENSE_PLATE_EVENT_TYPES.includes(event.type)
        && ((Array.isArray(event.smartDetectTypes) && event.smartDetectTypes.includes("licensePlate"))
            || extractLicensePlates(event).length > 0));
}

module.exports = {
    LICENSE_PLATE_EVENT_TYPES,
    extractLicensePlates,
    isLicensePlateEvent
};
