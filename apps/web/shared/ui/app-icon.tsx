import type { SVGProps } from "react";

export type AppIconName =
  | "arrowLeft"
  | "agents"
  | "alertCircle"
  | "approvals"
  | "automations"
  | "calendar"
  | "checkCircle"
  | "chevronDown"
  | "close"
  | "contacts"
  | "containers"
  | "copy"
  | "costs"
  | "download"
  | "edit"
  | "groups"
  | "info"
  | "knowledge"
  | "logout"
  | "market"
  | "menu"
  | "messages"
  | "open"
  | "orgChart"
  | "performance"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "skills"
  | "tables"
  | "taskBoard"
  | "templates"
  | "trash";

interface AppIconProps extends SVGProps<SVGSVGElement> {
  readonly name: AppIconName;
}

export function AppIcon({ name, className, ...props }: AppIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height="18"
      viewBox="0 0 18 18"
      width="18"
      {...props}
    >
      {renderIcon(name)}
    </svg>
  );
}

function renderIcon(name: AppIconName) {
  switch (name) {
    case "menu":
      return (
        <path
          d="M3.5 5h11M3.5 9h11M3.5 13h11"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
        />
      );
    case "arrowLeft":
      return (
        <path
          d="m10.75 4.75-3.5 4.25 3.5 4.25M7.5 9h6"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.6"
        />
      );
    case "search":
      return (
        <>
          <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M11.5 11.5 14.5 14.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "close":
      return (
        <path
          d="M5 5 13 13M13 5 5 13"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
        />
      );
    case "checkCircle":
      return (
        <>
          <circle cx="9" cy="9" r="5.75" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="m6.6 9 1.65 1.65L11.6 7.3"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </>
      );
    case "alertCircle":
      return (
        <>
          <circle cx="9" cy="9" r="5.75" stroke="currentColor" strokeWidth="1.6" />
          <path d="M9 6.2v3.1M9 11.5h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "plus":
      return (
        <path
          d="M9 4v10M4 9h10"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
        />
      );
    case "copy":
      return (
        <>
          <rect x="6.25" y="6.25" width="7.25" height="7.25" rx="1.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11.25 6.25V5.5A1.5 1.5 0 0 0 9.75 4h-5.5A1.25 1.25 0 0 0 3 5.25v5.5A1.5 1.5 0 0 0 4.5 12h.75" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
        </>
      );
    case "refresh":
      return (
        <>
          <path
            d="M13.5 7.25A4.75 4.75 0 0 0 5.15 5.1L4 6.25M4 3.75v2.5h2.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
          <path
            d="M4.5 10.75a4.75 4.75 0 0 0 8.35 2.15L14 11.75M14 14.25v-2.5h-2.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </>
      );
    case "download":
      return (
        <>
          <path
            d="M9 3.75v7M6.5 8.75 9 11.25l2.5-2.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
          <path d="M4.5 13.75h9" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "chevronDown":
      return (
        <path
          d="m5.5 7 3.5 3.5L12.5 7"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.6"
        />
      );
    case "logout":
      return (
        <>
          <path
            d="M7 4H5.75A1.75 1.75 0 0 0 4 5.75v6.5A1.75 1.75 0 0 0 5.75 14H7"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
          <path
            d="M10 6.25 12.75 9 10 11.75M7.5 9h5.25"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </>
      );
    case "open":
      return (
        <>
          <path
            d="M7.25 4H5.75A1.75 1.75 0 0 0 4 5.75v6.5A1.75 1.75 0 0 0 5.75 14h6.5A1.75 1.75 0 0 0 14 12.25v-1.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
          <path
            d="M9 4h5v5M14 4 8 10"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </>
      );
    case "edit":
      return (
        <>
          <path
            d="M4.5 12.75 5.15 10l5.9-5.9a1.45 1.45 0 0 1 2.05 0l.8.8a1.45 1.45 0 0 1 0 2.05L8 12.85l-2.75.65"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
          <path
            d="m10.25 4.9 2.85 2.85"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.6"
          />
        </>
      );
    case "messages":
      return (
        <>
          <path
            d="M4.75 4h8.5A1.75 1.75 0 0 1 15 5.75v5.5A1.75 1.75 0 0 1 13.25 13H8l-3.75 1V5.75A1.75 1.75 0 0 1 6 4"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
          <path d="M6.5 7.5h5M6.5 10h3.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "market":
      return (
        <>
          <path
            d="M5.25 7.25h7.5l-.55 6.25H5.8L5.25 7.25Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
          <path
            d="M6.5 7.25V6.5A2.5 2.5 0 0 1 9 4a2.5 2.5 0 0 1 2.5 2.5v.75"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.6"
          />
          <path d="M7.25 10h3.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "approvals":
      return (
        <>
          <path
            d="M6.5 4.5h5l1.75 1.75v4.25c0 2.35-1.8 3.95-4.25 4.9-2.45-.95-4.25-2.55-4.25-4.9V6.25L6.5 4.5Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
          <path d="m7.2 9 1.2 1.2 2.4-2.4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
        </>
      );
    case "agents":
      return (
        <>
          <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3.75 13c.7-1.5 1.9-2.3 3.75-2.3S10.55 11.5 11.25 13" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
          <path d="m11.75 5.25.85.85 1.65-1.65M13.25 8.75h2M12.6 11.4l1.65 1.65" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
        </>
      );
    case "taskBoard":
      return (
        <>
          <rect height="9" rx="1.25" stroke="currentColor" strokeWidth="1.6" width="10" x="4" y="4.5" />
          <path d="M7.5 4.5v9M10.5 7.25h1.75M10.5 10.25h1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "groups":
      return (
        <>
          <circle cx="6.25" cy="7" r="1.75" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="11.75" cy="7.5" r="1.75" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3.75 13c.55-1.55 1.72-2.5 3.5-2.5S10.2 11.45 10.75 13M9.25 13c.4-1.15 1.3-1.9 2.75-1.9 1.1 0 1.95.35 2.55 1.05" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "info":
      return (
        <>
          <circle cx="9" cy="9" r="5.75" stroke="currentColor" strokeWidth="1.6" />
          <path d="M9 8v3M9 5.9h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "contacts":
      return (
        <>
          <circle cx="9" cy="6.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M4.5 13.5C5.35 11.65 6.95 10.75 9 10.75s3.65.9 4.5 2.75" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "containers":
      return (
        <>
          <rect height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" width="10.5" x="3.75" y="4.5" />
          <path d="M6 7.5h1.75M6 10.25h6M10.75 7.5h1.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "skills":
      return (
        <path
          d="m9 3 1.35 3.65L14 8 10.35 9.35 9 13l-1.35-3.65L4 8l3.65-1.35L9 3Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1.6"
        />
      );
    case "knowledge":
      return (
        <>
          <path
            d="M5.75 4.25h6.5A1.75 1.75 0 0 1 14 6v7.25H7.25A2.25 2.25 0 0 0 5 15.5V6a1.75 1.75 0 0 1 .75-1.45Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
          <path d="M7.25 6.75h4M7.25 9h3.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "performance":
      return (
        <>
          <path d="M4 13.5h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
          <path d="M6 11.5V8.75M9 11.5V6.5M12 11.5v-4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "orgChart":
      return (
        <>
          <rect height="2.5" rx=".8" stroke="currentColor" strokeWidth="1.6" width="3.25" x="7.375" y="3.5" />
          <rect height="2.5" rx=".8" stroke="currentColor" strokeWidth="1.6" width="3.25" x="3.5" y="11.5" />
          <rect height="2.5" rx=".8" stroke="currentColor" strokeWidth="1.6" width="3.25" x="11.25" y="11.5" />
          <path d="M9 6v2.25M5.125 8.25H12.875M5.125 8.25v3.25M12.875 8.25v3.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "costs":
      return (
        <>
          <path d="M9 4.25v9.5M11.5 6.25c0-.85-1.1-1.5-2.5-1.5s-2.5.65-2.5 1.5 1.1 1.5 2.5 1.5 2.5.65 2.5 1.5-1.1 1.5-2.5 1.5-2.5-.65-2.5-1.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
          <circle cx="9" cy="9" r="5.75" stroke="currentColor" strokeWidth="1.2" />
        </>
      );
    case "tables":
      return (
        <>
          <rect height="9" rx="1.25" stroke="currentColor" strokeWidth="1.6" width="10" x="4" y="4.5" />
          <path d="M4 8h10M8 4.5v9M11 8v5.5" stroke="currentColor" strokeWidth="1.4" />
        </>
      );
    case "automations":
      return (
        <>
          <path d="M6.25 4.75H12.5V11" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
          <path d="m11.25 5.75 1.25-1 1.25 1M11.75 13.25H5.5V7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
          <path d="m6.75 12.25-1.25 1-1.25-1" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
        </>
      );
    case "calendar":
      return (
        <>
          <rect height="9.5" rx="1.5" stroke="currentColor" strokeWidth="1.6" width="10" x="4" y="4.25" />
          <path d="M6.5 3.5v2M11.5 3.5v2M4 7.5h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
          <circle cx="8" cy="10" fill="currentColor" r=".9" />
          <circle cx="11" cy="10" fill="currentColor" r=".9" />
        </>
      );
    case "templates":
      return (
        <>
          <path d="M6 4.5h6A1.5 1.5 0 0 1 13.5 6v8.25H6A1.5 1.5 0 0 1 4.5 12.75V6A1.5 1.5 0 0 1 6 4.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
          <path d="M7 7.25h4M7 9.5h4M7 11.75h2.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </>
      );
    case "trash":
      return (
        <>
          <path d="M5.25 6.5h7.5M7.25 6.5v6.25M10.75 6.5v6.25" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
          <path d="M6.25 6.5 6.7 14h4.6l.45-7.5M7.5 4.5h3L11.25 6h-4.5L7.5 4.5Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
        </>
      );
    case "settings":
      return (
        <>
          <path d="M5.25 5.5h7.5M5.25 9h7.5M5.25 12.5h7.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
          <circle cx="7" cy="5.5" fill="currentColor" r="1.15" />
          <circle cx="11" cy="9" fill="currentColor" r="1.15" />
          <circle cx="8.5" cy="12.5" fill="currentColor" r="1.15" />
        </>
      );
    default:
      return null;
  }
}
