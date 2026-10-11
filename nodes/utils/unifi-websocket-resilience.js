"use strict";

// Shared resilience for UniFi WebSocket streams. A ping/pong heartbeat detects
// half-open connections that never emit "close", and an exponential backoff
// spaces out reconnects while a controller restarts or upgrades.

const HEARTBEAT_INTERVAL_MS = 30000;
const RECONNECT_BASE_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 60000;

const heartbeatTimers = new WeakMap();

function stopHeartbeat(ws) {
    if (!ws || typeof ws !== "object") {
        return;
    }
    const timer = heartbeatTimers.get(ws);
    if (timer) {
        clearInterval(timer);
        heartbeatTimers.delete(ws);
    }
}

function attachHeartbeat(ws, options = {}) {
    if (!ws || typeof ws.on !== "function") {
        return;
    }

    stopHeartbeat(ws);
    const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : HEARTBEAT_INTERVAL_MS;
    let alive = true;
    const markAlive = () => {
        alive = true;
    };

    const timer = setInterval(() => {
        if (!alive) {
            // Nothing received since the previous ping: the peer is gone even
            // though the socket still looks open. terminate() emits "close",
            // which lets the owner schedule its normal reconnect.
            stopHeartbeat(ws);
            try {
                ws.terminate();
            } catch (error) {
            }
            return;
        }
        alive = false;
        try {
            ws.ping();
        } catch (error) {
        }
    }, intervalMs);
    if (typeof timer.unref === "function") {
        timer.unref();
    }
    heartbeatTimers.set(ws, timer);

    ws.on("pong", markAlive);
    ws.on("message", markAlive);
    ws.on("close", () => stopHeartbeat(ws));
}

function createReconnectBackoff(options = {}) {
    const baseMs = Number(options.baseMs) > 0 ? Number(options.baseMs) : RECONNECT_BASE_DELAY_MS;
    const maxMs = Number(options.maxMs) > 0 ? Number(options.maxMs) : RECONNECT_MAX_DELAY_MS;
    const random = typeof options.random === "function" ? options.random : Math.random;
    let attempts = 0;

    return {
        nextDelay() {
            const delay = Math.min(maxMs, baseMs * (2 ** attempts));
            attempts += 1;
            // Up to 20% jitter keeps several config nodes from reconnecting in
            // lockstep without ever exceeding the maximum delay.
            return Math.round(delay * (0.8 + (random() * 0.2)));
        },
        reset() {
            attempts = 0;
        },
        get attempts() {
            return attempts;
        }
    };
}

module.exports = {
    HEARTBEAT_INTERVAL_MS,
    RECONNECT_BASE_DELAY_MS,
    RECONNECT_MAX_DELAY_MS,
    attachHeartbeat,
    stopHeartbeat,
    createReconnectBackoff
};
