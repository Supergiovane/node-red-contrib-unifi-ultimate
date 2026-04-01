# Changelog

## 0.1.0-beta.2

- added first UniFi Access support with shared config node, door and Access device handling, notification events, and doorbell actions
- added controller-level safe cancel tracking for UniFi Access doorbells with a 60 second timeout
- filtered UniFi Access capabilities using the selected real device, hiding doorbell actions on unsupported devices such as Viewers
- filtered UniFi Protect capabilities using the selected real device, including PTZ, doorbell, and microphone-related actions
- improved dynamic editor behavior so device-specific capabilities and options reload coherently when the selected device changes
- simplified UniFi Access doorbell options to manual room name entry only
- refreshed node help, README, and package logo
