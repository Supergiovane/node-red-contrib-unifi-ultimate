"use strict";

const { doRequest, buildQueryString } = require("./unifi-network-utils");
const { extractProtectHistorySessionHeaders } = require("./unifi-protect-history");

function collection(response, label) {
    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${label} unavailable (HTTP ${response && response.statusCode || "unknown"}). Check Network permissions and the optional local account.`);
    }
    if (response.payload && response.payload.meta && response.payload.meta.rc !== "ok") {
        throw new Error(`${label} was rejected by Network. Check the account's site permissions.`);
    }
    const rows = Array.isArray(response.payload) ? response.payload : response.payload && response.payload.data;
    if (!Array.isArray(rows)) throw new Error(`${label} returned an unsupported format.`);
    return rows;
}

function installNetworkMonitorReads(node) {
    let session = null;
    let loginPromise = null;
    const sites = new Map();
    const root = () => new URL(node.baseUrl).origin;
    const login = async () => {
        if (session && session.expires > Date.now()) return session.headers;
        if (loginPromise) return loginPromise;
        const credentials = node.credentials || {};
        const username = String(credentials.localUsername || "").trim();
        const password = credentials.localPassword;
        if (!username || !password) throw new Error("Internet monitoring requires access to Network's local API. Configure Local User and Local Password with Network site read permissions.");
        loginPromise = Promise.resolve().then(async () => {
            const response = await doRequest(new URL(`${root()}/api/auth/login`), {
                method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
                timeout: 15000, rejectUnauthorized: node.rejectUnauthorized
            }, JSON.stringify({ username, password, rememberMe: false }));
            if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Network local login failed (HTTP ${response.statusCode}). Use a local UniFi OS account and check its password.`);
            const headers = extractProtectHistorySessionHeaders(response);
            if (!node.isClosing) session = { headers, expires: Date.now() + 15 * 60000 };
            return headers;
        }).finally(() => { loginPromise = null; });
        return loginPromise;
    };
    node.readMonitorLegacy = async (path, query) => {
        // Try the existing key first. A local session is only a fallback for
        // these read-only monitor endpoints, never for unrelated actions.
        if (!session) {
            const response = await node.legacyApiRequest({ path, query, method: "GET" });
            if (![401, 403].includes(response.statusCode)) return response;
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const headers = await login();
            if (node.isClosing) throw new Error("Network connection is closing.");
            const response = await doRequest(new URL(`${root()}/proxy/network${path}${buildQueryString(query)}`), {
                method: "GET", headers: { ...headers, Accept: "application/json" }, timeout: 15000,
                rejectUnauthorized: node.rejectUnauthorized
            });
            if (response.statusCode !== 401 || attempt === 1) return response;
            session = null;
        }
    };
    node.readSimpleMonitor = async ({ kind, target }) => {
        if (kind === "observeAvailability") return node.fetchDeviceByTypeAndId("device", target);
        if (kind !== "observeInternet") throw new Error("Unsupported Network monitor.");
        if (!sites.has(target)) {
            const rows = collection(await node.readMonitorLegacy("/api/self/sites"), "Network sites");
            for (const site of rows) {
                for (const id of [site.id, site._id, site.external_id, site.name]) {
                    if (id && site.name) sites.set(String(id), site.name);
                }
            }
        }
        const site = sites.get(target);
        if (!site) throw new Error("Cannot match this site to the local Network API. Re-select the site and check the account's site permissions.");
        const path = `/api/s/${encodeURIComponent(site)}`;
        const health = collection(await node.readMonitorLegacy(`${path}/stat/health`), "Internet health");
        let events = [];
        let wanEventsAvailable = true;
        try { events = collection(await node.readMonitorLegacy(`${path}/stat/event`, { _limit: 100, _sort: "-time" }), "WAN events"); }
        catch (error) { wanEventsAvailable = false; }
        return { health, events, site, wanEventsAvailable };
    };
    node.clearMonitorLocalSession = () => { session = null; sites.clear(); };
}

module.exports = { collection, installNetworkMonitorReads };
