import type { CSSProperties } from "react";

export type GeneratedAvatarVariant = "agent" | "channel" | "human" | "system";

interface GeneratedAvatarProps {
  readonly className?: string;
  readonly id: string;
  readonly name?: string;
  readonly size?: number;
  readonly style?: CSSProperties;
  readonly variant?: GeneratedAvatarVariant;
}

interface AvatarPalette {
  readonly accent: string;
  readonly background: string;
  readonly detail: string;
  readonly surface: string;
  readonly text: string;
}

const AGENT_PALETTES: readonly AvatarPalette[] = [
  { background: "#202326", surface: "#30353a", accent: "#55c7a9", detail: "#bdf4e8", text: "#f8fafc" },
  { background: "#26252a", surface: "#343139", accent: "#f1b35b", detail: "#ffe3b5", text: "#fffaf2" },
  { background: "#1f2933", surface: "#2f3b47", accent: "#7fc8ff", detail: "#d7efff", text: "#f8fbff" },
  { background: "#28251f", surface: "#3a352b", accent: "#d5cd67", detail: "#f6f0bc", text: "#fffdf2" },
  { background: "#221f27", surface: "#322e3a", accent: "#c8a3ff", detail: "#eadbff", text: "#fbf8ff" },
  { background: "#1f2924", surface: "#2e3b34", accent: "#91d37a", detail: "#dcffd4", text: "#f8fff5" },
];

const HUMAN_PALETTES: readonly AvatarPalette[] = [
  { background: "#f6d8c8", surface: "#fff6ef", accent: "#c96f50", detail: "#f0ae90", text: "#593224" },
  { background: "#d9e7d1", surface: "#f8fff3", accent: "#5f8f65", detail: "#a9cf9a", text: "#263f2a" },
  { background: "#dbe4f4", surface: "#f7fbff", accent: "#637fae", detail: "#a7bce0", text: "#283750" },
  { background: "#f0dfb4", surface: "#fff8e4", accent: "#aa7a2e", detail: "#dfbe6f", text: "#513916" },
  { background: "#ead8ec", surface: "#fff7ff", accent: "#9b6fa1", detail: "#d3abd8", text: "#49324d" },
  { background: "#d8ece7", surface: "#f4fffc", accent: "#4f9489", detail: "#9acdc4", text: "#223f3a" },
];

const CHANNEL_PALETTES: readonly AvatarPalette[] = [
  { background: "#f1f2f4", surface: "#ffffff", accent: "#6c7480", detail: "#c9cdd3", text: "#25282c" },
  { background: "#eef0e8", surface: "#ffffff", accent: "#777d52", detail: "#c9cead", text: "#303320" },
  { background: "#f2ede8", surface: "#ffffff", accent: "#9a765f", detail: "#d6bca9", text: "#3a2d25" },
];

export function GeneratedAvatar({
  className,
  id,
  name,
  size,
  style,
  variant = "agent",
}: GeneratedAvatarProps) {
  const seed = `${variant}:${id || name || "unknown"}`;
  const values = buildAvatarValues(seed);
  const palette = resolvePalette(variant, values[0] ?? 0);
  const initials = buildAvatarInitials(name || id, variant);
  const rootStyle = size ? { ...style, width: size, height: size } : style;

  return (
    <span
      aria-hidden="true"
      className={["generated-avatar", `generated-avatar--${variant}`, className].filter(Boolean).join(" ")}
      style={rootStyle}
    >
      <svg className="generated-avatar__svg" focusable="false" viewBox="0 0 64 64">
        <rect fill={palette.background} height="64" rx={variant === "agent" ? "14" : "32"} width="64" />
        {variant === "agent" ? renderAgentMark(palette, values) : null}
        {variant === "human" ? renderHumanMark(palette, values) : null}
        {variant === "channel" ? renderChannelMark(palette, values) : null}
        {variant === "system" ? renderSystemMark(palette, values) : null}
        <text
          aria-hidden="true"
          dominantBaseline="middle"
          fill={palette.text}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          fontSize={initials.length > 1 ? "19" : "23"}
          fontWeight="700"
          textAnchor="middle"
          x="32"
          y="34"
        >
          {initials}
        </text>
      </svg>
    </span>
  );
}

function renderAgentMark(palette: AvatarPalette, values: readonly number[]) {
  const radius = [8, 10, 12, 16][(values[1] ?? 0) % 4] ?? 10;
  const skew = ((values[2] ?? 0) % 9) - 4;
  const nodeA = { x: 17 + ((values[3] ?? 0) % 8), y: 18 + ((values[4] ?? 0) % 8) };
  const nodeB = { x: 42 + ((values[5] ?? 0) % 7), y: 17 + ((values[6] ?? 0) % 10) };
  const nodeC = { x: 25 + ((values[7] ?? 0) % 18), y: 44 + ((values[8] ?? 0) % 7) };

  return (
    <>
      <rect fill={palette.surface} height="42" rx={radius} width="42" x="11" y="11" />
      <path
        d={`M${nodeA.x} ${nodeA.y} L${nodeB.x} ${nodeB.y} L${nodeC.x} ${nodeC.y} Z`}
        fill="none"
        opacity="0.78"
        stroke={palette.detail}
        strokeWidth="2.2"
      />
      <path
        d={`M15 ${45 + skew} C26 ${36 - skew}, 38 ${54 + skew}, 50 ${42 - skew}`}
        fill="none"
        opacity="0.72"
        stroke={palette.accent}
        strokeLinecap="round"
        strokeWidth="3"
      />
      {[nodeA, nodeB, nodeC].map((node, index) => (
        <circle cx={node.x} cy={node.y} fill={index === 1 ? palette.accent : palette.detail} key={index} r={index === 2 ? "3.4" : "3"} />
      ))}
    </>
  );
}

function renderHumanMark(palette: AvatarPalette, values: readonly number[]) {
  const offsetA = ((values[1] ?? 0) % 12) - 6;
  const offsetB = ((values[2] ?? 0) % 10) - 5;
  const arc = ((values[3] ?? 0) % 8) + 12;

  return (
    <>
      <circle cx={22 + offsetA} cy={21 + offsetB} fill={palette.surface} opacity="0.94" r="20" />
      <circle cx={47 - offsetB} cy={46 - offsetA} fill={palette.detail} opacity="0.72" r={arc} />
      <path
        d={`M15 ${47 - offsetB} C22 ${38 + offsetA}, 42 ${38 - offsetA}, 50 ${47 + offsetB}`}
        fill="none"
        opacity="0.7"
        stroke={palette.accent}
        strokeLinecap="round"
        strokeWidth="4"
      />
    </>
  );
}

function renderChannelMark(palette: AvatarPalette, values: readonly number[]) {
  const angle = ((values[1] ?? 0) % 10) - 5;

  return (
    <>
      <rect fill={palette.surface} height="39" opacity="0.94" rx="10" width="39" x="13" y="13" />
      <path d={`M18 ${25 + angle} H46M18 ${38 - angle} H46`} opacity="0.7" stroke={palette.detail} strokeLinecap="round" strokeWidth="4" />
      <path d="M24 18 20 46M44 18 40 46" opacity="0.74" stroke={palette.accent} strokeLinecap="round" strokeWidth="3" />
    </>
  );
}

function renderSystemMark(palette: AvatarPalette, values: readonly number[]) {
  const offset = ((values[1] ?? 0) % 8) - 4;

  return (
    <>
      <circle cx="32" cy="32" fill={palette.surface} opacity="0.92" r="22" />
      <path
        d={`M22 ${24 + offset}h20M22 ${32 - offset}h20M22 ${40 + offset}h20`}
        opacity="0.78"
        stroke={palette.accent}
        strokeLinecap="round"
        strokeWidth="3"
      />
      <circle cx="20" cy={24 + offset} fill={palette.detail} r="2.6" />
      <circle cx="20" cy={32 - offset} fill={palette.detail} r="2.6" />
      <circle cx="20" cy={40 + offset} fill={palette.detail} r="2.6" />
    </>
  );
}

function buildAvatarValues(seed: string): number[] {
  return Array.from({ length: 12 }, (_, index) => hashString(`${seed}:${index}`));
}

function buildAvatarInitials(value: string, variant: GeneratedAvatarVariant): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return variant === "channel" ? "#" : variant === "system" ? "S" : "?";
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${Array.from(words[0] ?? "")[0] ?? ""}${Array.from(words[1] ?? "")[0] ?? ""}`.toUpperCase();
  }

  const chars = Array.from(trimmed.replace(/^@/, ""));
  return (chars[0] ?? "?").toUpperCase();
}

function resolvePalette(variant: GeneratedAvatarVariant, value: number): AvatarPalette {
  if (variant === "human") {
    return HUMAN_PALETTES[value % HUMAN_PALETTES.length]!;
  }
  if (variant === "channel") {
    return CHANNEL_PALETTES[value % CHANNEL_PALETTES.length]!;
  }
  if (variant === "system") {
    return CHANNEL_PALETTES[(value + 1) % CHANNEL_PALETTES.length]!;
  }
  return AGENT_PALETTES[value % AGENT_PALETTES.length]!;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
