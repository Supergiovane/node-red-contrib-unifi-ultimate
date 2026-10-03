"use strict";

// Human-friendly metadata used to turn raw Protect field names into editor
// labels/help text when "Update One Property" discovers patchable paths.
const COMMON_FIELD_METADATA = {
    name: {
        label: "Name",
        description: "Human-readable name shown in UniFi Protect.",
        source: "official"
    },
    displayName: {
        label: "Display Name",
        description: "Display label exposed by UniFi Protect for this object.",
        source: "official"
    },
    isDark: {
        label: "Low Light Detected",
        description: "Reports whether the device currently considers the scene to be dark.",
        source: "inferred"
    },
    volume: {
        label: "Volume",
        description: "Audio volume level used by the device.",
        unit: "%",
        source: "inferred"
    }
};

// Device-family-specific metadata overrides or extends the common dictionary.
const TYPE_FIELD_METADATA = {
    nvr: {
        armStatus: {
            label: "Alarm Status (Local)",
            description: "Local Alarm Manager status from armMode.status. Kept as a string, including transitional states; it may differ from an Alarm Hub's armed state.",
            source: "official"
        }
    },
    camera: {
        isMicEnabled: {
            label: "Microphone Enabled",
            description: "Controls whether the camera microphone is active.",
            source: "inferred"
        },
        isRecording: {
            label: "Recording Enabled",
            description: "Controls whether the camera is recording.",
            source: "inferred"
        },
        isMotionDetected: {
            label: "Motion Detected",
            description: "Current motion detection state reported by the camera.",
            source: "inferred"
        },
        lcdMessage: {
            label: "Doorbell Message",
            description: "Message currently shown on the camera display.",
            source: "official"
        },
        "lcdMessage.type": {
            label: "Doorbell Message Type",
            description: "Defines whether the doorbell message is predefined, custom text, or an image asset.",
            source: "official"
        },
        "lcdMessage.text": {
            label: "Doorbell Message Text",
            description: "Text or asset identifier associated with the current doorbell message.",
            source: "official"
        },
        "lcdMessage.resetAt": {
            label: "Doorbell Message Reset Time",
            description: "Unix timestamp after which the current doorbell message should reset.",
            source: "official"
        },
        "speakerSettings.volume": {
            label: "Speaker Volume",
            description: "Playback volume used by the camera speaker.",
            unit: "%",
            source: "inferred"
        },
        "recordingSettings.mode": {
            label: "Recording Mode",
            description: "Recording policy configured for the camera.",
            source: "official"
        }
    },
    sensor: {
        isOpened: {
            label: "Contact Open",
            description: "Reports whether the sensor contact is currently open.",
            source: "inferred"
        },
        isMotionDetected: {
            label: "Motion Detected",
            description: "Reports whether motion is currently active on the sensor.",
            source: "inferred"
        },
        isAlarmDetected: {
            label: "Alarm Detected",
            description: "Reports whether the sensor alarm state is currently active.",
            source: "inferred"
        },
        isWaterLeakDetected: {
            label: "Water Leak Detected",
            description: "Reports whether the sensor currently detects a water leak.",
            source: "inferred"
        },
        isBatteryLow: {
            label: "Battery Low",
            description: "Reports whether the battery level is considered low.",
            source: "inferred"
        },
        batteryStatus: {
            label: "Battery Status",
            description: "Battery health state reported by the sensor.",
            source: "official"
        },
        "batteryStatus.percentage": {
            label: "Battery Level",
            description: "Current sensor battery percentage.",
            unit: "%",
            source: "inferred"
        },
        isTampered: {
            label: "Tamper Detected",
            description: "Reports whether the sensor tamper state is currently active.",
            source: "inferred"
        },
        isSmokeTestRunning: {
            label: "Smoke Test Running",
            description: "Reports whether a smoke test is currently in progress.",
            source: "inferred"
        },
        motionSensitivity: {
            label: "Motion Sensitivity",
            description: "Sensitivity level used for motion detection.",
            source: "inferred"
        }
    },
    light: {
        isLightOn: {
            label: "Light On",
            description: "Reports whether the light output is currently on.",
            source: "inferred"
        },
        isMotionDetected: {
            label: "Motion Detected",
            description: "Reports whether motion is currently detected by the light device.",
            source: "inferred"
        },
        lightDeviceSettings: {
            label: "Light Settings",
            description: "Configuration group for the light device.",
            source: "inferred"
        },
        "lightDeviceSettings.ledLevel": {
            label: "LED Level",
            description: "Brightness level used by the light.",
            unit: "%",
            source: "inferred"
        },
        "lightDeviceSettings.pirDuration": {
            label: "Motion Duration",
            description: "How long the light remains active after motion is detected.",
            unit: "s",
            source: "inferred"
        }
    },
    viewer: {
        liveview: {
            label: "Live View",
            description: "Live view currently assigned to the viewer.",
            source: "official"
        }
    }
};

// Observable metadata powers the "Receive Events" helper text shown in the
// editor when the user chooses which state/metric to expose.
const OBSERVABLE_METADATA = {
    camera: {
        licensePlate: {
            label: "License Plate (LPR)",
            description: "Emits each recognized license plate as text on msg.payload. Enable LPR in Protect and configure the optional Local User and Local Password in the shared Protect connection to retrieve plate text.",
            source: "inferred"
        },
        ring: {
            label: "Doorbell Ring",
            description: "True while the camera is reporting a ring event.",
            source: "official"
        },
        motion: {
            label: "Motion",
            description: "True while the camera is reporting an active motion event.",
            source: "official"
        },
        smartAudioDetect: {
            label: "Smart Audio Detect",
            description: "True while a smart audio detection event is active.",
            source: "inferred"
        },
        smartDetectZone: {
            label: "Smart Detect Zone",
            description: "True while a smart detection zone event is active.",
            source: "inferred"
        },
        smartDetectLine: {
            label: "Smart Detect Line",
            description: "True while a smart line crossing detection event is active.",
            source: "inferred"
        },
        smartDetectLoiterZone: {
            label: "Smart Detect Loiter",
            description: "True while a smart loitering detection event is active.",
            source: "inferred"
        },
        nfcCardScanned: {
            label: "NFC Card Scanned",
            description: "Emits true when an NFC card is scanned at the camera device.",
            source: "official"
        },
        fingerprintIdentified: {
            label: "Fingerprint Identified",
            description: "Emits true when a fingerprint is scanned at the camera device.",
            source: "official"
        }
    },
    sensor: {
        contact: {
            label: "Contact Open/Closed",
            description: "True when the sensor contact is open, false when it is closed.",
            source: "official"
        },
        motion: {
            label: "Motion",
            description: "True while the sensor is reporting an active motion event.",
            source: "official"
        },
        alarm: {
            label: "Alarm",
            description: "True while the sensor alarm state is active.",
            source: "inferred"
        },
        waterLeak: {
            label: "Water Leak",
            description: "True while the sensor is reporting an active water leak event.",
            source: "official"
        },
        batteryLow: {
            label: "Battery Low",
            description: "True when the sensor reports a low battery condition.",
            source: "inferred"
        },
        tamper: {
            label: "Tamper",
            description: "True while the sensor tamper state is active.",
            source: "inferred"
        },
        smokeTest: {
            label: "Smoke Test",
            description: "True while a smoke test is active.",
            source: "inferred"
        },
        extremeValues: {
            label: "Extreme Values",
            description: "True while the sensor is reporting an active extreme-values event.",
            source: "official"
        },
        vape: {
            label: "Vape Detected",
            description: "True while the sensor is reporting a vape detection.",
            source: "official"
        },
        button: {
            label: "Button Pressed",
            description: "Emits true when the sensor reports a button press.",
            source: "official"
        },
        smokeBatteryLow: {
            label: "Smoke Detector Battery Low",
            description: "True while the smoke or CO detector reports that its internal battery needs replacement.",
            source: "official"
        },
        smokeNeedsCleaning: {
            label: "Smoke Detector Needs Cleaning",
            description: "True while the smoke detector reports that cleaning is required.",
            source: "official"
        },
        smokeFault: {
            label: "Smoke Detector Fault",
            description: "True while the smoke detector reports a fault.",
            source: "official"
        },
        coFault: {
            label: "CO Detector Fault",
            description: "True while the carbon-monoxide detector reports a fault.",
            source: "official"
        },
        smokeEndOfLife: {
            label: "Smoke Detector End of Life",
            description: "True when the smoke or CO detector reports the end of its service life.",
            source: "official"
        },
        temperature: {
            label: "Temperature",
            description: "Current ambient temperature reported by the sensor.",
            source: "official"
        },
        humidity: {
            label: "Humidity",
            description: "Current relative humidity reported by the sensor.",
            source: "official"
        },
        lightLevel: {
            label: "Light Level",
            description: "Current ambient light level reported by the sensor.",
            source: "inferred"
        },
        batteryLevel: {
            label: "Battery Level",
            description: "Current battery percentage reported by the sensor.",
            source: "inferred"
        }
    },
    light: {
        motion: {
            label: "Motion",
            description: "True while the light device is reporting an active motion event.",
            source: "official"
        },
        lightOn: {
            label: "Light On",
            description: "True when the light output is currently on.",
            source: "inferred"
        }
    },
    fob: {
        arm: {
            label: "Arm (1)",
            description: "Emits true when the Key Fob Arm button is pressed.",
            source: "official"
        },
        night: {
            label: "Night (2)",
            description: "Emits true when the Key Fob Night button is pressed.",
            source: "official"
        },
        disarm: {
            label: "Disarm (3)",
            description: "Emits true when the Key Fob Disarm button is pressed.",
            source: "official"
        },
        panic: {
            label: "Panic (4)",
            description: "Emits true when the Key Fob Panic button is pressed.",
            source: "official"
        },
        left: {
            label: "Left",
            description: "Emits true when the Key Fob left side button is pressed.",
            source: "official"
        },
        right: {
            label: "Right",
            description: "Emits true when the Key Fob right side button is pressed.",
            source: "official"
        }
    },
    relay: {
        inputChanged: {
            label: "Input Changed",
            description: "Emits true when the relay input circuit closes and false when it opens.",
            source: "official"
        }
    },
    alarmHub: {
        armed: {
            label: "Armed",
            description: "Current Alarm Hub armed state: on becomes true and off becomes false. Updated by device state messages, not a dedicated arm/disarm event.",
            source: "official"
        },
        motion: {
            label: "Motion Input",
            description: "True while an Alarm Hub motion input is active.",
            source: "official"
        },
        entry: {
            label: "Entry Open/Closed",
            description: "True when an Alarm Hub entry input opens and false when it closes.",
            source: "official"
        },
        smoke: {
            label: "Smoke Input",
            description: "True while an Alarm Hub smoke input is active.",
            source: "official"
        },
        glassBreak: {
            label: "Glass Break Input",
            description: "True while an Alarm Hub glass-break input is active.",
            source: "official"
        },
        emergencyButton: {
            label: "Emergency Button",
            description: "Emits true when an Alarm Hub emergency button is pressed.",
            source: "official"
        },
        tamper: {
            label: "Tamper",
            description: "True while an Alarm Hub input reports tampering.",
            source: "official"
        },
        relaySwitched: {
            label: "Relay Switched",
            description: "Emits true when an Alarm Hub relay output is switched.",
            source: "official"
        },
        batteryLow: {
            label: "Battery Low",
            description: "True while the Alarm Hub reports a low battery condition.",
            source: "official"
        },
        batteryConnected: {
            label: "Battery Connected",
            description: "Emits true when an Alarm Hub battery is connected.",
            source: "official"
        }
    }
};

// Preserve common acronyms during automatic label formatting so generated field
// names look intentional instead of machine-expanded.
const ACRONYM_REPLACEMENTS = {
    api: "API",
    fps: "FPS",
    ip: "IP",
    ir: "IR",
    lcd: "LCD",
    led: "LED",
    mic: "Mic",
    nvr: "NVR",
    pir: "PIR",
    ptz: "PTZ",
    rtsps: "RTSPS",
    wifi: "Wi-Fi"
};

function resolveFieldMetadata(deviceType, propertyPath) {
    const normalizedType = normalizeToken(deviceType);
    const normalizedPath = normalizePath(propertyPath);
    if (!normalizedPath) {
        return null;
    }

    const typeEntries = TYPE_FIELD_METADATA[normalizedType] || {};
    const exactMatch = typeEntries[normalizedPath] || COMMON_FIELD_METADATA[normalizedPath];
    if (exactMatch) {
        return exactMatch;
    }

    const lastSegment = normalizedPath.split(".").pop();
    return typeEntries[lastSegment] || COMMON_FIELD_METADATA[lastSegment] || null;
}

function formatFieldLabel(deviceType, propertyPath) {
    const metadata = resolveFieldMetadata(deviceType, propertyPath);
    if (metadata && metadata.label) {
        return metadata.label;
    }

    return humanizePath(propertyPath);
}

function buildFieldHelpText(deviceType, propertyPath, extra) {
    const metadata = resolveFieldMetadata(deviceType, propertyPath);
    const parts = [];

    if (metadata && metadata.description) {
        parts.push(metadata.description);
    }

    if (extra && extra.currentValueText) {
        parts.push(`Current value: ${extra.currentValueText}.`);
    }

    return parts.join(" ");
}

function formatValueWithMetadata(deviceType, propertyPath, value) {
    const metadata = resolveFieldMetadata(deviceType, propertyPath);

    if (value === null) {
        return "null";
    }

    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }

    const text = String(value);
    const clipped = text.length > 24 ? `${text.slice(0, 21)}...` : text;

    if (typeof value === "number" && metadata && metadata.unit) {
        return `${clipped}${metadata.unit === "%" ? "%" : ` ${metadata.unit}`}`;
    }

    return clipped;
}

function resolveObservableMetadata(deviceType, observableId) {
    const normalizedType = normalizeToken(deviceType);
    const normalizedId = String(observableId || "").trim();
    if (!normalizedType || !normalizedId) {
        return null;
    }

    const typeEntries = OBSERVABLE_METADATA[normalizedType] || {};
    return typeEntries[normalizedId] || null;
}

function formatObservableLabel(deviceType, observableId, fallbackLabel) {
    const metadata = resolveObservableMetadata(deviceType, observableId);
    if (metadata && metadata.label) {
        return metadata.label;
    }

    return String(fallbackLabel || humanizeSegment(observableId) || observableId || "").trim();
}

function buildObservableHelpText(deviceType, observableId) {
    const metadata = resolveObservableMetadata(deviceType, observableId);
    if (!metadata) {
        return "";
    }

    const parts = [];
    if (metadata.description) {
        parts.push(metadata.description);
    }

    return parts.join(" ");
}

function humanizePath(propertyPath) {
    return normalizePath(propertyPath)
        .split(".")
        .filter(Boolean)
        .map(humanizeSegment)
        .join(" > ");
}

function humanizeSegment(segment) {
    const normalized = String(segment || "").trim();
    if (!normalized) {
        return "";
    }

    const withoutBooleanPrefix = /^is[A-Z]/.test(normalized)
        ? normalized.slice(2)
        : normalized;

    return withoutBooleanPrefix
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .split(" ")
        .filter(Boolean)
        .map((part) => {
            const lower = part.toLowerCase();
            if (ACRONYM_REPLACEMENTS[lower]) {
                return ACRONYM_REPLACEMENTS[lower];
            }
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join(" ");
}

function normalizePath(value) {
    return String(value || "").trim();
}

function normalizeToken(value) {
    return String(value || "").trim().toLowerCase();
}

module.exports = {
    buildObservableHelpText,
    buildFieldHelpText,
    formatFieldLabel,
    formatObservableLabel,
    formatValueWithMetadata,
    humanizePath,
    resolveObservableMetadata,
    resolveFieldMetadata
};
