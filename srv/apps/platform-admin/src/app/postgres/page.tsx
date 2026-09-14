import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import PostgresManager from "./PostgresManager";

export default async function PostgresPage() {
  if (!(await isAuthenticated())) redirect("/login");
  return <PostgresManager />;
}
