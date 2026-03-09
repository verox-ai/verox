import { createInterface } from "node:readline";

export function prompt(question: string, defaultVal = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const display = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

export function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  "));
  }
}
