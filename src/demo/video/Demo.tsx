import { useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  Freeze,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import {
  buildCamera,
  buildCursor,
  buildEdit,
  cameraAt,
  cursorAt,
  type Edit,
  type Frame,
  screenFrame,
  segmentDuration,
  sourceToOutput,
  toStage,
} from "../edit";
import type { Music, VideoStyle } from "../style";
import type { Timeline } from "../timeline";

export interface DemoProps extends Record<string, unknown> {
  readonly timeline: Timeline;
  readonly style: VideoStyle;
}

export function Demo({ timeline, style }: DemoProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const now = (frame / fps) * 1000;
  const edit = useMemo(() => buildEdit(timeline, style), [timeline, style]);
  const camera = useMemo(() => buildCamera(timeline, edit, style), [timeline, edit, style]);
  const cursor = useMemo(() => buildCursor(timeline, edit), [timeline, edit]);
  const keys = useMemo(
    () =>
      timeline.events.flatMap((event) =>
        event.kind === "keys" ? [{ at: sourceToOutput(edit, event.at), label: event.label }] : [],
      ),
    [timeline, edit],
  );
  const screen = screenFrame(timeline, style);
  const view = cameraAt(camera, now);
  const transform = `translate(${style.width / 2}px, ${style.height / 2}px) scale(${view.zoom}) translate(${-view.x}px, ${-view.y}px)`;

  return (
    <AbsoluteFill style={{ fontFamily: style.fontFamily }}>
      <Backdrop style={style} />
      <AbsoluteFill style={{ transform, transformOrigin: "0 0" }}>
        <div
          style={{
            position: "absolute",
            left: screen.offsetX,
            top: screen.offsetY,
            width: screen.width,
            height: screen.height,
            borderRadius: style.cornerRadius,
            overflow: "hidden",
            boxShadow: "0 30px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.08)",
            background: "#1f1f1f",
          }}
        >
          <ScreenVideo edit={edit} file={timeline.video.file} fps={fps} />
        </div>
        <Cursor screen={screen} style={style} now={now} track={cursor} zoom={view.zoom} />
      </AbsoluteFill>
      {style.showKeys ? <Keys keys={keys} now={now} style={style} /> : null}
      <ChapterCards edit={edit} fps={fps} style={style} />
      <Intro style={style} edit={edit} fps={fps} />
      <Outro style={style} edit={edit} fps={fps} />
      {style.music ? <Soundtrack music={style.music} fps={fps} /> : null}
    </AbsoluteFill>
  );
}

function Soundtrack({ music, fps }: { music: Music; fps: number }) {
  const { durationInFrames } = useVideoConfig();
  const fadeIn = toFrames(music.fadeInMs, fps);
  const fadeOut = durationInFrames - toFrames(music.fadeOutMs, fps);
  return (
    <Audio
      src={staticFile(music.file)}
      trimBefore={toFrames(music.startAtMs, fps)}
      volume={(f) =>
        music.volume *
        interpolate(f, [0, fadeIn, fadeOut, durationInFrames], [0, 1, 1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      }
    />
  );
}

function Backdrop({ style }: { style: VideoStyle }) {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1200px 800px at 12% 8%, ${style.glow[0]}, transparent 60%), radial-gradient(1100px 760px at 92% 96%, ${style.glow[1]}, transparent 60%), linear-gradient(135deg, ${style.background[0]}, ${style.background[1]})`,
      }}
    />
  );
}

function toFrames(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

function ScreenVideo({ edit, file, fps }: { edit: Edit; file: string; fps: number }) {
  const src = staticFile(file);
  return (
    <>
      {edit.segments.map((segment, index) => {
        const from = toFrames(segment.outStart, fps);
        const duration = toFrames(segment.outStart + segmentDuration(segment), fps) - from;
        if (duration <= 0) {
          return null;
        }
        return (
          <Sequence key={index} from={from} durationInFrames={duration} layout="none">
            {segment.kind === "play" ? (
              <OffthreadVideo
                src={src}
                muted
                trimBefore={toFrames(segment.srcStart, fps)}
                playbackRate={segment.rate}
                style={{ width: "100%", height: "100%", display: "block" }}
              />
            ) : (
              <Freeze frame={toFrames(segment.srcAt, fps)}>
                <OffthreadVideo
                  src={src}
                  muted
                  style={{ width: "100%", height: "100%", display: "block" }}
                />
              </Freeze>
            )}
          </Sequence>
        );
      })}
    </>
  );
}

function Cursor({
  screen,
  style,
  now,
  track,
  zoom,
}: {
  screen: Frame;
  style: VideoStyle;
  now: number;
  track: ReturnType<typeof buildCursor>;
  zoom: number;
}) {
  const position = cursorAt(track, now);
  if (!position) {
    return null;
  }
  const point = toStage(screen, position);
  const size = (style.cursorSize * screen.scale) / Math.sqrt(zoom);
  const recent = track.clicks.filter((click) => now >= click.at && now - click.at < 600);
  const pressing = track.clicks.some((click) => Math.abs(now - click.at) < 120);
  return (
    <>
      {recent.map((click, index) => {
        const progress = (now - click.at) / 600;
        const at = toStage(screen, click.point);
        const radius = interpolate(progress, [0, 1], [size * 0.3, size * 1.6]);
        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: at.x - radius,
              top: at.y - radius,
              width: radius * 2,
              height: radius * 2,
              borderRadius: "50%",
              border: `${size * 0.12}px solid ${style.accent}`,
              background: `${style.accent}33`,
              opacity: interpolate(progress, [0, 1], [0.9, 0]),
            }}
          />
        );
      })}
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        style={{
          position: "absolute",
          left: point.x - size * 0.16,
          top: point.y - size * 0.09,
          transform: `scale(${pressing ? 0.85 : 1})`,
          transformOrigin: "16% 9%",
          filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.45))",
        }}
      >
        <path
          d="M5 3 L5 25 L10.5 19.8 L14.2 28.2 L18 26.6 L14.4 18.4 L22 18.4 Z"
          fill="#111"
          stroke="#fff"
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}

function Keys({
  keys,
  now,
  style,
}: {
  keys: readonly { at: number; label: string }[];
  now: number;
  style: VideoStyle;
}) {
  const active = keys.filter((key) => now >= key.at && now - key.at < 1400).at(-1);
  if (!active) {
    return null;
  }
  const age = now - active.at;
  const opacity = interpolate(age, [0, 120, 1150, 1400], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 56 }}>
      <div style={{ display: "flex", gap: 10, opacity }}>
        {active.label.split("+").map((part) => (
          <div
            key={part}
            style={{
              padding: "10px 18px",
              borderRadius: 12,
              background: "rgba(20, 22, 27, 0.88)",
              border: "1px solid rgba(255,255,255,0.18)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
              color: "#fff",
              fontSize: 30,
              fontWeight: 600,
              fontFamily: style.fontFamily,
            }}
          >
            {part}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function ChapterCards({ edit, fps, style }: { edit: Edit; fps: number; style: VideoStyle }) {
  return (
    <>
      {edit.segments.map((segment, index) =>
        segment.kind === "hold" ? (
          <Sequence
            key={index}
            from={toFrames(segment.outStart, fps)}
            durationInFrames={toFrames(segment.duration, fps)}
          >
            <ChapterCard title={segment.title} style={style} durationMs={segment.duration} />
          </Sequence>
        ) : null,
      )}
    </>
  );
}

function ChapterCard({
  title,
  style,
  durationMs,
}: {
  title: string;
  style: VideoStyle;
  durationMs: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const fade = interpolate(ms, [0, 250, durationMs - 300, durationMs], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rise = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  return (
    <AbsoluteFill
      style={{
        opacity: fade,
        backdropFilter: "blur(14px) brightness(0.45)",
        background: "rgba(8, 10, 14, 0.35)",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          transform: `translateY(${(1 - rise) * 24}px)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 26,
        }}
      >
        <div style={{ width: 64 * rise, height: 6, borderRadius: 3, background: style.accent }} />
        <div
          style={{
            color: "#fff",
            fontSize: 76,
            fontWeight: 700,
            letterSpacing: -1.5,
            textAlign: "center",
            maxWidth: 1400,
            lineHeight: 1.12,
            textShadow: "0 8px 40px rgba(0,0,0,0.5)",
          }}
        >
          {title}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function Intro({ style, edit, fps }: { style: VideoStyle; edit: Edit; fps: number }) {
  const frame = useCurrentFrame();
  const ms = (frame / fps) * 1000;
  if (ms > edit.videoStart + 600) {
    return null;
  }
  const out = interpolate(ms, [edit.videoStart - 400, edit.videoStart + 400], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 24 });
  return (
    <AbsoluteFill style={{ opacity: out, justifyContent: "center", alignItems: "center" }}>
      <Backdrop style={style} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 40,
          transform: `scale(${0.94 + enter * 0.06})`,
          opacity: enter,
        }}
      >
        <Img src={staticFile(style.logo)} style={{ width: 640 }} />
        <div style={{ color: "rgba(255,255,255,0.86)", fontSize: 44, fontWeight: 500 }}>
          {style.intro.tagline}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function Outro({ style, edit, fps }: { style: VideoStyle; edit: Edit; fps: number }) {
  const frame = useCurrentFrame();
  const startFrame = toFrames(edit.videoEnd, fps);
  if (frame < startFrame - toFrames(500, fps)) {
    return null;
  }
  const local = frame - startFrame;
  const fade = interpolate(local, [-toFrames(500, fps), 0], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const enter = spring({ frame: Math.max(0, local), fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ opacity: fade, justifyContent: "center", alignItems: "center" }}>
      <Backdrop style={style} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 34,
          transform: `translateY(${(1 - enter) * 20}px)`,
        }}
      >
        <Img src={staticFile(style.logo)} style={{ width: 520 }} />
        <div style={{ color: "#fff", fontSize: 58, fontWeight: 700, letterSpacing: -1 }}>
          {style.outro.headline}
        </div>
        <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 34, fontWeight: 500 }}>
          {style.outro.subline}
        </div>
      </div>
    </AbsoluteFill>
  );
}
