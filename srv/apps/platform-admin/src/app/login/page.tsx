import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import LoginForm from "./LoginForm";
import styles from "./login.module.css";

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/");

  return (
    <main className={styles.page}>
      <LoginForm />
    </main>
  );
}
