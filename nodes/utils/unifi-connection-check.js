"use strict";

const protect = require("./unifi-protect-utils");
const access = require("./unifi-access-utils");
const network = require("./unifi-network-utils");
const { extractProtectHistorySessionHeaders } = require("./unifi-protect-history");
const PRODUCTS = {
    protect: { utils: protect, key: "apiKey", path: "/v1/cameras", label: "API key" },
    network: { utils: network, key: "apiKey", path: "/v1/sites", label: "API key" },
    access: { utils: access, key: "apiToken", path: "/api/v1/developer/doors", label: "API token" }
};

function connectionOrigin(product, config) {
    const spec = PRODUCTS[product];
    if (!spec) throw new Error("Unknown UniFi product.");
    try {
        const url = new URL(spec.utils.buildBaseUrlFromHost(config.host, config.port));
        if (url.username || url.password || !url.hostname) throw new Error();
        return url.origin;
    } catch (error) { throw new Error("Enter a valid controller host and port."); }
}

function responseProblem(status, what) {
    if (status === 401) return `${what} rejected. Check the username/password or API key/token.`;
    if (status === 403) return `${what} has insufficient permissions. Grant read access to the selected application/site.`;
    if (status === 404) return `${what} endpoint not found. Check the controller port and application/API version.`;
    if (status === 429) return "The controller is rate limiting requests. Wait before testing again.";
    return `${what} failed (HTTP ${status || "unknown"}). Check the application on the controller.`;
}

function transportProblem(error) {
    if (String(error && error.code || "").includes("CERT") || ["DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(error && error.code)) {
        return "Certificate verification failed. Check the controller certificate or the Allow self-signed certificate setting.";
    }
    return "Cannot reach the controller. Check its address, port, firewall and connection from the Node-RED host.";
}

async function runConnectionCheck(product, config, credentials, request = protect.doRequest) {
    const spec = PRODUCTS[product];
    const origin = connectionOrigin(product, config);
    const base = spec.utils.buildBaseUrlFromHost(config.host, config.port);
    const checks = [];
    const add = (id, status, message) => checks.push({ id, status, message });
    const opts = { timeout: 8000, rejectUnauthorized: config.rejectUnauthorized === true };
    const key = credentials[spec.key];
    if (!key) add("api", "error", `Enter the required ${spec.label}. The local account does not replace it.`);
    else {
        try {
            const headers = product === "access" ? { Authorization: `Bearer ${key}` } : { "X-API-Key": key };
            const response = await request(new URL(`${base}${spec.path}`), { ...opts, method: "GET", headers: { Accept: "application/json", ...headers } });
            add("controller", "ok", "Controller reached from Node-RED.");
            const ok = response.statusCode >= 200 && response.statusCode < 300;
            const payload = response.payload;
            const valid = (Array.isArray(payload) || payload && Array.isArray(payload.data))
                && !(payload && payload.code && payload.code !== "SUCCESS")
                && !(payload && payload.meta && payload.meta.rc !== "ok");
            add("api", ok && valid ? "ok" : "error", !ok ? responseProblem(response.statusCode, spec.label)
                : valid ? `${spec.label} accepted; application read access verified.` : "The controller returned an unexpected response. Check the application API and port.");
        } catch (error) { add("controller", "error", transportProblem(error)); }
    }
    const username = String(credentials.localUsername || "").trim();
    const password = credentials.localPassword;
    if (product === "access") {
        add("local", "info", "Access actions, including door monitoring, use the API token. The optional local account is not used or tested.");
    } else if (!username && !password) {
        add("local", "info", product === "protect" ? "No local account: LPR text, recorded event photos and recent detections require Local User and Local Password."
            : "No local account: Internet/WAN monitoring can require it if the controller rejects the API key on local endpoints.");
    } else if (!username || !password) {
        add("local", "error", "Complete both Local User and Local Password, or leave both empty.");
    } else {
        try {
            const response = await request(new URL(`${origin}/api/auth/login`), {
                ...opts, method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }
            }, JSON.stringify({ username, password, rememberMe: false }));
            if (response.statusCode < 200 || response.statusCode >= 300) add("local", "error", responseProblem(response.statusCode, "Local login"));
            else {
                let session;
                try { session = extractProtectHistorySessionHeaders(response); }
                catch (error) { add("local", "error", "Local login returned no session. Use a local UniFi OS account without interactive sign-in."); }
                if (session) {
                    add("local", "ok", "Local account login accepted.");
                    const path = product === "protect" ? "/proxy/protect/api/events?limit=1" : "/proxy/network/api/self/sites";
                    const permission = await request(new URL(`${origin}${path}`), { ...opts, method: "GET", headers: { ...session, Accept: "application/json" } });
                    const ok = permission.statusCode >= 200 && permission.statusCode < 300;
                    const rows = permission.payload;
                    const valid = (Array.isArray(rows) || rows && (Array.isArray(rows.data) || Array.isArray(rows.events)))
                        && !(rows && rows.meta && rows.meta.rc !== "ok");
                    add("local-permissions", ok && valid ? "ok" : "error", ok && valid ? (product === "protect" ? "Recorded events can be read. Camera permissions and retained images are checked when used." : "Network sites can be read. Internet/WAN support is checked for the selected site when monitoring starts.")
                        : ok ? "The local API returned an unexpected response. Check application permissions and version support." : responseProblem(permission.statusCode, "Local application access"));
                }
            }
        } catch (error) { add("local", "error", transportProblem(error)); }
    }
    return { ok: !checks.some((check) => check.status === "error"), checks };
}

function registerConnectionCheck(RED, product) {
    // Some embedders only expose the discovery GET API.
    if (!RED.httpAdmin || typeof RED.httpAdmin.post !== "function") return;
    const spec = PRODUCTS[product];
    const type = `unifi-${product}-config`;
    const title = product[0].toUpperCase() + product.slice(1);
    RED.httpAdmin.post(`/unifi${title}/test-connection`, RED.auth.needsPermission(`${type}.write`), async (req, res) => {
        try {
            const body = req.body || {};
            const config = { host: String(body.host || ""), port: body.port, rejectUnauthorized: body.rejectUnauthorized === true };
            const origin = connectionOrigin(product, config);
            const saved = body.serverId ? RED.nodes.getNode(String(body.serverId)) : null;
            if (saved && saved.type !== type) throw new Error("Select the matching UniFi connection configuration.");
            const incoming = body.credentials && typeof body.credentials === "object" ? body.credentials : {};
            const credentials = {};
            for (const key of [spec.key, "localUsername", "localPassword"]) {
                if (incoming[key] === "__PWRD__") {
                    if (!saved || connectionOrigin(product, saved) !== origin) throw new Error("Re-enter the credentials to test a new controller address or an undeployed configuration.");
                    credentials[key] = saved.credentials && saved.credentials[key];
                } else credentials[key] = typeof incoming[key] === "string" ? incoming[key] : "";
            }
            res.json(await runConnectionCheck(product, config, credentials));
        } catch (error) {
            // All validation errors above are ours, never remote response bodies.
            res.status(400).json({ ok: false, checks: [{ id: "configuration", status: "error", message: error.message }] });
        }
    });
}

module.exports = { connectionOrigin, runConnectionCheck, registerConnectionCheck };
