import { redirect } from "next/navigation";

/** 루트는 자동 파이프라인 페이지(`/auto`)로 보낸다. 구 풀 UI는 `/legacy`. */
export default function HomePage(): never {
  redirect("/auto");
}
