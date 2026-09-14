"use client";

import styles from "./page.module.css";

export default function SignOutButton() {
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <button className={styles.signOut} type="button" onClick={signOut}>
      Sign out
    </button>
  );
}
