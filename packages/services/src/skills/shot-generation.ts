export type ShotGenerationFailureKind = "temporary" | "missing_asset";

/**
 * A single shot failure reported by a video-model adapter. The adapter may
 * additionally annotate which character/scene assets were referenced but are
 * absent from the frozen input revision (structural gap).
 */
export interface ShotFailure {
  shotId: string;
  errorCode: string;
  missingCharacters?: string[];
  missingScenes?: string[];
}

export interface AssetGap {
  shotId: string;
  missingCharacters: string[];
  missingScenes: string[];
}

export interface BatchFailureAttribution {
  /** Transient failures (rate-limit, timeout, network) — retry in place. */
  retryable: ShotFailure[];
  /** Structural gaps — must loop back to the convergence-group input revision R. */
  assetGaps: AssetGap[];
}

/**
 * Classifies a shot failure. A missing character/scene annotation means the
 * failure is structural (asset gap), not transient — it must feed the asset-gap
 * analysis and loop back to the convergence group instead of being retried.
 */
export function attributeShotFailure(failure: ShotFailure): ShotGenerationFailureKind {
  const hasMissingAsset =
    (failure.missingCharacters?.length ?? 0) > 0 ||
    (failure.missingScenes?.length ?? 0) > 0;
  return hasMissingAsset ? "missing_asset" : "temporary";
}

/** Splits a batch of failures into in-place retries vs asset-gap backfills. */
export function attributeBatchFailures(failures: ShotFailure[]): BatchFailureAttribution {
  const retryable: ShotFailure[] = [];
  const assetGaps: AssetGap[] = [];
  for (const failure of failures) {
    if (attributeShotFailure(failure) === "missing_asset") {
      assetGaps.push({
        shotId: failure.shotId,
        missingCharacters: failure.missingCharacters ?? [],
        missingScenes: failure.missingScenes ?? [],
      });
    } else {
      retryable.push(failure);
    }
  }
  return { retryable, assetGaps };
}

/**
 * Video-model adapter skeleton. Real adapters (Sora/Veo/Kling/...) implement
 * this interface; the module only orchestrates batches and attribution, never
 * makes per-model decisions.
 */
export interface VideoModelAdapter {
  readonly modelId: string;
  generateShot(input: {
    shotId: string;
    prompt: string;
    characterIds: string[];
    sceneIds: string[];
  }): Promise<{ outputDigest: string }>;
}

export interface ShotGenerationBatch {
  storyboardArtifactDigest: string;
  shots: Array<{
    shotId: string;
    prompt: string;
    characterIds: string[];
    sceneIds: string[];
  }>;
}
