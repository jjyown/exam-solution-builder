"use client";

/**
 * 시험지 편집 탭 — placeholder.
 * 추후 추가될 기능: OCR 결과 텍스트 직접 편집, 문항 분리 수동 보정 등.
 */
export default function EditPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 text-center">
      <h1 className="text-xl font-bold text-slate-900">📝 시험지 편집</h1>
      <p className="mt-2 text-sm text-slate-600">곧 추가됩니다.</p>
      <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-left text-xs text-slate-700">
        <p className="font-semibold text-slate-800">예정 기능</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>OCR 추출 결과 텍스트 직접 편집 — 잘못 인식된 수식·기호 보정</li>
          <li>문항 분리 수동 보정 — 자동 분리가 틀렸을 때 경계 조정</li>
          <li>수정 결과 저장 후 곧바로 「해설 제작」 탭으로 전달</li>
        </ul>
        <p className="mt-3 text-[11px] text-slate-500">
          현재로는 「해설 제작」 탭의 텍스트 입력 박스에 직접 붙여넣어 사용해주세요.
        </p>
      </div>
    </div>
  );
}
