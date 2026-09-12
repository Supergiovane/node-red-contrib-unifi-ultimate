(function (global) {
    "use strict";
    global.UnifiUltimateConnectionCheck = {
        bind: function (node, product) {
            var $button = $("#node-config-test-connection");
            var $results = $("#node-config-test-results");
            var request = null;
            var version = 0;
            function cancel() {
                version += 1;
                if (request) request.abort();
                request = null;
                $button.prop("disabled", false);
            }
            node._unifiConnectionCheckCleanup = cancel;
            $("#node-config-input-host, #node-config-input-port, #node-config-input-apiKey, #node-config-input-apiToken, #node-config-input-localUsername, #node-config-input-localPassword, #node-config-input-allowSelfSigned")
                .on("input.unifiCheck change.unifiCheck", function () { cancel(); $results.empty(); });
            $button.off("click.unifiCheck").on("click.unifiCheck", function (event) {
                event.preventDefault();
                cancel();
                var current = version;
                var credentials = {};
                [product === "access" ? "apiToken" : "apiKey", "localUsername", "localPassword"].forEach(function (key) {
                    credentials[key] = $("#node-config-input-" + key).val() || "";
                });
                $button.prop("disabled", true);
                $results.text("Checking connection from Node-RED…");
                var title = product.charAt(0).toUpperCase() + product.slice(1);
                request = $.ajax({
                    url: "unifi" + title + "/test-connection", type: "POST", contentType: "application/json", timeout: 35000,
                    data: JSON.stringify({ serverId: node.id, host: $("#node-config-input-host").val(), port: $("#node-config-input-port").val(),
                        rejectUnauthorized: !$("#node-config-input-allowSelfSigned").prop("checked"), credentials: credentials })
                }).done(function (result) {
                    if (current !== version) return;
                    render(result);
                }).fail(function (xhr, status) {
                    if (current !== version || status === "abort") return;
                    render(xhr.responseJSON || { checks: [{ status: "error", message: "Connection check could not complete. Check Node-RED connectivity and editor permissions." }] });
                }).always(function () { if (current === version) { request = null; $button.prop("disabled", false); } });
            });
            function render(result) {
                $results.empty();
                (result.checks || []).forEach(function (check) {
                    $("<div></div>").text((check.status === "ok" ? "✓ " : check.status === "error" ? "⚠ " : "ⓘ ") + check.message).appendTo($results);
                });
            }
        },
        cleanup: function (node) {
            if (typeof node._unifiConnectionCheckCleanup === "function") node._unifiConnectionCheckCleanup();
            delete node._unifiConnectionCheckCleanup;
        }
    };
})(window);
