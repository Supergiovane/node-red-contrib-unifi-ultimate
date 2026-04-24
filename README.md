<p align="center">
  <img src="nodes/icons/unifi-ultimate-logo.svg" alt="Unifi Ultimate" width="720">
</p>

<p align="center">
  <img src="nodes/icons/readme-overview.svg" alt="Overview of Node-RED UniFi Ultimate architecture" width="980">
</p>

[![NPM version][npm-version-image]][npm-url]
[![Node.js version][node-version-image]][npm-url]
[![Node-RED Flow Library][flows-image]][flows-url]
[![Docs][docs-image]][docs-url]
[![NPM downloads per month][npm-downloads-month-image]][npm-url]
[![NPM downloads total][npm-downloads-total-image]][npm-url]
[![MIT License][license-image]][license-url]
[![Youtube][youtube-image]][youtube-url]

# node-red-contrib-unifi-ultimate

Build UniFi automations in Node-RED without hand-writing API calls.

[View Changelog](CHANGELOG.md)

## At A Glance

- one package for `UniFi Protect`, `UniFi Access`, and `UniFi Network`
- device-first UX: pick item, then only compatible actions are shown
- built-in live events for Protect and Access
- utility nodes for Network presence and PoE control
- import-ready example flows included

## Quick Navigation

- [Install](#install)
- [Quick Start](#quick-start)
- [Available Nodes](#available-nodes)
- [UniFi Protect](#unifi-protect)
- [UniFi Access](#unifi-access)
- [UniFi Network](#unifi-network)
- [Outputs](#outputs)
- [Example Flows](#example-flows)
- [Project Status](#project-status)

## Install

In Node-RED:

1. Open `Manage palette`
2. Select `Install`
3. Search for `node-red-contrib-unifi-ultimate`
4. Install the package

## Quick Start

1. Add a config node: `Unifi Protect Config`, `Unifi Access Config`, or `Unifi Network Config`
2. Enter host and credentials
3. Add a corresponding device node
4. Choose type, item, and action
5. Deploy
6. Wire outputs:
   Output 1 for state/action responses
   Output 2 for live events (when action is `Receive Events`)

If you want the fastest path, import one of the flows from `examples/` and replace credentials.

## Available Nodes

| Node | Purpose |
|---|---|
| `Unifi Protect Config` | stores UniFi Protect connection settings |
| `Unifi Protect Device` | reads state, receives events, and executes Protect actions |
| `Unifi Access Config` | stores UniFi Access connection settings |
| `Unifi Access Device` | reads state, receives events, and executes Access actions |
| `Unifi Network Config` | stores UniFi Network connection settings |
| `Unifi Network Device` | reads state/details and executes supported Network actions |
| `Unifi Network Presence` | emits stable `true/false` presence for one client |
| `Unifi Network Control POE` | enables/disables/cycles PoE on one switch port |

## UniFi Protect

Supported device types:

- `Camera`
- `Sensor`
- `Light`
- `Chime`
- `Viewer`
- `Live View`
- `NVR`

Common capabilities:

- `Receive Events`
- `Read Device State`
- `Send Raw Update`

Additional capabilities (when supported by selected device):

- `Take Snapshot`
- `List RTSPS Streams`
- `Create RTSPS Stream`
- `Delete RTSPS Stream`
- `Start Talkback Session`
- `Disable Microphone Permanently`
- `Start PTZ Patrol`
- `Stop PTZ Patrol`
- `Recall PTZ Preset`
- `Show Doorbell Message`
- `Switch Live View`
- `Update One Property`
- `Read Application Info` (NVR)

Editor adaptation examples:

- sensor observables: contact, motion, alarm, water leak, tamper, battery low, extreme values
- camera observables: ring, motion, smart detections
- PTZ preset selector only on PTZ-capable cameras
- live view selector for viewers
- patchable property discovery from selected device

For supported observables, `msg.payload` can be normalized to `true/false`; raw context remains available in `msg.RAW`.

## UniFi Access

Supported device types:

- `Door`
- `Access Device`

Common capabilities:

- `Receive Events`
- `Read State`

Door capabilities:

- `Unlock Door`
- `Read Lock Rule`
- `Set Temporary Lock Rule`
- `Read Emergency Mode`
- `Set Emergency Mode`

Temporary lock rule UX:

- selecting `Custom Duration` reveals minutes (`interval`)
- legacy unix `ended_time` fallback is still supported for compatibility

Access device capabilities:

- `Read Access Methods`
- `Update Access Methods`
- `Trigger Doorbell`
- `Cancel Doorbell`

When using `Receive Events`, the node fetches current state once and then listens to official Access notifications.

## UniFi Network

Supported resource types:

- `Site`
- `UniFi Device`
- `Client`

Common capabilities:

- `Read State`
- `Read Details`

Additional capabilities:

- Site: `Read Application Info`, `List Site Devices`, `List Site Clients`
- UniFi Device: `Read Latest Statistics`, `Restart Device`, `Power Cycle Port`
- Client: `Authorize Guest Access`, `Revoke Guest Access`

Notes:

- for device/client resources, site context is handled automatically behind the scenes
- `Read Application Info` is available on `Site` and returns Network application metadata

Dedicated utility nodes:

- `Unifi Network Presence`: stable presence with disconnect hysteresis
- `Unifi Network Control POE`: enable, disable, or cycle PoE on one selected port

## Outputs

- Output 1: current state or action response
- Output 2: live events when capability is `Receive Events` (Protect and Access)
- Metadata is attached via product-specific fields (`msg.unifiProtect`, `msg.unifiAccess`, `msg.unifiNetwork`)

## Example Flows

Import from `examples/`:

| Flow file | What it demonstrates |
|---|---|
| [examples/unifi-protect-info.json](examples/unifi-protect-info.json) | read Protect camera state |
| [examples/unifi-protect-sensor-observe.json](examples/unifi-protect-sensor-observe.json) | boolean sensor observable stream |
| [examples/unifi-protect-camera-actions.json](examples/unifi-protect-camera-actions.json) | snapshot, PTZ presets, doorbell messages |
| [examples/unifi-access-door-control.json](examples/unifi-access-door-control.json) | door observe, unlock, temporary lock rule |
| [examples/unifi-access-intercom-doorbell.json](examples/unifi-access-intercom-doorbell.json) | intercom observe, trigger/cancel doorbell safely |

## Project Status

- UniFi Protect is currently the most complete surface
- UniFi Access is stable but may evolve quickly in upcoming releases
- UniFi Network currently focuses on read-first flows plus selected action utilities

[npm-version-image]: https://img.shields.io/npm/v/node-red-contrib-unifi-ultimate.svg
[npm-url]: https://www.npmjs.com/package/node-red-contrib-unifi-ultimate
[node-version-image]: https://img.shields.io/node/v/node-red-contrib-unifi-ultimate.svg
[flows-image]: https://img.shields.io/badge/Node--RED-Flow%20Library-red
[flows-url]: https://flows.nodered.org/node/node-red-contrib-unifi-ultimate
[docs-image]: https://img.shields.io/badge/docs-documents-blue
[docs-url]: https://github.com/Supergiovane/node-red-contrib-unifi-ultimate#readme
[npm-downloads-month-image]: https://img.shields.io/npm/dm/node-red-contrib-unifi-ultimate.svg
[npm-downloads-total-image]: https://img.shields.io/npm/dt/node-red-contrib-unifi-ultimate.svg
[license-image]: https://img.shields.io/badge/license-MIT-green.svg
[license-url]: https://opensource.org/licenses/MIT
[youtube-image]: https://img.shields.io/badge/YouTube-Subscribe-red?logo=youtube&logoColor=white
[youtube-url]: https://www.youtube.com/@maxsupervibe
