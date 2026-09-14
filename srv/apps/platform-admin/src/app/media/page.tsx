import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import MediaManager from "./MediaManager";

export default async function MediaPage() {
  if (!(await isAuthenticated())) redirect("/login");
  return <MediaManager />;
}
