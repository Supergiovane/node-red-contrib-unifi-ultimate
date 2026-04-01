"use strict";

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

const TYPE_FIELD_METADATA = {
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

const OBSERVABLE_METADATA = {
    camera: {
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
    }
};

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
