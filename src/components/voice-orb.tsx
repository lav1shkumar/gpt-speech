import type { ActivityState, ConnectionState } from "@/lib/realtime/types";

type OrbMode = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ending" | "error";

type VoiceOrbProps = {
  connectionState: ConnectionState;
  activityState: ActivityState;
};

function getOrbMode(connectionState: ConnectionState, activityState: ActivityState): OrbMode {
  if (connectionState === "requesting-microphone" || connectionState === "negotiating") {
    return "connecting";
  }

  if (connectionState === "disconnecting") return "ending";
  if (connectionState === "error") return "error";
  if (connectionState !== "connected") return "idle";

  if (activityState === "assistant-thinking") return "thinking";
  if (activityState === "assistant-speaking" || activityState === "user-speaking") return "speaking";
  return "listening";
}

export function VoiceOrb({ connectionState, activityState }: VoiceOrbProps) {
  const mode = getOrbMode(connectionState, activityState);

  return (
    <div className="voice-orb" data-mode={mode} aria-hidden="true">
      <span className="voice-orb__ring voice-orb__ring--outer" />
      <span className="voice-orb__ring voice-orb__ring--inner" />
      <span className="voice-orb__core">
        <span className="voice-orb__glow" />
        <span className="voice-orb__wave voice-orb__wave--one" />
        <span className="voice-orb__wave voice-orb__wave--two" />
        <span className="voice-orb__wave voice-orb__wave--three" />
      </span>
    </div>
  );
}
