const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(tick: number): string {
  return SPINNER[Math.abs(tick) % SPINNER.length]!;
}

export function progressBar(done: number, total: number, width: number): string {
  const ratio = total <= 0 ? 0 : Math.min(1, Math.max(0, done / total));
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 1) return "…".slice(0, limit);
  return `${text.slice(0, limit - 1)}…`;
}
