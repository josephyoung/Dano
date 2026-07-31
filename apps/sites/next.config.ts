import type { NextConfig } from "next";
import { siteBasePath } from "./build/site-base-path";

const nextConfig: NextConfig = {
  basePath: siteBasePath,
};

export default nextConfig;
