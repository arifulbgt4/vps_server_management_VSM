import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import DockerManager from "./DockerManager";

export default async function DockerPage() {
  if (!(await isAuthenticated())) redirect("/login");
  return <DockerManager />;
}
