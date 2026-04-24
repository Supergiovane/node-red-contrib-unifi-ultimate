# Changelog

## 0.1.3

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
