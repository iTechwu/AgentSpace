export type FeedbackState =
  | { tone: "idle" }
  | { tone: "error" | "info" | "success"; message: string };
