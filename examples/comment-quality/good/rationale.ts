// The decision service rejects batches over 13 MiB, so cap the payload here.
const MAX_BATCH_BYTES = 13 << 20

export function clampToServiceLimit(size: number): number {
  // Oversized bodies are rejected, not truncated, so fail closed at the cap.
  return Math.min(size, MAX_BATCH_BYTES)
}
