import type { MetadataRoute } from "next";

const pages = [
  { path: "", changeFrequency: "hourly", priority: 1 },
  { path: "/launch", changeFrequency: "weekly", priority: 0.9 },
  { path: "/my", changeFrequency: "daily", priority: 0.7 },
  { path: "/rewards", changeFrequency: "daily", priority: 0.7 },
  { path: "/tokenomics", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs", changeFrequency: "monthly", priority: 0.6 },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return pages.map((page) => ({
    url: `https://laypipe.fun${page.path}`,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
