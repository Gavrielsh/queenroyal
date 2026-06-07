/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep Prisma's native engine out of the bundler so route handlers trace it correctly.
  serverExternalPackages: ["@prisma/client"],
  reactStrictMode: true,
};

export default nextConfig;
