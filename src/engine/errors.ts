export type FailureClass =
  | "contract_error"
  | "permission_denied"
  | "node_error"
  | "assert_failed";

export interface EngineError {
  class: FailureClass;
  message: string;
}
