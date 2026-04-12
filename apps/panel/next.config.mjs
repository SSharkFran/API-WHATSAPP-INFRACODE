/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@infracode/ui", "@infracode/types"],
  async rewrites() {
    const apiInternalUrl = process.env.API_INTERNAL_BASE_URL ?? "http://localhost:3333";
    return [
      {
        source: "/api/:path*",
        destination: `${apiInternalUrl}/:path*`
      }
    ];
  }
};

export default nextConfig;
