import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import MySQLManager from "./MySQLManager";

export default async function MySQLPage() {
  if (!(await isAuthenticated())) redirect("/login");
  return <MySQLManager />;
}
