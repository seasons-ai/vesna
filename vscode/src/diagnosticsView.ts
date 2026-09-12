/**
 * The findings as squiggles: `diagnostics.ts` says what to underline, this
 * module hands it to the editor's `DiagnosticCollection` — one `set` per
 * file, `vesna` as the source, files that are not on disk skipped.
 */
import * as vscode from "vscode";
import { groupByFile, type Diag } from "./diagnostics";

const SEVERITY: Record<Diag["severity"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
};

function diagnosticFor(diag: Diag): vscode.Diagnostic {
  const range = new vscode.Range(diag.line, 0, diag.line, 0);
  const diagnostic = new vscode.Diagnostic(range, diag.message, SEVERITY[diag.severity]);
  diagnostic.source = "vesna";
  return diagnostic;
}

/**
 * Replaces everything in `collection` with `diags`. `exists` decides which
 * files are worth a squiggle (`fs.existsSync` in production); an empty
 * `diags` leaves the collection cleared.
 */
export function applyDiagnostics(collection: vscode.DiagnosticCollection, diags: Diag[], exists: (path: string) => boolean): void {
  collection.clear();
  for (const [file, group] of groupByFile(diags, exists)) {
    collection.set(vscode.Uri.file(file), group.map(diagnosticFor));
  }
}
