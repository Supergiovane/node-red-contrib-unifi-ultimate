"use strict";

function boundedNumber(value, fallback, min, max) {
    const number = value === "" || value === undefined || value === null ? NaN : Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

// Only successful, explicit samples count towards an alarm. A failed read or
// unknown state breaks the pending interval, but does not fabricate a recovery.
function createDelayedTransition(delayMs) {
    let since = null;
    let alerted = false;
    return {
        update(active, now = Date.now()) {
            if (active !== true && active !== false) {
                since = null;
                return null;
            }
            if (active === false) {
                const result = alerted ? { active: false, since, at: now } : null;
                since = null;
                alerted = false;
                return result;
            }
            if (since === null) since = now;
            if (alerted || now - since < delayMs) return null;
            alerted = true;
            return { active: true, since, at: now };
        }
    };
}

function deviceOffline(device) {
    if (!device || typeof device !== "object") return undefined;
    const state = device.state;
    if (state === 0 || ["OFFLINE", "DISCONNECTED"].includes(String(state).toUpperCase())) return true;
    if (state === 1 || ["ONLINE", "CONNECTED"].includes(String(state).toUpperCase())) return false;
    // Adopting, upgrading and an absent device are not confirmed outages.
    return undefined;
}

function doorOpen(device) {
    const state = String(device && device.door_position_status || "").toLowerCase();
    if (state === "open") return true;
    if (["close", "closed"].includes(state)) return false;
    return undefined;
}

function internetOffline(health) {
    const www = Array.isArray(health) && health.find((row) => row && row.subsystem === "www");
    if (!www) return undefined;
    if (www.status === "ok") return false;
    if (www.status === "error") return true;
    return undefined;
}

function createSimpleMonitorProcessor({ kind, options = {}, emit, reportError, status, now = Date.now }) {
    const isDoor = kind === "observeDoorOpenTooLong";
    const isInternet = kind === "observeInternet";
    const delay = boundedNumber(options.delaySeconds, isDoor ? 120 : isInternet ? 30 : 60, isDoor ? 1 : 0, isInternet ? 3600 : 86400);
    const transition = createDelayedTransition(delay * 1000);
    const startedAt = now();
    const seenWanEvents = new Set();
    const wanTimeByInterface = new Map();
    let lastError = "";
    let wanWarning = false;
    const fail = (message) => {
        status({ fill: "yellow", shape: "ring", text: "monitor data unavailable" });
        if (message !== lastError) reportError(new Error(message));
        lastError = message;
    };
    return {
        // A physical close from Access cancels a pending alarm immediately.
        // Opening is confirmed by a fresh read before an alarm can be emitted.
        invalidate() { transition.update(undefined, now()); },
        handle(update = {}) {
            if (update.error) {
                transition.update(undefined, now());
                fail(update.error.message || "Unable to read the monitor state. Check the connection.");
                return;
            }
            const raw = update.latest;
            const active = isDoor ? doorOpen(raw) : isInternet ? internetOffline(raw && raw.health) : deviceOffline(raw);
            const change = transition.update(active, now());
            if (active === undefined) {
                fail(isDoor ? "Door position is unavailable. Connect and configure a door position sensor (DPS) in Access. Lock/unlock state cannot detect an open door."
                    : isInternet ? "Internet health is unavailable. This action requires a UniFi gateway and the local Network API's WWW health status."
                        : "The controller has not reported a definite online/offline state for this device.");
            } else {
                lastError = "";
                status({ fill: active ? "yellow" : "green", shape: "dot", text: isDoor ? (active ? "door open" : "door closed") : (active ? "offline" : "online") });
            }
            if (change) {
                const state = isDoor ? (change.active ? "openTooLong" : "closed") : (change.active ? "offline" : "online");
                const eventName = isDoor ? (change.active ? "doorOpenTooLong" : "doorClosed")
                    : isInternet ? (change.active ? "internetOffline" : "internetRestored")
                        : (change.active ? "deviceOffline" : "deviceRestored");
                const at = new Date(change.at).toISOString();
                emit({ state, ...(isDoor ? { open: change.active } : { online: !change.active }), at }, eventName, {
                    raw,
                    monitor: { source: update.source || "monitor-poll", delaySeconds: delay,
                        observedSince: change.since === null ? null : new Date(change.since).toISOString(),
                        durationSeconds: change.since === null ? null : Math.floor((change.at - change.since) / 1000) }
                });
            }
            if (!isInternet || !raw) return;
            if (raw.wanEventsAvailable === false && !wanWarning) {
                wanWarning = true;
                reportError(new Error("Internet health is monitored, but this controller/account does not expose WAN transition events. Check local Network permissions and version support."));
            }
            const events = (Array.isArray(raw.events) ? raw.events : [])
                .filter((event) => event && event.key === "EVT_GW_WANTransition" && Number.isFinite(Number(event.time))
                    && Number(event.time) >= startedAt && Number(event.time) <= now() + 60000)
                .sort((a, b) => Number(a.time) - Number(b.time));
            for (const event of events) {
                const key = String(event._id || JSON.stringify([event.time, event.iface, event.state]));
                if (seenWanEvents.has(key) || !["failover", "active", "inactive"].includes(event.state)) continue;
                const iface = String(event.iface || "");
                if (Number(event.time) < (wanTimeByInterface.get(iface) || 0)) continue;
                wanTimeByInterface.set(iface, Number(event.time));
                seenWanEvents.add(key);
                if (seenWanEvents.size > 512) seenWanEvents.delete(seenWanEvents.values().next().value);
                emit({ state: event.state, interface: event.iface || "", at: new Date(Number(event.time)).toISOString() },
                    event.state === "failover" ? "wanFailover" : event.state === "active" ? "wanActive" : "wanInactive",
                    { raw: event, monitor: { source: "controller-event", site: raw.site } });
            }
        }
    };
}

// One scheduler per connection, including when the websocket is connected.
// Nodes watching the same target share a read. There is no per-leaf polling.
function installSimpleMonitorScheduler(node, read) {
    const lastReads = new Map();
    let timer = null;
    let inFlight = false;
    let closed = false;
    const clients = () => (node.nodeClients || []).map((client) => ({
        client,
        descriptor: typeof client.getSimpleMonitorDescriptor === "function" ? client.getSimpleMonitorDescriptor() : null
    })).filter(({ descriptor }) => descriptor && descriptor.kind && descriptor.target);
    const targetKey = ({ descriptor }) => JSON.stringify([descriptor.kind, descriptor.target]);

    node.pollSimpleMonitors = async () => {
        if (closed || node.isClosing || inFlight) return;
        inFlight = true;
        try {
            const groups = new Map();
            for (const entry of clients()) {
                const key = targetKey(entry);
                groups.set(key, [...(groups.get(key) || []), entry]);
            }
            for (const [key, entries] of groups) {
                if (closed || node.isClosing) break;
                const intervalMs = Math.min(...entries.map(({ descriptor }) => boundedNumber(descriptor.intervalMs, 10000, 1000, 300000)));
                const now = Date.now();
                if (lastReads.has(key) && lastReads.get(key) + intervalMs > now) continue;
                lastReads.set(key, now);
                let update;
                try { update = { latest: await read(entries[0].descriptor), source: "monitor-poll" }; }
                catch (error) { update = { error, source: "monitor-poll" }; }
                if (closed || node.isClosing) break;
                for (const { client } of entries) {
                    if (!(node.nodeClients || []).includes(client) || !client.getSimpleMonitorDescriptor()) continue;
                    client.handleSimpleMonitorUpdate(update);
                }
            }
        } finally { inFlight = false; }
    };

    node.refreshSimpleMonitorScheduler = () => {
        const activeTargets = new Set(clients().map(targetKey));
        for (const key of lastReads.keys()) if (!activeTargets.has(key)) lastReads.delete(key);
        if (closed || node.isClosing || !activeTargets.size) {
            if (timer) clearInterval(timer);
            timer = null;
        } else if (!timer) {
            timer = setInterval(() => { node.pollSimpleMonitors().catch(() => {}); }, 1000);
        }
    };
    node.stopSimpleMonitorScheduler = () => {
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
        lastReads.clear();
    };
}

module.exports = { boundedNumber, createDelayedTransition, deviceOffline, doorOpen, internetOffline, createSimpleMonitorProcessor, installSimpleMonitorScheduler };
