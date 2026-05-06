export type TextbookPreset = {
  solverProfile: "easy" | "balanced" | "killer";
  generationMode: "test" | "final";
  delayMs: number;
  strictGate: boolean;
  mathpix: boolean;
  mathpixMinConfidence: number;
};

export const TEXTBOOK_DEFAULT_PRESET: TextbookPreset = {
  solverProfile: "balanced",
  generationMode: "final",
  delayMs: 1000,
  strictGate: true,
  mathpix: true,
  mathpixMinConfidence: 0.75,
};

export function buildTextbookFinalFromInputArgs(params: {
  inputDir: string;
  examName: string;
  baseUrl: string;
  preset?: Partial<TextbookPreset>;
  fastMode?: boolean;
  mathpixStrict?: boolean;
  mathpixNoCache?: boolean;
  disableMathpix?: boolean;
}): string[] {
  const p = { ...TEXTBOOK_DEFAULT_PRESET, ...(params.preset ?? {}) };
  const args: string[] = [
    "scripts/make-final-from-input.mts",
    "--input",
    params.inputDir,
    "--exam-name",
    params.examName,
    "--base-url",
    params.baseUrl,
    "--solver-profile",
    p.solverProfile,
    "--generation-mode",
    p.generationMode,
    "--delay-ms",
    String(p.delayMs),
  ];

  if (params.fastMode) {
    args.push("--fast");
  } else if (p.strictGate) {
    args.push("--strict-gate");
  }

  if (!params.disableMathpix && p.mathpix) {
    args.push("--mathpix", "--mathpix-min-confidence", String(p.mathpixMinConfidence));
  } else {
    args.push("--no-mathpix");
  }

  if (params.mathpixStrict) args.push("--mathpix-strict");
  if (params.mathpixNoCache) args.push("--mathpix-no-cache");
  return args;
}
