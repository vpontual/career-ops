import { redirect } from "next/navigation";

// /ranked merged into the home page as the "Ranked" tab (design system says
// one app should have one consistent layout). Redirect preserves bookmarks
// and any external links that still point at the old route.
export default function RankedRedirect() {
  redirect("/?tab=ranked");
}
