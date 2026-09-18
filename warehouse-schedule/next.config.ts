import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: { position: "bottom-right" },
  experimental: {
    // Importi i Excel-it dërgon skedarin përmes një server action.
    serverActions: { bodySizeLimit: "10mb" },
  },
};

export default nextConfig;
