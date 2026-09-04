# Azure Realtime Voice

A browser-based speech-to-speech client for an Azure OpenAI GPT Realtime deployment. The app uses WebRTC for the live audio path and a small Next.js server route for secure session negotiation.

## What it includes

- Hands-free server voice activity detection with interruption support
- Live assistant transcripts and completed user transcripts
- Selectable Azure-supported voices
- Mute, end, continue, reset, and autoplay recovery controls
- Responsive light/dark interface with accessible status updates
- Server-side Azure credential handling; no key, endpoint, or ephemeral token is sent to the browser
- Conversation transcripts and the selected voice are stored locally in the browser so a conversation can continue after a reload
- Audio is never stored by the app; Reset session clears local transcript data and starts over

## Prerequisites

- Node.js 24 LTS
- pnpm 11
- An Azure OpenAI resource with:
  - A GPT Realtime deployment
  - A compatible transcription model deployment
  - An API key

For the strongest current Azure setup, deploy `gpt-realtime-2.1` for the conversation and `gpt-live-transcribe` for input transcripts. Use `gpt-realtime-2` if version 2.1 is not available in your resource. The environment variables below require the deployment names you choose, not the model IDs.

The WebRTC API uses the Azure OpenAI resource endpoint, such as `https://my-resource.openai.azure.com`, not a Foundry project endpoint.

## Local setup

```bash
pnpm install
pnpm exec playwright install chromium webkit
cp .env.example .env.local
pnpm dev
```

Fill in `.env.local`:

```dotenv
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_REALTIME_DEPLOYMENT=your-realtime-deployment
AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT=your-transcription-deployment
REALTIME_INSTRUCTIONS=You are a helpful, concise voice assistant. Speak naturally, keep answers brief unless asked for detail, and reply in the user's language.
APP_ORIGIN=http://localhost:3000
```

Open `http://localhost:3000`. Microphone access works on localhost during development; production must use HTTPS.

## Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm start
```

The browser tests mock the connection UI. A real two-way audio smoke test still requires the configured Azure deployments, a microphone, and a supported browser.

## Azure App Service

Deploy this repository as a Node.js 24 application. Configure the build command as `pnpm install --frozen-lockfile && pnpm build` and the startup command as `pnpm start`.

Set all variables from `.env.example` as App Service application settings, with `APP_ORIGIN` set to the final HTTPS origin. Never create `NEXT_PUBLIC_` versions of the Azure settings. Enable:

- HTTPS Only
- Always On
- Health check path `/api/health`

After deployment, verify the health endpoint, grant microphone permission from the HTTPS site, and complete at least two conversational turns in Chrome or Edge and Safari.

## Architecture

1. After a user gesture, the browser obtains a microphone track and creates an `RTCPeerConnection` and data channel.
2. The browser sends its SDP offer and selected voice to `POST /api/realtime/session`.
3. The server creates an Azure client secret with the permanent API key, exchanges the offer with Azure, and returns only the SDP answer.
4. Azure and the browser exchange live audio over WebRTC. Transcript and activity events arrive on the data channel.
5. Completed transcript turns and the selected voice are saved in browser-local IndexedDB. Starting again sends a bounded portion of that text to Azure as context so the conversation can continue.
6. Ending a conversation closes the data channel and peer connection and stops every local media track. Resetting also clears the saved browser history.

Conversation history stays in the current browser profile and is not synchronized across devices. Clearing site data, using private browsing, or selecting **Reset session** removes it. The app stores text transcripts only, never microphone or assistant audio.

The session route is intentionally unauthenticated and has no application rate limit, matching this project's small trusted-audience requirement. Anyone who can reach the deployed URL can request a billable session, so keep the URL private and configure Azure budget and quota alerts.

## Browser support

Current Chrome, Edge, desktop Safari, and iPhone Safari are the acceptance targets. Firefox is best effort.

## References

- [Azure GPT Realtime via WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc)
- [OpenAI Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
