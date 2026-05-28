# Specification: Janus Terminal Orchestrator Configuration & Settings Menu

This document specifies the architecture, JSON schema, and interface guidelines for the **Settings Menu** in the **Janus Terminal Orchestrator** (also known as *Orbital Harness*). This configuration model facilitates storing, managing, and exporting/importing all system metadata and configurations for both live cloud runs and local, on-premise installations.

---

## 1. Core Architectural Goals
- **Unified Configuration Profile**: Consolidate all system configurations, API credentials, voice assistant settings, and terminal runtime profiles into a single structured schema.
- **Portability**: Allow users to download their complete project environment parameters as a lightweight JSON file (`janus-config.json`) and import it instantly during a local installation.
- **Dynamic Adaptability**: Support live, bi-directional updates between frontend form-fields, direct interactive raw JSON text editors, and backend system stores.
- **Security-First Isolation**: Clearly separate public local setup options from sensitive secrets (such as the `GEMINI_API_KEY`), which must be masked inside form components and never logged or exposed.

---

## 2. Configuration JSON Schema (`janus-config.json`)

For a local installation of this project, all input parameters and metadata are maintained under the following JSON schema:

```json
{
  "$schema": "https://json.schemastore.org/janus-config.json",
  "meta": {
    "version": "1.0.4",
    "createdAt": "2026-05-28T02:24:22Z",
    "updatedAt": "2026-05-28T02:24:22Z",
    "environment": "local"
  },
  "server": {
    "port": 3000,
    "host": "0.0.0.0",
    "appUrl": "http://localhost:3000",
    "localWorkspacePath": "./"
  },
  "voiceAi": {
    "geminiApiKey": "AIzaSy...",
    "model": "gemini-3.1-flash-live-preview",
    "voice": "Zephyr",
    "sampleRate": 16000,
    "isMicMuted": false
  },
  "orchestrator": {
    "globalPermissionsMode": "Inherit",
    "maxBufferLines": 100,
    "idleTimeoutMs": 2000,
    "defaultShellCommand": "bash",
    "defaultProjectContext": "default_project"
  },
  "presets": {
    "claudeCode": {
      "enabled": true,
      "command": "npx @anthropic-ai/claude"
    },
    "codex": {
      "enabled": true,
      "command": "npx codex-cli"
    },
    "antigravity": {
      "enabled": true,
      "command": "npx antigravity"
    }
  }
}
```

### Parameter Explanations

| Field Path | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `server.port` | `number` | `3000` | The primary port on which the Express and Vite dev servers listen. |
| `server.host` | `string` | `"0.0.0.0"` | Bind network interface. `0.0.0.0` allows routing through Docker/containers. |
| `server.appUrl` | `string` | `"http://localhost:3000"`| Core reference callback url, essential for self-referral or OAuth payloads. |
| `voiceAi.geminiApiKey`| `string` | `""` | Gemini API Key for running full multiplexed real-time voice sessions. |
| `voiceAi.model` | `string` | `"gemini-3.1-flash-live-preview"`| Live Voice AI model selection. |
| `voiceAi.voice` | `string` | `"Zephyr"` | Sound/Prebuilt voice persona. Default to `Zephyr` (also supports `Puck`, `Charon` etc.)|
| `orchestrator.globalPermissionsMode`| `string`| `"Inherit"` | Overriding agent execute mode: `Inherit`, `Full Auto`, `Human-in-the-Loop`, `Read-Only`. |
| `orchestrator.maxBufferLines`| `number` | `100` | Maximum console lines preserved in active in-memory terminal buffers. |
| `orchestrator.defaultShellCommand`| `string` | `"bash"` | Shell fallback string used to boot generic Custom Shell terminals. |
| `presets.claudeCode.command` | `string` | `"npx @anthropic-ai/claude"`| Base shell execution tool for Antigravity automated code changes. |

---

## 3. Web Service API (`/api/settings`)

The backend server persists configuration parameters in `.janus_settings.json` locally and provides a unified REST handler:

### GET `/api/settings`
Retrieves the active, compiled configuration JSON profile. Masked API keys are returned for secure visualization.

- **Request**: Empty
- **Response**: `200 OK`
```json
{
  "server": { "port": 3000, "host": "0.0.0.5", "appUrl": "http://localhost:3000" },
  "voiceAi": { "geminiApiKey": "••••••••••••••••", "model": "gemini-3.1-flash-live-preview", "voice": "Zephyr" },
  "orchestrator": { "globalPermissionsMode": "Inherit", "maxBufferLines": 100, "defaultShellCommand": "bash" }
}
```

### PUT `/api/settings`
Updates the active configurations on-the-fly and broadcasts changed items to connected frontends via WebSocket.

- **Request**: Complete or partial JSON body matches the schema above.
- **Response**: `200 OK` on successful validation.

---

## 4. UI Settings Menu Implementation Guide

To maintain highest-fidelity, the settings menu layout consists of:

1. **Tabbed Panel Layout**:
    - **General Form**: Interactive UI sliders, toggles, and dropdowns for general settings.
    - **Environment Config Parser**: Interactive text area displaying the compiled parameter JSON, facilitating quick copies or direct direct edits with automatic JSON checks.
    - **Local Setup Tools**: Import (Local File Upload / Drag-and-Drop) and Export (instantly downloads a clean configured `janus-config.json` profile).

2. **Visual Aesthetics**:
    - Pure dark styling matching the elegant **Cosmic Slate Theme** of Orbital Harness.
    - Uses Space Grotesk layout display titles paired with JetBrains Mono code panels.
    - Responsive slider elements to coordinate buffer line limits.

3. **Status Indicators**:
    - Indicator highlighting if settings are synchronized with local file systems `.janus_settings.json`.
