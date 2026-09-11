/**
 * The two things a question-and-answer exchange needs, whatever is on the
 * other end: a real terminal, or a test double that scripts the answers.
 */
export interface PromptIO {
  write(text: string): void;
  question(prompt: string): Promise<string>;
}
