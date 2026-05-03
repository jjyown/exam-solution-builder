import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { CROPPED_EXAMS_DIR_NAME } from "@/lib/outputPaths";

export async function GET() {
  try {
    const root = path.join(process.cwd(), CROPPED_EXAMS_DIR_NAME);
    await fs.mkdir(root, { recursive: true });
    const entries = await fs.readdir(root, { withFileTypes: true });
    const bundles: Array<{ name: string; kind: "zip" | "folder" }> = [];

    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        bundles.push({ name: e.name, kind: "folder" });
      } else if (e.isFile() && /\.zip$/i.test(e.name)) {
        bundles.push({ name: e.name, kind: "zip" });
      }
    }

    bundles.sort((a, b) => {
      const ak = `${a.kind}:${a.name}`;
      const bk = `${b.kind}:${b.name}`;
      return ak.localeCompare(bk, "ko");
    });

    return NextResponse.json({
      bundles,
      serverCwd: process.cwd(),
      scanRoot: CROPPED_EXAMS_DIR_NAME,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    console.error("cropped-exams list:", message, error);
    return NextResponse.json(
      { error: `크롭된 시험지 목록을 읽지 못했습니다: ${message}` },
      { status: 500 },
    );
  }
}
