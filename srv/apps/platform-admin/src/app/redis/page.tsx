import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import RedisManager from "./RedisManager";

export default async function RedisPage() {
  if (!(await isAuthenticated())) redirect("/login");
  return <RedisManager />;
}
