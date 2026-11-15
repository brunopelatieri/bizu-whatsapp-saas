import type { MetaFunction } from "react-router";
import { ProfilePage } from "@/pages/profile-page";

export const meta: MetaFunction = () => [
  { title: "Perfil — Bizu SaaS" },
  { name: "robots", content: "noindex" },
];

export default function AdminProfile() {
  return <ProfilePage />;
}
