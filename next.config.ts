import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: "/New_Pft_W_CAD",
  assetPrefix: "/New_Pft_W_CAD",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
