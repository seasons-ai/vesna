export function spinnerFrame(tick: number, frames: readonly string[]): string {
  return frames[Math.abs(tick) % frames.length]!;
}

export function progressBar(done: number, total: number, width: number): string {
  const ratio = total <= 0 ? 0 : Math.min(1, Math.max(0, done / total));
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
}
