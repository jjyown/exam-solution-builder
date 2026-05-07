import { redirect } from "next/navigation";

/** 루트는 자동 파이프라인 페이지로 리다이렉트. */
export default function HomePage(): never {
  redirect("/auto");
}
