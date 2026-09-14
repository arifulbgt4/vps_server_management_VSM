import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import MongoDBManager from "./MongoDBManager";

export default async function MongoDBPage() {
  if (!(await isAuthenticated())) redirect("/login");
  return <MongoDBManager />;
}
