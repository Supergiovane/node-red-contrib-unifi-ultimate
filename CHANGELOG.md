# Changelog

## 1.0.4

- UniFi Network, Protect, and Access config: added an optional **Port** field so you can connect to controllers that listen on a custom port instead of the default (for example UniFi OS server on `11443`). Leave it empty to keep the previous default (`443` for Network/Protect, `12445` for Access). A port written directly in the Controller field (`host:port`) still takes precedence. (#10)

## 1.0.3

- All nodes now have a **second output for errors**. When something goes wrong — connection problem, action not supported, timeout — the error message comes out of the second output instead of silently failing. Connect it to a debug node to see what happened, or wire it to a notification in your flow.

## 1.0.2

- UI: removed per-node `Timeout` fields and standardized request timeouts internally
- Config editors: aligned progressive field visibility with Node-RED stored node values on reopen
- UniFi Network, Protect, and Access Device: added optional periodic emission for read-only actions, hidden for event streams and write actions
- UniFi Network config: made the global PoE power polling interval optional and defaulted it to 15 seconds for existing nodes
- UniFi Network Device: added simple end-user actions for `Is Client Online`, `Count Online Clients`, `Read CPU`, `Read Memory`, `Read Uptime`, and `Create Guest Voucher`
- UniFi Network Device: added `Read Temperatures`, which normalizes switch/device thermal readings when the controller exposes them and falls back to legacy device stats where available
- UniFi Protect Sensor: added numeric observables for `Temperature`, `Humidity`, `Light Level`, and `Battery Level` (in addition to existing event-based observables)
- UniFi Access: expanded `Receive Events` with official event filters (doorbell, unlock, DPS, emergency, schedule, temporary unlock, visitor status, and remote-view families) while keeping `All` for full stream passthrough

## 1.0.0

- release stable `1.0.0`
- hardening runtime Node-RED: nel polling doorbell di UniFi Access sono state aggiunte protezioni esplicite sulle Promise async (`.catch(...)`) per evitare unhandled rejections e ridurre il rischio di crash del runtime
- migliorata la resilienza del bootstrap polling iniziale doorbell con gestione errori dedicata e logging tramite `node.warn(...)`

## 0.1.11

- Network config/runtime: added automatic fallback from official local `/v1` endpoints to legacy local Network endpoints when official routes are unavailable (improves compatibility with older local controller releases, including 7.x-era setups)
- editor UX: renamed capability field label from `Observable` to `Event` across Access, Network, and Protect device nodes for clearer terminology
- editor UX: normalized searchable selector widths and refresh-button alignment across device/client selectors in Access, Network Device, Network Presence, Network Control POE, and Protect nodes
- editor UX: removed the visual `Action options` row label from device-node forms while preserving dynamic capability fields behavior
- editor UX: updated help/info tip layout so capability help boxes span the full action-options row width
- editor styling: introduced `unifi-ultimate-info-tip` with blue palette styling for capability help boxes to match node branding
- node help text: updated wording to match the new UI labels and dynamic-field behavior

## 0.1.10

- added YouTube tutorial links with icon to README and every node help/editor panel
- simplified editor layouts with progressive field disclosure so each node reveals the next fields only after the previous main selection is made
- removed editor summary/detail cards from runtime nodes to keep node configuration panels cleaner
- removed connection preview cards from config node editors
- added a blocking wait popup while the Network Control POE editor loads and resolves client-based targets

## 0.1.9

- fixed HTTP response parsing so explicitly non-text payloads (including Protect camera snapshots) are returned as raw `Buffer` data instead of being coerced to utf8 strings
- centralized shared response body parsing in `nodes/utils/http-response-utils.js` for Access, Network, and Protect utilities
- improved JSON detection for `application/json` and `+json` media types while preserving JSON-shape fallback for unknown/text responses

## 0.1.8

- centralized UniFi Network observation logic in `unifi-network-config` (single shared timers/schedulers and event fan-out to runtime nodes)
- aligned runtime nodes to subscribe via config-node client registry (`addClient/removeClient`) instead of opening their own event channels
- Network Control POE: simplified actions to a single `Emit Power Consumption` observer mode with global poll interval from Network config
- fixed POE power reporting in Client search mode and improved fallback power extraction when official port power is missing
- updated node help HTML across touched nodes to reflect centralized fetch/event architecture and global POE polling
- added status timestamp formatting to runtime/config node statuses (`<status> (day X, HH:MM:SS)`)
- removed dead code paths tied to deprecated POE observe modes (`change` vs `interval`)

## 0.1.7

- Network Control POE: added `POE controlled by msg.payload` action and set it as the default for new nodes (`true` enables PoE, `false` disables PoE)
- editor UX: when client lists are loading/not populated, dependent derived fields stay disabled to prevent invalid selections
- fixed refresh-button spinner behavior so only the refresh icon spins (not the full button container)
- added accessibility labels (`title` and `aria-label`) to refresh buttons in node editors
- moved shared editor styles into `resources/editor/unifi-ultimate-editor-common.css` and aligned node HTML templates to use it
- refreshed README and node editor branding assets to official UniFi SVG logos
- updated Node-RED palette icons to the UniFi `U-logo-light` set with product badges (`N`, `A`, `P`), including a softer badge color palette

## 0.1.6

- added `msg.topic` (node name) across runtime node outputs
- replaced `msg.friendlyName` with `msg.deviceName` (remembered/observed client or device name)
- replaced `payload.friendlyName` with `payload.deviceName` when `msg.payload` is an object
- added `msg.eventName` across runtime node outputs with the trigger/event name that produced each message
- UniFi Protect: when an observable matches an incoming event, the same event is now also propagated to the events output pin
- Protect/Access/Network editor: input pin visibility is now driven by registry stream capabilities (hidden only for actions that open event streams)
- BREAKING CHANGE: Protect and Access device nodes now use a single output pin (state and events share output 1)
- Presence Detection: input pin removed; polling/listening is always automatic
- removed the `"(OffLine)"` suffix from Network editor selectors to keep item names clean
- updated editor auto-name behavior so node `Name` changes only on manual list selection (not during list loading or programmatic value changes)
- updated README output documentation for `topic`, `deviceName`, and `eventName`
- stream-based `Receive Events` actions now expose an explicit `All` option so nodes can emit every event for the selected device/client
- Network Device: added experimental `Receive Events (Unofficial Stream)` capability (non-official websocket endpoint, emits all events with `All` only)
- Network Control POE: added power-observe actions (`Emit Power Consumption at change` and `Emit Power Consumption at fixed intervals`) with minimum interval 5 seconds and hidden input pin in observe mode
- Network Control POE: added `msg.payload.portPowerW`, `msg.payload.powerConsumptionSwitchTotal`, and aligned power metadata in `msg.details.unifiNetworkPoe.*`
- README/Help: added beta notice (< 1.0.0), output payload examples, and guaranteed vs optional power-field documentation

## 0.1.5

- BREAKING CHANGE: runtime nodes no longer read or apply input message properties to override the configured target, action, payload, query, headers, parameters, or capability options. Incoming messages now only trigger the action configured in the node editor.
- improved editor usability with searchable device/client selectors and automatic node `Name` updates when selecting an item
- updated UniFi Network PoE handling, including client-based targeting and switch/port resolution where UniFi exposes attachment data
- enriched UniFi Network port selectors with connected client names when available
- added registry discovery scripts and report suggestions for maintainers
- refreshed README and node help text to reflect the current user-facing behavior

## 0.1.4

- fixed ring handling for UniFi Access doorbell trigger/cancel

## 0.1.2

- UniFi Protect: added `Read Application Info` capability on NVR (`GET /v1/meta/info`)
- UniFi Protect: added Sensor observable `Extreme Values` mapped to `sensorExtremeValues` events
- UniFi Network: added site capability `Read Application Info` (`GET /v1/info`)
- UniFi Access: updated temporary lock rule editor/payload for current `custom` duration (`interval`) with legacy `ended_time` fallback
- UniFi Access editor UX: temporary lock rule inputs now adapt to selected rule type, with contextual help text and auto-refresh of dependent fields
- refreshed README and node help text to include the new capabilities
- updated Protect and Network node help HTML with the new action/observable details

## 0.1.1

- bumped package patch version from `0.1.0` to `0.1.1`
- updated README badges with npm/node/flows/docs/download/license coverage
- added YouTube badge to README using the same channel link as related project docs

## 0.1.0

- improved runtime hardening to reduce the risk of unhandled exceptions and Node-RED crashes, including safer async timer flows and websocket initialization guards
- added defensive fallback handling for `done` in node input handlers, with explicit `node.error(...)` fallback when `done` is not available
- restored node editor lists to standard selects (non-searchable) to remove listbox interaction flapping issues
- added automatic preselection of an existing `-config` node when dropping a new node with an empty connection field
- expanded inline code comments across runtime nodes, config nodes, registries, utils, and editor files for easier maintenance

## 0.1.0-pre.5

- added ready-to-import example flows for Protect sensor observe, Protect camera actions, Access door control, and Access intercom doorbell handling
- updated node help and README to match the current runtime behavior and capability labels
- confirmed `Receive Events` subscriptions start at deploy time for both Protect and Access nodes
- increased the shared UniFi Access safe-cancel ring tracking timeout from 60 seconds to 180 seconds

## 0.1.0-pre.2

- added first UniFi Access support with shared config node, door and Access device handling, notification events, and doorbell actions
- added controller-level safe cancel tracking for UniFi Access doorbells with a 60 second timeout
- filtered UniFi Access capabilities using the selected real device, hiding doorbell actions on unsupported devices such as Viewers
- filtered UniFi Protect capabilities using the selected real device, including PTZ, doorbell, and microphone-related actions
- improved dynamic editor behavior so device-specific capabilities and options reload coherently when the selected device changes
- simplified UniFi Access doorbell options to manual room name entry only
- refreshed node help, README, and package logo
