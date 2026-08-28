/**
 * An execution runtime needs a conversational language model. Protocol
 * compatibility alone is insufficient because image, video, and embedding
 * models can also expose OpenAI-compatible endpoints.
 */
export function isExecutionLanguageModel(model: { modelType?: unknown }): boolean {
  return model.modelType === "llm";
}
