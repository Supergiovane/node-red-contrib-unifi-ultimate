<p align="center">
  <img src="nodes/icons/unifi-ultimate-logo.svg" alt="Unifi Ultimate" width="720">
</p>

# node-red-contrib-unifi-ultimate

Use UniFi Protect and UniFi Access inside Node-RED without building custom API calls.

This package lets you:

- monitor cameras, sensors, lights, doors, and Access devices
- react to live events inside your flows
- trigger common Protect and Access actions from a single device node
- start from ready-to-import example flows

Current release status: `0.1.0-beta.5`

[View Changelog](CHANGELOG.md)

## Before you start

- Node-RED `3.1.1` or newer
- Node.js `18` or newer
- For UniFi Protect: controller IP or host, API key header, and API key
- For UniFi Access: host and bearer token
- If your UniFi controller uses a self-signed certificate, both config nodes let you adjust TLS behavior

## Install

In Node-RED:

1. Open `Manage palette`
2. Select `Install`
3. Search for `node-red-contrib-unifi-ultimate`
4. Install the package

## Quick start

1. Add the right config node for your UniFi product:
   `Unifi Protect Config` or `Unifi Access Config`
2. Enter your connection details and credentials
3. Add a `Device` node
4. Select the device type, the specific UniFi device, and the capability you want
5. Deploy
6. Connect:
   Output 1 for state or action results
   Output 2 for live events when you use `Receive Events`

If you want the fastest path, import one of the included example flows and replace the credentials with your own.

## Available nodes

- `Unifi Protect Config`: stores the connection settings for UniFi Protect
- `Unifi Protect Device`: select a Protect device, read its state, listen for events, or trigger actions
- `Unifi Access Config`: stores the connection settings for UniFi Access
- `Unifi Access Device`: select a door or Access device, read its state, listen for events, or trigger actions

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

Additional capabilities available when supported by the selected device:

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

The editor adapts to the selected device and capability. For example, it can offer:

- sensor observables such as contact, motion, alarm, water leak, tamper, or battery low
- camera observables such as ring, motion, and smart detections
- light observables such as motion or light on/off
- PTZ preset choices for supported cameras
- live view choices for supported viewers
- patchable properties discovered from the selected device

For supported boolean event observables, the main payload is normalized to `true` or `false`, while the original event details remain available in the message.

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

Access device capabilities:

- `Read Access Methods`
- `Update Access Methods`
- `Trigger Doorbell`
- `Cancel Doorbell`

When you use `Receive Events`, the node first fetches the current state and then keeps listening for matching UniFi Access notifications.

## Outputs

- Output 1 returns the current state or the main action response
- Output 2 returns live events when the selected capability is `Receive Events`
- The message also includes product-specific metadata and the last known device data when available

## Example flows

Import one of these flows from the `examples` folder:

- [examples/unifi-protect-info.json](examples/unifi-protect-info.json): read the state of a Protect camera
- [examples/unifi-protect-sensor-observe.json](examples/unifi-protect-sensor-observe.json): observe a Protect sensor as a boolean event stream
- [examples/unifi-protect-camera-actions.json](examples/unifi-protect-camera-actions.json): take snapshots, use PTZ presets, and show doorbell messages
- [examples/unifi-access-door-control.json](examples/unifi-access-door-control.json): observe a door, unlock it, and manage a temporary lock rule
- [examples/unifi-access-intercom-doorbell.json](examples/unifi-access-intercom-doorbell.json): observe an intercom device, trigger a doorbell, and cancel it safely

## Beta notes

- UniFi Protect is the main supported surface today
- UniFi Access is included as a first beta and may evolve faster across releases
